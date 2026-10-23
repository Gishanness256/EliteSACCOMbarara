/**
 * loans.js — Loan routes for Elite SACCO Mbarara
 *
 * Mount in your Express app:
 *   const loans = require('./loans');
 *   app.use('/api/loans', requireAuth, loans(db));
 *
 * Expectations:
 *  - `requireAuth` sets req.user = { name, role, ini }
 *  - `db` implements the async interface below (a JSON-file version is
 *    exported as `jsonFileDb()` for local testing only).
 *
 * db interface:
 *   db.getMember(acc)                         -> member | null
 *   db.getNonMember(id)                       -> { id, name, tel, nin } | null
 *   db.findOrCreateNonMember({name,tel,nin})  -> { id, ... }
 *   db.listLoans()                            -> loan[]
 *   db.getLoan(ref)                           -> loan | null
 *   db.insertLoan(loan)                       -> void
 *   db.addRepayment(ref, repayment)           -> void
 *   db.nextLoanSeq()                          -> number (atomic)
 *   db.listRequests()                         -> request[]
 *   db.getRequest(id)                         -> request | null
 *   db.insertRequest(req)                     -> void
 *   db.updateRequest(id, patch)               -> void
 *   db.nextRequestSeq()                       -> number (atomic)
 *   db.audit({ act, part, user })             -> void
 *
 * Loan:    { ref, req, acc, nid, amt, rate, date 'YYYY-MM-DD', cat, term, tel, reps[], ini }
 * Repayment: { date 'YYYY-MM-DD', amt, type, ini }
 * Request: { id, date, type 'm'|'n', acc, nid, name, tel, email, addr, cat, term, amt, rate,
 *            status 'Pending'|'On Hold'|'Approved'|'Rejected', by, byIni, remark, decBy, decOn }
 */
'use strict';

const express = require('express');

/* ----------------------------- configuration ----------------------------- */
// Monthly interest rate by category (% per month).
const CATS = {
  'Normal Loan': 3,
  'Special Loan': 2.5,
  'Secured Business Loan': 2.5,
  'Agricultural Loan': 2,
  'School Fees Loan': 2,
};
const NONMEMBER_EXTRA = 1; // extra % per month for non-members
const termAdj = (t) => (t <= 6 ? 0 : t <= 12 ? 0.25 : 0.5);

const REQUEST_ROLES = ['Admin', 'Credit Officer', 'Credit Supervisor'];
const VIEW_ROLES = REQUEST_ROLES;
const APPROVE_ROLES = ['Admin'];
const REPAY_ROLES = ['Admin', 'Treasurer', 'Credit Supervisor', 'Credit Officer'];

