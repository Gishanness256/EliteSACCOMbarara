'use strict';
/**
 * members.js — Express routes for SACCO Member endpoints (Elite SACCO Mbarara).
 *
 * Mount:   app.use(express.json({ limit: '3mb' }));       // photos are base64 data URLs
 *          app.use('/api/members', authenticate, require('./members')());
 *
 * `authenticate` must set req.user = { name, email, role } (role: Admin | Treasurer |
 * Credit Supervisor | Credit Officer). Writes need the "Create/remove member accounts"
 * permission, which only Admin holds by default.
 *
 * Endpoints
 *   GET    /            list members (?q=search&page=1&limit=50)
 *   GET    /:acc        one member
 *   POST   /            create member (account number is generated)
 *   PUT    /:acc        update member (account number and gender never change)
 *   DELETE /:acc        remove member (refused while the member has savings/loan activity)
 *
 * Member shape (matches the front end):
 *   { acc: 'ES-F 000001', first, last, dob: 'YYYY-MM-DD', addr, nin, tel, email, photo }
 * Gender is encoded in the account number (ES-F / ES-M).
 */

const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const GENDERS = ['F', 'M'];
const WRITE_ROLES = ['Admin']; // default; override with options.writeRoles
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/* ---------- default store: JSON file, serialised writes ---------- */
function createFileStore(file = path.join(__dirname, 'data', 'members.json')) {
  let cache = null;
  let queue = Promise.resolve();

  const load = async () => {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      cache = { seq: 0, members: [] };
    }
    return cache;
  };
  const persist = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
    await fs.rename(tmp, file); // atomic replace
  };
  // run fn(data) exclusively; persists afterwards
  const tx = fn => {
    const run = queue.then(async () => {
      const data = await load();
      const out = await fn(data);
      await persist();
      return out;
    });
    queue = run.catch(() => {});
    return run;
  };

  return {
    read: async fn => fn(await load()),
    write: tx,
    // Savings/loans live elsewhere — replace with a real check when those modules exist.
    hasActivity: async () => false,
  };
}

/* ---------- validation ---------- */
const str = v => (typeof v === 'string' ? v.trim() : '');

function validate(body, { partial = false, creating = false } = {}) {
  const errors = {};
  const out = {};
  const need = (k, label) => {
    const has = body[k] !== undefined;
    if (!has && !partial) errors[k] = `${label} is required.`;
    return has;
  };

  if (need('first', 'First name')) {
    out.first = str(body.first);
    if (!out.first) errors.first = 'First name is required.';
  }
  if (need('last', 'Last name')) {
    out.last = str(body.last);
    if (!out.last) errors.last = 'Last name is required.';
  }
  if (need('dob', 'Date of birth')) {
    out.dob = str(body.dob);
    const d = new Date(out.dob);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.dob) || isNaN(d) || d > new Date())
      errors.dob = 'Date of birth must be a valid past date (YYYY-MM-DD).';
  }
  if (need('addr', 'Address')) {
    out.addr = str(body.addr);
    if (!out.addr) errors.addr = 'Address is required.';
  }
  if (need('nin', 'NIN')) {
    out.nin = str(body.nin).toUpperCase();
    if (!/^[A-Z0-9]{14}$/.test(out.nin)) errors.nin = 'NIN must be 14 letters/digits.';
  }
  if (need('tel', 'Telephone')) {
    out.tel = str(body.tel);
    if (!/^\+?[0-9 ()-]{7,20}$/.test(out.tel)) errors.tel = 'Enter a valid telephone number.';
  }
  if (body.email !== undefined) {
    out.email = str(body.email);
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) errors.email = 'Enter a valid email address.';
  }
  if (body.photo !== undefined) {
    out.photo = typeof body.photo === 'string' ? body.photo : '';
    if (out.photo) {
      const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(out.photo);
      if (!m) errors.photo = 'Photo must be a base64 PNG, JPEG, WebP or GIF data URL.';
      else if (Math.floor((m[2].length * 3) / 4) > MAX_PHOTO_BYTES) errors.photo = 'Photo must be 2 MB or smaller.';
    }
  }
  if (creating) {
    out.gender = str(body.gender).toUpperCase();
    if (!GENDERS.includes(out.gender)) errors.gender = 'Gender must be F or M.';
  }
  return { out, errors };
}

