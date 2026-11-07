'use strict';

const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createNewsroom } = require('./newsroom');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.resolve(__dirname, '../../newsroom.db');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

const newsroom = createNewsroom({ db });
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          reject(Object.assign(new Error('Expected a JSON object.'), { status: 400 }));
          return;
        }
        resolve(body);
      } catch {
        reject(Object.assign(new Error('Invalid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    return sendJson(res, 200, {
      ok: true,
      service: 'gold-silver-newsroom',
      name: 'Gold & Silver Newsroom',
      telegram_configured: newsroom.configured,
    });
  }
  if (url.pathname === '/telegram-webhook') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!newsroom.configured) return sendJson(res, 503, { error: 'Telegram webhook is not configured' });
    if (!newsroom.validWebhookSecret(req.headers['x-telegram-bot-api-secret-token'])) {
      return sendJson(res, 401, { error: 'Invalid webhook secret' });
    }
    try {
      const update = await readJsonBody(req);
      await newsroom.handleUpdate(update);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, error.status || 500, { error: error.status ? error.message : 'Webhook processing failed' });
    }
  }
  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', async () => {
  newsroom.start();
  console.log(`Gold & Silver Newsroom listening on port ${PORT}.`);
  if (!newsroom.configured) {
    console.warn('Telegram webhook is not configured; set the bot token and webhook secret in service secrets.');
    return;
  }
  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '';
  if (!publicUrl) {
    console.warn('Telegram webhook registration skipped because no public service URL is available.');
    return;
  }
  if (await newsroom.registerWebhook(publicUrl)) {
    console.log('Telegram webhook registered for the public Gold & Silver Newsroom URL.');
  } else {
    console.warn('Telegram webhook registration failed; check the Render public URL and Telegram configuration.');
  }
});

server.on('error', (error) => {
  console.error(`Gold & Silver Newsroom server error: ${error.code || 'unknown error'}.`);
  process.exitCode = 1;
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
