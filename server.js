/**
 * Elite SACCO Mbarara — standalone server
 * Express + better-sqlite3
 *
 * Setup:
 *   npm init -y
 *   npm install express better-sqlite3
 *   node server.js            (index.html and app.db must sit in the same folder)
 *
 * Then open http://localhost:8080
 *
 * Env vars:
 *   PORT        (default 8080)
 *   HOST        (default 127.0.0.1; use 0.0.0.0 to share on a network)
 *   DB_FILE     (default app.db next to this file)
 *   HTML_FILE   (default index.html next to this file)
 *
 * Endpoints (what index.html expects):
 *   GET  /               the app
 *   GET  /api/state      full application state (204 if nothing saved yet)
 *   PUT  /api/state      replace state (POST also accepted: used by sendBeacon on page close)
 *   GET  /healthz        "ok"
 *
 * Relational API (queries the tables in app.db directly, always JSON):
 *   GET  /api/data                 every table (password column never returned)
 *   GET  /api/data?table=savings   one table; optional &limit=&offset=&order=col&dir=asc|desc
 *                                  and any column as an exact-match filter, e.g. &acc=ES-F%20000001
 *   GET  /api/data?view=v_loans    one of the read-only views (v_member_savings, v_loans)
 *   POST /api/save                 {"table":"savings","record":{...}}  or  {"table":"savings","records":[...]}
 *                                  Upserts by primary key (insert when the key is absent or new).
 *                                  audit_log is insert-only. Returns {ok, saved, rows:[...]}.
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
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(__dirname, 'app.db'));
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

// app.db already ships with app_state(id, json, updated) and the relational tables;
// only the snapshot history table is added here if missing.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    json    TEXT NOT NULL,
    updated TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS state_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const qGet = db.prepare('SELECT json AS data, updated AS updated_at FROM app_state WHERE id = 1');
const qUpsert = db.prepare(`
  INSERT INTO app_state (id, json, updated) VALUES (1, @data, @ts)
  ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated = excluded.updated
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

/* ---------------- relational JSON API ---------------- */
// Only these tables/views are reachable. app_state / state_history / sqlite_* are internal.
const TABLES = [
  'users', 'permissions', 'role_permissions', 'members', 'non_members', 'savings',
  'loan_requests', 'loans', 'loan_repayments', 'audit_log', 'reg_inputs', 'settings',
];
const VIEWS = ['v_member_savings', 'v_loans'];
const HIDDEN_COLUMNS = { users: ['password'] }; // never sent to the browser
const INSERT_ONLY = new Set(['audit_log']);     // table has append-only triggers

// column metadata is read from the database itself, so it never drifts from the schema
const meta = {};
for (const t of [...TABLES, ...VIEWS]) {
  const cols = db.prepare('PRAGMA table_info(' + t + ')').all();
  if (!cols.length) continue; // table missing in this database
  meta[t] = {
    cols: cols.map((c) => c.name),
    pk: cols.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name),
    notnull: cols.filter((c) => c.notnull && c.dflt_value == null && !c.pk).map((c) => c.name),
  };
}
const q = (name) => '"' + name.replace(/"/g, '""') + '"'; // names only ever come from `meta`
const visibleCols = (t) => meta[t].cols.filter((c) => !(HIDDEN_COLUMNS[t] || []).includes(c));
const selectList = (t) => visibleCols(t).map(q).join(', ');

const readTable = (t, params = {}) => {
  const m = meta[t];
  const where = [];
  const args = [];
  for (const c of visibleCols(t)) {
    if (params[c] !== undefined && typeof params[c] === 'string') {
      where.push(q(c) + ' = ?');
      args.push(params[c]);
    }
  }
  let sql = 'SELECT ' + selectList(t) + ' FROM ' + q(t);
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  const order = visibleCols(t).includes(params.order) ? params.order : (m.pk[0] || null);
  if (order) sql += ' ORDER BY ' + q(order) + (String(params.dir).toLowerCase() === 'desc' ? ' DESC' : ' ASC');
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 0, 0), 100000);
  if (limit) {
    sql += ' LIMIT ?';
    args.push(limit);
    const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
    if (offset) {
      sql += ' OFFSET ?';
      args.push(offset);
    }
  }
  return db.prepare(sql).all(...args);
};

