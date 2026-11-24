/**
 * Elite SACCO Mbarara — standalone server
 * Express + better-sqlite3
 *
 * Setup:
 *   npm init -y
 *   npm install express better-sqlite3
 *   node server.js            (index.html must sit in the same folder)
 *
 * Then open http://localhost:8080
 *
 * Env vars:
 *   PORT        (default 8080)
 *   HOST        (default 127.0.0.1; use 0.0.0.0 to share on a network)
 *   DB_FILE     (default esacco.db next to this file)
 *   HTML_FILE   (default index.html next to this file)
 *
 * Endpoints (what index.html expects):
 *   GET  /               the app
 *   GET  /api/state      full application state (204 if nothing saved yet)
 *   PUT  /api/state      replace state (POST also accepted: used by sendBeacon on page close)
 *   GET  /healthz        "ok"
 *
 * NOTE: /api/state has no login of its own, and the app keeps user passwords inside
 * the state. Keep HOST on 127.0.0.1, or put the server behind HTTPS and an
 * authenticating reverse proxy before exposing it to a network.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(__dirname, 'esacco.db'));
const HTML_FILE = path.resolve(process.env.HTML_FILE || path.join(__dirname, 'index.html'));
const LEGACY_JSON = path.join(__dirname, 'esacco-data.json'); // from the old Node-only runtime
const BODY_LIMIT = '50mb';
const SNAPSHOT_EVERY_MS = 10 * 60 * 1000; // at most one history snapshot per 10 minutes
const SNAPSHOT_KEEP = 50;

/* ---------------- database ---------------- */
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    data       TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS state_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const qGet = db.prepare('SELECT data, updated_at FROM app_state WHERE id = 1');
const qUpsert = db.prepare(`
  INSERT INTO app_state (id, data, updated_at) VALUES (1, @data, @ts)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const qLastSnap = db.prepare('SELECT created_at FROM state_history ORDER BY id DESC LIMIT 1');
const qAddSnap = db.prepare('INSERT INTO state_history (data, created_at) VALUES (?, ?)');
const qPruneSnap = db.prepare(
  'DELETE FROM state_history WHERE id NOT IN (SELECT id FROM state_history ORDER BY id DESC LIMIT ?)'
);

const saveState = db.transaction((json) => {
  const now = new Date();
  const ts = now.toISOString();
  const last = qLastSnap.get();
  // keep a rolling history so a bad save can be recovered from
  if (!last || now - new Date(last.created_at) >= SNAPSHOT_EVERY_MS) {
    const prev = qGet.get();
    if (prev) {
      qAddSnap.run(prev.data, prev.updated_at);
      qPruneSnap.run(SNAPSHOT_KEEP);
    }
  }
  qUpsert.run({ data: json, ts });
});

// One-time import of data from the old esacco-data.json file, if present and DB is empty
if (!qGet.get() && fs.existsSync(LEGACY_JSON)) {
  try {
    const raw = fs.readFileSync(LEGACY_JSON, 'utf8');
    const o = JSON.parse(raw);
    if (o && Array.isArray(o.users)) {
      saveState(raw);
      console.log('Imported existing data from ' + LEGACY_JSON);
    }
  } catch (e) {
    console.warn('Could not import ' + LEGACY_JSON + ': ' + e.message);
  }
}

/* ---------------- app ---------------- */
const app = express();
app.disable('x-powered-by');

const isState = (o) => o && typeof o === 'object' && !Array.isArray(o) && Array.isArray(o.users);

app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

app.get('/api/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  let row;
  try {
    row = qGet.get();
  } catch (e) {
    console.error('Read failed:', e.message);
    return res.status(500).type('text/plain').send('Cannot read data');
  }
  if (!row) return res.status(204).end();
  res.type('application/json; charset=utf-8').send(row.data);
});

// sendBeacon posts a Blob typed application/json, so express.json() covers PUT and POST
const jsonBody = express.json({ limit: BODY_LIMIT, strict: true });
const writeState = (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!isState(req.body)) return res.status(400).type('text/plain').send('Invalid state');
  try {
    saveState(JSON.stringify(req.body));
    res.status(204).end();
  } catch (e) {
    console.error('Write failed:', e.message);
    res.status(500).type('text/plain').send('Write failed');
  }
};
app.put('/api/state', jsonBody, writeState);
app.post('/api/state', jsonBody, writeState);
app.all('/api/state', (req, res) => {
  res.set('Allow', 'GET, PUT, POST').status(405).end();
});

const sendApp = (req, res) => {
  res.set({
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.sendFile(HTML_FILE, (err) => {
    if (err && !res.headersSent) res.status(500).type('text/plain').send('Cannot read ' + HTML_FILE);
  });
};
app.get(['/', '/index.html'], sendApp);

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

// error handler: oversized / malformed bodies
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).type('text/plain').send('Too large');
  if (err.type === 'entity.parse.failed') return res.status(400).type('text/plain').send('Invalid state');
  console.error(err);
  res.status(500).type('text/plain').send('Server error');
});

/* ---------------- start / shutdown ---------------- */
if (!fs.existsSync(HTML_FILE)) console.warn('Warning: ' + HTML_FILE + ' not found. Put index.html next to server.js.');

const server = app.listen(PORT, HOST, () => {
  console.log('Elite SACCO Mbarara at http://localhost:' + PORT + '  (database: ' + DB_FILE + ')');
});
server.on('error', (e) => {
  console.error('Server error: ' + e.message);
  process.exit(1);
});

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.close(() => {
    try {
      db.close();
    } catch (e) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, shutdown));
