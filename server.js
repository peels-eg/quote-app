const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const CF_BASE = 'https://confluence.eg.dk';

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

http.createServer((req, res) => {
  const parsed = url.parse(req.url);

  if (parsed.pathname.startsWith('/rest/api')) {
    const cfUrl = CF_BASE + req.url;
    const cfParsed = url.parse(cfUrl);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const proxyReq = https.request({
        hostname: cfParsed.hostname,
        path: cfParsed.path,
        method: req.method,
        headers: {
          ...req.headers,
          host: cfParsed.hostname,
        },
      }, proxyRes => {
        res.writeHead(proxyRes.statusCode, {
          ...proxyRes.headers,
          'access-control-allow-origin': '*',
        });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', e => {
        res.writeHead(502);
        res.end(e.message);
      });
      if (body.length) proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
    res.end();
    return;
  }

  const filePath = path.join(__dirname, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
