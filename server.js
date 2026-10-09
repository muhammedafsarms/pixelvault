require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const isProduction = process.env.NODE_ENV === "production";

if (ADMIN_PASSWORD.length < 16) {
  console.error("ADMIN_PASSWORD must be at least 16 characters.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  max: 5
});

// In-memory sessions expire after 8 hours.
// Restarting the server invalidates all sessions.
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_MS = 8 * 60 * 60 * 1000;

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS advertisements (
      id BIGSERIAL PRIMARY KEY,
      business_name VARCHAR(100) NOT NULL,
      website_url TEXT NOT NULL,
      description VARCHAR(300) NOT NULL DEFAULT '',
      logo_url TEXT NOT NULL DEFAULT '',
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("Database initialized.");
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 10000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function validWebsite(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && url.hostname.includes(".")
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function getCookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

function getSession(req) {
  const token = getCookies(req).pv_admin;
  if (!token) return null;

  const expiry = sessions.get(token);
  if (!expiry) return null;

  if (expiry < Date.now()) {
    sessions.delete(token);
    return null;
  }

  return token;
}

function cookieOptions() {
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=28800",
    ...(isProduction ? ["Secure"] : [])
  ].join("; ");
}

function clearSessionCookie() {
  return [
    "pv_admin=",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(isProduction ? ["Secure"] : [])
  ].join("; ");
}

function originIsAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function loginRateLimited(req) {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = loginAttempts.get(ip);

  if (!entry || now - entry.start > 15 * 60 * 1000) {
    entry = { start: now, count: 0 };
  }

  entry.count++;
  loginAttempts.set(ip, entry);

  // Allow at most 5 attempts per 15-minute window.
  return entry.count > 5;
}

function resetLoginAttempts(req) {
  const ip = req.socket.remoteAddress || "unknown";
  loginAttempts.delete(ip);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/api/health" && req.method === "GET") {
    try {
      await pool.query("SELECT 1");
      return sendJson(res, 200, {
        ok: true,
        database: "connected"
      });
    } catch {
      return sendJson(res, 503, {
        ok: false,
        database: "unavailable"
      });
    }
  }

  // Public: show approved advertisements on the wall.
  if (pathname === "/api/advertisements" && req.method === "GET") {
    try {
      const result = await pool.query(
        `SELECT id, business_name, website_url, description, logo_url, created_at
         FROM advertisements
         WHERE status = 'approved'
         ORDER BY created_at DESC
         LIMIT 400`
      );
      return sendJson(res, 200, { advertisements: result.rows });
    } catch (error) {
      console.error("Public advertisement list failed:", error.message);
      return sendJson(res, 500, { error: "Unable to load advertisements." });
    }
  }

  // Public: submit a new advertisement for approval.
  if (pathname === "/api/advertisements" && req.method === "POST") {
    try {
      const data = await readJson(req);
      const businessName =
        typeof data.businessName === "string"
          ? data.businessName.trim() : "";
      const websiteUrl =
        typeof data.websiteUrl === "string"
          ? data.websiteUrl.trim() : "";
      const description =
        typeof data.description === "string"
          ? data.description.trim() : "";
      const logoUrl =
        typeof data.logoUrl === "string" ? data.logoUrl.trim() : "";

      if (!businessName || businessName.length > 100) {
        return sendJson(res, 400, {
          error: "Business name is required (maximum 100 characters)."
        });
      }

      if (!validWebsite(websiteUrl) || websiteUrl.length > 2048) {
        return sendJson(res, 400, {
          error: "Enter a valid website URL beginning with http:// or https://."
        });
      }

      if (description.length > 300) {
        return sendJson(res, 400, {
          error: "Description must be 300 characters or fewer."
        });
      }

      if (logoUrl && (!validWebsite(logoUrl) || logoUrl.length > 2048)) {
        return sendJson(res, 400, {
          error: "Logo URL must be a valid http:// or https:// URL."
        });
      }

      const result = await pool.query(
        `INSERT INTO advertisements
          (business_name, website_url, description, logo_url)
         VALUES ($1, $2, $3, $4)
         RETURNING id, status, created_at`,
        [businessName, websiteUrl, description, logoUrl]
      );

      return sendJson(res, 201, {
        message: "Submission received. It will appear after admin approval.",
        advertisement: result.rows[0]
      });
    } catch (error) {
      if (error.message === "Request too large") {
        return sendJson(res, 413, { error: "Request too large." });
      }
      if (error.message === "Invalid JSON") {
        return sendJson(res, 400, { error: "Invalid JSON." });
      }

      console.error("Submission failed:", error.message);
      return sendJson(res, 500, {
        error: "Unable to submit advertisement."
      });
    }
  }

  // Admin login: never return or expose the configured password.
  if (pathname === "/api/admin/login" && req.method === "POST") {
    if (!originIsAllowed(req)) {
      return sendJson(res, 403, { error: "Request origin rejected." });
    }

    if (loginRateLimited(req)) {
      return sendJson(res, 429, {
        error: "Too many login attempts. Try again in 15 minutes."
      });
    }

    try {
      const data = await readJson(req);
      const candidate =
        typeof data.password === "string" ? data.password : "";

      const expectedHash = crypto
        .createHash("sha256")
        .update(ADMIN_PASSWORD)
        .digest();

      const candidateHash = crypto
        .createHash("sha256")
        .update(candidate)
        .digest();

      if (!crypto.timingSafeEqual(expectedHash, candidateHash)) {
        return sendJson(res, 401, { error: "Incorrect password." });
      }

      resetLoginAttempts(req);

      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, Date.now() + SESSION_MS);

      res.setHeader("Set-Cookie", `pv_admin=${token}; ${cookieOptions()}`);
      return sendJson(res, 200, { ok: true, authenticated: true });
    } catch (error) {
      return sendJson(res, 400, { error: "Invalid login request." });
    }
  }

  if (pathname === "/api/admin/session" && req.method === "GET") {
    return sendJson(res, 200, {
      authenticated: Boolean(getSession(req))
    });
  }

  if (pathname === "/api/admin/logout" && req.method === "POST") {
    if (!originIsAllowed(req)) {
      return sendJson(res, 403, { error: "Request origin rejected." });
    }

    const token = getSession(req);
    if (token) sessions.delete(token);

    res.setHeader("Set-Cookie", clearSessionCookie());
    return sendJson(res, 200, { ok: true });
  }

  // Every remaining /api/admin route requires a valid session.
  if (pathname.startsWith("/api/admin/")) {
    if (!getSession(req)) {
      return sendJson(res, 401, { error: "Admin login required." });
    }

    if (!originIsAllowed(req)) {
      return sendJson(res, 403, { error: "Request origin rejected." });
    }

    if (
      pathname === "/api/admin/advertisements"
      && req.method === "GET"
    ) {
      const status = url.searchParams.get("status") || "pending";

      if (!["pending", "approved", "rejected"].includes(status)) {
        return sendJson(res, 400, { error: "Invalid status." });
      }

      try {
        const result = await pool.query(
          `SELECT id, business_name, website_url, description,
                  logo_url, status, created_at
           FROM advertisements
           WHERE status = $1
           ORDER BY created_at DESC
           LIMIT 100`,
          [status]
        );

        return sendJson(res, 200, { advertisements: result.rows });
      } catch (error) {
        console.error("Admin list failed:", error.message);
        return sendJson(res, 500, { error: "Unable to load advertisements." });
      }
    }

    const match = pathname.match(
      /^\/api\/admin\/advertisements\/([0-9]+)$/
    );

    if (match && req.method === "PATCH") {
      try {
        const data = await readJson(req);
        const status = data.status;

        if (!["approved", "rejected"].includes(status)) {
          return sendJson(res, 400, {
            error: "Status must be approved or rejected."
          });
        }

        const result = await pool.query(
          `UPDATE advertisements
           SET status = $1
           WHERE id = $2
           RETURNING id, business_name, website_url, description,
                     logo_url, status, created_at`,
          [status, match[1]]
        );

        if (!result.rowCount) {
          return sendJson(res, 404, { error: "Advertisement not found." });
        }

        return sendJson(res, 200, {
          message: `Advertisement ${status}.`,
          advertisement: result.rows[0]
        });
      } catch (error) {
        console.error("Admin update failed:", error.message);
        return sendJson(res, 500, { error: "Unable to update advertisement." });
      }
    }

    return sendJson(res, 404, { error: "Admin endpoint not found." });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "Method not allowed." });
  }

  const fileName =
    pathname === "/admin" || pathname === "/admin/"
      ? "admin.html"
      : pathname === "/" || pathname === "/index.html"
        ? "index.html"
        : null;

  if (!fileName) {
    return sendJson(res, 404, { error: "Not found." });
  }

  const filePath = path.join(__dirname, fileName);

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(
        fileName === "admin.html"
          ? "Admin page is not installed yet."
          : "Homepage not found."
      );
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });

    res.end(req.method === "HEAD" ? undefined : content);
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error("Request failed:", error.message);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error." });
    } else {
      res.destroy();
    }
  });
});

initializeDatabase()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`PixelVault running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Startup failed:", error.message);
    process.exit(1);
  });

process.on("SIGTERM", async () => {
  server.close();
  await pool.end();
  process.exit(0);
});

