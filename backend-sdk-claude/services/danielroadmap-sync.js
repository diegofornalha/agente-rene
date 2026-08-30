// Sync de estado do danielroadmap (checkboxes/status/notas marcados pelo Daniel)
// GET  /api/roadmap-state  -> JSON do último estado salvo
// POST /api/roadmap-state  -> persiste estado em data/danielroadmap-state.json
// Mesmo hostname via ingress cloudflared (path /api/*), sem CORS cross-origin.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8202;
const STATE_FILE = path.join(__dirname, '..', 'data', 'danielroadmap-state.json');
const MAX_BODY = 256 * 1024; // 256 KB — estado é pequeno

function readState() {
  try {
    return fs.readFileSync(STATE_FILE, 'utf8');
  } catch {
    return '{}';
  }
}

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url !== '/api/roadmap-state') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{"error":"not found"}');
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(readState());
  }

  if (req.method === 'POST') {
    let body = '';
    let overflow = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) { overflow = true; req.destroy(); }
    });
    req.on('end', () => {
      if (overflow) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{"error":"invalid json"}');
      }
      const record = { ...parsed, _savedAt: new Date().toISOString() };
      fs.writeFile(STATE_FILE, JSON.stringify(record, null, 2), (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end('{"error":"write failed"}');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end('{"error":"method not allowed"}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[danielroadmap-sync] listening on 127.0.0.1:${PORT}, state file: ${STATE_FILE}`);
});
