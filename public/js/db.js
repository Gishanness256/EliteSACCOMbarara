/*!
 * db.js — Storage layer for Elite SACCO Mbarara
 * Order of precedence: IndexedDB (local, instant)  ->  server API (sync/backup)
 *
 * Load : IndexedDB first. If it is empty, ask the server. If the server has
 *        nothing either, migrate the legacy localStorage "esacco" blob.
 * Save : write to IndexedDB immediately (marks the record dirty), then push to
 *        the server in the background (debounced, retried, offline-safe).
 * Fallbacks: if IndexedDB is unavailable (private mode / blocked) the layer
 *        degrades to localStorage + server, and finally to memory only.
 *
 * Server contract (all JSON, paths relative to apiBase, default "/api"):
 *   GET  /state            -> 200 { state, rev, updatedAt }   | 204/404 when empty
 *   PUT  /state            body { state, baseRev, updatedAt, force? }
 *                          -> 200 { rev, updatedAt }
 *                          -> 409 { state, rev, updatedAt }   (server is ahead)
 *   Auth: "Authorization: Bearer <token>" when a token / getToken is supplied.
 *
 * Usage:
 *   await DB.init({ apiBase: '/api', getToken: () => sessionStorage.token });
 *   const saved = await DB.load();           // object or null
 *   if (saved) S = saved;
 *   DB.save(S);                              // fire-and-forget is fine
 *   DB.onStatus(s => console.log(s));        // idle|dirty|syncing|synced|offline|error
 *   DB.onRemoteUpdate(() => location.reload());
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    dbName: 'elite-sacco',
    storeName: 'kv',
    stateKey: 'state',
    legacyKey: 'esacco',        // old localStorage key used by the current app
    apiBase: '/api',
    stateEndpoint: '/state',
    serverSync: true,           // set false for a purely local app
    token: null,
    getToken: null,             // () => string | Promise<string>
    syncDelay: 1500,            // ms debounce before pushing to the server
    timeout: 15000,             // ms per request
    retryMax: 60000,            // ms cap for exponential backoff
    autoPull: true,             // background-check the server after load()
    conflict: 'local'           // 'local' | 'server' | (local, server) => mergedState
  };

  let cfg = { ...DEFAULTS };
  let idb = null;               // IDBDatabase | null
  let idbTried = false;
  let mem = null;               // last-resort in-memory record
  let writeChain = Promise.resolve();
  let pushTimer = null, pushing = false, retryDelay = 0, started = false;
  let status = 'idle';
  const statusCbs = new Set(), remoteCbs = new Set();

  /* ---------- helpers ---------- */
  const now = () => new Date().toISOString();
  const setStatus = s => { if (s === status) return; status = s; statusCbs.forEach(f => { try { f(s); } catch (e) {} }); };
  const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;
  const canServer = () => cfg.serverSync && !!cfg.apiBase;
  const url = () => cfg.apiBase.replace(/\/+$/, '') + cfg.stateEndpoint;
  const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

  /* ---------- IndexedDB ---------- */
  function openIDB() {
    if (idbTried) return Promise.resolve(idb);
    idbTried = true;
    return new Promise(resolve => {
      try {
        if (!global.indexedDB) return resolve(null);
        const req = global.indexedDB.open(cfg.dbName, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(cfg.storeName)) d.createObjectStore(cfg.storeName, { keyPath: 'key' });
        };
        req.onsuccess = () => {
          idb = req.result;
          idb.onversionchange = () => { idb.close(); idb = null; };
          resolve(idb);
        };
        req.onerror = req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  function idbReq(mode, fn) {
    return new Promise((resolve, reject) => {
      try {
        const tx = idb.transaction(cfg.storeName, mode);
        const r = fn(tx.objectStore(cfg.storeName));
        tx.oncomplete = () => resolve(r && r.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      } catch (e) { reject(e); }
    });
  }

  /* ---------- record read / write (IDB -> localStorage -> memory) ---------- */
  async function readRec() {
    if (idb) {
      try { const r = await idbReq('readonly', s => s.get(cfg.stateKey)); if (r) return r; } catch (e) {}
    }
    if (!idb) {
      try {
        const raw = global.localStorage.getItem(cfg.dbName + ':' + cfg.stateKey);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return mem;
    }
    return null;
  }

  function writeRec(rec) {
    // serialised so rapid saves can never land out of order
    writeChain = writeChain.then(async () => {
      if (idb) {
        try { await idbReq('readwrite', s => s.put(rec)); return; } catch (e) { /* fall through */ }
      }
      try { global.localStorage.setItem(cfg.dbName + ':' + cfg.stateKey, JSON.stringify(rec)); mem = null; }
      catch (e) { mem = rec; }
    });
    return writeChain;
  }

  function legacyState() {
    try { const raw = global.localStorage.getItem(cfg.legacyKey); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }

  /* ---------- server API ---------- */
  async function headers() {
    const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    let t = cfg.token;
    if (cfg.getToken) { try { t = await cfg.getToken(); } catch (e) {} }
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  async function http(method, body, extra) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), cfg.timeout);
    try {
      return await fetch(url(), {
        method,
        headers: await headers(),
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        signal: ctl ? ctl.signal : undefined,
        ...(extra || {})
      });
    } finally { if (timer) clearTimeout(timer); }
  }

  async function serverGet() {
    if (!canServer() || !online()) return null;
    try {
      const r = await http('GET');
      if (r.status === 204 || r.status === 404) return { empty: true };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return j && j.state ? j : { empty: true };
    } catch (e) { return null; }       // null = unreachable
  }

  /* ---------- push (local -> server) ---------- */
  function schedulePush(delay) {
    if (!canServer()) { setStatus('idle'); return; }
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, delay == null ? cfg.syncDelay : delay);
  }

  async function pushNow() {
    if (!canServer() || pushing) return;
    const rec = await readRec();
    if (!rec || !rec.dirty) { setStatus('synced'); return; }
    if (!online()) { setStatus('offline'); return; }
    pushing = true; setStatus('syncing');
    try {
      const sent = rec.updatedAt;
      const r = await http('PUT', { state: rec.value, baseRev: rec.serverRev || 0, updatedAt: sent });
      if (r.status === 409) {
        await resolveConflict(rec, await r.json());
      } else if (!r.ok) {
        throw new Error('HTTP ' + r.status);
      } else {
        const j = await r.json().catch(() => ({}));
        const cur = await readRec();
        if (cur && cur.updatedAt === sent) {           // nothing newer was saved meanwhile
          cur.dirty = false; cur.serverRev = j.rev != null ? j.rev : cur.serverRev; cur.syncedAt = now();
          await writeRec(cur);
        } else if (cur) {                              // newer local edits — keep dirty, remember rev
          cur.serverRev = j.rev != null ? j.rev : cur.serverRev; await writeRec(cur);
        }
      }
      retryDelay = 0;
      const after = await readRec();
      if (after && after.dirty) { pushing = false; schedulePush(0); return; }
      setStatus('synced');
    } catch (e) {
      retryDelay = Math.min(cfg.retryMax, retryDelay ? retryDelay * 2 : 3000);
      setStatus(online() ? 'error' : 'offline');
      schedulePush(retryDelay);
    } finally { pushing = false; }
  }

  async function resolveConflict(local, server) {
    const policy = cfg.conflict;
    if (policy === 'server') {
      await writeRec({ key: cfg.stateKey, value: server.state, rev: (local.rev || 0) + 1, updatedAt: server.updatedAt || now(),
        dirty: false, serverRev: server.rev, syncedAt: now() });
      remoteCbs.forEach(f => { try { f(server.state); } catch (e) {} });
      return;
    }
    let merged = local.value;
    if (typeof policy === 'function') merged = await policy(clone(local.value), clone(server.state)) || local.value;
    const t = now();
    const r = await http('PUT', { state: merged, baseRev: server.rev, updatedAt: t, force: true });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json().catch(() => ({}));
    await writeRec({ key: cfg.stateKey, value: merged, rev: (local.rev || 0) + 1, updatedAt: t,
      dirty: false, serverRev: j.rev != null ? j.rev : server.rev, syncedAt: now() });
    if (typeof policy === 'function') remoteCbs.forEach(f => { try { f(merged); } catch (e) {} });
  }

  /* ---------- public API ---------- */
  async function init(opts) {
    cfg = { ...DEFAULTS, ...(opts || {}) };
    await openIDB();
    if (!started) {
      started = true;
      global.addEventListener('online', () => schedulePush(500));
      global.addEventListener('offline', () => setStatus('offline'));
      global.addEventListener('pagehide', () => { flushLocalOnly(); });
      global.document && global.document.addEventListener('visibilitychange', () => {
        if (global.document.visibilityState === 'hidden') schedulePush(0);
      });
    }
    return { indexedDB: !!idb, server: canServer() };
  }

  // Everything is written to IDB on save(); on page hide we only need to nudge the push.
  function flushLocalOnly() { if (canServer()) { clearTimeout(pushTimer); pushNow(); } }

  async function load() {
    await openIDB();
    const rec = await readRec();

    // 1) IndexedDB hit -> return instantly, reconcile with the server in the background
    if (rec && rec.value) {
      if (rec.dirty) schedulePush(0);
      else if (cfg.autoPull && canServer()) backgroundPull(rec);
      return rec.value;
    }

    // 2) Empty locally -> server
    const srv = await serverGet();
    if (srv && srv.state) {
      await writeRec({ key: cfg.stateKey, value: srv.state, rev: 1, updatedAt: srv.updatedAt || now(),
        dirty: false, serverRev: srv.rev, syncedAt: now() });
      return srv.state;
    }

    // 3) Legacy localStorage blob -> migrate into IDB and push up to the server
    const old = legacyState();
    if (old) { await save(old); return old; }

    return null;
  }

  async function backgroundPull(rec) {
    const srv = await serverGet();
    if (!srv || !srv.state) return;
    const newer = (srv.rev != null && srv.rev !== rec.serverRev) &&
                  new Date(srv.updatedAt || 0) > new Date(rec.updatedAt || 0);
    if (!newer) return;
    const cur = await readRec();
    if (cur && cur.dirty) return;                    // local edits made meanwhile win
    await writeRec({ key: cfg.stateKey, value: srv.state, rev: (cur ? cur.rev : 0) + 1, updatedAt: srv.updatedAt,
      dirty: false, serverRev: srv.rev, syncedAt: now() });
    remoteCbs.forEach(f => { try { f(srv.state); } catch (e) {} });
  }

  async function save(state) {
    if (state == null || typeof state !== 'object') throw new TypeError('DB.save expects the state object');
    await openIDB();
    const prev = await readRec();
    const rec = { key: cfg.stateKey, value: clone(state), rev: (prev ? prev.rev || 0 : 0) + 1, updatedAt: now(),
      dirty: true, serverRev: prev ? prev.serverRev || 0 : 0, syncedAt: prev ? prev.syncedAt : null };
    setStatus('dirty');
    await writeRec(rec);
    schedulePush();
    return rec.rev;
  }

  async function flush() { clearTimeout(pushTimer); await writeChain; await pushNow(); return status; }

  async function exportJSON() {
    const rec = await readRec();
    return JSON.stringify(rec ? rec.value : null, null, 2);
  }

  async function importJSON(text) {
    const s = typeof text === 'string' ? JSON.parse(text) : text;
    await save(s);
    return s;
  }

  async function clearLocal() {
    await writeChain;
    if (idb) { try { await idbReq('readwrite', s => s.delete(cfg.stateKey)); } catch (e) {} }
    try { global.localStorage.removeItem(cfg.dbName + ':' + cfg.stateKey); } catch (e) {}
    mem = null; setStatus('idle');
  }

  const info = async () => {
    const r = await readRec();
    return { status, indexedDB: !!idb, server: canServer(), online: online(),
      dirty: !!(r && r.dirty), rev: r ? r.rev : 0, serverRev: r ? r.serverRev : 0,
      updatedAt: r ? r.updatedAt : null, syncedAt: r ? r.syncedAt : null };
  };

  global.DB = {
    init, load, save, flush, info,
    exportJSON, importJSON, clearLocal,
    get status() { return status; },
    onStatus(cb) { statusCbs.add(cb); return () => statusCbs.delete(cb); },
    onRemoteUpdate(cb) { remoteCbs.add(cb); return () => remoteCbs.delete(cb); },
    configure(o) { cfg = { ...cfg, ...o }; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
