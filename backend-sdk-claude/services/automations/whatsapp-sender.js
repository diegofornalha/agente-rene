const http = require('http');

const API_PORT = process.env.PORT || '8080';
const API_TOKEN = process.env.API_BEARER_SECRET || '';

function send(jid, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jid, text });
    const req = http.request({
      hostname: '127.0.0.1',
      port: parseInt(API_PORT),
      path: '/api/whatsapp/say',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`WhatsApp ${res.statusCode}: ${body}`));
        } else {
          resolve(JSON.parse(body));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('WhatsApp send timeout')); });
    req.write(payload);
    req.end();
  });
}

async function sendChunked(jid, messages, delayMs = 1500) {
  for (let i = 0; i < messages.length; i++) {
    await send(jid, messages[i]);
    if (i < messages.length - 1 && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

module.exports = { send, sendChunked };
