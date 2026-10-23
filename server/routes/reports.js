'use strict';
/**
 * reports.js — Elite SACCO Mbarara
 * Express routes for member Statements and Regulatory Returns (Auditing).
 *
 * Mount:
 *   const reports = require('./reports');
 *   app.use('/api/reports', reports({ store, auth }));
 *
 * `store` must provide (sync or async):
 *   getState()                  -> { members, savings, loans, nonMembers, regin, rcfg }
 *   saveRegin(monthKey, obj|null)   (null deletes the month)
 *   saveRcfg(cfgObject)
 *   addAudit({ t, ini, user, role, act, part })      (optional)
 *
 * `auth` must be an Express middleware that sets req.user = { name, role, ini }.
 *
 * Data shapes match the front end:
 *   member : { acc, first, last, tel, ... }
 *   saving : { acc, amt, date, w (withdrawal?), ini, ref }
 *   loan   : { ref, acc | nid, amt, rate (% per month), date 'YYYY-MM-DD', term, cat, reps:[{date,amt,type,ini}] }
 *
 * Optional dependency: `xlsx` (npm i xlsx) for Excel export. CSV/JSON need nothing.
 */
const express = require('express');

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
const p2 = n => String(n).padStart(2, '0');
const fmtD = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const today = () => fmtD(new Date());
const addM = (d, n) => { d = new Date(d); return new Date(d.getFullYear(), d.getMonth() + n, d.getDate()); };
const mkS = (y, m0) => `${y}-${p2(m0 + 1)}`;
const curMk = () => { const d = new Date(); return mkS(d.getFullYear(), d.getMonth()); };
const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MN3 = MN.map(m => m.slice(0, 3));
const paid = l => (l.reps || []).reduce((t, x) => t + x.amt, 0);
const lref = (l, i) => l.ref || 'LN-' + String(i + 1).padStart(4, '0');
const num = x => parseFloat(String(x).replace(/[^0-9.\-]/g, '')) || 0;
const dd = x => /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(x) ? String(x).replace('T', ' ') : fmtD(new Date(x));
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ */
/* loan maths (monthly compounding on outstanding balance)             */
/* ------------------------------------------------------------------ */
function bal(l, to = new Date()) {
  const r = l.rate / 100, d = new Date(l.date);
  const rp = (l.reps || []).map(x => [new Date(x.date), x.amt]);
  let b = l.amt, k = 0, prev = new Date(+d - 1);
  for (;;) {
    const nx = new Date(d.getFullYear(), d.getMonth() + k + 1, d.getDate());
    if (nx > to) break;
    const p = rp.filter(x => x[0] > prev && x[0] <= nx).reduce((a, x) => a + x[1], 0);
    b = Math.max(0, b - p) * (1 + r);
    prev = nx; k++;
  }
  b -= rp.filter(x => x[0] > prev && x[0] <= to).reduce((a, x) => a + x[1], 0);
  return { b: Math.max(0, b), k };
}

