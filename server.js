const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  const file = path.join(__dirname, 'index.html');

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end('Website file not found');
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`PixelVault running on port ${PORT}`);
});
