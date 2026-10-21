/* =====================================================================
   Elite SACCO Mbarara — regulatory.js
   Reports > Auditing: regulatory returns with month-end, month-on-month
   and year-on-year averages.

   HOW IT PLUGS IN
   1. Add before </body> in index.html, after the main script:
        <script src="regulatory.js"></script>
   2. Inside the main script, just before the final "})();", add (same line
      as for statements.js — only once):
        window.ESACCO={get S(){return S},get cu(){return cu},R,audit,save,bal,sim,ini};
   This file REQUIRES that line (it saves monthly inputs and benchmarks).
   Without it, it does nothing and the built-in Auditing screen keeps working.

   It uses the same saved data as the built-in screen (S.regin monthly
   inputs, S.rcfg benchmarks), so nothing already entered is lost.

   REPORTING BASES
   - Month-end snapshot ........ one month, balances at month end
   - Month-on-month (3/6/12) ... each month side by side + average, total
                                 (flows), change vs prior month; months that
                                 breach a benchmark are shown in red
   - Year-on-year (YTD) ........ Jan..chosen month vs same months last year
   - Rolling 12 months ......... last 12 months vs the 12 months before

   HOW AVERAGES ARE TAKEN (only months that have data are included)
   - Balances (assets, savings, capital) ... average of month-end balances
   - Flows (income, deposits, repayments) .. monthly average; totals shown too
   - Ratios ................................ average of the monthly ratios;
                                             change shown in percentage points
   ===================================================================== */
