'use strict';
/**
 * audit.js — Elite SACCO Mbarara
 * Express routes for the System Auditor (activity log).
 *
 * Mount:
 *   const audit = require('./audit');
 *   app.use('/api/audit', audit({ store, auth }));
 *
 * `store` must provide (sync or async):
 *   getAudit()          -> array of { t (ISO), ini, user, role, act, part }   (oldest first)
 *   addAudit(entry)     -> append one entry
 *
 * `auth` must set req.user = { name, role, ini }.
 *
 * The log is append-only: there are no update or delete routes.
 * Access matches the front end: Admin and Treasurer only.
 * The front end keeps the latest 5000 entries; trimming should be done by the store.
 */
const express = require('express');

const p2 = n => String(n).padStart(2, '0');
const fmtD = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const fmtT = t => { const d = new Date(t); return `${fmtD(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const today = () => fmtD(new Date());
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

const MAX_PAGE = 500;
const CSV_HEAD = ['#', 'Date & time', 'Initials', 'User', 'Role', 'Activity', 'Particulars'];

// Numbered oldest-first (stable ids), returned newest-first like the screen.
function numbered(log) {
  return log.map((x, i) => ({ ...x, n: i + 1 })).reverse();
}

function applyFilters(rows, q) {
  const user = String(q.user || ''), act = String(q.activity || ''), search = String(q.q || '').trim().toLowerCase();
  const from = q.from, to = q.to;
  if (from && !isDate(from)) throw httpErr(400, 'from must be YYYY-MM-DD');
  if (to && !isDate(to)) throw httpErr(400, 'to must be YYYY-MM-DD');
  if (from && to && from > to) throw httpErr(400, 'from cannot be after to');
  return rows.filter(x => {
    const dt = fmtD(new Date(x.t));
    return (!user || x.user === user) && (!act || x.act === act) && (!from || dt >= from) && (!to || dt <= to) &&
      (!search || `${x.part} ${x.act} ${x.user} ${x.ini}`.toLowerCase().includes(search));
  });
}

const toRow = x => [x.n, fmtT(x.t), x.ini, x.user, x.role, x.act, x.part];
const csvOf = aoa => '\ufeff' + aoa.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

module.exports = function createAuditRouter({ store, auth }) {
  if (!store) throw new Error('audit: a store is required');
  const router = express.Router();
  if (auth) router.use(auth);
  router.use((req, res, next) => req.user ? next() : res.status(401).json({ error: 'Not authenticated' }));
  router.use((req, res, next) =>
    ['Admin', 'Treasurer'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Your role does not have access to the audit log' }));

  const record = (req, act, part) => Promise.resolve(store.addAudit({
    t: new Date().toISOString(), ini: req.user.ini || '', user: req.user.name, role: req.user.role, act, part
  })).catch(() => {});
  const load = async () => numbered(await store.getAudit() || []);

  // GET /  ?user=&activity=&from=YYYY-MM-DD&to=YYYY-MM-DD&q=&page=1&limit=100
  router.get('/', wrap(async (req, res) => {
    const all = await load(), rows = applyFilters(all, req.query);
    const limit = Math.min(MAX_PAGE, Math.max(1, +req.query.limit || 100));
    const pages = Math.max(1, Math.ceil(rows.length / limit));
    const page = Math.min(pages, Math.max(1, +req.query.page || 1));
    res.json({
      total: all.length, matched: rows.length, page, pages, limit,
      entries: rows.slice((page - 1) * limit, page * limit).map(x => ({ ...x, time: fmtT(x.t) }))
    });
  }));

  // GET /filters  -> values for the User and Activity dropdowns
  router.get('/filters', wrap(async (req, res) => {
    const all = await load();
    res.json({
      users: [...new Set(all.map(x => x.user))].sort(),
      activities: [...new Set(all.map(x => x.act))].sort()
    });
  }));

  // GET /export?format=csv|json  (same filters; exports ALL matches, not just a page)
  router.get('/export', wrap(async (req, res) => {
    const rows = applyFilters(await load(), req.query), fmt = String(req.query.format || 'csv').toLowerCase();
    if (!['csv', 'json'].includes(fmt)) throw httpErr(400, 'format must be csv or json');
    await record(req, 'Audit log exported', `Exported ${rows.length} audit entries to ${fmt.toUpperCase()}`);
    if (fmt === 'json') return res.json({ count: rows.length, entries: rows });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="elite-sacco-audit-${today()}.csv"` })
      .send(csvOf([CSV_HEAD, ...rows.map(toRow)]));
  }));

  // POST /print  -> records that the log was printed (printing itself happens in the browser)
  router.post('/print', express.json(), wrap(async (req, res) => {
    const n = Math.max(0, parseInt(req.body && req.body.count, 10) || 0);
    await record(req, 'Audit log printed', `Printed ${n} audit entries`);
    res.status(204).end();
  }));

  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    if (status >= 500) console.error('[audit]', err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return router;
};

module.exports._internal = { numbered, applyFilters };