// Splits each repayment into interest-first, then principal.
function sim(l) {
  const r = l.rate / 100, d = new Date(l.date);
  const rp = [...(l.reps || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  let P = l.amt, I = 0, k = 0;
  const out = [];
  const nx = () => new Date(d.getFullYear(), d.getMonth() + k + 1, d.getDate());
  rp.forEach(x => {
    const xd = new Date(x.date);
    while (nx() < xd) { I += (P + I) * r; k++; }
    let a = x.amt;
    const i = Math.min(a, I); I -= i; a -= i;
    const p = Math.min(a, P); P -= p;
    out.push({ date: x.date, p, i, bal: P + I, ini: x.ini, type: x.type });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* MEMBER STATEMENTS                                                   */
/* ------------------------------------------------------------------ */
const STMT_HEADS = ['Date', 'Ref', 'Particulars', 'Deposit', 'Withdrawal', 'Savings balance',
  'Loan disbursed', 'Repayment (principal)', 'Interest paid', 'Loan balance', 'Officer'];

function periodRange(q) {
  const t = q.period || 'm', now = new Date();
  let f, e, label;
  if (t === 'm') {
    const m = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : curMk();
    const [y, mo] = m.split('-').map(Number);
    f = new Date(y, mo - 1, 1); e = new Date(y, mo, 1); label = `${MN[mo - 1]} ${y}`;
  } else if (t === 'q') {
    const y = +q.year || now.getFullYear(), qq = +q.quarter || Math.floor(now.getMonth() / 3) + 1;
    if (qq < 1 || qq > 4) throw httpErr(400, 'quarter must be 1-4');
    f = new Date(y, (qq - 1) * 3, 1); e = new Date(y, qq * 3, 1);
    label = `Quarter ${qq} ${y} (${MN3[(qq - 1) * 3]} - ${MN3[qq * 3 - 1]})`;
  } else if (t === 'y') {
    const y = +q.year || now.getFullYear();
    f = new Date(y, 0, 1); e = new Date(y + 1, 0, 1); label = `Year ${y}`;
  } else throw httpErr(400, 'period must be m, q or y');
  return { f, t: e, label, type: t };
}

function buildStatement(S, acc, range) {
  const m = S.members.find(x => x.acc === acc);
  if (!m) throw httpErr(404, 'Member account not found');
  const { f, t, label } = range, ev = [];
  S.savings.filter(s => s.acc === acc).forEach(x => ev.push({ d: x.date, t: 's', x }));
  S.loans.forEach((l, i) => {
    if (l.acc !== acc) return;
    ev.push({ d: l.date, t: 'd', l, i });
    sim(l).forEach(r => ev.push({ d: r.date, t: 'r', l, i, r }));
  });
  ev.sort((p, q) => new Date(p.d) - new Date(q.d) || (p.t === 'd' ? -1 : 0) - (q.t === 'd' ? -1 : 0));

  let sb = 0, osb = 0;
  const lbs = {}, rows = [], T = { dep: 0, wd: 0, ld: 0, rp: 0, ip: 0 };
  ev.forEach(e => {
    const when = new Date(e.d);
    let part, dep = 0, wd = 0, ld = 0, rp = 0, ip = 0, ini = '', rf = '';
    if (e.t === 's') {
      sb += e.x.w ? -e.x.amt : e.x.amt;
      if (e.x.w) wd = e.x.amt; else dep = e.x.amt;
      part = e.x.w ? 'Savings withdrawal' : 'Savings deposit'; ini = e.x.ini; rf = e.x.ref || '';
    } else if (e.t === 'd') {
      lbs[e.i] = e.l.amt; ld = e.l.amt; part = 'Loan disbursement - ' + (e.l.cat || ''); ini = e.l.ini; rf = lref(e.l, e.i);
    } else {
      lbs[e.i] = e.r.bal; rp = e.r.p; ip = e.r.i; part = 'Loan repayment - ' + (e.r.type || ''); ini = e.r.ini; rf = lref(e.l, e.i);
    }
    if (when < f) osb = sb;
    else if (when < t) {
      T.dep += dep; T.wd += wd; T.ld += ld; T.rp += rp; T.ip += ip;
      rows.push([dd(e.d), rf, part, dep || '', wd || '', Math.round(sb), ld || '',
        rp ? Math.round(rp) : '', ip ? Math.round(ip) : '',
        Math.round(Object.values(lbs).reduce((s, x) => s + x, 0)), ini || '']);
    }
  });
  const lbal = d => S.loans.filter(l => l.acc === acc && new Date(l.date) <= d).reduce((s, l) => s + bal(l, d).b, 0);
  const oL = Math.round(lbal(new Date(f - 1)));
  const cL = Math.round(lbal(new Date(Math.min(t - 1, Date.now()))));
  const cS = Math.round(osb + T.dep - T.wd);
  return {
    member: { acc: m.acc, name: `${m.first} ${m.last}`, tel: m.tel || '' },
    period: { label, from: fmtD(f), to: fmtD(new Date(t - 1)) },
    summary: {
      openingSavings: Math.round(osb), deposits: Math.round(T.dep), withdrawals: Math.round(T.wd), closingSavings: cS,
      openingLoan: oL, loansDisbursed: Math.round(T.ld), principalRepaid: Math.round(T.rp),
      interestPaid: Math.round(T.ip), closingLoan: cL, netPosition: cS - cL
    },
    columns: STMT_HEADS,
    rows,
    openingRow: ['', '', 'Opening balance', '', '', Math.round(osb), '', '', '', oL, ''],
    closingRow: ['', '', 'Closing balance', '', '', cS, '', '', '', cL, '']
  };
}

function statementAoa(st, user) {
  const s = st.summary;
  return [
    ['ELITE SACCO MBARARA'], ['Member Account Statement'], [],
    ['Account', st.member.acc], ['Member', st.member.name], ['Telephone', st.member.tel],
    ['Period', st.period.label], ['From', st.period.from], ['To', st.period.to],
    ['Generated', `${today()} by ${user.name}`], [],
    ['SUMMARY (UGX)'],
    ['Opening savings balance', s.openingSavings], ['Deposits in period', s.deposits],
    ['Withdrawals in period', s.withdrawals], ['Closing savings balance', s.closingSavings],
    ['Opening loan balance', s.openingLoan], ['Loans disbursed', s.loansDisbursed],
    ['Principal repaid', s.principalRepaid], ['Interest paid', s.interestPaid],
    ['Closing loan balance', s.closingLoan], ['Net position (savings - loans)', s.netPosition], [],
    st.columns, st.openingRow, ...st.rows, st.closingRow
  ];
}

/* ------------------------------------------------------------------ */
/* REGULATORY RETURNS                                                  */
/* ------------------------------------------------------------------ */
const RC0 = { reg: 'Uganda Microfinance Regulatory Authority (UMRA)', lic: '', minLiq: 15, minCore: 10, minInst: 8, maxP30: 5, maxP90: 2, pr: [1, 5, 25, 50, 100] };
const RIS = [['cash', 'Cash on hand'], ['bank', 'Bank balances'], ['liq', 'Other liquid investments (T-bills, fixed deposits)'],
  ['oa', 'Other assets (fixed assets, prepayments)'], ['ol', 'Other liabilities (borrowings, payables) — treated as short-term'],
  ['sh', 'Member share capital'], ['rs', 'Statutory / other reserves']];
const RIF = [['fee', 'Fee & other income (this month)'], ['sint', 'Interest / dividends paid on savings (this month)'], ['opx', 'Operating expenses (this month)']];
const BK = ['Current (not yet due)', '1-29 days overdue', '30-59 days overdue', '60-89 days overdue', '90+ days overdue'];

const normCfg = c => {
  const o = Object.assign({}, RC0, c || {});
  if (!Array.isArray(o.pr) || o.pr.length !== 5) o.pr = RC0.pr.slice();
  return o;
};

function makeEngine(S) {
  const cfg = normCfg(S.rcfg);
  const regin = S.regin || {};
  const cache = {};
  const has = x => x !== undefined && x !== '' && x !== null && !isNaN(+x);
  // balance inputs carry forward (st=true); flow inputs apply to their month only
  const rin = (mk, k, st) => {
    if (regin[mk] && has(regin[mk][k])) return +regin[mk][k];
    if (st) {
      const ks = Object.keys(regin).filter(x => x < mk && regin[x] && has(regin[x][k])).sort();
      if (ks.length) return +regin[ks.at(-1)][k];
    }
    return null;
  };
  const firstKey = () => {
    const ds = [...S.savings.map(x => x.date), ...S.loans.map(x => x.date),
      ...S.loans.flatMap(l => (l.reps || []).map(r => r.date))].map(x => new Date(x)).filter(d => !isNaN(d));
    if (!ds.length) return null;
    const d = new Date(Math.min(...ds));
    return mkS(d.getFullYear(), d.getMonth());
  };
  const lstats = d => {
    const o = { P: 0, I: 0, G: 0, n: 0, bk: [0, 0, 0, 0, 0], bn: [0, 0, 0, 0, 0], bw: new Set() };
    S.loans.forEach(l => {
      if (new Date(l.date) > d) return;
      const b = bal(l, d).b; if (b < .5) return;
      const pp = sim(l).filter(r => new Date(r.date) <= d).reduce((t, r) => t + r.p, 0);
      const P = Math.min(b, Math.max(0, l.amt - pp)), I = Math.max(0, b - P);
      let k = 0;
      if (l.term) {
        const days = Math.floor((d - addM(l.date, l.term)) / 864e5);
        k = days <= 0 ? 0 : days < 30 ? 1 : days < 60 ? 2 : days < 90 ? 3 : 4;
      }
      o.P += P; o.I += I; o.G += b; o.n++; o.bk[k] += P; o.bn[k]++; o.bw.add(l.acc || l.nid);
    });
    return o;
  };
  const snap = (y, m0) => {
    const mk = mkS(y, m0); if (cache[mk]) return cache[mk];
    const E = new Date(y, m0 + 1, 0, 23, 59, 59, 999), B = new Date(y, m0, 1), pv = new Date(+B - 1);
    const s = { mk, miss: [] };
    const L = lstats(E), L0 = lstats(pv), inM = x => { const t = new Date(x); return t >= B && t <= E; };
    RIS.forEach(([k]) => { const v = rin(mk, k, true); if (v == null) s.miss.push(k); s['i_' + k] = v || 0; });
    RIF.forEach(([k]) => { const v = rin(mk, k, false); if (v == null) s.miss.push(k); s['i_' + k] = v || 0; });
    const sE = S.savings.filter(x => new Date(x.date) <= E);
    s.sb = sE.reduce((t, x) => t + (x.w ? -x.amt : x.amt), 0);
    const mv = S.savings.filter(x => inM(x.date));
    s.dep = mv.filter(x => !x.w).reduce((t, x) => t + x.amt, 0);
    s.wd = mv.filter(x => x.w).reduce((t, x) => t + x.amt, 0);
    s.nsm = s.dep - s.wd;
    const hs = {}; sE.forEach(x => hs[x.acc] = (hs[x.acc] || 0) + (x.w ? -x.amt : x.amt));
    s.mem = S.members.length; s.msv = Object.values(hs).filter(v => v > 0).length;
    s.asv = s.mem ? s.sb / s.mem : null;
    s.nl = L.n; s.nb = L.bw.size; s.prin = L.P; s.intr = L.I; s.gross = L.G;
    s.dis = 0; s.disn = 0; s.rp = 0; s.ri = 0;
    S.loans.forEach(l => {
      if (inM(l.date)) { s.dis += l.amt; s.disn++; }
      sim(l).forEach(r => { if (inM(r.date)) { s.rp += r.p; s.ri += r.i; } });
    });
    L.bk.forEach((v, i) => { s['bk' + i] = v; s['bn' + i] = L.bn[i]; s['bp' + i] = v * cfg.pr[i] / 100; });
    s.prov = L.bk.reduce((t, v, i) => t + v * cfg.pr[i] / 100, 0);
    const prov0 = L0.bk.reduce((t, v, i) => t + v * cfg.pr[i] / 100, 0);
    s.nprov = -s.prov;
    s.liqA = s.i_cash + s.i_bank + s.i_liq; s.tl = s.sb + s.i_ol; s.lbase = s.tl;
    s.ta = s.liqA + s.prin + s.intr - s.prov + s.i_oa;
    s.nw = s.ta - s.tl; s.re = s.nw - s.i_sh - s.i_rs; s.core = s.nw; s.inst = s.i_rs + s.re; s.tle = s.tl + s.nw;
    s.iinc = s.ri + (L.I - L0.I); s.tinc = s.iinc + s.i_fee; s.pexp = s.prov - prov0;
    s.texp = s.i_sint + s.i_opx + s.pexp; s.sur = s.tinc - s.texp;
    s.liqGap = s.liqA - cfg.minLiq / 100 * s.lbase; s.capGap = s.core - cfg.minCore / 100 * s.ta;
    const pc = (a, b) => b > 0 ? a / b * 100 : null, od = i => L.bk.slice(i).reduce((t, v) => t + v, 0);
    s.rLiq = pc(s.liqA, s.lbase); s.rLiqTA = pc(s.liqA, s.ta); s.rL2S = pc(s.prin, s.sb);
    s.rCore = s.ta > 0 ? pc(s.core, s.ta) : null; s.rInst = s.ta > 0 ? pc(s.inst, s.ta) : null; s.rNW2S = pc(s.nw, s.sb);
    s.rP1 = pc(od(1), s.prin); s.rP30 = pc(od(2), s.prin); s.rP60 = pc(od(3), s.prin); s.rP90 = pc(od(4), s.prin);
    s.rPC = pc(s.prov, s.prin); s.rOSS = pc(s.tinc, s.texp);
    return cache[mk] = s;
  };
  return { cfg, snap, firstKey };
}

/* templates: h = section header; l = label; k = snapshot key; t = type (m money, p %, n count); a:'flow'; b = bold; th = threshold */
const H = h => ({ h });
const Rw = (l, k, t, o) => ({ l, k, t: t || 'm', ...(o || {}) });
const FL = { a: 'flow' }, FLB = { a: 'flow', b: 1 };
const RT = [
  { id: 'sum', n: 'Prudential Ratios Summary', s: 'Ratios', rows: [
    H('Liquidity'), Rw('Liquidity ratio (liquid assets ÷ savings + short-term liabilities)', 'rLiq', 'p', { th: ['min', 'minLiq'] }),
    Rw('Liquid assets ÷ total assets', 'rLiqTA', 'p'), Rw('Loans (principal) ÷ member savings', 'rL2S', 'p'),
    H('Capital adequacy'), Rw('Core capital ÷ total assets', 'rCore', 'p', { th: ['min', 'minCore'] }),
    Rw('Institutional capital (reserves + retained earnings) ÷ total assets', 'rInst', 'p', { th: ['min', 'minInst'] }),
    Rw('Net worth ÷ member savings', 'rNW2S', 'p'),
    H('Asset quality (on outstanding principal)'), Rw('Portfolio at risk, 30 days and above (PAR 30)', 'rP30', 'p', { th: ['max', 'maxP30'] }),
    Rw('Portfolio at risk, 90 days and above (PAR 90)', 'rP90', 'p', { th: ['max', 'maxP90'] }),
    Rw('Loan loss provision ÷ principal outstanding', 'rPC', 'p'),
    H('Earnings'), Rw('Total income ÷ total expenses (operating self-sufficiency)', 'rOSS', 'p')] },
  { id: 'sfp', n: 'Statement of Financial Position', s: 'Financial Position',
    note: 'Retained earnings is derived: total assets less liabilities, member share capital and reserves. Cash, bank, other assets/liabilities, share capital and reserves come from the monthly financial inputs.',
    rows: [
      H('Assets'), Rw('Cash on hand', 'i_cash'), Rw('Bank balances', 'i_bank'), Rw('Other liquid investments', 'i_liq'),
      Rw('Loans to members and others (principal outstanding)', 'prin'), Rw('Interest receivable on loans', 'intr'),
      Rw('Less: loan loss provision', 'nprov'), Rw('Other assets', 'i_oa'), Rw('TOTAL ASSETS', 'ta', 'm', { b: 1 }),
      H('Liabilities'), Rw('Member savings / deposits', 'sb'), Rw('Other liabilities', 'i_ol'), Rw('TOTAL LIABILITIES', 'tl', 'm', { b: 1 }),
      H('Equity'), Rw('Member share capital', 'i_sh'), Rw('Statutory / other reserves', 'i_rs'),
      Rw('Retained earnings & surplus (derived)', 're'), Rw('TOTAL EQUITY (core capital)', 'nw', 'm', { b: 1 }),
      Rw('TOTAL LIABILITIES AND EQUITY', 'tle', 'm', { b: 1 })] },
  { id: 'inc', n: 'Statement of Income', s: 'Income',
    note: 'Interest income is on an accrual basis (interest collected plus the movement in interest receivable). Provision expense is the movement in the required provision. Fee income, savings interest/dividends and operating expenses come from the monthly financial inputs.',
    rows: [
      H('Income'), Rw('Interest income on loans (accrual)', 'iinc', 'm', FL), Rw('Fee & other income', 'i_fee', 'm', FL), Rw('TOTAL INCOME', 'tinc', 'm', FLB),
      H('Expenses'), Rw('Interest / dividends paid on savings', 'i_sint', 'm', FL), Rw('Operating expenses', 'i_opx', 'm', FL),
      Rw('Loan loss provision expense', 'pexp', 'm', FL), Rw('TOTAL EXPENSES', 'texp', 'm', FLB),
      H('Result'), Rw('NET SURPLUS / (DEFICIT)', 'sur', 'm', FLB), Rw('Operating self-sufficiency (income ÷ expenses)', 'rOSS', 'p'),
      H('Memo: loan activity'), Rw('Loans disbursed', 'dis', 'm', FL), Rw('Principal repaid', 'rp', 'm', FL), Rw('Interest collected', 'ri', 'm', FL)] },
  { id: 'liq', n: 'Liquidity Return', s: 'Liquidity', rows: [
    H('Liquid assets'), Rw('Cash on hand', 'i_cash'), Rw('Bank balances', 'i_bank'), Rw('Other liquid investments', 'i_liq'),
    Rw('TOTAL LIQUID ASSETS', 'liqA', 'm', { b: 1 }),
    H('Liability base'), Rw('Member savings / deposits', 'sb'), Rw('Other short-term liabilities', 'i_ol'),
    Rw('TOTAL SAVINGS AND SHORT-TERM LIABILITIES', 'lbase', 'm', { b: 1 }),
    H('Liquidity position'), Rw('Liquidity ratio', 'rLiq', 'p', { th: ['min', 'minLiq'], b: 1 }),
    Rw('Liquid assets above / (below) required minimum', 'liqGap'), Rw('Liquid assets ÷ total assets', 'rLiqTA', 'p'),
    Rw('Loans (principal) ÷ member savings', 'rL2S', 'p'),
    H('Savings movement'), Rw('Deposits received', 'dep', 'm', FL), Rw('Withdrawals paid', 'wd', 'm', FL)] },
  { id: 'cap', n: 'Capital Adequacy Return', s: 'Capital Adequacy',
    note: 'Core capital = member share capital + reserves + retained earnings (retained earnings derived from the financial position). Institutional capital excludes member share capital.',
    rows: [
      H('Core capital'), Rw('Member share capital', 'i_sh'), Rw('Statutory / other reserves', 'i_rs'),
      Rw('Retained earnings & surplus (derived)', 're'), Rw('TOTAL CORE CAPITAL', 'core', 'm', { b: 1 }),
      Rw('Institutional capital (reserves + retained earnings)', 'inst'),
      H('Asset base'), Rw('Total assets', 'ta'), Rw('Member savings / deposits', 'sb'),
      H('Capital adequacy ratios'), Rw('Core capital ÷ total assets', 'rCore', 'p', { th: ['min', 'minCore'], b: 1 }),
      Rw('Core capital above / (below) required minimum', 'capGap'),
      Rw('Institutional capital ÷ total assets', 'rInst', 'p', { th: ['min', 'minInst'] }), Rw('Net worth ÷ member savings', 'rNW2S', 'p')] },
  { id: 'pqr', n: 'Portfolio Quality & Loan Loss Provisioning', s: 'Portfolio Quality', rows: [
    H('Portfolio'), Rw('Active loans (number)', 'nl', 'n'), Rw('Principal outstanding', 'prin'), Rw('Interest receivable', 'intr'),
    Rw('Gross portfolio', 'gross', 'm', { b: 1 }),
    H('Ageing of principal outstanding'), ...BK.map((b, i) => Rw(b, 'bk' + i)),
    H('Number of loans by ageing'), ...BK.map((b, i) => Rw(b, 'bn' + i, 'n')),
    H('Provision required'), ...BK.map((b, i) => Rw('Provision - ' + b, 'bp' + i)),
    Rw('TOTAL PROVISION REQUIRED', 'prov', 'm', { b: 1 }), Rw('Provision ÷ principal outstanding', 'rPC', 'p'),
    H('Portfolio at risk (on principal)'), Rw('Overdue 1 day and above', 'rP1', 'p'),
    Rw('PAR 30', 'rP30', 'p', { th: ['max', 'maxP30'] }), Rw('PAR 60', 'rP60', 'p'), Rw('PAR 90', 'rP90', 'p', { th: ['max', 'maxP90'] }),
    H('Activity in period'), Rw('Loans disbursed (amount)', 'dis', 'm', FL), Rw('Loans disbursed (number)', 'disn', 'n', FL),
    Rw('Principal repaid', 'rp', 'm', FL), Rw('Interest collected', 'ri', 'm', FL)] },
  { id: 'mem', n: 'Membership & Savings Return', s: 'Membership',
    note: 'Member numbers are the members currently registered (the system does not record a registration date).',
    rows: [
      H('Membership'), Rw('Registered members', 'mem', 'n'), Rw('Members with a savings balance', 'msv', 'n'),
      Rw('Active borrowers', 'nb', 'n'), Rw('Active loans', 'nl', 'n'),
      H('Savings'), Rw('Member savings balance', 'sb', 'm', { b: 1 }), Rw('Average savings per member', 'asv'),
      Rw('Deposits in period', 'dep', 'm', FL), Rw('Withdrawals in period', 'wd', 'm', FL), Rw('Net savings movement', 'nsm', 'm', FL),
      H('Intermediation'), Rw('Loans (principal) ÷ member savings', 'rL2S', 'p')] }
];

/* aggregation */
const mean = (a, k) => { const v = a.map(s => s[k]).filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((t, x) => t + x, 0) / v.length : null; };
const tot = (a, k) => a.length ? a.reduce((t, s) => t + (s[k] || 0), 0) : null;
const C = (v, t) => ({ v, t }), TX = v => C(v, 's');

function formatCell(c) {
  if (!c) return '';
  if (c.t === 's') return String(c.v ?? '');
  if (c.v == null || isNaN(c.v)) return 'n/a';
  switch (c.t) {
    case 'p': return c.v.toFixed(2) + '%';
    case 'pp': return (c.v >= 0 ? '+' : '') + c.v.toFixed(2) + ' pp';
    case 'c': return (c.v >= 0 ? '+' : '') + c.v.toFixed(1) + '%';
    default: return Math.round(c.v).toLocaleString('en-US');
  }
}

function windows(eng, q) {
  const mode = ['m', 'mom', 'yoy'].includes(q.mode) ? q.mode : 'm';
  const asAt = /^\d{4}-\d{2}$/.test(q.asAt || '') ? q.asAt : null;
  if (!asAt) throw httpErr(400, 'asAt (YYYY-MM) is required');
  if (asAt > curMk()) throw httpErr(400, 'asAt cannot be in the future');
  const n = [3, 6, 12].includes(+q.n) ? +q.n : 6;
  const [y, m1] = asAt.split('-').map(Number), m0 = m1 - 1, fk = eng.firstKey();
  const ok = ([a, b]) => fk && mkS(a, b) >= fk;
  let cur = [], prv = [];
  if (mode === 'm') cur = [[y, m0]];
  else if (mode === 'mom') for (let i = n - 1; i >= 0; i--) { const d = new Date(y, m0 - i, 1); cur.push([d.getFullYear(), d.getMonth()]); }
  else for (let i = 0; i <= m0; i++) { cur.push([y, i]); prv.push([y - 1, i]); }
  const req = cur.length;
  return { mode, asAt, n, y, m0, req, fk, cur: cur.filter(ok).map(([a, b]) => eng.snap(a, b)), prv: prv.filter(ok).map(([a, b]) => eng.snap(a, b)) };
}

const basis = W => W.mode === 'm' ? 'Month-end ' + W.asAt
  : W.mode === 'mom' ? `Month-on-month average, ${W.n} months to ${W.asAt}`
    : `Year-on-year average, Jan-${MN3[W.m0]} ${W.y} vs Jan-${MN3[W.m0]} ${W.y - 1}`;

function buildReturn(tpl, W, cfg) {
  const hasF = tpl.rows.some(r => r.a === 'flow'), { cur, prv, mode: m } = W;
  const head = ['Item'];
  if (m === 'm') head.push('Value');
  else if (m === 'mom') head.push(...cur.map(s => s.mk), 'Average', ...(hasF ? ['Total'] : []), 'Change vs prior month');
  else head.push(`Avg ${W.y} (YTD)`, `Avg ${W.y - 1} (YTD)`, 'Change', '% change', ...(hasF ? [`Total ${W.y}`, `Total ${W.y - 1}`] : []));
  head.push('Benchmark', 'Status');
  const rows = tpl.rows.map(r => {
    if (r.h) return { h: r.h };
    const k = r.k, t = r.t, fl = r.a === 'flow', cells = [TX(r.l)];
    let pr;
    if (m === 'm') { pr = cur[0][k]; cells.push(C(pr, t)); }
    else if (m === 'mom') {
      cur.forEach(s => cells.push(C(s[k], t)));
      pr = mean(cur, k); cells.push(C(pr, t));
      if (hasF) cells.push(fl ? C(tot(cur, k), t) : TX(''));
      const n = cur.length;
      cells.push(n > 1 && cur[n - 1][k] != null && cur[n - 2][k] != null ? C(cur[n - 1][k] - cur[n - 2][k], t === 'p' ? 'pp' : t) : TX('n/a'));
    } else {
      const a = mean(cur, k), b = prv.length ? mean(prv, k) : null;
      pr = a; cells.push(C(a, t), b == null ? TX('n/a') : C(b, t));
      const d = a != null && b != null ? a - b : null;
      cells.push(d == null ? TX('n/a') : C(d, t === 'p' ? 'pp' : t));
      cells.push(t === 'p' || d == null || !b ? TX('n/a') : C(d / Math.abs(b) * 100, 'c'));
      if (hasF) cells.push(fl ? C(tot(cur, k), t) : TX(''), fl && prv.length ? C(tot(prv, k), t) : TX(''));
    }
    let st = '';
    if (r.th) {
      const lim = cfg[r.th[1]];
      cells.push(TX((r.th[0] === 'min' ? '>= ' : '<= ') + lim + '%'));
      st = pr == null ? 'n/a' : (r.th[0] === 'min' ? pr >= lim : pr <= lim) ? 'Compliant' : 'Breach';
      cells.push(TX(st));
    } else cells.push(TX(''), TX(''));
    return { c: cells, b: !!r.b, st };
  });
  return { head, rows };
}

function returnNotes(tpl, W, cfg) {
  const a = [];
  if (tpl.note) a.push(tpl.note);
  if (tpl.id === 'pqr') a.push(`Provision rates applied (current / 1-29 / 30-59 / 60-89 / 90+ days): ${cfg.pr.join('% / ')}%. Overdue is measured from loan due date (disbursement date + term); loans with no term recorded are treated as current.`);
  if (W.mode !== 'm') a.push('Averages use month-end balances; flow items (income, deposits, repayments) are monthly averages with period totals shown separately. Only months with recorded data are included.');
  const cnt = {}, nm = Object.fromEntries([...RIS, ...RIF]);
  W.cur.forEach(s => s.miss.forEach(k => cnt[k] = (cnt[k] || 0) + 1));
  const mi = Object.entries(cnt).map(([k, v]) => `${nm[k].split(' (')[0].split(' —')[0]} (${v}/${W.cur.length} months)`).join(', ');
  if (mi) a.push('Financial inputs not entered (treated as zero): ' + mi + '.');
  a.push("Benchmarks are indicative values from the institution settings; confirm they match the regulator's current minimums before submission.");
  a.push("Layout follows a common prudential-return structure; transfer figures to the regulator's prescribed form if a specific form is required.");
  return a;
}

function assembleReturn(S, tplId, q) {
  const eng = makeEngine(S);
  const W = windows(eng, q);
  const list = tplId === 'pack' ? RT : [RT.find(t => t.id === tplId)];
  if (!list[0]) throw httpErr(404, 'Unknown return template');
  if (!W.cur.length) throw httpErr(422, 'No financial data on or before the selected month');
  return {
    meta: {
      regulator: eng.cfg.reg, licence: eng.cfg.lic || '', basis: basis(W), asAt: W.asAt, mode: W.mode,
      monthsIncluded: W.cur.length, monthsRequested: W.req,
      comparativeMonths: W.mode === 'yoy' ? W.prv.length : undefined, currency: 'UGX'
    },
    returns: list.map(tpl => {
      const o = buildReturn(tpl, W, eng.cfg);
      return { id: tpl.id, name: tpl.n, sheet: tpl.s, head: o.head, rows: o.rows, notes: returnNotes(tpl, W, eng.cfg) };
    })
  };
}

/* ------------------------------------------------------------------ */
/* export helpers                                                      */
/* ------------------------------------------------------------------ */
const csvOf = aoa => '\ufeff' + aoa.map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
function loadXlsx() {
  try { return require('xlsx'); } catch (e) { throw httpErr(501, 'Excel export requires the "xlsx" package (npm i xlsx). Use format=csv or json.'); }
}
function sendCsv(res, aoa, name) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` }).send(csvOf(aoa));
}
function sendXlsx(res, sheets, name) {
  const XLSX = loadXlsx(), wb = XLSX.utils.book_new();
  sheets.forEach(([title, aoa]) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    Object.keys(ws).forEach(k => { if (k[0] !== '!' && ws[k].t === 'n') ws[k].z = '#,##0'; });
    XLSX.utils.book_append_sheet(wb, ws, String(title).slice(0, 31));
  });
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${name}.xlsx"`
  }).send(buf);
}
function returnAoa(meta, r, user) {
  const A = [['ELITE SACCO MBARARA'], [r.name], ['Regulator', meta.regulator], ['Registration / licence no.', meta.licence || '-'],
    ['Basis', meta.basis], ['Months included', `${meta.monthsIncluded} of ${meta.monthsRequested}`], ['Amounts', 'UGX'],
    ['Generated', `${today()} by ${user.name} (${user.ini || ''})`], [], r.head];
  r.rows.forEach(x => A.push(x.h ? [x.h] : x.c.map(c => c.t === 's' ? c.v : formatCell(c))));
  A.push([], ['Notes'], ...r.notes.map(n => [n]), [],
    [`Prepared by: ${user.name}`, 'Signature: ____________', 'Date: ____________'],
    ['Reviewed by (Treasurer)', 'Signature: ____________', 'Date: ____________'],
    ['Approved by (Manager / Chairperson)', 'Signature: ____________', 'Date: ____________']);
  return A;
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */
module.exports = function createReportsRouter({ store, auth }) {
  if (!store) throw new Error('reports: a store is required');
  const router = express.Router();
  if (auth) router.use(auth);
  router.use((req, res, next) => req.user ? next() : res.status(401).json({ error: 'Not authenticated' }));

  const allow = (...roles) => (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Your role does not have access to this report' });
  const audit = (req, act, part) => {
    if (typeof store.addAudit !== 'function') return;
    const u = req.user;
    return Promise.resolve(store.addAudit({ t: new Date().toISOString(), ini: u.ini || '', user: u.name, role: u.role, act, part })).catch(() => {});
  };
  const state = async () => {
    const S = await store.getState();
    return { members: [], savings: [], loans: [], regin: {}, ...S };
  };

  /* ---------- Statements ---------- */
  // GET /statements            -> members list with current position (for the Accounts screen)
  router.get('/statements', wrap(async (req, res) => {
    const S = await state(), qs = String(req.query.q || '').trim().toLowerCase();
    const rows = S.members
      .filter(m => !qs || `${m.first} ${m.last} ${m.acc}`.toLowerCase().includes(qs))
      .map(m => {
        const sd = S.savings.filter(s => s.acc === m.acc);
        const dep = sd.filter(s => !s.w).reduce((t, s) => t + s.amt, 0), wd = sd.filter(s => s.w).reduce((t, s) => t + s.amt, 0);
        const ls = S.loans.filter(l => l.acc === m.acc), out = ls.reduce((t, l) => t + bal(l).b, 0);
        return { acc: m.acc, name: `${m.first} ${m.last}`, tel: m.tel || '', deposits: dep, withdrawals: wd, savings: dep - wd,
          loansTaken: ls.reduce((t, l) => t + l.amt, 0), repayments: ls.reduce((t, l) => t + paid(l), 0),
          outstanding: Math.round(out), activeLoans: ls.filter(l => bal(l).b >= .5).length, net: Math.round(dep - wd - out) };
      });
    res.json({ count: rows.length, members: rows });
  }));

  // GET /statements/:acc?period=m|q|y&month=YYYY-MM&quarter=1-4&year=YYYY
  router.get('/statements/:acc', wrap(async (req, res) => {
    const st = buildStatement(await state(), req.params.acc, periodRange(req.query));
    res.json(st);
  }));

  // GET /statements/:acc/export?format=csv|xlsx|json&...same period params
  router.get('/statements/:acc/export', wrap(async (req, res) => {
    const st = buildStatement(await state(), req.params.acc, periodRange(req.query));
    const fmt = String(req.query.format || 'csv').toLowerCase();
    const name = `statement-${st.member.acc.replace(/\s+/g, '-')}-${st.period.from.slice(0, 7)}`;
    await audit(req, 'Statement exported', `Exported ${fmt.toUpperCase()} statement for ${st.member.acc} - ${st.member.name} (${st.period.label})`);
    if (fmt === 'json') return res.json(st);
    const aoa = statementAoa(st, req.user);
    if (fmt === 'csv') return sendCsv(res, aoa, name);
    if (fmt === 'xlsx') return sendXlsx(res, [['Statement', aoa]], name);
    throw httpErr(400, 'format must be csv, xlsx or json');
  }));

  /* ---------- Regulatory returns (Auditing) ---------- */
  const regRoles = allow('Admin', 'Treasurer', 'Credit Supervisor');
  const cfgRoles = allow('Admin', 'Treasurer');

  router.get('/regulatory/templates', regRoles, (req, res) =>
    res.json(RT.map(t => ({ id: t.id, name: t.n, sheet: t.s }))));

  router.get('/regulatory/config', regRoles, wrap(async (req, res) => {
    res.json(normCfg((await state()).rcfg));
  }));

  router.put('/regulatory/config', cfgRoles, express.json(), wrap(async (req, res) => {
    const b = req.body || {}, pct = ['minLiq', 'minCore', 'minInst', 'maxP30', 'maxP90'];
    const out = { reg: String(b.reg || '').trim(), lic: String(b.lic || '').trim() };
    if (!out.reg) throw httpErr(400, 'Regulator name is required');
    for (const k of pct) {
      const v = Number(b[k]);
      if (b[k] === '' || b[k] == null || isNaN(v) || v < 0 || v > 100) throw httpErr(400, `${k} must be between 0 and 100`);
      out[k] = v;
    }
    if (!Array.isArray(b.pr) || b.pr.length !== 5 || b.pr.some(v => isNaN(+v) || +v < 0 || +v > 100))
      throw httpErr(400, 'pr must be five percentages between 0 and 100');
    out.pr = b.pr.map(Number);
    await store.saveRcfg(out);
    await audit(req, 'Regulatory settings changed', 'Updated regulator details, benchmarks and provision rates');
    res.json(normCfg(out));
  }));

  router.get('/regulatory/inputs', regRoles, wrap(async (req, res) => {
    const S = await state();
    res.json({ fields: { balance: RIS.map(([k, l]) => ({ key: k, label: l })), flow: RIF.map(([k, l]) => ({ key: k, label: l })) }, months: S.regin });
  }));

  router.put('/regulatory/inputs/:month', cfgRoles, express.json(), wrap(async (req, res) => {
    const mk = req.params.month;
    if (!/^\d{4}-\d{2}$/.test(mk)) throw httpErr(400, 'month must be YYYY-MM');
    if (mk > curMk()) throw httpErr(400, 'month cannot be in the future');
    const allowed = new Set([...RIS, ...RIF].map(x => x[0])), o = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!allowed.has(k) || v === '' || v == null) continue;
      const n = Number(v);
      if (isNaN(n) || n < 0) throw httpErr(400, `${k} must be zero or more`);
      o[k] = n;
    }
    await store.saveRegin(mk, Object.keys(o).length ? o : null);
    await audit(req, 'Regulatory inputs saved', `Saved financial inputs for ${mk}`);
    res.json({ month: mk, values: o });
  }));

  // GET /regulatory/:tpl?mode=m|mom|yoy&asAt=YYYY-MM&n=3|6|12   (tpl = sum|sfp|inc|liq|cap|pqr|mem|pack)
  router.get('/regulatory/:tpl', regRoles, wrap(async (req, res) => {
    res.json(assembleReturn(await state(), req.params.tpl, req.query));
  }));

  // GET /regulatory/:tpl/export?format=csv|xlsx|json&...
  router.get('/regulatory/:tpl/export', regRoles, wrap(async (req, res) => {
    const out = assembleReturn(await state(), req.params.tpl, req.query);
    const fmt = String(req.query.format || 'xlsx').toLowerCase();
    const name = `elite-sacco-${req.params.tpl === 'pack' ? 'regulatory-pack' : req.params.tpl}-${out.meta.mode}-${out.meta.asAt}`;
    await audit(req, 'Regulatory return exported', `Exported ${req.params.tpl === 'pack' ? 'full regulatory pack' : out.returns[0].name} (${out.meta.basis}) to ${fmt.toUpperCase()}`);
    if (fmt === 'json') return res.json(out);
    const sheets = out.returns.map(r => [r.sheet, returnAoa(out.meta, r, req.user)]);
    if (fmt === 'xlsx') return sendXlsx(res, sheets, name);
    if (fmt === 'csv') return sendCsv(res, sheets.flatMap(([, a]) => [...a, [], []]), name);
    throw httpErr(400, 'format must be csv, xlsx or json');
  }));

  // error handler scoped to this router
  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    if (status >= 500) console.error('[reports]', err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return router;
};

// exposed for unit tests
module.exports._internal = { bal, sim, buildStatement, makeEngine, assembleReturn, RT };
