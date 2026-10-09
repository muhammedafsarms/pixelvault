
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  max: 5
});

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing");
  }

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
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
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
    return ["http:", "https:"].includes(url.protocol) &&
      url.hostname.includes(".");
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/api/health" && req.method === "GET") {
    try {
      await pool.query("SELECT 1");
      return sendJson(res, 200, { ok: true, database: "connected" });
    } catch {
      return sendJson(res, 503, { ok: false, database: "unavailable" });
    }
  }

  if (pathname === "/api/advertisements" && req.method === "POST") {
    try {
      const data = await readJson(req);
      const businessName = typeof data.businessName === "string"
        ? data.businessName.trim() : "";
      const websiteUrl = typeof data.websiteUrl === "string"
        ? data.websiteUrl.trim() : "";
      const description = typeof data.description === "string"
        ? data.description.trim() : "";

      if (!businessName || businessName.length > 100) {
        return sendJson(res, 400, {
          error: "Business name is required (maximum 100 characters)."
        });
      }

      if (!validWebsite(websiteUrl) || websiteUrl.length > 2048) {
        return sendJson(res, 400, {
          error: "Enter a valid website URL beginning with https:// or http://."
        });
      }

      if (description.length > 300) {
        return sendJson(res, 400, {
          error: "Description must be 300 characters or fewer."
        });
      }

      const result = await pool.query(
        `INSERT INTO advertisements
          (business_name, website_url, description)
         VALUES ($1, $2, $3)
         RETURNING id, status, created_at`,
        [businessName, websiteUrl, description]
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
      return sendJson(res, 500, { error: "Unable to submit advertisement." });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "Method not allowed." });
  }

  const filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("Unable to load PixelVault.");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : content);
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

