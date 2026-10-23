/**
 * savings.js — Savings routes for Elite SACCO Mbarara
 *
 * Mount in your Express app:
 *   const savings = require('./savings');
 *   app.use('/api/savings', requireAuth, savings(db));
 *
 * Expectations:
 *  - `requireAuth` sets req.user = { name, role, ini }
 *  - `db` implements the small async interface documented below (adapt to
 *    your database; a JSON-file implementation is exported for quick testing).
 *
 * db interface:
 *   db.getMember(acc)                     -> member | null
 *   db.listMembers()                      -> member[]
 *   db.listSavings({ acc })               -> saving[]   (all if acc omitted)
 *   db.nextSavingsSeq()                   -> number     (atomic increment)
 *   db.insertSavings(rows)                -> void
 *   db.audit({ act, part, user })         -> void
 *
 * Saving record:
 *   { ref, acc, amt, date (ISO), w (true = withdrawal), ch, slip, rm, ini }
 */
'use strict';

const express = require('express');

const CHANNELS = ['Counter / Cash', 'Mobile money', 'Bank transfer', 'Salary deduction', 'Agent'];
// Roles holding the "Acknowledge savings/deposits" permission (matches the UI defaults).
const RECORD_ROLES = ['Admin', 'Treasurer', 'Credit Officer'];

const n0 = (x) => Math.round(x).toLocaleString('en-US');
const refOf = (seq) => 'SV-' + String(seq).padStart(6, '0');
const signed = (s) => (s.w ? -s.amt : s.amt);
const balanceOf = (rows) => rows.reduce((t, s) => t + signed(s), 0);

