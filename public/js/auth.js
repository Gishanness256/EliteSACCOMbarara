/*!
 * auth.js — Elite SACCO Mbarara
 * Login sessions, roles and permission checks.
 *
 * Works with the data model already used in index.html:
 *   state.users = [{ name, email, role, ini, pw|hash, mustChange?, disabled? }]
 *   state.roles = { 'Admin': [bool x 9], 'Treasurer': [...], ... }  (indexed by PERMS)
 *
 * Usage (browser):
 *   <script src="auth.js"></script>
 *   Auth.init({ getState: () => S, save, audit });
 *   const r = await Auth.login(handle, password);
 *
 * NOTE: this is client-side access control. It protects the UI and hashes
 * stored passwords, but anyone with browser dev-tools can edit localStorage.
 * Real security needs the same checks enforced on a server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.Auth = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Configuration
   * ------------------------------------------------------------------ */
  const cfg = {
    domain: '@elitesacco.co.ug',
    sessionKey: 'esacco_session',
    lockKey: 'esacco_auth_lock',
    idleMs: 15 * 60 * 1000,          // sign out after 15 min of inactivity
    maxAgeMs: 8 * 60 * 60 * 1000,    // hard limit of 8 h per session
    maxAttempts: 5,                  // failed attempts before lockout
    lockMs: 5 * 60 * 1000,           // lockout length
    minPassword: 6,
    iterations: 150000,              // PBKDF2 rounds
    seedAdminPassword: 'Admin',      // legacy default for the seeded admin
    menuSelector: '#side [data-v]',
    now: () => Date.now()
  };

  /* ------------------------------------------------------------------ *
   * Roles, permissions and view rules (mirror index.html)
   * ------------------------------------------------------------------ */
  let PERMS = [
    'Approve loans',
    'Acknowledge savings/deposits',
    'Acknowledge loan repayments',
    'Set interest rates',
    'Create/remove system users',
    'Create/remove member accounts',
    'Weekly reports',
    'Monthly reports',
    'Annual reports'
  ];
  const PERM = {
    APPROVE_LOANS: 0,
    ACK_SAVINGS: 1,
    ACK_REPAYMENTS: 2,
    SET_RATES: 3,
    MANAGE_USERS: 4,
    MANAGE_MEMBERS: 5,
    REPORT_WEEKLY: 6,
    REPORT_MONTHLY: 7,
    REPORT_ANNUAL: 8
  };
  let ROLES = ['Admin', 'Treasurer', 'Credit Supervisor', 'Credit Officer'];

  // Views restricted to certain roles. Any view not listed is open to every
  // signed-in user. A rule may use { roles: [...] } and/or { perm: 'KEY' }.
  const VIEW_RULES = {
    lreq: { roles: ['Admin', 'Credit Officer', 'Credit Supervisor'] },
    lsec: { roles: ['Admin', 'Credit Officer', 'Credit Supervisor'] },
    lapp: { roles: ['Admin'] },
    audit: { roles: ['Admin', 'Treasurer'] },
    users: { perm: 'MANAGE_USERS' },
    access: { roles: ['Admin'] }
  };

  /* ------------------------------------------------------------------ *
   * Hooks into the host app
   * ------------------------------------------------------------------ */
  const hooks = {
    getState: () => ({ users: [], roles: {} }),
    save: () => {},
    audit: () => {}
  };
  const listeners = { login: [], logout: [], expire: [], denied: [] };
  const on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  const emit = (ev, data) => (listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { /* ignore */ } });

  /* ------------------------------------------------------------------ *
   * Storage (falls back to memory when blocked)
   * ------------------------------------------------------------------ */
  function memStore() {
    const m = {};
    return {
      getItem: k => (k in m ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      removeItem: k => { delete m[k]; }
    };
  }
  function pick(name) {
    try {
      const s = root[name];
      if (s) { s.setItem('__t', '1'); s.removeItem('__t'); return s; }
    } catch (e) { /* blocked */ }
    return memStore();
  }
  let sessionStore = pick('sessionStorage');
  let localStore = pick('localStorage');
  const readJSON = (st, k) => { try { return JSON.parse(st.getItem(k)); } catch (e) { return null; } };
  const writeJSON = (st, k, v) => { try { st.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

  /* ------------------------------------------------------------------ *
   * Password hashing (PBKDF2-SHA256 via Web Crypto)
   * ------------------------------------------------------------------ */
  const C = root.crypto || (typeof require === 'function' ? require('crypto').webcrypto : null);
  const subtle = C && C.subtle;
  const enc = new TextEncoder();

  const toB64 = bytes => btoa(String.fromCharCode.apply(null, Array.from(bytes)));
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const randomBytes = n => C.getRandomValues(new Uint8Array(n));
  const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

  function needCrypto() {
    if (!subtle) throw new Error('Secure password storage needs a secure context (https or localhost).');
  }
  async function derive(password, salt, iterations) {
    const key = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
    return new Uint8Array(bits);
  }
  function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }
  async function hashPassword(password) {
    needCrypto();
    const salt = randomBytes(16);
    const out = await derive(password, salt, cfg.iterations);
    return 'pbkdf2$' + cfg.iterations + '$' + toB64(salt) + '$' + toB64(out);
  }
  async function verifyHash(password, stored) {
    needCrypto();
    const p = String(stored || '').split('$');
    if (p[0] !== 'pbkdf2' || p.length !== 4) return false;
    const out = await derive(password, fromB64(p[2]), parseInt(p[1], 10));
    return safeEqual(out, fromB64(p[3]));
  }
  const safeEqualStr = (a, b) => safeEqual(enc.encode(String(a)), enc.encode(String(b)));

  /* ------------------------------------------------------------------ *
   * Users
   * ------------------------------------------------------------------ */
  const state = () => hooks.getState() || {};
  const users = () => state().users || [];
  const now = () => cfg.now();

  function normalizeId(id) {
    id = String(id || '').trim().toLowerCase();
    if (!id) return '';
    return id.indexOf('@') === -1 ? id + cfg.domain : id;
  }
  const findUser = id => {
    const h = normalizeId(id);
    return users().find(u => String(u.email || '').toLowerCase() === h) || null;
  };
  const initials = u =>
    u.ini || String(u.name || '').split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 3);
  const publicUser = u => (u ? { name: u.name, email: u.email, role: u.role, ini: initials(u) } : null);
  const validHandle = h => /^[a-z0-9._-]+$/i.test(h);

  function passwordProblem(pw, handle) {
    if (!pw || pw.length < cfg.minPassword) return 'Password must be at least ' + cfg.minPassword + ' characters.';
    if (handle && pw.toLowerCase() === String(handle).toLowerCase()) return 'Password must not match the login handle.';
    return '';
  }

  // Checks a password against a user, upgrading legacy plaintext to a hash.
  async function verifyCredentials(u, password) {
    if (u.hash) return verifyHash(password, u.hash);

    if (u.pw) { // legacy plaintext record
      if (!safeEqualStr(u.pw, password)) return false;
      u.hash = await hashPassword(password);
      delete u.pw;
      hooks.save();
      return true;
    }

    // Seeded admin with no password stored yet (first run)
    if (u.role === 'Admin' && safeEqualStr(cfg.seedAdminPassword, password)) {
      u.hash = await hashPassword(password);
      u.mustChange = true;
      hooks.save();
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Lockout (per login handle, persisted so a refresh does not reset it)
   * ------------------------------------------------------------------ */
  function lockRemaining(handle) {
    const all = readJSON(localStore, cfg.lockKey) || {};
    const r = all[handle];
    return r && r.until > now() ? r.until - now() : 0;
  }
  function recordFailure(handle) {
    const all = readJSON(localStore, cfg.lockKey) || {};
    const r = all[handle] || { count: 0, until: 0 };
    r.count += 1;
    if (r.count >= cfg.maxAttempts) { r.until = now() + cfg.lockMs; r.count = 0; }
    all[handle] = r;
    writeJSON(localStore, cfg.lockKey, all);
  }
  function clearFailures(handle) {
    const all = readJSON(localStore, cfg.lockKey) || {};
    if (all[handle]) { delete all[handle]; writeJSON(localStore, cfg.lockKey, all); }
  }
  const minutes = ms => Math.max(1, Math.ceil(ms / 60000));

  /* ------------------------------------------------------------------ *
   * Session
   * ------------------------------------------------------------------ */
  let sess = null;
  let idleTimer = null;
  let lastWrite = 0;
  let listening = false;

  const persistSession = () => { if (sess) writeJSON(sessionStore, cfg.sessionKey, sess); };

  function sessionExpired(s) {
    const t = now();
    return t - s.lastActive > cfg.idleMs || t - s.loginAt > cfg.maxAgeMs;
  }
  function startSession(u) {
    const t = now();
    sess = { id: toHex(randomBytes(16)), email: String(u.email).toLowerCase(), loginAt: t, lastActive: t };
    persistSession();
    watchActivity();
  }
  function touch() {
    if (!sess) return;
    const t = now();
    sess.lastActive = t;
    if (t - lastWrite > 10000) { lastWrite = t; persistSession(); }
  }
  function watchActivity() {
    clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (sess && sessionExpired(sess)) { logout('expired'); }
    }, 15000);
    if (idleTimer && idleTimer.unref) idleTimer.unref();

    const doc = root.document;
    if (!listening && doc && doc.addEventListener) {
      ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(ev =>
        doc.addEventListener(ev, touch, { passive: true, capture: true }));
      listening = true;
    }
  }

  const currentUser = () => {
    if (!sess) return null;
    const u = findUser(sess.email);
    if (!u || u.disabled) { logout('revoked'); return null; }
    return u;
  };
  const isAuthenticated = () => {
    if (!sess) return false;
    if (sessionExpired(sess)) { logout('expired'); return false; }
    return !!currentUser();
  };

  // Re-open a session that survived a page refresh (same tab).
  function restore() {
    const s = readJSON(sessionStore, cfg.sessionKey);
    if (!s || sessionExpired(s)) { sessionStore.removeItem(cfg.sessionKey); return null; }
    const u = findUser(s.email);
    if (!u || u.disabled) { sessionStore.removeItem(cfg.sessionKey); return null; }
    sess = s;
    touch();
    watchActivity();
    emit('login', { user: publicUser(u), restored: true });
    return publicUser(u);
  }

  async function login(id, password) {
    const handle = normalizeId(id);
    if (!handle || !password) {
      return { ok: false, reason: 'missing', message: 'Enter your login handle and password.' };
    }

    const wait = lockRemaining(handle);
    if (wait) {
      return {
        ok: false, reason: 'locked', retryAfterMs: wait,
        message: 'Too many failed attempts. Try again in ' + minutes(wait) + ' minute(s).'
      };
    }

    let u = findUser(handle), ok = false;
    try {
      if (u && !u.disabled) ok = await verifyCredentials(u, password);
      else await hashPassword(password); // keep timing similar for unknown users
    } catch (e) {
      return { ok: false, reason: 'error', message: e.message };
    }

    if (!ok) {
      recordFailure(handle);
      hooks.audit('Failed login', 'Failed sign-in attempt for "' + (String(id).trim().toLowerCase() || 'unknown') + '"',
        { name: handle || 'unknown', role: '—', ini: '—' });
      const left = lockRemaining(handle);
      return {
        ok: false, reason: left ? 'locked' : 'invalid', retryAfterMs: left,
        message: left
          ? 'Too many failed attempts. Try again in ' + minutes(left) + ' minute(s).'
          : 'Invalid email or password.'
      };
    }

    clearFailures(handle);
    startSession(u);
    hooks.audit('Login', 'Signed in successfully', u);
    const pu = publicUser(u);
    emit('login', { user: pu, restored: false });
    return { ok: true, user: pu, mustChangePassword: !!u.mustChange };
  }

  function logout(reason) {
    reason = reason || 'manual';
    const u = sess ? findUser(sess.email) : null;
    if (u) {
      hooks.audit(
        reason === 'expired' ? 'Session expired' : 'Logout',
        reason === 'expired' ? 'Signed out after inactivity' : reason === 'revoked' ? 'Session revoked' : 'Signed out',
        u
      );
    }
    sess = null;
    clearInterval(idleTimer);
    idleTimer = null;
    sessionStore.removeItem(cfg.sessionKey);
    emit(reason === 'expired' ? 'expire' : 'logout', { reason });
    if (reason === 'expired') emit('logout', { reason });
  }

  const needsPasswordChange = () => {
    const u = currentUser();
    return !!(u && u.mustChange);
  };
  const sessionInfo = () => {
    if (!sess) return null;
    return {
      loginAt: sess.loginAt,
      lastActive: sess.lastActive,
      idleExpiresAt: sess.lastActive + cfg.idleMs,
      hardExpiresAt: sess.loginAt + cfg.maxAgeMs
    };
  };

  /* ------------------------------------------------------------------ *
   * Roles & permissions
   * ------------------------------------------------------------------ */
  const isAdmin = user => { const u = user || currentUser(); return !!u && u.role === 'Admin'; };
  const hasRole = (...roles) => {
    const u = currentUser();
    return !!u && roles.flat().includes(u.role);
  };
  function permIndex(p) {
    if (typeof p === 'number') return p;
    if (p in PERM) return PERM[p];
    return PERMS.indexOf(p);
  }
  // can('APPROVE_LOANS') | can(0) | can('Approve loans')
  function can(perm, user) {
    const u = user || currentUser();
    if (!u) return false;
    if (u.role === 'Admin') return true;
    const idx = permIndex(perm);
    if (idx < 0) return false;
    const row = (state().roles || {})[u.role];
    return !!(row && row[idx]);
  }
  const canAny = (...perms) => perms.flat().some(p => can(p));
  const canAll = (...perms) => perms.flat().every(p => can(p));

  function canView(view, user) {
    const u = user || currentUser();
    if (!u) return false;
    const rule = VIEW_RULES[view];
    if (!rule) return true;
    if (rule.roles && !rule.roles.includes(u.role)) return false;
    if (rule.perm && !can(rule.perm, u)) return false;
    return true;
  }

  function deny(what, detail) {
    const u = currentUser();
    hooks.audit('Access denied', 'Blocked: ' + what + (detail ? ' — ' + detail : ''), u || undefined);
    emit('denied', { what, user: publicUser(u) });
  }
  function authError(message, code) {
    const e = new Error(message);
    e.name = 'AuthError';
    e.code = code;
    return e;
  }
  // Throws unless the signed-in user holds the permission(s).
  function requirePermission(...perms) {
    if (!isAuthenticated()) throw authError('Please sign in.', 'UNAUTHENTICATED');
    const list = perms.flat();
    if (!list.every(p => can(p))) {
      deny('permission', list.join(', '));
      throw authError('You do not have permission to do this.', 'FORBIDDEN');
    }
    return true;
  }
  function requireRole(...roles) {
    if (!isAuthenticated()) throw authError('Please sign in.', 'UNAUTHENTICATED');
    if (!hasRole(...roles)) {
      deny('role', roles.flat().join(', '));
      throw authError('You do not have permission to do this.', 'FORBIDDEN');
    }
    return true;
  }
  // Wrap a handler so it only runs for users holding the permission.
  // Returns undefined (and fires 'denied') otherwise.
  function guard(perm, fn) {
    return function () {
      try { requirePermission(perm); } catch (e) { return undefined; }
      return fn.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------------ *
   * DOM helpers
   *   data-v="view"         menu items hidden when canView() is false
   *   data-perm="KEY,KEY"   hidden (or disabled) unless user holds all perms
   *   data-role="A,B"       hidden (or disabled) unless user has one role
   *   data-perm-mode="disable"  disables instead of hiding
   * ------------------------------------------------------------------ */
  function setAccess(el, allowed) {
    const mode = el.getAttribute('data-perm-mode');
    if (mode === 'disable') {
      el.disabled = !allowed;
      el.style.opacity = allowed ? '' : '.5';
    } else {
      el.style.display = allowed ? '' : 'none';
    }
  }
  function applyDom(scope) {
    const doc = root.document;
    if (!doc) return;
    scope = scope || doc;

    scope.querySelectorAll(cfg.menuSelector).forEach(el => {
      el.style.display = canView(el.getAttribute('data-v')) ? '' : 'none';
    });
    // hide a group button when all of its sub-items are hidden
    scope.querySelectorAll('[data-sub]').forEach(btn => {
      const grp = doc.getElementById(btn.getAttribute('data-sub'));
      if (!grp) return;
      const items = Array.from(grp.querySelectorAll('[data-v]'));
      const any = items.some(b => b.style.display !== 'none');
      btn.style.display = any ? '' : 'none';
      if (!any) grp.classList.remove('show');
    });
    scope.querySelectorAll('[data-perm]').forEach(el => {
      const need = el.getAttribute('data-perm').split(',').map(s => s.trim()).filter(Boolean);
      setAccess(el, need.every(p => can(p)));
    });
    scope.querySelectorAll('[data-role]').forEach(el => {
      const roles = el.getAttribute('data-role').split(',').map(s => s.trim()).filter(Boolean);
      setAccess(el, hasRole(roles));
    });
  }

  /* ------------------------------------------------------------------ *
   * Credential management (hashes passwords; permission-checked)
   * ------------------------------------------------------------------ */
  const ok = (message, extra) => Object.assign({ ok: true, message }, extra);
  const fail = message => ({ ok: false, message });

  async function createUser({ name, handle, role, initials: ini, password }) {
    requirePermission('MANAGE_USERS');
    handle = String(handle || '').trim().toLowerCase();
    name = String(name || '').trim();
    if (!name || !handle || !password) return fail('Name, login handle and password are required.');
    if (!validHandle(handle)) return fail('Login handle may contain only letters, numbers, dots, hyphens and underscores.');
    if (ROLES.indexOf(role) === -1) return fail('Choose a valid role.');
    const p = passwordProblem(password, handle);
    if (p) return fail(p);
    const email = handle + cfg.domain;
    if (findUser(email)) return fail('That login handle is already in use.');

    const u = {
      name, email, role,
      ini: String(ini || '').trim().toUpperCase() || initials({ name }),
      hash: await hashPassword(password),
      mustChange: true // temporary password: user must choose their own
    };
    users().push(u);
    hooks.save();
    hooks.audit('User created', 'Created system user ' + name + ' (' + role + ', ' + email + ')');
    return ok('User created. Login handle: ' + email, { user: publicUser(u) });
  }

  async function resetCredentials(target, { handle, password } = {}) {
    requirePermission('MANAGE_USERS');
    const u = typeof target === 'number' ? users()[target] : findUser(target);
    if (!u) return fail('Select a user.');
    handle = String(handle || '').trim().toLowerCase() || String(u.email).split('@')[0];
    if (!validHandle(handle)) return fail('Login handle may contain only letters, numbers, dots, hyphens and underscores.');
    const p = passwordProblem(password, handle);
    if (p) return fail(p);
    const email = handle + cfg.domain;
    const clash = findUser(email);
    if (clash && clash !== u) return fail('That login handle is already in use.');

    const old = u.email;
    u.email = email;
    u.hash = await hashPassword(password);
    delete u.pw;
    u.mustChange = true;
    if (sess && sess.email === String(old).toLowerCase()) { sess.email = email.toLowerCase(); persistSession(); }
    clearFailures(normalizeId(old));
    hooks.save();
    hooks.audit('Credentials reset',
      'Reset login credentials for ' + u.name + ' (' + (old === email ? email : old + ' → ' + email) + ')');
    return ok('Credentials reset for ' + u.name + '. New login handle: ' + email);
  }

  function removeUser(target) {
    requirePermission('MANAGE_USERS');
    const list = users();
    const u = typeof target === 'number' ? list[target] : findUser(target);
    if (!u) return fail('User not found.');
    if (sess && String(u.email).toLowerCase() === sess.email) return fail('You cannot remove your own account while signed in.');
    if (u.role === 'Admin' && list.filter(x => x.role === 'Admin').length < 2) {
      return fail('The last Admin account cannot be removed.');
    }
    list.splice(list.indexOf(u), 1);
    hooks.save();
    hooks.audit('User removed', 'Removed system user ' + u.name + ' (' + u.email + ')');
    return ok('User removed.');
  }

  async function changePassword(current, next) {
    const u = currentUser();
    if (!u) return fail('Please sign in.');
    let good;
    try { good = await verifyCredentials(u, current); } catch (e) { return fail(e.message); }
    if (!good) return fail('Current password is incorrect.');
    const p = passwordProblem(next, String(u.email).split('@')[0]);
    if (p) return fail(p);
    if (safeEqualStr(current, next)) return fail('Choose a password different from the current one.');
    u.hash = await hashPassword(next);
    delete u.pw;
    u.mustChange = false;
    hooks.save();
    hooks.audit('Password changed', 'Changed own password', u);
    return ok('Password changed.');
  }

  /* ------------------------------------------------------------------ *
   * Setup
   * ------------------------------------------------------------------ */
  function configure(opts) {
    opts = opts || {};
    ['getState', 'save', 'audit'].forEach(k => { if (typeof opts[k] === 'function') hooks[k] = opts[k]; });
    if (opts.sessionStore) sessionStore = opts.sessionStore;
    if (opts.localStore) localStore = opts.localStore;
    if (Array.isArray(opts.perms)) PERMS = opts.perms.slice();
    if (Array.isArray(opts.roles)) ROLES = opts.roles.slice();
    if (opts.viewRules) Object.assign(VIEW_RULES, opts.viewRules);
    Object.keys(cfg).forEach(k => { if (k in opts && typeof opts[k] === typeof cfg[k]) cfg[k] = opts[k]; });
    return api;
  }
  // init() configures and restores any session that survived a refresh.
  function init(opts) {
    configure(opts);
    return restore();
  }

  const api = {
    init, configure, on,
    // session
    login, logout, restore, isAuthenticated, currentUser: () => publicUser(currentUser()),
    sessionInfo, needsPasswordChange,
    // checks
    can, canAny, canAll, hasRole, isAdmin, canView,
    requirePermission, requireRole, guard, applyDom,
    // credentials
    createUser, resetCredentials, removeUser, changePassword, hashPassword,
    // constants
    get PERMS() { return PERMS.slice(); },
    get ROLES() { return ROLES.slice(); },
    PERM, VIEW_RULES
  };
  return api;
});
