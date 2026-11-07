'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { createNewsroom } = require('../newsroom');

const env = {
  TELEGRAM_BOT_TOKEN: crypto.randomBytes(24).toString('hex'),
  TELEGRAM_WEBHOOK_SECRET: crypto.randomBytes(32).toString('hex'),
  TELEGRAM_OWNER_ID: '100',
  TELEGRAM_EDITOR_ID: '200',
  TELEGRAM_ANALYST_ID: '300',
  TELEGRAM_CHANNEL_ID: '-10099',
  OPENAI_API_KEY: crypto.randomBytes(32).toString('hex'),
  OPENAI_MODEL: 'test-model',
  RSS_FEEDS: 'https://news.example.test/rss',
};

function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => body,
  };
}

function message(updateId, userId, text) {
  return { update_id: updateId, message: { from: { id: userId, first_name: 'Test' }, chat: { id: userId }, text } };
}

let db;
let calls;
let newsroom;
let serverProcess;
let serverPort;
let dbPath;
let tempDir;
let startupOutput = '';

before(async () => {
  db = new DatabaseSync(':memory:');
  calls = [];
  newsroom = createNewsroom({
    db,
    env,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).startsWith('https://api.telegram.org/')) return fakeResponse({ ok: true });
      if (String(url) === 'https://api.openai.com/v1/responses') {
        return fakeResponse({ output: [{ content: [{ type: 'output_text', text: 'Educational answer.' }] }] });
      }
      if (String(url) === 'https://news.example.test/rss') {
        return fakeResponse('<rss><channel><item><title>Central bank update</title><description>Policy context</description><link>https://news.example.test/story/1</link><pubDate>Sat, 07 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>');
      }
      throw new Error('Unexpected mocked URL');
    },
    clock: () => Date.parse('2026-11-07T12:00:00Z'),
  });

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-newsroom-test-'));
  dbPath = path.join(tempDir, 'server.db');
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  serverPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  serverProcess = spawn(process.execPath, ['--no-warnings', path.resolve(__dirname, '../newsroom-server.js')], {
    env: {
      ...process.env,
      PORT: String(serverPort),
      DB_FILE: dbPath,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET,
      TELEGRAM_OWNER_ID: env.TELEGRAM_OWNER_ID,
      TELEGRAM_EDITOR_ID: env.TELEGRAM_EDITOR_ID,
      TELEGRAM_ANALYST_ID: env.TELEGRAM_ANALYST_ID,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      RENDER_EXTERNAL_URL: '',
      PUBLIC_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (data) => { startupOutput += data.toString(); });
  serverProcess.stderr.on('data', (data) => { startupOutput += data.toString(); });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${serverPort}/health`)).ok) break;
    } catch { /* Wait for the child server to bind. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await fetch(`http://127.0.0.1:${serverPort}/health`)).status, 200, 'server should start and expose health');
  assert.match(startupOutput, /Gold & Silver Newsroom listening/);
  assert.equal(startupOutput.includes(env.TELEGRAM_BOT_TOKEN), false);
  assert.equal(startupOutput.includes(env.TELEGRAM_WEBHOOK_SECRET), false);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once('exit', resolve));
  }
  if (db) db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* The database may not have created every file. */ }
  }
  if (tempDir) fs.rmdirSync(tempDir);
});

test('validates webhook secret tokens without accepting missing or mismatched values', () => {
  assert.equal(newsroom.validWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET), true);
  assert.equal(newsroom.validWebhookSecret('wrong'), false);
  assert.equal(newsroom.validWebhookSecret(undefined), false);
});

test('registers the Telegram webhook against Render public URL without exposing its secret', async () => {
  const registrationCalls = [];
  const registrationDb = new DatabaseSync(':memory:');
  const registrationNewsroom = createNewsroom({
    db: registrationDb,
    env,
    fetchImpl: async (url, options) => {
      registrationCalls.push({ url: String(url), options });
      return fakeResponse({ ok: true });
    },
  });
  assert.equal(await registrationNewsroom.registerWebhook('https://new2026tareq.onrender.com'), true);
  assert.equal(await registrationNewsroom.registerWebhook('http://localhost:3000'), false);
  assert.equal(registrationCalls.length, 1);
  assert.match(registrationCalls[0].url, /\/setWebhook$/);
  const payload = JSON.parse(registrationCalls[0].options.body);
  assert.equal(payload.url, 'https://new2026tareq.onrender.com/telegram-webhook');
  assert.deepEqual(payload.allowed_updates, ['message']);
  assert.equal(payload.secret_token, env.TELEGRAM_WEBHOOK_SECRET);
  registrationDb.close();
});