(() => {
'use strict';
const B = window.ESACCO;
if (!B || !B.R || !B.S || !B.bal || !B.sim || !B.save || !B.audit) {
  console.warn('regulatory.js: ESACCO bridge not found. Add the window.ESACCO line described at the top of regulatory.js. The built-in Auditing screen is unchanged.');
  return;
}
if (window.EliteRegulatory) return;

/* ------------------------------ helpers ------------------------------ */
const S = B.S, $ = s => document.querySelector(s);
S.regin = S.regin || {};
const RC0 = { reg: 'Uganda Microfinance Regulatory Authority (UMRA)', lic: '', minLiq: 15, minCore: 10, minInst: 8, maxP30: 5, maxP90: 2, pr: [1, 5, 25, 50, 100] };
S.rcfg = Object.assign({}, RC0, S.rcfg || {});
if (!Array.isArray(S.rcfg.pr) || S.rcfg.pr.length != 5) S.rcfg.pr = RC0.pr.slice();
const cu = () => B.cu, me = () => B.ini(B.cu);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const p2 = n => String(n).padStart(2, '0'), fmtD = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, today = () => fmtD(new Date());
const addM = (d, n) => { d = new Date(d); return new Date(d.getFullYear(), d.getMonth() + n, d.getDate()); };
const MN3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mkS = (y, m0) => y + '-' + p2(m0 + 1);
const curMk = () => { const d = new Date(); return mkS(d.getFullYear(), d.getMonth()); };
const prevMk = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return mkS(d.getFullYear(), d.getMonth()); };
const ROLES_OK = ['Admin', 'Treasurer', 'Credit Supervisor'];

/* Monthly inputs the system does not track elsewhere (same keys as the built-in screen) */
const RIS = [['cash', 'Cash on hand'], ['bank', 'Bank balances'], ['liq', 'Other liquid investments (T-bills, fixed deposits)'], ['oa', 'Other assets (fixed assets, prepayments)'], ['ol', 'Other liabilities (borrowings, payables) — treated as short-term'], ['sh', 'Member share capital'], ['rs', 'Statutory / other reserves']];
const RIF = [['fee', 'Fee & other income (this month)'], ['sint', 'Interest / dividends paid on savings (this month)'], ['opx', 'Operating expenses (this month)']];

/* ------------------------------ monthly snapshots ------------------------------ */
const FKEY = () => {
  const ds = [...S.savings.map(x => x.date), ...S.loans.map(x => x.date), ...S.loans.flatMap(l => (l.reps || []).map(r => r.date))].map(x => new Date(x)).filter(d => !isNaN(d));
  if (!ds.length) return null;
  const d = new Date(Math.min(...ds)); return mkS(d.getFullYear(), d.getMonth());
};
/* Balance items carry forward until changed (carry=true); income/expense items apply to their month only */
const rin = (mk, k, carry) => {
  const d = S.regin, ok = x => x !== undefined && x !== '' && x !== null && !isNaN(+x);
  if (d[mk] && ok(d[mk][k])) return +d[mk][k];
  if (carry) { const ks = Object.keys(d).filter(x => x < mk && d[x] && ok(d[x][k])).sort(); if (ks.length) return +d[ks.at(-1)][k]; }
  return null;
};
const lstats = d => {
  const o = { P: 0, I: 0, G: 0, n: 0, bk: [0, 0, 0, 0, 0], bn: [0, 0, 0, 0, 0], bw: new Set() };
  S.loans.forEach(l => {
    if (new Date(l.date) > d) return;
    const b = B.bal(l, d).b; if (b < .5) return;
    const pp = B.sim(l).filter(r => new Date(r.date) <= d).reduce((t, r) => t + r.p, 0), P = Math.min(b, Math.max(0, l.amt - pp)), I = Math.max(0, b - P);
    let k = 0;
    if (l.term) { const due = addM(l.date, l.term), days = Math.floor((d - due) / 864e5); k = days <= 0 ? 0 : days < 30 ? 1 : days < 60 ? 2 : days < 90 ? 3 : 4; }
    o.P += P; o.I += I; o.G += b; o.n++; o.bk[k] += P; o.bn[k]++; o.bw.add(l.acc || l.nid);
  });
  return o;
};
let SC = {};
const snap = (y, m0) => {
  const mk = mkS(y, m0); if (SC[mk]) return SC[mk];
  const E = new Date(y, m0 + 1, 0, 23, 59, 59, 999), Bg = new Date(y, m0, 1), pv = new Date(+Bg - 1), c = S.rcfg, s = { mk, miss: [] };
  const L = lstats(E), L0 = lstats(pv), inM = x => { const t = new Date(x); return t >= Bg && t <= E; };
  RIS.forEach(([k]) => { const v = rin(mk, k, true); if (v == null) s.miss.push(k); s['i_' + k] = v || 0; });
  RIF.forEach(([k]) => { const v = rin(mk, k, false); if (v == null) s.miss.push(k); s['i_' + k] = v || 0; });
  const sE = S.savings.filter(x => new Date(x.date) <= E);
  s.sb = sE.reduce((t, x) => t + (x.w ? -x.amt : x.amt), 0);
  const mv = S.savings.filter(x => inM(x.date));
  s.dep = mv.filter(x => !x.w).reduce((t, x) => t + x.amt, 0); s.wd = mv.filter(x => x.w).reduce((t, x) => t + x.amt, 0); s.nsm = s.dep - s.wd;
  const hs = {}; sE.forEach(x => hs[x.acc] = (hs[x.acc] || 0) + (x.w ? -x.amt : x.amt));
  s.mem = S.members.length; s.msv = Object.values(hs).filter(v => v > 0).length; s.asv = s.mem ? s.sb / s.mem : null;
  s.nl = L.n; s.nb = L.bw.size; s.prin = L.P; s.intr = L.I; s.gross = L.G;
  s.dis = 0; s.disn = 0; s.rp = 0; s.ri = 0;
  S.loans.forEach(l => { if (inM(l.date)) { s.dis += l.amt; s.disn++; } B.sim(l).forEach(r => { if (inM(r.date)) { s.rp += r.p; s.ri += r.i; } }); });
  L.bk.forEach((v, i) => { s['bk' + i] = v; s['bn' + i] = L.bn[i]; s['bp' + i] = v * c.pr[i] / 100; });
  s.prov = L.bk.reduce((t, v, i) => t + v * c.pr[i] / 100, 0); const prov0 = L0.bk.reduce((t, v, i) => t + v * c.pr[i] / 100, 0); s.nprov = -s.prov;
  s.liqA = s.i_cash + s.i_bank + s.i_liq; s.tl = s.sb + s.i_ol; s.lbase = s.tl; s.ta = s.liqA + s.prin + s.intr - s.prov + s.i_oa;
  s.nw = s.ta - s.tl; s.re = s.nw - s.i_sh - s.i_rs; s.core = s.nw; s.inst = s.i_rs + s.re; s.tle = s.tl + s.nw;
  s.iinc = s.ri + (L.I - L0.I); s.tinc = s.iinc + s.i_fee; s.pexp = s.prov - prov0; s.texp = s.i_sint + s.i_opx + s.pexp; s.sur = s.tinc - s.texp;
  s.liqGap = s.liqA - c.minLiq / 100 * s.lbase; s.capGap = s.core - c.minCore / 100 * s.ta;
  const pc = (a, b) => b > 0 ? a / b * 100 : null, od = i => L.bk.slice(i).reduce((t, v) => t + v, 0);
  s.rLiq = pc(s.liqA, s.lbase); s.rLiqTA = pc(s.liqA, s.ta); s.rL2S = pc(s.prin, s.sb); s.rCore = s.ta > 0 ? pc(s.core, s.ta) : null; s.rInst = s.ta > 0 ? pc(s.inst, s.ta) : null; s.rNW2S = pc(s.nw, s.sb);
  s.rP1 = pc(od(1), s.prin); s.rP30 = pc(od(2), s.prin); s.rP60 = pc(od(3), s.prin); s.rP90 = pc(od(4), s.prin); s.rPC = pc(s.prov, s.prin); s.rOSS = pc(s.tinc, s.texp);
  return SC[mk] = s;
};

/* ------------------------------ return templates ------------------------------ */
const H = h => ({ h }), Rw = (l, k, t, o) => ({ l, k, t: t || 'm', ...(o || {}) }), FL = { a: 'flow' }, FLB = { a: 'flow', b: 1 };
const BK = ['Current (not yet due)', '1-29 days overdue', '30-59 days overdue', '60-89 days overdue', '90+ days overdue'];
const RT = [
  { id: 'sum', n: 'Prudential Ratios Summary', s: 'Ratios', rows: [H('Liquidity'), Rw('Liquidity ratio (liquid assets ÷ savings + short-term liabilities)', 'rLiq', 'p', { th: ['min', 'minLiq'] }), Rw('Liquid assets ÷ total assets', 'rLiqTA', 'p'), Rw('Loans (principal) ÷ member savings', 'rL2S', 'p'),
    H('Capital adequacy'), Rw('Core capital ÷ total assets', 'rCore', 'p', { th: ['min', 'minCore'] }), Rw('Institutional capital (reserves + retained earnings) ÷ total assets', 'rInst', 'p', { th: ['min', 'minInst'] }), Rw('Net worth ÷ member savings', 'rNW2S', 'p'),
    H('Asset quality (on outstanding principal)'), Rw('Portfolio at risk, 30 days and above (PAR 30)', 'rP30', 'p', { th: ['max', 'maxP30'] }), Rw('Portfolio at risk, 90 days and above (PAR 90)', 'rP90', 'p', { th: ['max', 'maxP90'] }), Rw('Loan loss provision ÷ principal outstanding', 'rPC', 'p'),
    H('Earnings'), Rw('Total income ÷ total expenses (operating self-sufficiency)', 'rOSS', 'p')] },
  { id: 'sfp', n: 'Statement of Financial Position', s: 'Financial Position', note: 'Retained earnings is derived: total assets less liabilities, member share capital and reserves. Cash, bank, other assets/liabilities, share capital and reserves come from the monthly financial inputs.', rows: [
    H('Assets'), Rw('Cash on hand', 'i_cash'), Rw('Bank balances', 'i_bank'), Rw('Other liquid investments', 'i_liq'), Rw('Loans to members and others (principal outstanding)', 'prin'), Rw('Interest receivable on loans', 'intr'), Rw('Less: loan loss provision', 'nprov'), Rw('Other assets', 'i_oa'), Rw('TOTAL ASSETS', 'ta', 'm', { b: 1 }),
    H('Liabilities'), Rw('Member savings / deposits', 'sb'), Rw('Other liabilities', 'i_ol'), Rw('TOTAL LIABILITIES', 'tl', 'm', { b: 1 }),
    H('Equity'), Rw('Member share capital', 'i_sh'), Rw('Statutory / other reserves', 'i_rs'), Rw('Retained earnings & surplus (derived)', 're'), Rw('TOTAL EQUITY (core capital)', 'nw', 'm', { b: 1 }), Rw('TOTAL LIABILITIES AND EQUITY', 'tle', 'm', { b: 1 })] },
  { id: 'inc', n: 'Statement of Income', s: 'Income', note: 'Interest income is on an accrual basis (interest collected plus the movement in interest receivable). Provision expense is the movement in the required provision (see Portfolio Quality). Fee income, savings interest/dividends and operating expenses come from the monthly financial inputs.', rows: [
    H('Income'), Rw('Interest income on loans (accrual)', 'iinc', 'm', FL), Rw('Fee & other income', 'i_fee', 'm', FL), Rw('TOTAL INCOME', 'tinc', 'm', FLB),
    H('Expenses'), Rw('Interest / dividends paid on savings', 'i_sint', 'm', FL), Rw('Operating expenses', 'i_opx', 'm', FL), Rw('Loan loss provision expense', 'pexp', 'm', FL), Rw('TOTAL EXPENSES', 'texp', 'm', FLB),
    H('Result'), Rw('NET SURPLUS / (DEFICIT)', 'sur', 'm', FLB), Rw('Operating self-sufficiency (income ÷ expenses)', 'rOSS', 'p'),
    H('Memo: loan activity'), Rw('Loans disbursed', 'dis', 'm', FL), Rw('Principal repaid', 'rp', 'm', FL), Rw('Interest collected', 'ri', 'm', FL)] },
  { id: 'liq', n: 'Liquidity Return', s: 'Liquidity', rows: [
    H('Liquid assets'), Rw('Cash on hand', 'i_cash'), Rw('Bank balances', 'i_bank'), Rw('Other liquid investments', 'i_liq'), Rw('TOTAL LIQUID ASSETS', 'liqA', 'm', { b: 1 }),
    H('Liability base'), Rw('Member savings / deposits', 'sb'), Rw('Other short-term liabilities', 'i_ol'), Rw('TOTAL SAVINGS AND SHORT-TERM LIABILITIES', 'lbase', 'm', { b: 1 }),
    H('Liquidity position'), Rw('Liquidity ratio', 'rLiq', 'p', { th: ['min', 'minLiq'], b: 1 }), Rw('Liquid assets above / (below) required minimum', 'liqGap'), Rw('Liquid assets ÷ total assets', 'rLiqTA', 'p'), Rw('Loans (principal) ÷ member savings', 'rL2S', 'p'),
    H('Savings movement'), Rw('Deposits received', 'dep', 'm', FL), Rw('Withdrawals paid', 'wd', 'm', FL)] },
  { id: 'cap', n: 'Capital Adequacy Return', s: 'Capital Adequacy', note: 'Core capital = member share capital + reserves + retained earnings (retained earnings derived from the financial position). Institutional capital excludes member share capital.', rows: [
    H('Core capital'), Rw('Member share capital', 'i_sh'), Rw('Statutory / other reserves', 'i_rs'), Rw('Retained earnings & surplus (derived)', 're'), Rw('TOTAL CORE CAPITAL', 'core', 'm', { b: 1 }), Rw('Institutional capital (reserves + retained earnings)', 'inst'),
    H('Asset base'), Rw('Total assets', 'ta'), Rw('Member savings / deposits', 'sb'),
    H('Capital adequacy ratios'), Rw('Core capital ÷ total assets', 'rCore', 'p', { th: ['min', 'minCore'], b: 1 }), Rw('Core capital above / (below) required minimum', 'capGap'), Rw('Institutional capital ÷ total assets', 'rInst', 'p', { th: ['min', 'minInst'] }), Rw('Net worth ÷ member savings', 'rNW2S', 'p')] },
  { id: 'pqr', n: 'Portfolio Quality & Loan Loss Provisioning', s: 'Portfolio Quality', rows: [
    H('Portfolio'), Rw('Active loans (number)', 'nl', 'n'), Rw('Principal outstanding', 'prin'), Rw('Interest receivable', 'intr'), Rw('Gross portfolio', 'gross', 'm', { b: 1 }),
    H('Ageing of principal outstanding'), ...BK.map((b, i) => Rw(b, 'bk' + i)),
    H('Number of loans by ageing'), ...BK.map((b, i) => Rw(b, 'bn' + i, 'n')),
    H('Provision required'), ...BK.map((b, i) => Rw('Provision - ' + b, 'bp' + i)), Rw('TOTAL PROVISION REQUIRED', 'prov', 'm', { b: 1 }), Rw('Provision ÷ principal outstanding', 'rPC', 'p'),
    H('Portfolio at risk (on principal)'), Rw('Overdue 1 day and above', 'rP1', 'p'), Rw('PAR 30', 'rP30', 'p', { th: ['max', 'maxP30'] }), Rw('PAR 60', 'rP60', 'p'), Rw('PAR 90', 'rP90', 'p', { th: ['max', 'maxP90'] }),
    H('Activity in period'), Rw('Loans disbursed (amount)', 'dis', 'm', FL), Rw('Loans disbursed (number)', 'disn', 'n', FL), Rw('Principal repaid', 'rp', 'm', FL), Rw('Interest collected', 'ri', 'm', FL)] },
  { id: 'mem', n: 'Membership & Savings Return', s: 'Membership', note: 'Member numbers are the members currently registered (the system does not record a registration date).', rows: [
    H('Membership'), Rw('Registered members', 'mem', 'n'), Rw('Members with a savings balance', 'msv', 'n'), Rw('Active borrowers', 'nb', 'n'), Rw('Active loans', 'nl', 'n'),
    H('Savings'), Rw('Member savings balance', 'sb', 'm', { b: 1 }), Rw('Average savings per member', 'asv'), Rw('Deposits in period', 'dep', 'm', FL), Rw('Withdrawals in period', 'wd', 'm', FL), Rw('Net savings movement', 'nsm', 'm', FL),
    H('Intermediation'), Rw('Loans (principal) ÷ member savings', 'rL2S', 'p')] }
];

/* ------------------------------ reporting windows ------------------------------ */
const RS = { mode: 'm', asAt: '', n: 6, tpl: 'sum' };
const wins = () => {
  const [y, m1] = RS.asAt.split('-').map(Number), m0 = m1 - 1, fk = FKEY(), ok = ([a, b]) => fk && mkS(a, b) >= fk;
  let cur = [], prv = [], lc = '', lp = '';
  const mo = k => { const d = new Date(y, m0 - k, 1); return [d.getFullYear(), d.getMonth()]; };
  if (RS.mode == 'm') cur = [[y, m0]];
  else if (RS.mode == 'mom') { for (let i = RS.n - 1; i >= 0; i--) cur.push(mo(i)); }
  else if (RS.mode == 'yoy') { for (let i = 0; i <= m0; i++) { cur.push([y, i]); prv.push([y - 1, i]); } lc = 'YTD ' + y; lp = 'YTD ' + (y - 1); }
  else { for (let i = 11; i >= 0; i--) { cur.push(mo(i)); prv.push(mo(i + 12)); } lc = '12m to ' + RS.asAt; lp = '12m to ' + mkS(...mo(12)); }
  const req = cur.length;
  cur = cur.filter(ok).map(([a, b]) => snap(a, b)); prv = prv.filter(ok).map(([a, b]) => snap(a, b));
  return { mode: RS.mode, y, m0, cur, prv, req, fk, lc, lp, cmp: RS.mode == 'yoy' || RS.mode == 'r12' };
};
const basis = W => W.mode == 'm' ? 'Month-end ' + RS.asAt
  : W.mode == 'mom' ? 'Month-on-month average, ' + RS.n + ' months to ' + RS.asAt
  : W.mode == 'yoy' ? 'Year-on-year average, Jan-' + MN3[W.m0] + ' ' + W.y + ' vs Jan-' + MN3[W.m0] + ' ' + (W.y - 1)
  : 'Rolling 12 months to ' + RS.asAt + ' vs the previous 12 months';

/* ------------------------------ building the output table ------------------------------ */
const mean = (a, k) => { const v = a.map(s => s[k]).filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((t, x) => t + x, 0) / v.length : null; };
const tot = (a, k) => a.length ? a.reduce((t, s) => t + (s[k] || 0), 0) : null;
const C = (v, t, bad) => ({ v, t, bad }), TX = v => C(v, 's');
const FM = c => {
  if (!c) return ''; if (c.t == 's') return String(c.v ?? '');
  if (c.v == null || isNaN(c.v)) return 'n/a'; const v = c.v;
  switch (c.t) { case 'p': return v.toFixed(2) + '%'; case 'pp': return (v >= 0 ? '+' : '') + v.toFixed(2) + ' pp'; case 'c': return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; default: return Math.round(v).toLocaleString('en-US'); }
};
const breach = (th, v) => { if (!th || v == null) return false; const lim = S.rcfg[th[1]]; return th[0] == 'min' ? v < lim : v > lim; };
const outFor = (tpl, W) => {
  const c = S.rcfg, m = W.mode, hasF = tpl.rows.some(r => r.a == 'flow'), cur = W.cur, prv = W.prv, head = ['Item'];
  if (m == 'm') head.push('Value');
  else if (m == 'mom') head.push(...cur.map(s => s.mk), 'Average', ...(hasF ? ['Total'] : []), 'Change vs prior month');
  else head.push('Avg ' + W.lc, 'Avg ' + W.lp, 'Change', '% change', ...(hasF ? ['Total ' + W.lc, 'Total ' + W.lp] : []));
  head.push('Benchmark', 'Status');
  const rows = tpl.rows.map(r => {
    if (r.h) return { h: r.h };
    const k = r.k, t = r.t, fl = r.a == 'flow', cells = [TX(r.l)]; let pr;
    if (m == 'm') { pr = cur[0][k]; cells.push(C(pr, t, breach(r.th, pr))); }
    else if (m == 'mom') {
      cur.forEach(s => cells.push(C(s[k], t, breach(r.th, s[k]))));
      pr = mean(cur, k); cells.push(C(pr, t));
      if (hasF) cells.push(fl ? C(tot(cur, k), t) : TX(''));
      const n = cur.length;
      cells.push(n > 1 && cur[n - 1][k] != null && cur[n - 2][k] != null ? C(cur[n - 1][k] - cur[n - 2][k], t == 'p' ? 'pp' : t) : TX('n/a'));
    } else {
      const a = mean(cur, k), b = prv.length ? mean(prv, k) : null; pr = a;
      cells.push(C(a, t), b == null ? TX('n/a') : C(b, t));
      const d = a != null && b != null ? a - b : null;
      cells.push(d == null ? TX('n/a') : C(d, t == 'p' ? 'pp' : t));
      cells.push(t == 'p' || d == null || !b ? TX('n/a') : C(d / Math.abs(b) * 100, 'c'));
      if (hasF) cells.push(fl ? C(tot(cur, k), t) : TX(''), fl && prv.length ? C(tot(prv, k), t) : TX(''));
    }
    let st = '';
    if (r.th) {
      const lim = c[r.th[1]];
      cells.push(TX((r.th[0] == 'min' ? '≥ ' : '≤ ') + lim + '%'));
      st = pr == null ? 'n/a' : breach(r.th, pr) ? 'Breach' : 'Compliant'; cells.push(TX(st));
    } else cells.push(TX(''), TX(''));
    return { c: cells, b: r.b, st };
  });
  return { title: tpl.n, head, rows };
};
const rhtml = o => {
  const n = o.head.length;
  return `<div class="tw"><table><tr>${o.head.map((h, i) => `<th class="${i && i < n - 2 ? 'n' : ''}">${esc(h)}</th>`).join('')}</tr>${o.rows.map(r => r.h
    ? `<tr><td colspan="${n}" style="background:var(--blue-soft);color:var(--blue);font-weight:800">${esc(r.h)}</td></tr>`
    : `<tr>${r.c.map((c, i) => {
      const f = esc(FM(c)), b = r.b ? ';font-weight:800' : '';
      if (i == 0) return `<td style="white-space:normal;min-width:280px${b}">${f}</td>`;
      if (i == n - 1) return `<td>${r.st ? `<span class="bd ${r.st == 'Compliant' ? 'ok' : r.st == 'Breach' ? 'no' : 'pen'}">${r.st}</span>` : ''}</td>`;
      return `<td class="${c.t != 's' ? 'n' : ''}" style="${b.slice(1)}${c.bad ? ';color:#D62828;font-weight:700' : ''}">${f}</td>`;
    }).join('')}</tr>`).join('')}</table></div>`;
};
const missInfo = W => {
  const cnt = {}, nm = Object.fromEntries([...RIS, ...RIF]);
  W.cur.forEach(s => s.miss.forEach(k => cnt[k] = (cnt[k] || 0) + 1));
  return Object.entries(cnt).map(([k, v]) => nm[k].split(' (')[0].split(' —')[0] + ' (' + v + '/' + W.cur.length + ' months)').join(', ');
};
const notes = (tpl, W) => {
  const a = [];
  if (tpl.note) a.push(tpl.note);
  if (tpl.id == 'pqr') a.push('Provision rates applied (current / 1-29 / 30-59 / 60-89 / 90+ days): ' + S.rcfg.pr.join('% / ') + '%. Overdue is measured from loan due date (disbursement date + term); loans with no term recorded are treated as current.');
  if (W.mode != 'm') a.push('Averaging: balances are the average of month-end balances; flows (income, deposits, repayments) are monthly averages with period totals shown separately; ratios are the average of the monthly ratios and changes in ratios are in percentage points (pp). Only months with recorded data are included.');
  if (W.mode == 'mom') a.push('Months shown in red breach the benchmark for that month; the Status column tests the average.');
  if (W.cmp && W.prv.length < W.cur.length) a.push('The comparative period has data for ' + W.prv.length + ' of ' + W.cur.length + ' months; its average covers the available months only.');
  const mi = missInfo(W); if (mi) a.push('Financial inputs not entered (treated as zero): ' + mi + '.');
  a.push('Benchmarks are the indicative values under Institution & benchmarks; confirm they match the regulator\'s current minimums before submission.');
  a.push('Layout follows a common prudential-return structure; transfer figures to the regulator\'s prescribed form if a specific form is required.');
  return a;
};

/* ------------------------------ exports ------------------------------ */
const cl = s => String(s ?? '').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/÷/g, '/').replace(/[—–]/g, '-').replace(/[^\x00-\x7F]/g, '');
const hdrLines = (tpl, W) => [['ELITE SACCO MBARARA'], [tpl.n], ['Regulator', S.rcfg.reg], ['Registration / licence no.', S.rcfg.lic || '-'], ['Basis', basis(W)], ['Months included', W.cur.length + ' of ' + W.req + (W.cmp ? ' (comparative period: ' + W.prv.length + ')' : '')], ['Amounts', 'UGX'], ['Generated', today() + ' by ' + cu().name + ' (' + me() + ')'], []];
const xsheet = (tpl, W) => {
  const o = outFor(tpl, W), A = hdrLines(tpl, W), Z = {}; A.push(o.head);
  o.rows.forEach(r => {
    if (r.h) { A.push([r.h]); return; }
    A.push(r.c.map((c, i) => { if (c.v == null) return 'n/a'; if (c.t != 's' && !isNaN(c.v)) { Z[A.length + ',' + i] = c.t; return c.t == 'p' || c.t == 'c' ? c.v / 100 : c.v; } return c.v; }));
  });
  A.push([], ['Notes'], ...notes(tpl, W).map(t => [t]), [], ['Prepared by: ' + cu().name + ' (' + me() + ')', 'Signature: ____________', 'Date: ____________'], ['Reviewed by (Treasurer)', 'Signature: ____________', 'Date: ____________'], ['Approved by (Manager / Chairperson)', 'Signature: ____________', 'Date: ____________']);
  const ws = XLSX.utils.aoa_to_sheet(A);
  Object.entries(Z).forEach(([k, t]) => { const [r, c] = k.split(',').map(Number), a = ws[XLSX.utils.encode_cell({ r, c })]; if (a && typeof a.v == 'number') a.z = t == 'p' || t == 'c' ? '0.00%' : t == 'pp' ? '0.00" pp"' : '#,##0'; });
  ws['!cols'] = [{ wch: 62 }, ...o.head.slice(1).map(() => ({ wch: 16 }))]; return ws;
};
const pdfPage = (P, tpl, W, first) => {
  if (!first) P.addPage();
  const o = outFor(tpl, W), n = o.head.length, pw = P.internal.pageSize.getWidth(), ph = P.internal.pageSize.getHeight();
  P.setFontSize(15); P.setTextColor(27, 60, 145); P.text('Elite SACCO Mbarara', 40, 38);
  P.setFontSize(11); P.setTextColor(0); P.text(cl(tpl.n + ' - ' + basis(W)), 40, 56);
  P.setFontSize(8.5); P.text(cl('Regulator: ' + S.rcfg.reg + '    Registration/licence no.: ' + (S.rcfg.lic || '-')), 40, 72);
  P.text(cl('Months included: ' + W.cur.length + ' of ' + W.req + '    Amounts in UGX    Generated ' + today() + ' by ' + cu().name + ' (' + me() + ')'), 40, 84);
  const body = o.rows.map(r => r.h ? [{ content: cl(r.h), colSpan: n, styles: { fillColor: [233, 238, 251], textColor: [27, 60, 145], fontStyle: 'bold' } }] : r.c.map(c => cl(FM(c))));
  P.autoTable({
    startY: 96, head: [o.head.map(cl)], body, styles: { fontSize: n > 10 ? 6.5 : 8, cellPadding: 3 }, headStyles: { fillColor: [27, 60, 145] },
    columnStyles: Object.fromEntries(o.head.map((_, i) => [i, { halign: i && i < n - 2 ? 'right' : 'left' }])),
    didParseCell: h => {
      if (h.section != 'body') return; const r = o.rows[h.row.index]; if (!r || r.h) return;
      if (r.b) h.cell.styles.fontStyle = 'bold';
      const c = r.c[h.column.index]; if (c && c.bad) h.cell.styles.textColor = [214, 40, 40];
      if (r.st && h.column.index == n - 1) h.cell.styles.textColor = r.st == 'Breach' ? [214, 40, 40] : r.st == 'Compliant' ? [10, 122, 59] : [90, 104, 144];
    },
    didDrawPage: () => { P.setFontSize(7); P.setTextColor(120); P.text(cl('Elite SACCO Mbarara - ' + tpl.n + ' - ' + basis(W) + ' - Page ' + P.internal.getNumberOfPages()), 40, ph - 18); P.setTextColor(0); }
  });
  let y = P.lastAutoTable.finalY + 14; P.setFontSize(7.5); P.setTextColor(0);
  const ns = notes(tpl, W).flatMap(t => P.splitTextToSize(cl('Note: ' + t), pw - 80));
  if (y + ns.length * 10 + 70 > ph - 30) { P.addPage(); y = 40; }
  ns.forEach(l => { P.text(l, 40, y); y += 10; }); y += 26; const cw = (pw - 80) / 3;
  ['Prepared by: ' + cu().name + ' (' + me() + ')', 'Reviewed by (Treasurer)', 'Approved by (Manager / Chairperson)'].forEach((t, i) => { const x = 40 + i * cw; P.line(x, y, x + cw - 20, y); P.text(cl(t), x, y + 10); P.text('Date:', x, y + 22); });
};
const fname = (list, ext) => 'elite-sacco-' + (list.length > 1 ? 'regulatory-pack' : list[0].id) + '-' + RS.mode + '-' + RS.asAt + '.' + ext;
const what = list => list.length > 1 ? 'full regulatory pack' : list[0].n;