/* ---------- router factory ---------- */
module.exports = function createMembersRouter(options = {}) {
  const store = options.store || createFileStore(options.file);
  const writeRoles = options.writeRoles || WRITE_ROLES;
  const audit = options.audit || (() => {}); // audit(req.user, action, details)

  const router = express.Router();

  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const fail = (res, status, error, details) => res.status(status).json({ error, ...(details && { details }) });

  const requireUser = (req, res, next) =>
    req.user ? next() : fail(res, 401, 'Authentication required.');
  const requireWrite = (req, res, next) =>
    writeRoles.includes(req.user.role)
      ? next()
      : fail(res, 403, 'You do not have permission to create or remove member accounts.');

  router.use(requireUser);

  // accounts look like "ES-F 000001" — decode the URL segment and normalise spacing
  const accParam = req => decodeURIComponent(req.params.acc).replace(/\s+/g, ' ').trim().toUpperCase();

  /* LIST */
  router.get('/', wrap(async (req, res) => {
    const q = str(req.query.q).toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const { total, items } = await store.read(d => {
      const all = q
        ? d.members.filter(m => `${m.first} ${m.last} ${m.acc} ${m.tel} ${m.nin}`.toLowerCase().includes(q))
        : d.members;
      return { total: all.length, items: all.slice((page - 1) * limit, page * limit) };
    });
    res.json({ total, page, limit, members: items });
  }));

  /* READ */
  router.get('/:acc', wrap(async (req, res) => {
    const acc = accParam(req);
    const m = await store.read(d => d.members.find(x => x.acc === acc));
    if (!m) return fail(res, 404, 'Member not found.');
    res.json(m);
  }));

  /* CREATE */
  router.post('/', requireWrite, wrap(async (req, res) => {
    const { out, errors } = validate(req.body || {}, { creating: true });
    if (Object.keys(errors).length) return fail(res, 400, 'Validation failed.', errors);

    const result = await store.write(d => {
      if (d.members.some(m => m.nin === out.nin)) return { conflict: 'A member with this NIN already exists.' };
      d.seq += 1;
      const { gender, ...fields } = out;
      const member = {
        acc: `ES-${gender} ${String(d.seq).padStart(6, '0')}`,
        email: '',
        photo: '',
        ...fields,
        createdAt: new Date().toISOString(),
      };
      d.members.push(member);
      return { member };
    });
    if (result.conflict) return fail(res, 409, result.conflict);

    const m = result.member;
    audit(req.user, 'Member created', `Registered member ${m.acc} — ${m.first} ${m.last}`);
    res.status(201).location(`${req.baseUrl}/${encodeURIComponent(m.acc)}`).json(m);
  }));

  /* UPDATE */
  router.put('/:acc', requireWrite, wrap(async (req, res) => {
    const acc = accParam(req);
    const { out, errors } = validate(req.body || {}, { partial: true });
    if (Object.keys(errors).length) return fail(res, 400, 'Validation failed.', errors);

    const result = await store.write(d => {
      const m = d.members.find(x => x.acc === acc);
      if (!m) return { missing: true };
      if (out.nin && d.members.some(x => x.nin === out.nin && x.acc !== acc))
        return { conflict: 'A member with this NIN already exists.' };
      Object.assign(m, out, { updatedAt: new Date().toISOString() });
      return { member: m };
    });
    if (result.missing) return fail(res, 404, 'Member not found.');
    if (result.conflict) return fail(res, 409, result.conflict);

    const m = result.member;
    audit(req.user, 'Member updated', `Updated member ${m.acc} — ${m.first} ${m.last}`);
    res.json(m);
  }));

  /* DELETE */
  router.delete('/:acc', requireWrite, wrap(async (req, res) => {
    const acc = accParam(req);
    if (await store.hasActivity(acc))
      return fail(res, 409, 'This member has savings or loan records and cannot be removed.');

    const removed = await store.write(d => {
      const i = d.members.findIndex(x => x.acc === acc);
      return i < 0 ? null : d.members.splice(i, 1)[0];
    });
    if (!removed) return fail(res, 404, 'Member not found.');

    audit(req.user, 'Member removed', `Removed member ${removed.acc} — ${removed.first} ${removed.last}`);
    res.status(204).end();
  }));

  // JSON error handler for this router
  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[members]', err);
    fail(res, 500, 'Internal server error.');
  });

  return router;
};

module.exports.createFileStore = createFileStore;
