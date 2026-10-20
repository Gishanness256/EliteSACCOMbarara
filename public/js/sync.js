/*!
 * Elite SACCO Mbarara — offline change queue (sync.js)
 *
 * Watches the app's localStorage state ("esacco"), works out what changed
 * (members, savings, loans, loan requests, users, non-members, audit, inputs),
 * queues those changes in IndexedDB, and POSTs them to your server as soon as
 * the device is online. Queued changes survive page reloads and browser restarts.
 *
 * Usage — add before the main app script in index.html:
 *   <script src="sync.js"></script>
 *   <script>ESync.configure({ endpoint: 'https://your-server/api/sync', token: '...' });</script>
 *
 * Server contract:
 *   POST endpoint  { deviceId, sentAt, ops: [ {id, coll, key, op:'upsert'|'delete', data, ts} ] }
 *   Respond 2xx    => the batch is marked as delivered and removed from the queue.
 *   Anything else  => the batch stays queued and is retried with back-off.
 *   Upserts/deletes are idempotent per (coll,key), so retries are safe.
 */
(function (global) {
  'use strict';

  var STATE_KEY = 'esacco';              // key the app saves its state under
  var BASE_KEY  = 'esacco_sync_base';    // hashes of what has already been queued
  var DEV_KEY   = 'esacco_sync_device';
  var DB_NAME   = 'esacco_sync', STORE = 'q';

  var cfg = {
    endpoint: '',                 // empty = queue only, never send
    token: '',                    // optional Bearer token
    batchSize: 100,
    retryBaseMs: 3000,
    retryMaxMs: 5 * 60 * 1000,
    pollMs: 30000,                // periodic retry while online
    redact: ['pw'],               // fields stripped from payloads (user passwords)
    ui: true                      // show the small status badge
  };

  // collection name -> function returning a stable key for a record
  var COLLS = {
    members: function (r) { return r.acc; },
    users:   function (r) { return r.email; },
    non:     function (r) { return r.id; },
    reqs:    function (r) { return r.id; },
    loans:   function (r) { return r.ref || ((r.acc || r.nid) + '|' + r.date + '|' + r.amt); },
    savings: function (r) { return r.ref || ((r.acc || '') + '|' + r.date + '|' + r.amt + '|' + (r.w ? 'w' : 'd')); },
    audit:   function (r) { return r.t + '|' + (r.ini || '') + '|' + r.act; }
  };

  var flushing = false, timer = null, failures = 0, debounce = null, dbp = null, listeners = [];

  /* ---------- helpers ---------- */
  function hash(str) {                      // djb2 — cheap change detector
    var h = 5381, i = str.length;
    while (i) h = (h * 33) ^ str.charCodeAt(--i);
    return (h >>> 0).toString(36) + ':' + str.length;
  }
  function clean(rec) {
    if (!cfg.redact.length || !rec || typeof rec !== 'object') return rec;
    var o = {}; for (var k in rec) if (cfg.redact.indexOf(k) < 0) o[k] = rec[k];
    return o;
  }
  function deviceId() {
    try {
      var d = localStorage.getItem(DEV_KEY);
      if (!d) { d = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(DEV_KEY, d); }
      return d;
    } catch (e) { return 'dev-unknown'; }
  }
  function online() { return navigator.onLine !== false; }

  /* ---------- IndexedDB queue ---------- */
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(STORE, mode), s = t.objectStore(STORE), out = fn(s);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  function putMany(ops) { return tx('readwrite', function (s) { ops.forEach(function (o) { s.put(o); }); }); }
  function allOps()     { return tx('readonly', function (s) { return s.getAll(); }); }
  function removeMany(ids) { return tx('readwrite', function (s) { ids.forEach(function (i) { s.delete(i); }); }); }
  function count()      { return tx('readonly', function (s) { return s.count(); }); }

  /* ---------- change detection ---------- */
  function loadBase() { try { return JSON.parse(localStorage.getItem(BASE_KEY)) || {}; } catch (e) { return {}; } }
  function saveBase(b) { try { localStorage.setItem(BASE_KEY, JSON.stringify(b)); } catch (e) {} }

  function diff(state) {
    var base = loadBase(), next = {}, ops = [], now = Date.now(), seq = 0;
    Object.keys(COLLS).forEach(function (coll) {
      var list = Array.isArray(state[coll]) ? state[coll] : [], prev = base[coll] || {}, cur = {};
      list.forEach(function (rec) {
        var key = String(COLLS[coll](rec)), data = clean(rec), h = hash(JSON.stringify(data));
        cur[key] = h;
        if (prev[key] !== h) ops.push({ id: coll + '|' + key, coll: coll, key: key, op: 'upsert', data: data, ts: now, n: seq++ });
      });
      Object.keys(prev).forEach(function (key) {
        if (!(key in cur)) ops.push({ id: coll + '|' + key, coll: coll, key: key, op: 'delete', data: null, ts: now, n: seq++ });
      });
      next[coll] = cur;
    });
    // keyed records: monthly regulatory inputs and settings
    ['regin', 'rcfg', 'roles'].forEach(function (name) {
      var v = state[name];
      if (v === undefined) return;
      var h = hash(JSON.stringify(v));
      next['_' + name] = h;
      if (base['_' + name] !== h) ops.push({ id: '_' + name, coll: name, key: name, op: 'upsert', data: v, ts: now, n: seq++ });
    });
    return { ops: ops, next: next };
  }

  function capture(raw) {
    var state;
    try { state = JSON.parse(raw); } catch (e) { return; }
    if (!state || typeof state !== 'object') return;
    var d = diff(state);
    if (!d.ops.length) return;
    putMany(d.ops).then(function () {   // only advance the baseline once the ops are safely stored
      saveBase(d.next); notify(); flush();
    }).catch(function () {});
  }

  /* ---------- sending ---------- */
  function flush() {
    if (flushing || !cfg.endpoint || !online()) { notify(); return Promise.resolve(false); }
    flushing = true; notify();
    return allOps().then(function (ops) {
      if (!ops.length) { flushing = false; failures = 0; notify(); return true; }
      ops.sort(function (a, b) { return a.ts - b.ts || a.n - b.n; });
      var batch = ops.slice(0, cfg.batchSize);
      var headers = { 'Content-Type': 'application/json' };
      if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
      return fetch(cfg.endpoint, {
        method: 'POST', headers: headers, keepalive: batch.length < 20,
        body: JSON.stringify({ deviceId: deviceId(), sentAt: new Date().toISOString(), ops: batch })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return removeMany(batch.map(function (o) { return o.id; })).then(function () {
          // only drop an op if it was not re-queued with newer content meanwhile
          failures = 0; flushing = false; notify();
          return ops.length > batch.length ? flush() : true;
        });
      });
    }).catch(function () {
      flushing = false; failures++; notify(); schedule(); return false;
    });
  }

  function schedule() {
    clearTimeout(timer);
    var wait = Math.min(cfg.retryMaxMs, cfg.retryBaseMs * Math.pow(2, Math.max(0, failures - 1)));
    timer = setTimeout(flush, wait);
  }

  /* ---------- status badge ---------- */
  var badge;
  function notify() {
    count().then(function (n) {
      var st = { online: online(), pending: n, syncing: flushing, failing: failures > 0 };
      listeners.forEach(function (fn) { try { fn(st); } catch (e) {} });
      if (!cfg.ui) return;
      if (!badge) {
        badge = document.createElement('div');
        badge.setAttribute('role', 'status');
        badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99;padding:.4rem .8rem;border-radius:99px;font:700 .78rem system-ui,sans-serif;box-shadow:0 6px 16px rgba(5,15,50,.3);cursor:pointer;display:none';
        badge.title = 'Click to sync now';
        badge.onclick = function () { flush(); };
        (document.body || document.documentElement).appendChild(badge);
      }
      var hide = st.online && !n && !st.syncing;
      badge.style.display = hide ? 'none' : 'block';
      badge.style.background = !st.online ? '#9a6200' : st.failing ? '#D62828' : '#1B3C91';
      badge.style.color = '#fff';
      badge.textContent = !st.online ? 'Offline — ' + n + ' change(s) queued'
        : st.syncing ? 'Syncing…'
        : st.failing ? 'Sync failed — ' + n + ' pending (retrying)'
        : n + ' change(s) pending';
    }).catch(function () {});
  }

  /* ---------- hook into the app's saves ---------- */
  var origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    origSet.apply(this, arguments);
    if (this === global.localStorage && k === STATE_KEY) {
      clearTimeout(debounce);
      debounce = setTimeout(function () { capture(v); }, 300);
    }
  };

  global.addEventListener('online', function () { failures = 0; flush(); });
  global.addEventListener('offline', notify);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) flush(); });
  setInterval(function () { if (online()) flush(); }, cfg.pollMs);

  /* ---------- public API ---------- */
  global.ESync = {
    configure: function (o) { for (var k in o) cfg[k] = o[k]; flush(); notify(); },
    flush: flush,
    pending: count,
    queue: allOps,
    onChange: function (fn) { listeners.push(fn); },
    // Re-queue every record (e.g. first-time upload to a new server).
    resyncAll: function () { saveBase({}); try { capture(localStorage.getItem(STATE_KEY)); } catch (e) {} },
    clear: function () { return tx('readwrite', function (s) { s.clear(); }).then(notify); }
  };

  // Catch anything saved before this script loaded (e.g. while the tab was closed offline).
  function boot() {
    try { var raw = localStorage.getItem(STATE_KEY); if (raw) capture(raw); } catch (e) {}
    notify();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