function parseAmount(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function parseDate(v) {
  const d = v ? new Date(v) : new Date();
  return isNaN(d) ? null : d;
}

function parseType(v) {
  const t = String(v ?? 'deposit').trim().toLowerCase();
  if (t === 'd' || t.startsWith('dep')) return false;
  if (t === 'w' || t.startsWith('with')) return true;
  return null;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireRecorder(req, res, next) {
  if (!req.user || !RECORD_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have permission to record savings transactions.' });
  }
  next();
}

module.exports = function savingsRoutes(db) {
  const router = express.Router();
  router.use(express.json({ limit: '5mb' }));

  /**
   * Validate and build a savings row. Returns { row } or { error }.
   * `running` optionally holds in-flight balances (for bulk imports).
   */
  async function buildRow(input, user, ref, running) {
    const acc = String(input.acc ?? input.account ?? '').trim();
    const member = acc ? await db.getMember(acc) : null;
    if (!member) return { error: 'Unknown member account.' };

    const amt = parseAmount(input.amount ?? input.amt);
    if (!(amt > 0)) return { error: 'Amount must be a positive number.' };

    const w = parseType(input.type);
    if (w === null) return { error: 'Type must be Deposit or Withdrawal.' };

    const date = parseDate(input.date);
    if (!date) return { error: 'Invalid date.' };
    if (date.getTime() > Date.now() + 5 * 60 * 1000) return { error: 'Date cannot be in the future.' };

    if (w) {
      const bal = running && acc in running ? running[acc] : balanceOf(await db.listSavings({ acc }));
      if (amt > bal) return { error: `Withdrawal exceeds savings balance (UGX ${n0(bal)}).` };
    }

    if (running) running[acc] = (acc in running ? running[acc] : balanceOf(await db.listSavings({ acc }))) + (w ? -amt : amt);

    return {
      row: {
        ref,
        acc,
        amt,
        date: date.toISOString(),
        w,
        ch: String(input.channel ?? input.ch ?? '').trim() || 'Counter / Cash',
        slip: String(input.slip ?? '').trim(),
        rm: String(input.remarks ?? input.rm ?? '').trim(),
        ini: user.ini || '',
      },
      member,
    };
  }

  // GET /api/savings?acc=&type=&from=&to=&q=&limit=&offset=
  router.get('/', wrap(async (req, res) => {
    const { acc, type, from, to, q } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let rows = await db.listSavings(acc ? { acc: String(acc) } : {});
    if (type) {
      const w = parseType(type);
      if (w !== null) rows = rows.filter((r) => r.w === w);
    }
    if (from) rows = rows.filter((r) => new Date(r.date) >= new Date(from));
    if (to) rows = rows.filter((r) => new Date(r.date) <= new Date(to + 'T23:59:59.999'));
    if (q) {
      const s = String(q).toLowerCase();
      rows = rows.filter((r) => [r.ref, r.acc, r.slip, r.rm, r.ch].join(' ').toLowerCase().includes(s));
    }
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ total: rows.length, limit, offset, data: rows.slice(offset, offset + limit) });
  }));

  // GET /api/savings/accounts — per-member position
  router.get('/accounts', wrap(async (req, res) => {
    const [members, rows] = await Promise.all([db.listMembers(), db.listSavings({})]);
    const by = {};
    rows.forEach((s) => {
      const a = (by[s.acc] = by[s.acc] || { dep: 0, wd: 0 });
      s.w ? (a.wd += s.amt) : (a.dep += s.amt);
    });
    const data = members.map((m) => {
      const a = by[m.acc] || { dep: 0, wd: 0 };
      return { acc: m.acc, name: `${m.first} ${m.last}`, tel: m.tel, deposits: a.dep, withdrawals: a.wd, balance: a.dep - a.wd };
    });
    res.json({
      data,
      totals: {
        members: data.length,
        deposits: data.reduce((t, x) => t + x.deposits, 0),
        withdrawals: data.reduce((t, x) => t + x.withdrawals, 0),
        balance: data.reduce((t, x) => t + x.balance, 0),
      },
    });
  }));

  // GET /api/savings/accounts/:acc/balance
  router.get('/accounts/:acc/balance', wrap(async (req, res) => {
    const member = await db.getMember(req.params.acc);
    if (!member) return res.status(404).json({ error: 'Member account not found.' });
    const rows = await db.listSavings({ acc: member.acc });
    res.json({ acc: member.acc, name: `${member.first} ${member.last}`, balance: balanceOf(rows) });
  }));

  // GET /api/savings/monthly?months=12 — member savings by month (net)
  router.get('/monthly', wrap(async (req, res) => {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 36);
    const keys = [...Array(months)].map((_, i) => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - (months - 1) + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
    const [members, rows] = await Promise.all([db.listMembers(), db.listSavings({})]);
    const t = {};
    rows.forEach((s) => {
      const d = new Date(s.date);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      (t[s.acc] = t[s.acc] || {})[k] = ((t[s.acc] || {})[k] || 0) + signed(s);
    });
    const data = members.map((m) => ({
      acc: m.acc,
      name: `${m.first} ${m.last}`,
      months: keys.map((k) => (t[m.acc] && t[m.acc][k]) || 0),
      balance: balanceOf(rows.filter((s) => s.acc === m.acc)),
    }));
    res.json({ keys, data });
  }));

  // GET /api/savings/:ref
  router.get('/:ref', wrap(async (req, res) => {
    if (!/^SV-\d+$/i.test(req.params.ref)) return res.status(404).json({ error: 'Transaction not found.' });
    const row = (await db.listSavings({})).find((s) => s.ref.toUpperCase() === req.params.ref.toUpperCase());
    if (!row) return res.status(404).json({ error: 'Transaction not found.' });
    res.json(row);
  }));

  // POST /api/savings — record a single deposit or withdrawal
  // body: { acc, type: 'deposit'|'withdrawal', amount, date?, channel?, slip?, remarks? }
  router.post('/', requireRecorder, wrap(async (req, res) => {
    const seq = await db.nextSavingsSeq();
    const { row, member, error } = await buildRow(req.body || {}, req.user, refOf(seq));
    if (error) return res.status(400).json({ error });

    await db.insertSavings([row]);
    await db.audit({
      act: row.w ? 'Savings withdrawal' : 'Savings deposit',
      part: `${row.ref} — ${row.acc} ${member.first} ${member.last}, UGX ${n0(row.amt)} via ${row.ch}${row.slip ? ` (slip ${row.slip})` : ''}`,
      user: req.user,
    });

    const balance = balanceOf(await db.listSavings({ acc: row.acc }));
    res.status(201).json({ transaction: row, balance });
  }));

  // POST /api/savings/import — bulk import past savings
  // body: { rows: [{ account, date, amount, type, channel, slip, remarks }], fileName? }
  router.post('/import', requireRecorder, wrap(async (req, res) => {
    const input = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!input || !input.length) return res.status(400).json({ error: 'Provide a non-empty "rows" array.' });
    if (input.length > 5000) return res.status(400).json({ error: 'Import is limited to 5000 rows per request.' });

    // Process chronologically so withdrawals are checked against the running balance.
    const ordered = input
      .map((r, i) => ({ r, i, t: new Date(r.date).getTime() || 0 }))
      .sort((a, b) => a.t - b.t || a.i - b.i);

    const running = {};
    const good = [];
    const skipped = [];
    for (const { r, i } of ordered) {
      const seq = await db.nextSavingsSeq();
      const out = await buildRow(r, req.user, refOf(seq), running);
      if (out.error) skipped.push({ row: i + 1, error: out.error });
      else {
        out.row.ch = out.row.ch || 'Imported';
        good.push(out.row);
      }
    }

    if (good.length) await db.insertSavings(good);
    await db.audit({
      act: 'Savings imported',
      part: `Imported ${good.length} savings record(s)${req.body.fileName ? ' from ' + req.body.fileName : ''}${skipped.length ? `; ${skipped.length} skipped` : ''}`,
      user: req.user,
    });

    res.status(good.length ? 201 : 400).json({ imported: good.length, skipped: skipped.length, errors: skipped.slice(0, 100) });
  }));

  // Error handler (scoped to this router)
  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[savings]', err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return router;
};

/* ------------------------------------------------------------------ */
/* Optional: simple JSON-file store for local testing.                 */
/*   const { jsonFileDb } = require('./savings');                      */
/*   app.use('/api/savings', auth, require('./savings')(jsonFileDb())) */
/* Not safe for concurrent multi-process use — swap for a real DB.     */
/* ------------------------------------------------------------------ */
module.exports.jsonFileDb = function jsonFileDb(file = './sacco-data.json') {
  const fs = require('fs');
  const load = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  };
  const read = () => Object.assign({ members: [], savings: [], audit: [], sseq: 0 }, load());
  const write = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  return {
    async getMember(acc) { return read().members.find((m) => m.acc === acc) || null; },
    async listMembers() { return read().members; },
    async listSavings({ acc } = {}) { const s = read().savings; return acc ? s.filter((x) => x.acc === acc) : s; },
    async nextSavingsSeq() { const d = read(); d.sseq += 1; write(d); return d.sseq; },
    async insertSavings(rows) { const d = read(); d.savings.push(...rows); write(d); },
    async audit({ act, part, user }) {
      const d = read();
      d.audit.push({ t: new Date().toISOString(), ini: user.ini, user: user.name, role: user.role, act, part });
      write(d);
    },
  };
};