app.get('/api/data', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { table, view } = req.query;
    if (typeof view === 'string') {
      if (!VIEWS.includes(view) || !meta[view]) return res.status(404).json({ error: 'Unknown view: ' + view });
      return res.json({ view, rows: db.prepare('SELECT * FROM ' + q(view)).all() });
    }
    if (typeof table === 'string') {
      if (!TABLES.includes(table) || !meta[table]) return res.status(404).json({ error: 'Unknown table: ' + table });
      const rows = readTable(table, req.query);
      return res.json({ table, count: rows.length, rows });
    }
    const out = {};
    for (const t of TABLES) if (meta[t]) out[t] = readTable(t);
    res.json({ tables: out, views: VIEWS.filter((v) => meta[v]) });
  } catch (e) {
    console.error('GET /api/data failed:', e.message);
    res.status(500).json({ error: 'Cannot read data' });
  }
});

// Insert or update one record. Unknown / hidden-read-only columns are rejected, not ignored,
// so typos surface instead of silently losing data.
const saveRecord = (t, rec) => {
  const m = meta[t];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new HttpError(400, 'Each record must be an object');
  const keys = Object.keys(rec);
  const unknown = keys.filter((k) => !m.cols.includes(k));
  if (unknown.length) throw new HttpError(400, 'Unknown column(s) for ' + t + ': ' + unknown.join(', '));
  for (const k of keys) {
    const v = rec[k];
    if (v !== null && typeof v === 'object') throw new HttpError(400, 'Column ' + k + ' must be a string, number, boolean or null');
  }
  const vals = {};
  for (const k of keys) vals[k] = typeof rec[k] === 'boolean' ? (rec[k] ? 1 : 0) : rec[k];

  const hasPk = m.pk.length > 0 && m.pk.every((k) => vals[k] !== undefined && vals[k] !== null);
  const exists = hasPk &&
    db.prepare('SELECT 1 FROM ' + q(t) + ' WHERE ' + m.pk.map((k) => q(k) + ' = ?').join(' AND ')).get(...m.pk.map((k) => vals[k]));

  if (exists) {
    if (INSERT_ONLY.has(t)) throw new HttpError(405, t + ' is append-only');
    const setCols = keys.filter((k) => !m.pk.includes(k));
    if (setCols.length) {
      db.prepare(
        'UPDATE ' + q(t) + ' SET ' + setCols.map((k) => q(k) + ' = @' + k).join(', ') +
        ' WHERE ' + m.pk.map((k) => q(k) + ' = @' + k).join(' AND ')
      ).run(vals);
    }
    return Object.fromEntries(m.pk.map((k) => [k, vals[k]]));
  }

  const missing = m.notnull.filter((k) => vals[k] === undefined || vals[k] === null);
  if (missing.length) throw new HttpError(400, 'Missing required column(s) for ' + t + ': ' + missing.join(', '));
  const info = keys.length
    ? db.prepare('INSERT INTO ' + q(t) + ' (' + keys.map(q).join(', ') + ') VALUES (' + keys.map((k) => '@' + k).join(', ') + ')').run(vals)
    : db.prepare('INSERT INTO ' + q(t) + ' DEFAULT VALUES').run();
  const key = {};
  if (m.pk.length === 1) key[m.pk[0]] = vals[m.pk[0]] !== undefined ? vals[m.pk[0]] : Number(info.lastInsertRowid);
  else for (const k of m.pk) key[k] = vals[k];
  return key;
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const saveRecords = db.transaction((t, records) => records.map((r) => saveRecord(t, r)));

app.post('/api/save', jsonBody, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { table, record, records } = req.body || {};
    if (typeof table !== 'string' || !TABLES.includes(table) || !meta[table]) {
      return res.status(400).json({ error: 'Unknown or missing "table". Allowed: ' + TABLES.filter((t) => meta[t]).join(', ') });
    }
    const list = Array.isArray(records) ? records : record !== undefined ? [record] : null;
    if (!list || !list.length) return res.status(400).json({ error: 'Send "record" (object) or "records" (array)' });
    if (list.length > 5000) return res.status(413).json({ error: 'Too many records in one request (max 5000)' });

    const keys = saveRecords(table, list); // all-or-nothing
    const m = meta[table];
    const rows = keys.map((k) => {
      const w = m.pk.map((c) => q(c) + ' = ?').join(' AND ');
      return db.prepare('SELECT ' + selectList(table) + ' FROM ' + q(table) + ' WHERE ' + w).get(...m.pk.map((c) => k[c]));
    });
    res.json({ ok: true, table, saved: rows.length, rows });
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    if (e.code && String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: e.message });
    console.error('POST /api/save failed:', e.message);
    res.status(500).json({ error: 'Write failed' });
  }
});
app.all('/api/data', (req, res) => {
  res.set('Allow', 'GET').status(405).json({ error: 'Method not allowed' });
});
app.all('/api/save', (req, res) => {
  res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed' });
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

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).type('text/plain').send('Not found');
});

// error handler: oversized / malformed bodies
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/') && !req.path.startsWith('/api/state')) {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  }
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
