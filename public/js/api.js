/*!
 * api.js — Server API client for Elite SACCO Mbarara
 * Plain fetch wrapper: auth token handling, timeouts, JSON errors, safe retries
 * for GET requests, and a 401 hook. No dependencies. Exposes a global `API`.
 *
 * Endpoints expected (all JSON, relative to baseUrl, default "/api"):
 *   POST /auth/login        { email, password } -> { token, user, expiresAt? }
 *   POST /auth/logout
 *   GET  /auth/me           -> { user }
 *   GET  /state             -> { state, rev, updatedAt }  | 204/404 when empty
 *   PUT  /state             { state, baseRev, updatedAt, force? } -> { rev, updatedAt } | 409 { state, rev, updatedAt }
 *   GET  /health            -> { ok: true }
 *   CRUD /members, /savings, /loans, /loan-requests, /users, /non-members
 *        GET /x?query  |  GET /x/:id  |  POST /x  |  PUT /x/:id  |  DELETE /x/:id
 *   GET  /audit?from=&to=&user=&q=&limit=
 *   POST /audit             { act, part }
 *
 * Usage:
 *   API.configure({ baseUrl: '/api', onUnauthorized: () => showLogin() });
 *   const { user } = await API.auth.login(email, password);
 *   const members = await API.members.list({ q: 'jane' });
 *   // share the token with db.js so state sync is authenticated:
 *   DB.init({ apiBase: '/api', getToken: API.getToken });
 */