/* ------------------------------ screen ------------------------------ */
const msg = (id, t, e) => { const m = $('#' + id); if (m) { m.className = 'msg' + (e ? ' err' : ''); m.textContent = t; } };
const table = (h, rows) => `<div class="tw"><table><tr>${h.map((x, i) => `<th class="${i ? 'n' : ''}">${esc(x)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map((x, i) => `<td class="${i ? 'n' : ''}">${esc(x)}</td>`).join('')}</tr>`).join('')}</table></div>`;

const mount = () => {
  if (!ROLES_OK.includes(cu().role)) return B.R.home();
  SC = {};
  const V = $('#view'), fk = FKEY(), canCfg = cu().role == 'Admin' || cu().role == 'Treasurer', c = S.rcfg;
  const auto = () => fk && fk > prevMk() ? curMk() : prevMk();
  if (!RS.asAt || RS.asAt > curMk()) RS.asAt = auto();
  const dis = canCfg ? '' : ' disabled';
  const inp = (id, l, v, ex) => `<div><label>${l}</label><input id="${id}" ${ex || 'type="number" min="0" step="0.01"'} value="${esc(v)}"${dis}></div>`;
  V.innerHTML = `<div class="card noprint"><h3>Generate regulatory return</h3>
<div class="row"><div><label>Return / template</label><select id="rt">${RT.map(t => `<option value="${t.id}">${t.n}</option>`).join('')}</select></div>
<div><label>Reporting basis</label><select id="rb"><option value="m">Month-end snapshot</option><option value="mom">Month-on-month average</option><option value="yoy">Year-on-year average (YTD)</option><option value="r12">Rolling 12 months vs previous 12</option></select></div>
<div><label>As at month</label><input id="ra" type="month" max="${curMk()}"></div>
<div id="rnw"><label>Months in average</label><select id="rn"><option>3</option><option>6</option><option>12</option></select></div></div>
<p class="note" id="rinfo"></p>
<button class="btn" id="e1">Export PDF</button><button class="btn alt2" id="e2">Export Excel</button><button class="btn alt2" id="e3">Full pack — PDF</button><button class="btn alt2" id="e4">Full pack — Excel</button><button class="btn alt2" id="e5">Print</button><button class="btn alt2" id="e6">Latest period (auto)</button>
<div id="msg" class="msg"></div></div>
<details class="card noprint"><summary style="cursor:pointer;font-weight:800;color:var(--blue)">Monthly financial inputs (cash, bank, capital, income &amp; expenses)</summary>
<p class="note">Loans, savings and interest are calculated automatically from the system records. Items below are not tracked elsewhere. Balance items (first seven) carry forward to later months until changed; income and expense items apply to that month only.</p>
<div class="row"><div><label>Month</label><input id="im" type="month" max="${curMk()}" value="${RS.asAt}"></div></div>
<div class="row">${RIS.concat(RIF).map(([k, l]) => inp('in_' + k, l, '')).join('')}</div>
<button class="btn" id="isv"${dis}>Save inputs for month</button><div id="msg3" class="msg"></div><div id="isaved"></div></details>
<details class="card noprint"><summary style="cursor:pointer;font-weight:800;color:var(--blue)">Institution &amp; benchmarks</summary>
<p class="note">Benchmarks are indicative defaults. Replace them with the minimums in the regulator's current guidelines. Provision rates are applied to principal outstanding by overdue bucket.</p>
<div class="row">${inp('cg_reg', 'Regulator', c.reg, 'type="text"')}${inp('cg_lic', 'Registration / licence no.', c.lic, 'type="text"')}${inp('cg_minLiq', 'Minimum liquidity ratio (%)', c.minLiq)}${inp('cg_minCore', 'Minimum core capital ÷ total assets (%)', c.minCore)}${inp('cg_minInst', 'Minimum institutional capital ÷ total assets (%)', c.minInst)}${inp('cg_maxP30', 'Maximum PAR 30 (%)', c.maxP30)}${inp('cg_maxP90', 'Maximum PAR 90 (%)', c.maxP90)}</div>
<div class="row">${BK.map((b, i) => inp('cg_pr' + i, 'Provision % — ' + b, c.pr[i])).join('')}</div>
<button class="btn" id="csv"${dis}>Save settings</button><div id="msg2" class="msg"></div>${canCfg ? '' : '<p class="note">Only the System Admin or Treasurer can change these settings.</p>'}</details>
<div id="rep"><div class="card"><h2 id="rtt" style="font-size:1.35rem"></h2><p class="note" id="rcap"></p><div id="rres"></div><div id="rnt" class="note"></div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1.5rem;margin-top:2rem;font-size:.85rem"><div style="border-top:1.5px solid #000;padding-top:.4rem">Prepared by: ${esc(cu().name)} (${esc(me())})<br>Date:</div><div style="border-top:1.5px solid #000;padding-top:.4rem">Reviewed by (Treasurer)<br>Date:</div><div style="border-top:1.5px solid #000;padding-top:.4rem">Approved by (Manager / Chairperson)<br>Date:</div></div></div></div>`;
  $('#rt').value = RS.tpl; $('#rb').value = RS.mode; $('#ra').value = RS.asAt; $('#rn').value = RS.n;

  const draw = () => {
    RS.mode = $('#rb').value; RS.tpl = $('#rt').value; RS.n = +$('#rn').value; if ($('#ra').value) RS.asAt = $('#ra').value;
    if (RS.asAt > curMk()) { RS.asAt = curMk(); $('#ra').value = RS.asAt; }
    $('#rnw').style.display = RS.mode == 'mom' ? '' : 'none';
    const W = wins(), tpl = RT.find(t => t.id == RS.tpl);
    $('#rinfo').textContent = (W.fk ? 'Financial data is recorded from ' + W.fk + '. ' : 'No loan or savings records exist yet. ') + W.cur.length + ' of ' + W.req + ' month(s) in the selected window have data and are included' + (W.cmp ? '; the comparative period has ' + W.prv.length + ' month(s)' : '') + '. ' +
      (W.mode == 'yoy' ? 'Year-on-year compares January to the chosen month with the same months a year earlier.' : W.mode == 'r12' ? 'Rolling 12 months compares the 12 months to the chosen month with the 12 months before.' : '');
    $('#rtt').textContent = tpl.n;
    if (!W.cur.length) { $('#rcap').textContent = ''; $('#rres').innerHTML = '<p class="msg err">No financial data on or before the selected month. Choose a later month or record savings/loans first.</p>'; $('#rnt').innerHTML = ''; return; }
    $('#rcap').textContent = S.rcfg.reg + ' · ' + basis(W) + ' · Amounts in UGX';
    $('#rres').innerHTML = rhtml(outFor(tpl, W));
    $('#rnt').innerHTML = notes(tpl, W).map(t => '<p>' + esc(t) + '</p>').join('');
  };
  ['rt', 'rb', 'rn'].forEach(i => $('#' + i).onchange = draw); $('#ra').onchange = $('#ra').oninput = draw;

  const run = (list, kind) => {
    const W = wins(); if (!W.cur.length) return msg('msg', 'No data for the selected period.', 1);
    try {
      if (kind == 'pdf') {
        if (!(window.jspdf && jspdf.jsPDF)) return msg('msg', 'PDF library could not load — check your internet connection.', 1);
        const P = new jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' }); list.forEach((t, i) => pdfPage(P, t, W, i == 0)); P.save(fname(list, 'pdf'));
      } else {
        if (!window.XLSX) return msg('msg', 'Excel library could not load — check your internet connection.', 1);
        const wb = XLSX.utils.book_new(); list.forEach(t => XLSX.utils.book_append_sheet(wb, xsheet(t, W), t.s)); XLSX.writeFile(wb, fname(list, 'xlsx'));
      }
      B.audit('Regulatory return exported', 'Exported ' + what(list) + ' (' + basis(W) + ') to ' + (kind == 'pdf' ? 'PDF' : 'Excel')); msg('msg', 'Exported.');
    } catch (e) { msg('msg', 'Export failed: ' + e.message, 1); }
  };
  const one = () => [RT.find(t => t.id == RS.tpl)];
  $('#e1').onclick = () => run(one(), 'pdf'); $('#e2').onclick = () => run(one(), 'xlsx'); $('#e3').onclick = () => run(RT, 'pdf'); $('#e4').onclick = () => run(RT, 'xlsx');
  $('#e5').onclick = () => { B.audit('Regulatory return printed', one()[0].n + ' (' + RS.asAt + ')'); window.print(); };
  $('#e6').onclick = () => { $('#ra').value = auto(); draw(); };

  const all = RIS.concat(RIF);
  const loadIn = () => {
    const mk = $('#im').value; if (!mk) return;
    all.forEach(([k], i) => { const e = (S.regin[mk] || {})[k], el = $('#in_' + k), cv = i < RIS.length ? rin(mk, k, true) : null; el.value = e === undefined ? '' : e; el.placeholder = e === undefined && cv != null ? 'carried: ' + cv.toLocaleString('en-US') : '0'; });
  };
  const saved = () => {
    const ks = Object.keys(S.regin).sort().reverse();
    $('#isaved').innerHTML = ks.length ? '<h3 style="margin-top:1rem">Saved months</h3>' + table(['Month', ...all.map(x => x[1].split(' (')[0].split(' —')[0])], ks.map(m => [m, ...all.map(([k]) => S.regin[m][k] !== undefined ? Math.round(S.regin[m][k]).toLocaleString('en-US') : '')])) : '';
  };
  $('#im').onchange = loadIn; loadIn(); saved();
  $('#isv').onclick = () => {
    if (!canCfg) return; const mk = $('#im').value; if (!mk) return msg('msg3', 'Choose a month.', 1);
    const o = {}; let bad = 0;
    all.forEach(([k]) => { const v = $('#in_' + k).value.trim(); if (v === '') return; const n = +v; if (isNaN(n) || n < 0) bad = 1; else o[k] = n; });
    if (bad) return msg('msg3', 'Enter valid amounts (zero or more).', 1);
    if (!Object.keys(o).length) delete S.regin[mk]; else S.regin[mk] = o;
    B.audit('Regulatory inputs saved', 'Saved financial inputs for ' + mk); B.save(); SC = {}; loadIn(); saved(); draw(); msg('msg3', 'Inputs saved for ' + mk + '.');
  };
  $('#csv').onclick = () => {
    if (!canCfg) return; const g = id => $('#' + id).value.trim(), nn = id => +g(id);
    const ids = ['cg_minLiq', 'cg_minCore', 'cg_minInst', 'cg_maxP30', 'cg_maxP90', 'cg_pr0', 'cg_pr1', 'cg_pr2', 'cg_pr3', 'cg_pr4'];
    if (ids.some(i => g(i) === '' || isNaN(nn(i)) || nn(i) < 0 || nn(i) > 100)) return msg('msg2', 'Percentages must be between 0 and 100.', 1);
    if (!g('cg_reg')) return msg('msg2', 'Regulator name is required.', 1);
    Object.assign(S.rcfg, { reg: g('cg_reg'), lic: g('cg_lic'), minLiq: nn('cg_minLiq'), minCore: nn('cg_minCore'), minInst: nn('cg_minInst'), maxP30: nn('cg_maxP30'), maxP90: nn('cg_maxP90'), pr: [0, 1, 2, 3, 4].map(i => nn('cg_pr' + i)) });
    B.audit('Regulatory settings changed', 'Updated regulator details, benchmarks and provision rates'); B.save(); SC = {}; draw(); msg('msg2', 'Settings saved.');
  };
  draw();
};

B.R.regrep = mount;                                              // take over Reports > Auditing
window.EliteRegulatory = { mount, snap, wins, outFor, FM, RT, RS, notes, basis, clearCache: () => { SC = {}; } };
})();