/* -------------------------------- helpers -------------------------------- */
const p2 = (n) => String(n).padStart(2, '0');
const fmtD = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const today = () => fmtD(new Date());
const n0 = (x) => Math.round(x).toLocaleString('en-US');
const num = (x) => {
  const n = parseFloat(String(x ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
// Parse a 'YYYY-MM-DD' (or other date string) into local midnight.
const toDate = (s) => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
};
const addM = (d, n) => {
  d = toDate(d);
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
};
const normDate = (s) => {
  s = String(s ?? '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return `${m[1]}-${p2(m[2])}-${p2(m[3])}`;
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return `${y}-${p2(m[2])}-${p2(m[1])}`;
  }
  const d = new Date(s);
  return isNaN(d) ? '' : fmtD(d);
};
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const allow = (roles, msg) => (req, res, next) =>
  req.user && roles.includes(req.user.role) ? next() : res.status(403).json({ error: msg || 'Permission denied.' });

/* ---------------------------- loan calculations --------------------------- */
const calcRate = (cat, term, member) => {
  const b = CATS[cat] ?? 3;
  const t = termAdj(+term || 0);
  const n = member ? 0 : NONMEMBER_EXTRA;
  return { base: b, term: t, nonMember: n, rate: +(b + t + n).toFixed(2) };
};

const paid = (l) => (l.reps || []).reduce((t, x) => t + x.amt, 0);

/**
 * Outstanding balance (principal + accrued interest) as at `to`.
 * Interest compounds monthly on each monthly anniversary of the disbursement date;
 * repayments made up to that anniversary are deducted before interest accrues.
 */
function balance(l, to = new Date()) {
  const r = l.rate / 100;
  const d = toDate(l.date);
  const rp = (l.reps || []).map((x) => [toDate(x.date), x.amt]);
  let b = l.amt;
  let k = 0;
  let prev = new Date(+d - 1);
  for (;;) {
    const nx = new Date(d.getFullYear(), d.getMonth() + k + 1, d.getDate());
    if (nx > to) break;
    const p = rp.filter((x) => x[0] > prev && x[0] <= nx).reduce((a, x) => a + x[1], 0);
    b = Math.max(0, b - p) * (1 + r);
    prev = nx;
    k++;
  }
  b -= rp.filter((x) => x[0] > prev && x[0] <= to).reduce((a, x) => a + x[1], 0);
  return { balance: Math.max(0, b), months: k };
}

/** Repayment history split into interest-first, then principal. */
function simulate(l) {
  const r = l.rate / 100;
  const d = toDate(l.date);
  const rp = [...(l.reps || [])].sort((a, b) => toDate(a.date) - toDate(b.date));
  let P = l.amt;
  let I = 0;
  let k = 0;
  const nx = () => new Date(d.getFullYear(), d.getMonth() + k + 1, d.getDate());
  const out = [];
  rp.forEach((x) => {
    const xd = toDate(x.date);
    while (nx() < xd) {
      I += (P + I) * r;
      k++;
    }
    let a = x.amt;
    const i = Math.min(a, I);
    I -= i;
    a -= i;
    const p = Math.min(a, P);
    P -= p;
    out.push({ date: x.date, principal: p, interest: i, balance: P + I, type: x.type, ini: x.ini });
  });
  return out;
}

const PMT = (P, r, n) => (r ? (P * r) / (1 - Math.pow(1 + r, -n)) : P / n);
const dueDate = (l) => (l.term ? addM(l.date, l.term) : null);
const status = (l) => {
  if (balance(l).balance < 0.5) return 'Cleared';
  const due = dueDate(l);
  return due && due < new Date() ? 'Overdue' : 'Active';
};

module.exports = function loanRoutes(db) {
  const router = express.Router();
  router.use(express.json({ limit: '5mb' }));

  /* -------- presentation helpers -------- */
  async function borrower(l) {
    const m = l.acc ? await db.getMember(l.acc) : null;
    if (m) return { acc: m.acc, name: `${m.first} ${m.last}`, tel: m.tel, member: true };
    const n = l.nid ? await db.getNonMember(l.nid) : null;
    return { acc: '', name: n ? n.name : 'Unknown', tel: n ? n.tel : '', member: false };
  }

  async function present(l) {
    const w = await borrower(l);
    const b = balance(l).balance;
    const due = dueDate(l);
    return {
      ref: l.ref,
      request: l.req || null,
      acc: w.acc,
      borrower: w.name,
      member: w.member,
      tel: l.tel || w.tel || '',
      category: l.cat || '',
      term: l.term || null,
      principal: l.amt,
      rate: l.rate,
      disbursed: l.date,
      due: due ? fmtD(due) : null,
      paid: Math.round(paid(l)),
      balance: Math.round(b),
      installment: l.term && b >= 0.5 ? Math.round(PMT(l.amt, l.rate / 100, l.term)) : null,
      status: status(l),
    };
  }

  /* ================================ RATES ================================ */

  // GET /api/loans/categories
  router.get('/categories', (req, res) => {
    res.json({ categories: Object.entries(CATS).map(([name, rate]) => ({ name, baseRate: rate })), nonMemberExtra: NONMEMBER_EXTRA });
  });

  // GET /api/loans/rate?category=&term=&member=true|false
  router.get('/rate', (req, res) => {
    const { category, term } = req.query;
    if (!(category in CATS)) return res.status(400).json({ error: 'Unknown loan category.' });
    res.json(calcRate(category, term, String(req.query.member) !== 'false'));
  });

  /* ============================= LOAN REQUESTS ============================ */

  // GET /api/loans/requests?status=
  router.get('/requests', allow(VIEW_ROLES), wrap(async (req, res) => {
    let rows = await db.listRequests();
    if (req.query.status) rows = rows.filter((q) => q.status === req.query.status);
    res.json({ total: rows.length, data: rows.reverse() });
  }));

  // POST /api/loans/requests
  // body: { type:'m'|'n', acc?, name, tel, email?, addr?, nin?, category, term, amount, rate?, date? }
  router.post('/requests', allow(REQUEST_ROLES, 'You do not have permission to submit loan requests.'), wrap(async (req, res) => {
    const b = req.body || {};
    const isMember = (b.type || 'm') === 'm';
    let name = String(b.name || '').trim();
    let tel = String(b.tel || '').trim();
    let email = String(b.email || '').trim();
    let addr = String(b.addr || '').trim();
    let member = null;

    if (isMember) {
      member = await db.getMember(String(b.acc || ''));
      if (!member) return res.status(400).json({ error: 'Select a valid member.' });
      name = name || `${member.first} ${member.last}`;
      tel = tel || member.tel || '';
      email = email || member.email || '';
      addr = addr || member.addr || '';
    }
    if (!name) return res.status(400).json({ error: 'Applicant name is required.' });
    if (!tel) return res.status(400).json({ error: 'Contact telephone is required.' });
    if (!(b.category in CATS)) return res.status(400).json({ error: 'Unknown loan category.' });

    const amt = num(b.amount);
    const term = Math.round(num(b.term));
    const date = normDate(b.date) || today();
    if (amt <= 0) return res.status(400).json({ error: 'Enter the amount to borrow.' });
    if (term < 1 || term > 60) return res.status(400).json({ error: 'Loan term must be 1–60 months.' });

    const rate = b.rate === undefined || b.rate === '' ? calcRate(b.category, term, isMember).rate : +num(b.rate).toFixed(2);
    if (rate <= 0 || rate > 30) return res.status(400).json({ error: 'Interest rate must be between 0.01 and 30 % per month.' });

    const nid = isMember ? undefined : (await db.findOrCreateNonMember({ name, tel, nin: String(b.nin || '').trim() })).id;
    const id = 'LR-' + String(await db.nextRequestSeq()).padStart(4, '0');
    const request = {
      id, date, type: isMember ? 'm' : 'n', acc: isMember ? member.acc : '', nid, name, tel, email, addr,
      cat: b.category, term, amt, rate, status: 'Pending', by: req.user.name, byIni: req.user.ini || '',
    };
    await db.insertRequest(request);
    await db.audit({
      act: 'Loan request submitted',
      part: `${id} — ${name}, ${b.category}, UGX ${n0(amt)}, ${rate}% per month, ${term} months`,
      user: req.user,
    });
    res.status(201).json(request);
  }));

  // POST /api/loans/requests/:id/decision   (Admin only)
  // body: { decision: 'Approved'|'Rejected'|'On Hold', remark }
  router.post('/requests/:id/decision', allow(APPROVE_ROLES, 'Only the System Admin can approve, reject or hold loans.'), wrap(async (req, res) => {
    const q = await db.getRequest(req.params.id);
    if (!q) return res.status(404).json({ error: 'Loan request not found.' });
    if (!['Pending', 'On Hold'].includes(q.status)) return res.status(409).json({ error: `Request already ${q.status.toLowerCase()}.` });

    const decision = req.body && req.body.decision;
    const remark = String((req.body && req.body.remark) || '').trim();
    if (!['Approved', 'Rejected', 'On Hold'].includes(decision)) return res.status(400).json({ error: 'Decision must be Approved, Rejected or On Hold.' });
    if (decision !== 'Approved' && !remark) return res.status(400).json({ error: `Add a remark before ${decision === 'Rejected' ? 'rejecting' : 'holding'} ${q.id}.` });

    await db.updateRequest(q.id, { status: decision, remark, decBy: req.user.name, decOn: today() });

    let loan = null;
    if (decision === 'Approved') {
      const ref = 'LN-' + String(await db.nextLoanSeq()).padStart(4, '0');
      loan = {
        ref, req: q.id, acc: q.acc || '', nid: q.nid, amt: q.amt, rate: q.rate, date: today(),
        cat: q.cat, term: q.term, tel: q.tel, reps: [], ini: req.user.ini || '',
      };
      await db.insertLoan(loan);
    }
    await db.audit({
      act: 'Loan ' + decision.toLowerCase(),
      part: `${q.id} — ${q.name}, UGX ${n0(q.amt)} at ${q.rate}%/month${remark ? ' · Remark: ' + remark : ''}`,
      user: req.user,
    });
    res.json({ request: await db.getRequest(q.id), loan: loan ? await present(loan) : null });
  }));

  /* ================================= LOANS ================================ */

  // GET /api/loans?status=active|cleared|overdue|all&q=&acc=&limit=&offset=
  router.get('/', allow(VIEW_ROLES), wrap(async (req, res) => {
    const filter = String(req.query.status || 'active').toLowerCase();
    const q = String(req.query.q || '').toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let rows = await Promise.all((await db.listLoans()).map(present));
    if (req.query.acc) rows = rows.filter((r) => r.acc === req.query.acc);
    if (filter === 'active') rows = rows.filter((r) => r.status !== 'Cleared');
    else if (filter === 'cleared') rows = rows.filter((r) => r.status === 'Cleared');
    else if (filter === 'overdue') rows = rows.filter((r) => r.status === 'Overdue');
    if (q) rows = rows.filter((r) => `${r.borrower} ${r.acc} ${r.ref}`.toLowerCase().includes(q));

    const active = rows.filter((r) => r.status !== 'Cleared');
    res.json({
      total: rows.length,
      summary: {
        activeLoans: active.length,
        principalOut: active.reduce((t, r) => t + r.principal, 0),
        outstanding: active.reduce((t, r) => t + r.balance, 0),
      },
      limit, offset,
      data: rows.slice(offset, offset + limit),
    });
  }));

  // GET /api/loans/:ref — loan detail with repayment history
  router.get('/:ref', allow(VIEW_ROLES), wrap(async (req, res) => {
    if (!/^LN-\d+$/i.test(req.params.ref)) return res.status(404).json({ error: 'Loan not found.' });
    const l = await db.getLoan(req.params.ref.toUpperCase());
    if (!l) return res.status(404).json({ error: 'Loan not found.' });
    res.json({
      ...(await present(l)),
      history: simulate(l).map((x) => ({
        date: x.date, type: x.type || 'Payment', principal: Math.round(x.principal),
        interest: Math.round(x.interest), balanceAfter: Math.round(x.balance), by: x.ini || '',
      })),
    });
  }));

  // GET /api/loans/:ref/balance?asAt=YYYY-MM-DD
  router.get('/:ref/balance', allow(VIEW_ROLES), wrap(async (req, res) => {
    const l = await db.getLoan(String(req.params.ref).toUpperCase());
    if (!l) return res.status(404).json({ error: 'Loan not found.' });
    const asAt = req.query.asAt ? toDate(normDate(req.query.asAt)) : new Date();
    if (isNaN(asAt)) return res.status(400).json({ error: 'Invalid asAt date.' });
    res.json({ ref: l.ref, asAt: fmtD(asAt), balance: Math.ceil(balance(l, asAt).balance) });
  }));

  // POST /api/loans/:ref/repayments
  // body: { type: 'installment'|'lump'|'full', amount?, date? }
  router.post('/:ref/repayments', allow(REPAY_ROLES, 'You do not have permission to record repayments.'), wrap(async (req, res) => {
    const l = await db.getLoan(String(req.params.ref).toUpperCase());
    if (!l) return res.status(404).json({ error: 'Loan not found.' });
    if (balance(l).balance < 0.5) return res.status(409).json({ error: 'Loan is already cleared.' });

    const b = req.body || {};
    const t = String(b.type || 'installment').toLowerCase();
    if (!['installment', 'lump', 'full'].includes(t)) return res.status(400).json({ error: 'Type must be installment, lump or full.' });

    const d = normDate(b.date) || today();
    if (d < l.date || d > today()) return res.status(400).json({ error: 'Date must not be before disbursement or in the future.' });
    const last = (l.reps || []).reduce((m, x) => (x.date > m ? x.date : m), '');
    if (last && d < last) return res.status(400).json({ error: `Date cannot be earlier than the last recorded payment (${last}).` });

    const due = Math.ceil(balance(l, toDate(d)).balance);
    const amt = t === 'full' ? due : num(b.amount);
    if (amt <= 0) return res.status(400).json({ error: 'Enter an amount.' });
    if (amt > due) return res.status(400).json({ error: `Amount exceeds the balance due on that date (UGX ${n0(due)}).` });

    const type = t === 'full' ? 'Full settlement' : t === 'lump' ? 'Lump sum' : 'Installment';
    await db.addRepayment(l.ref, { date: d, amt, type, ini: req.user.ini || '' });
    const w = await borrower(l);
    await db.audit({
      act: 'Loan repayment',
      part: `${l.ref} — ${w.name} paid UGX ${n0(amt)} (${type.toLowerCase()}) dated ${d}`,
      user: req.user,
    });

    const updated = await db.getLoan(l.ref);
    const nb = balance(updated).balance;
    res.status(201).json({ loan: await present(updated), cleared: nb < 0.5 });
  }));

  // POST /api/loans/import — import old active/cleared loans
  // body: { rows:[{account,name,telephone,category,term,principal,rate,date,status,balance,paid,cleared}], fileName? }
  router.post('/import', allow(REQUEST_ROLES, 'You do not have permission to import loans.'), wrap(async (req, res) => {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!rows || !rows.length) return res.status(400).json({ error: 'Provide a non-empty "rows" array.' });
    if (rows.length > 5000) return res.status(400).json({ error: 'Import is limited to 5000 rows per request.' });

    const pick = (o, ...keys) => {
      for (const k of keys) if (o[k] !== undefined && String(o[k]).trim() !== '') return String(o[k]).trim();
      return '';
    };
    const existing = await db.listLoans();
    let ok = 0, dup = 0, bad = 0, unknown = 0;

    for (const raw of rows) {
      const o = {};
      for (const k in raw) o[k.trim().toLowerCase()] = raw[k];
      const amt = num(pick(o, 'principal', 'amount', 'amt'));
      const date = normDate(pick(o, 'date', 'date disbursed'));
      const accS = pick(o, 'account', 'acc');
      const name = pick(o, 'name', 'borrower');
      const member = accS ? await db.getMember(accS) : null;
      if (!date || amt <= 0 || (!member && !name)) { bad++; continue; }
      if (accS && !member) unknown++;

      const tel = pick(o, 'telephone', 'tel', 'phone');
      const nid = member ? undefined : (await db.findOrCreateNonMember({ name, tel, nin: '' })).id;
      const key = member ? member.acc : nid;
      if (existing.some((x) => (x.acc || x.nid) === key && x.date === date && x.amt === amt)) { dup++; continue; }

      const crit = pick(o, 'category', 'type');
      const cat = Object.keys(CATS).find((c) => c.toLowerCase() === crit.toLowerCase()) || crit || 'Normal Loan';
      const term = Math.round(num(pick(o, 'term', 'term (months)'))) || 0;
      const rt = num(pick(o, 'rate', 'rate (% per month)'));
      const loan = {
        ref: 'LN-' + String(await db.nextLoanSeq()).padStart(4, '0'),
        acc: member ? member.acc : '', nid, amt, date, cat, term,
        rate: rt > 0 ? rt : calcRate(cat, term, !!member).rate,
        tel: tel || (member ? member.tel : ''), reps: [], ini: req.user.ini || '', imported: true,
      };

      const st = pick(o, 'status').toLowerCase();
      const bs = pick(o, 'balance', 'outstanding');
      const paidAmt = num(pick(o, 'paid', 'amount paid'));
      if (/clear|closed|settled|fully/.test(st)) {
        let d = normDate(pick(o, 'cleared', 'date cleared')) || today();
        if (d < date) d = date;
        const b = balance(loan, toDate(d)).balance;
        if (b >= 0.5) loan.reps.push({ date: d, amt: Math.ceil(b), type: 'Imported settlement', ini: loan.ini });
      } else if (bs !== '') {
        const diff = balance(loan).balance - num(bs);
        if (diff >= 0.5) loan.reps.push({ date: today(), amt: Math.round(diff), type: 'Imported payments', ini: loan.ini });
      } else if (paidAmt > 0) {
        loan.reps.push({ date: today(), amt: Math.min(paidAmt, Math.ceil(balance(loan).balance)), type: 'Imported payments', ini: loan.ini });
      }

      await db.insertLoan(loan);
      existing.push(loan);
      ok++;
    }

    const summary = `Imported ${ok} loan(s)${dup ? `, skipped ${dup} duplicate(s)` : ''}${bad ? `, ${bad} row(s) skipped (missing name/amount/date)` : ''}${unknown ? `; ${unknown} unknown account number(s) treated as non-members` : ''}.`;
    await db.audit({ act: 'Loans imported', part: `${summary}${req.body.fileName ? ' File: ' + req.body.fileName : ''}`, user: req.user });
    res.status(ok ? 201 : 400).json({ imported: ok, duplicates: dup, skipped: bad, unknownAccounts: unknown, message: summary });
  }));

  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[loans]', err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return router;
};

// Exposed for reuse (e.g. ledger, liquidity/PAR and statement routes).
module.exports.calc = { balance, simulate, calcRate, PMT, addM, dueDate, status, paid, CATS };

/* ------------------------------------------------------------------ */
/* Optional JSON-file store for local testing only (not multi-process). */
/* ------------------------------------------------------------------ */
module.exports.jsonFileDb = function jsonFileDb(file = './sacco-data.json') {
  const fs = require('fs');
  const read = () => {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
    return Object.assign({ members: [], non: [], loans: [], reqs: [], audit: [], lseq: 0, rseq: 0 }, d);
  };
  const write = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  const mut = (fn) => { const d = read(); const r = fn(d); write(d); return r; };
  return {
    async getMember(acc) { return read().members.find((m) => m.acc === acc) || null; },
    async getNonMember(id) { return read().non.find((n) => n.id === id) || null; },
    async findOrCreateNonMember({ name, tel, nin }) {
      return mut((d) => {
        let n = d.non.find((x) => (nin && x.nin && x.nin.toUpperCase() === nin.toUpperCase()) ||
          (x.name.toLowerCase() === name.toLowerCase() && (!tel || !x.tel || x.tel === tel)));
        if (!n) { n = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, tel: tel || '', nin: nin || '' }; d.non.push(n); }
        return n;
      });
    },
    async listLoans() { return read().loans; },
    async getLoan(ref) { return read().loans.find((l) => l.ref === ref) || null; },
    async insertLoan(l) { mut((d) => d.loans.push(l)); },
    async addRepayment(ref, r) { mut((d) => { const l = d.loans.find((x) => x.ref === ref); (l.reps = l.reps || []).push(r); }); },
    async nextLoanSeq() { return mut((d) => ++d.lseq); },
    async listRequests() { return read().reqs; },
    async getRequest(id) { return read().reqs.find((q) => q.id === id) || null; },
    async insertRequest(q) { mut((d) => d.reqs.push(q)); },
    async updateRequest(id, patch) { mut((d) => Object.assign(d.reqs.find((q) => q.id === id), patch)); },
    async nextRequestSeq() { return mut((d) => ++d.rseq); },
    async audit({ act, part, user }) {
      mut((d) => d.audit.push({ t: new Date().toISOString(), ini: user.ini, user: user.name, role: user.role, act, part }));
    },
  };
};
