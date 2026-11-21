// Server tĩnh dùng chung cho các test tự chứa — phục vụ index.html + vendor/ (three.js vendor).
// Trước đây mỗi test chỉ serve 1 file index.html; từ nhịp vendor three.js (nhịp #5) app import
// ./vendor/three/* nên mọi server test phải phục vụ file tĩnh theo đường dẫn.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.css': 'text/css',
};

export function makeStaticHandler(ROOT) {
  const rootAbs = path.resolve(ROOT);
  return (req, res) => {
    let p;
    try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch { p = '/'; }
    if (p.endsWith('/')) p += 'index.html';
    const filePath = path.resolve(path.join(rootAbs, p));
    if (!filePath.startsWith(rootAbs)) { res.writeHead(403); res.end(); return; } // chống path traversal
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found: ' + p); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  };
}
export function startStaticServer(ROOT, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(makeStaticHandler(ROOT));
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