(function (global) {
  'use strict';

  const cfg = {
    baseUrl: '/api',
    timeout: 15000,
    retries: 2,                 // extra attempts for GET on network error / 502-504
    retryBase: 500,             // ms, doubles each attempt
    tokenKey: 'esacco_token',
    storage: 'session',         // 'session' | 'local' | 'memory'
    onUnauthorized: null        // () => void, called after a 401 clears the token
  };

  /* ---------- token storage ---------- */
  let memToken = null;
  const store = () => {
    try { return cfg.storage === 'local' ? global.localStorage : cfg.storage === 'session' ? global.sessionStorage : null; }
    catch (e) { return null; }
  };
  const getToken = () => {
    const s = store();
    if (s) { try { return s.getItem(cfg.tokenKey) || memToken; } catch (e) {} }
    return memToken;
  };
  const setToken = t => {
    memToken = t || null;
    const s = store();
    if (s) { try { t ? s.setItem(cfg.tokenKey, t) : s.removeItem(cfg.tokenKey); } catch (e) {} }
  };

  /* ---------- errors ---------- */
  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.name = 'ApiError';
      this.status = status || 0;          // 0 = network / timeout
      this.data = data;
      this.network = !status;
    }
  }

  /* ---------- core request ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const qs = obj => {
    if (!obj) return '';
    const p = new URLSearchParams();
    Object.entries(obj).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.append(k, v); });
    const s = p.toString();
    return s ? '?' + s : '';
  };

  async function request(method, path, opts) {
    opts = opts || {};
    const url = cfg.baseUrl.replace(/\/+$/, '') + path + qs(opts.query);
    const canRetry = method === 'GET' && opts.retry !== false;
    const attempts = canRetry ? cfg.retries + 1 : 1;
    let lastErr;

    for (let i = 0; i < attempts; i++) {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl && setTimeout(() => ctl.abort(), opts.timeout || cfg.timeout);
      try {
        const headers = { Accept: 'application/json' };
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        const t = getToken();
        if (t && !opts.noAuth) headers.Authorization = 'Bearer ' + t;

        const res = await fetch(url, {
          method, headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          credentials: 'same-origin',
          signal: ctl ? ctl.signal : undefined,
          keepalive: !!opts.keepalive
        });

        let data = null;
        if (res.status !== 204) {
          const txt = await res.text();
          if (txt) { try { data = JSON.parse(txt); } catch (e) { data = txt; } }
        }

        if (res.ok) return data;

        if (res.status === 401 && !opts.noAuth) {
          setToken(null);
          if (typeof cfg.onUnauthorized === 'function') { try { cfg.onUnauthorized(); } catch (e) {} }
        }
        const msg = (data && (data.error || data.message)) || res.statusText || 'Request failed';
        const err = new ApiError(msg, res.status, data);
        if (canRetry && [502, 503, 504].includes(res.status) && i < attempts - 1) { lastErr = err; await sleep(cfg.retryBase * 2 ** i); continue; }
        throw err;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        lastErr = new ApiError(e && e.name === 'AbortError' ? 'Request timed out' : 'Network error — server unreachable', 0);
        if (i < attempts - 1) { await sleep(cfg.retryBase * 2 ** i); continue; }
        throw lastErr;
      } finally { if (timer) clearTimeout(timer); }
    }
    throw lastErr;
  }

  const get = (p, query, o) => request('GET', p, { ...(o || {}), query });
  const post = (p, body, o) => request('POST', p, { ...(o || {}), body: body === undefined ? {} : body });
  const put = (p, body, o) => request('PUT', p, { ...(o || {}), body });
  const del = (p, o) => request('DELETE', p, o);

  /* ---------- resource helper ---------- */
  const resource = base => ({
    list: query => get(base, query),
    get: id => get(base + '/' + encodeURIComponent(id)),
    create: body => post(base, body),
    update: (id, body) => put(base + '/' + encodeURIComponent(id), body),
    remove: id => del(base + '/' + encodeURIComponent(id))
  });

  /* ---------- auth ---------- */
  const auth = {
    async login(email, password) {
      const r = await post('/auth/login', { email: String(email || '').trim().toLowerCase(), password }, { noAuth: true });
      if (r && r.token) setToken(r.token);
      return r;
    },
    async logout() {
      try { await post('/auth/logout'); } catch (e) { /* token is cleared regardless */ }
      setToken(null);
    },
    me: () => get('/auth/me'),
    isLoggedIn: () => !!getToken()
  };

  /* ---------- whole-app state (same contract db.js uses) ---------- */
  const state = {
    async get() {
      try { return await get('/state'); }
      catch (e) { if (e.status === 404) return null; throw e; }
    },
    // resolves { ok:true, rev, updatedAt } or { ok:false, conflict:true, server:{state,rev,updatedAt} }
    async put(stateObj, baseRev, updatedAt, force) {
      try {
        const r = await put('/state', { state: stateObj, baseRev: baseRev || 0, updatedAt: updatedAt || new Date().toISOString(), force: !!force });
        return { ok: true, ...(r || {}) };
      } catch (e) {
        if (e.status === 409) return { ok: false, conflict: true, server: e.data };
        throw e;
      }
    }
  };

  /* ---------- audit ---------- */
  const audit = {
    list: query => get('/audit', query),
    log: (act, part) => post('/audit', { act, part }, { keepalive: true })
  };

  /* ---------- public ---------- */
  global.API = {
    configure(o) { Object.assign(cfg, o || {}); return { ...cfg }; },
    config: () => ({ ...cfg }),
    ApiError,
    getToken, setToken,
    request, get, post, put, del,
    health: () => get('/health', null, { retry: false, timeout: 5000 }).then(() => true, () => false),
    auth, state, audit,
    members: resource('/members'),
    nonMembers: resource('/non-members'),
    savings: resource('/savings'),
    loans: {
      ...resource('/loans'),
      repay: (id, payment) => post('/loans/' + encodeURIComponent(id) + '/repayments', payment)
    },
    loanRequests: {
      ...resource('/loan-requests'),
      decide: (id, status, remark) => post('/loan-requests/' + encodeURIComponent(id) + '/decision', { status, remark })
    },
    users: {
      ...resource('/users'),
      resetCredentials: (id, email, password) => post('/users/' + encodeURIComponent(id) + '/reset', { email, password })
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