test('applies team authorization and deduplicates Telegram updates', async () => {
  await newsroom.handleUpdate(message(9, 999, '/start'));
  assert.match(JSON.parse(calls.filter((call) => call.url.includes('/sendMessage')).at(-1).options.body).text, /غرفة الأخبار/);
  await newsroom.handleUpdate(message(10, 999, '/ask explain inflation'));
  const denied = calls.filter((call) => call.url.includes('/sendMessage')).at(-1);
  assert.match(JSON.parse(denied.options.body).text, /فريق التحرير/);
  assert.equal(calls.some((call) => call.url === 'https://api.openai.com/v1/responses'), false);

  await newsroom.handleUpdate(message(11, 300, '/ask explain inflation'));
  const request = calls.find((call) => call.url === 'https://api.openai.com/v1/responses');
  assert.equal(JSON.parse(request.options.body).model, 'test-model');
  assert.equal(JSON.parse(request.options.body).store, false);
  assert.match(JSON.parse(request.options.body).instructions, /Never generate buy or sell orders/);
  assert.match(JSON.parse(calls.filter((call) => call.url.includes('/sendMessage')).at(-1).options.body).text, /Educational answer/);
  const sendCount = calls.filter((call) => call.url.includes('/sendMessage')).length;
  await newsroom.handleUpdate(message(11, 300, '/ask explain inflation'));
  assert.equal(calls.filter((call) => call.url.includes('/sendMessage')).length, sendCount, 'duplicate update is not processed twice');
});

test('handles each requested newsroom Telegram command', async () => {
  const commands = ['/help', '/myid', '/health', '/gold', '/silver', '/macro', '/calendar', '/brief', '/cfo', '/ask explain duration'];
  const aiCallsBefore = calls.filter((call) => call.url === 'https://api.openai.com/v1/responses').length;
  for (const [index, command] of commands.entries()) {
    await newsroom.handleUpdate(message(100 + index, 100, command));
  }
  const sentMessages = calls.filter((call) => call.url.includes('/sendMessage')).slice(-commands.length);
  assert.equal(sentMessages.length, commands.length);
  assert.equal(calls.filter((call) => call.url === 'https://api.openai.com/v1/responses').length - aiCallsBefore, 7);
});

test('collects deduplicated RSS items and only publishes after an editor approval', async () => {
  assert.equal(await newsroom.collectFeeds(), 1);
  assert.equal(await newsroom.collectFeeds(), 0, 'same source link is a duplicate');
  await newsroom.handleUpdate(message(20, 300, '/news'));
  let items = db.prepare('SELECT * FROM newsroom_items').all();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'pending');
  assert.equal(items[0].source, 'news.example.test');
  assert.equal(items[0].published_at, Date.parse('2026-11-07T10:00:00Z'));
  assert.doesNotMatch(JSON.parse(calls.filter((call) => call.url.includes('/sendMessage')).at(-1).options.body).text, /Central bank update/);

  await newsroom.handleUpdate(message(21, 300, '/approve 1'));
  assert.equal(db.prepare('SELECT status FROM newsroom_items WHERE id=1').get().status, 'pending', 'analyst cannot publish');
  await newsroom.handleUpdate(message(22, 100, '/approve 1'));
  items = db.prepare('SELECT * FROM newsroom_items').all();
  assert.equal(items[0].status, 'approved');
  assert.equal(JSON.parse(calls.filter((call) => call.url.includes('/sendMessage')).at(-2).options.body).chat_id, '-10099');

  await newsroom.handleUpdate(message(23, 300, '/news'));
  assert.match(JSON.parse(calls.filter((call) => call.url.includes('/sendMessage')).at(-1).options.body).text, /Central bank update/);
});

test('uses the Responses API and handles API failures without exposing credentials', async () => {
  assert.equal(await newsroom.askOpenAI('Explain a bond'), 'Educational answer.');
  const unsafeDb = new DatabaseSync(':memory:');
  const unsafeNewsroom = createNewsroom({
    db: unsafeDb,
    env,
    fetchImpl: async () => fakeResponse({ output_text: 'Buy the trade now; gold is guaranteed to rise.' }),
  });
  assert.match(await unsafeNewsroom.askOpenAI('What should I do?'), /لا أقدم أوامر تداول/);
  unsafeDb.close();
  const failingDb = new DatabaseSync(':memory:');
  const failingKey = crypto.randomBytes(32).toString('hex');
  const failing = createNewsroom({
    db: failingDb,
    env: { ...env, OPENAI_API_KEY: failingKey },
    fetchImpl: async () => fakeResponse({}, { ok: false, status: 500 }),
  });
  const error = await failing.askOpenAI('question');
  assert.match(error, /تعذّر/);
  assert.equal(error.includes(failingKey), false);
  failingDb.close();
});

test('serves Newsroom health and validates its webhook endpoint', async () => {
  const base = `http://127.0.0.1:${serverPort}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: 'gold-silver-newsroom',
    name: 'Gold & Silver Newsroom',
    telegram_configured: true,
  });
  const invalid = await fetch(`${base}/telegram-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
    body: JSON.stringify(message(1, 100, '/start')),
  });
  assert.equal(invalid.status, 401);
  const valid = await fetch(`${base}/telegram-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify({ update_id: Date.now() }),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { ok: true });
  const wrongMethod = await fetch(`${base}/telegram-webhook`);
  assert.equal(wrongMethod.status, 405);
  const notFound = await fetch(`${base}/api/health`);
  assert.equal(notFound.status, 404, 'newsroom deployment does not start the Volt API server');
});
