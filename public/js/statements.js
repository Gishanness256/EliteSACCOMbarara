/* =====================================================================
   Elite SACCO Mbarara — statements.js
   Weekly, Monthly and Annual statements + Member statements.

   HOW IT PLUGS IN
   1. Add this line just before </body> in index.html (after the main script):
        <script src="statements.js"></script>
   2. (Recommended) Add this ONE line inside the main script, just before the
      final "})();", so statements.js shares live data and writes to the audit log:
        window.ESACCO={get S(){return S},get cu(){return cu},R,audit,save,bal,sim,ini};
      Without that line it still works: it reads the saved data from
      localStorage ("esacco") and hooks the Reports > Statements menu button,
      but exports/prints are then not written to the System Auditor log.

   WHAT IT PROVIDES (Reports > Statements)
   - Weekly statement   (Mon–Sun week containing the chosen date)
   - Monthly statement  (chosen month)
   - Annual statement   (chosen year, with a month-by-month breakdown)
   - Member statement   (any member; weekly / monthly / quarterly / annual / custom range)
   Each can be viewed on screen and exported to PDF, Excel, CSV or printed.
   Weekly/Monthly/Annual tabs follow the "Weekly / Monthly / Annual reports"
   permissions in Access Levels. Member statements are open to all users
   (same as the Accounts screen).
   ===================================================================== */
(() => {
'use strict';
if (window.EliteStatements) return;

/* ------------------------------ helpers ------------------------------ */
const $ = s => document.querySelector(s);
const bridge = () => window.ESACCO || null;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = n => 'UGX ' + Math.round(n || 0).toLocaleString('en-US');
const p2 = n => String(n).padStart(2, '0');
const fD = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const today = () => fD(new Date());
const pdate = s => { const m = String(s || '').match(/^(\d{4})-(\d\d)-(\d\d)/); return m ? new Date(+m[1], m[2] - 1, +m[3]) : null; };
const addD = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const wkStart = d => addD(d, -((d.getDay() + 6) % 7));            // Monday
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON3 = MONTHS.map(m => m.slice(0, 3));
const DAY3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const isoWeek = d => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())), dn = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dn);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { w: Math.ceil(((t - y0) / 864e5 + 1) / 7), y: t.getUTCFullYear() };
};
const dl = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const aud = (act, part) => { const b = bridge(); if (b && typeof b.audit === 'function') b.audit(act, part); };

/* ------------------------------ data access ------------------------------ */
const loadS = () => {
  const b = bridge();
  if (b && b.S) return b.S;
  try {
    const x = JSON.parse(localStorage.getItem('esacco') || 'null');
    if (x) return Object.assign({ users: [], members: [], savings: [], loans: [], roles: {}, non: [] }, x);
  } catch (e) { /* ignore */ }
  return { users: [], members: [], savings: [], loans: [], roles: {}, non: [] };
};
const initials = u => u.ini || (u.name || '').split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 3);
const curUser = () => {
  const b = bridge();
  if (b && b.cu) return b.cu;
  const t = ($('#who') || {}).textContent || '', m = t.match(/Signed in as\s+(\S+)\s+·\s+(.+)$/), S = loadS();
  return (m && (S.users || []).find(x => x.email == m[1])) || { name: m ? m[1] : 'User', email: m ? m[1] : '', role: m ? m[2].trim() : 'Admin' };
};
const PERM_IDX = { weekly: 6, monthly: 7, annual: 8 };            // positions in the app's PERMS list
const allowed = (S, u, tab) => tab == 'member' || u.role == 'Admin' || !!(S.roles && S.roles[u.role] && S.roles[u.role][PERM_IDX[tab]]);
const memOf = (S, a) => (S.members || []).find(m => m.acc == a);
const who = (S, l) => {
  const m = memOf(S, l.acc);
  if (m) return { acc: m.acc, name: m.first + ' ' + m.last };
  const n = (S.non || []).find(x => x.id == l.nid);
  return { acc: '', name: (n ? n.name : 'Unknown') + ' (non-member)' };
};

/* Loan engine — identical to the one in index.html (interest compounds monthly on the
   loan's anniversary; repayments reduce the balance). Uses the app's own functions when
   the ESACCO bridge is present so numbers always agree with the Ledger. */
function balLocal(l, to = new Date()) {
  const r = l.rate / 100, d = new Date(l.date), rp = (l.reps || []).map(x => [new Date(x.date), x.amt]);
  let b = l.amt, k = 0, prev = new Date(+d - 1);
  while (true) {
    const nx = new Date(d.getFullYear(), d.getMonth() + k + 1, d.getDate());
    if (nx > to) break;
    const p = rp.filter(x => x[0] > prev && x[0] <= nx).reduce((a, x) => a + x[1], 0);
    b = Math.max(0, b - p) * (1 + r); prev = nx; k++;
  }
  b -= rp.filter(x => x[0] > prev && x[0] <= to).reduce((a, x) => a + x[1], 0);
  return { b: Math.max(0, b), k };
}
function simLocal(l) {
  const r = l.rate / 100, d = new Date(l.date), rp = [...(l.reps || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  let P = l.amt, I = 0, k = 0; const out = [];
  const nx = () => new Date(d.getFullYear(), d.getMonth() + k + 1, d.getDate());
  rp.forEach(x => {
    const xd = new Date(x.date);
    while (nx() < xd) { I += (P + I) * r; k++; }
    let a = x.amt; const i = Math.min(a, I); I -= i; a -= i;
    const p = Math.min(a, P); P -= p;
    out.push({ date: x.date, p, i, bal: P + I, ini: x.ini, type: x.type });
  });
  return out;
}
const BAL = (l, t) => ((bridge() && bridge().bal) || balLocal)(l, t);
const SIM = l => ((bridge() && bridge().sim) || simLocal)(l);
const lBal = (l, t) => +new Date(l.date) > +t ? 0 : BAL(l, t).b;
const lref = (l, i) => l.ref || 'LN-' + String(i + 1).padStart(4, '0');
const dueOf = l => { const d = pdate(l.date); return d && l.term ? new Date(d.getFullYear(), d.getMonth() + (+l.term), d.getDate()) : null; };

/* ------------------------------ periods ------------------------------ */
const KINDS = [['weekly', 'Weekly'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['annual', 'Annual'], ['custom', 'Custom range']];
const mkP = (kind, p) => {
  const now = new Date();
  if (kind == 'weekly') {
    const f = wkStart(pdate(p.date) || now), t = addD(f, 7), w = isoWeek(f);
    return { kind, from: f, to: t, label: `Week ${w.w}, ${w.y} (${fD(f)} to ${fD(addD(t, -1))})`, file: `${w.y}-W${p2(w.w)}` };
  }
  if (kind == 'monthly') {
    const m = String(p.month || '').match(/^(\d{4})-(\d\d)$/) || [], y = +m[1] || now.getFullYear(), mo = (+m[2] || now.getMonth() + 1) - 1;
    return { kind, from: new Date(y, mo, 1), to: new Date(y, mo + 1, 1), label: `${MONTHS[mo]} ${y}`, file: `${y}-${p2(mo + 1)}` };
  }
  if (kind == 'quarterly') {
    const y = +p.year || now.getFullYear(), q = Math.min(4, Math.max(1, +p.q || 1));
    return { kind, from: new Date(y, (q - 1) * 3, 1), to: new Date(y, q * 3, 1), label: `Q${q} ${y} (${MON3[(q - 1) * 3]} - ${MON3[q * 3 - 1]})`, file: `${y}-Q${q}` };
  }
  if (kind == 'annual') {
    const y = +p.year || now.getFullYear();
    return { kind, from: new Date(y, 0, 1), to: new Date(y + 1, 0, 1), label: `Year ${y} (1 Jan - 31 Dec)`, file: String(y) };
  }
  const f = pdate(p.from), e = pdate(p.to);
  if (!f || !e || e < f) return null;
  return { kind: 'custom', from: f, to: addD(e, 1), label: `${fD(f)} to ${fD(e)}`, file: `${fD(f)}_to_${fD(e)}` };
};

/* Split a period into day / week / month buckets for the breakdown table and chart */
const buckets = (f, t) => {
  const days = Math.round((t - f) / 864e5), unit = days <= 8 ? 'd' : days <= 35 ? 'w' : 'm', edges = [+f];
  let c = new Date(f);
  while (true) {
    c = unit == 'd' ? addD(c, 1) : unit == 'w' ? addD(wkStart(c), 7) : new Date(c.getFullYear(), c.getMonth() + 1, 1);
    if (+c >= +t) break;
    edges.push(+c);
  }
  edges.push(+t);
  const multiYear = new Date(edges[0]).getFullYear() != new Date(edges[edges.length - 1] - 1).getFullYear();
  const labels = [], short = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = new Date(edges[i]), b = new Date(edges[i + 1] - 1);
    if (unit == 'd') { labels.push(`${DAY3[a.getDay()]} ${a.getDate()} ${MON3[a.getMonth()]}`); short.push(`${DAY3[a.getDay()]} ${a.getDate()}`); }
    else if (unit == 'w') { labels.push(`${a.getDate()} ${MON3[a.getMonth()]} - ${b.getDate()} ${MON3[b.getMonth()]}`); short.push(`${a.getDate()} ${MON3[a.getMonth()]}`); }
    else { labels.push(`${MON3[a.getMonth()]} ${a.getFullYear()}`); short.push(MON3[a.getMonth()] + (multiYear ? " '" + String(a.getFullYear()).slice(2) : '')); }
  }
  return { unit, name: { d: 'Day', w: 'Week', m: 'Month' }[unit], edges, labels, short };
};
const bIdx = (edges, t) => { for (let i = edges.length - 2; i >= 0; i--) if (t >= edges[i]) return i; return 0; };

/* ------------------------------ calculations ------------------------------ */
/* Period boundaries. The effective end is capped at "now", so an unfinished week/month/year
   shows figures to date and balances are never projected into the future. */
const core = P => {
  const t0 = +P.from, t1 = Math.max(t0, Math.min(+P.to, Date.now() + 1));
  return { t0, t1, open: new Date(t0 - 1), asAt: new Date(t1 - 1), inR: d => { const t = +new Date(d); return t >= t0 && t < t1; }, partial: +P.to > Date.now() + 1 };
};
const loanData = (S, C, keep) => (S.loans || []).map((l, i) => ({ l, i })).filter(x => !keep || keep(x.l)).map(({ l, i }) => {
  const ld = +new Date(l.date), rs = SIM(l).filter(r => C.inR(r.date));
  const open = lBal(l, C.open), close = lBal(l, C.asAt), dis = ld >= C.t0 && ld < C.t1 ? l.amt : 0;
  const p = rs.reduce((a, r) => a + r.p, 0), it = rs.reduce((a, r) => a + r.i, 0);
  return { l, i, ref: lref(l, i), w: who(S, l), open, close, dis, p, it, rs, accr: close - open - dis + p + it };
});
const tx = {
  sv: s => ({ t: +new Date(s.date), a: s.w ? -s.amt : s.amt })
};
const SIG = ['Reviewed by (Treasurer)', 'Approved by (Manager / Chairperson)'];

/* ---------- institution statement (weekly / monthly / annual) ---------- */
const buildInst = (S, tab, P) => {
  const C = core(P), L = loanData(S, C), bk = buckets(P.from, P.to), n = bk.edges.length - 1, u = curUser();
  const Z = () => new Array(n).fill(0), B = { dep: Z(), wd: Z(), dis: Z(), pr: Z(), ip: Z() };
  let sOpen = 0, dep = 0, wd = 0, nd = 0, nw = 0;
  const chan = {}, accs = {}, srows = [], inRange = [];
  (S.savings || []).forEach(s => {
    const { t, a } = tx.sv(s), A = accs[s.acc] || (accs[s.acc] = { open: 0, dep: 0, wd: 0 });
    if (t < C.t0) { sOpen += a; A.open += a; return; }
    if (t >= C.t1) return;
    const i = bIdx(bk.edges, t), c = chan[s.ch || 'Not recorded'] || (chan[s.ch || 'Not recorded'] = { d: 0, w: 0 });
    if (s.w) { wd += s.amt; nw++; B.wd[i] += s.amt; A.wd += s.amt; c.w += s.amt; } else { dep += s.amt; nd++; B.dep[i] += s.amt; A.dep += s.amt; c.d += s.amt; }
    inRange.push(s);
  });
  const sClose = sOpen + dep - wd;
  inRange.sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(s => {
    const m = memOf(S, s.acc);
    srows.push([fD(new Date(s.date)), s.ref || '', s.acc, m ? m.first + ' ' + m.last : '', s.w ? 'Withdrawal' : 'Deposit', s.ch || '', s.slip || '', s.w ? '' : s.amt, s.w ? s.amt : '']);
  });
  let lOpen = 0, lClose = 0, lDis = 0, lP = 0, lI = 0, lAcc = 0, nLoans = 0, active = 0;
  const cats = {}, lrows = [];
  L.forEach(x => {
    lOpen += x.open; lClose += x.close; lDis += x.dis; lP += x.p; lI += x.it; lAcc += x.accr; if (x.close >= .5) active++;
    if (x.dis) {
      nLoans++; B.dis[bIdx(bk.edges, +new Date(x.l.date))] += x.dis;
      const c = cats[x.l.cat || 'Uncategorised'] || (cats[x.l.cat || 'Uncategorised'] = { n: 0, a: 0 }); c.n++; c.a += x.dis;
      lrows.push({ t: +new Date(x.l.date), r: [fD(new Date(x.l.date)), x.ref, x.w.acc, x.w.name, 'Disbursement' + (x.l.cat ? ' - ' + x.l.cat : ''), x.dis, '', '', x.l.amt] });
    }
    x.rs.forEach(r => { const i = bIdx(bk.edges, +new Date(r.date)); B.pr[i] += r.p; B.ip[i] += r.i; lrows.push({ t: +new Date(r.date), r: [fD(new Date(r.date)), x.ref, x.w.acc, x.w.name, 'Repayment' + (r.type ? ' (' + r.type + ')' : ''), '', r.p, r.i, r.bal] }); });
  });
  lrows.sort((a, b) => a.t - b.t);
  const inflow = dep + lP + lI, outflow = wd + lDis, net = inflow - outflow;
  const net_b = B.dep.map((_, i) => B.dep[i] + B.pr[i] + B.ip[i] - B.wd[i] - B.dis[i]);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const brows = bk.labels.map((lb, i) => [lb, B.dep[i], B.wd[i], B.dis[i], B.pr[i], B.ip[i], net_b[i]]);
  brows.push(['Total', dep, wd, lDis, lP, lI, sum(net_b)]);
  const accRows = Object.keys(accs).filter(a => accs[a].dep || accs[a].wd).sort().map(a => {
    const m = memOf(S, a), A = accs[a]; return [a, m ? m.first + ' ' + m.last : '', A.open, A.dep, A.wd, A.open + A.dep - A.wd];
  });
  if (accRows.length) accRows.push(['', 'Total', sum(accRows.map(r => r[2])), dep, wd, sum(accRows.map(r => r[5]))]);
  const chRows = Object.keys(chan).sort((a, b) => (chan[b].d + chan[b].w) - (chan[a].d + chan[a].w)).map(k => [k, chan[k].d, chan[k].w]);
  const catRows = Object.keys(cats).sort().map(k => [k, cats[k].n, cats[k].a]);
  const name = { weekly: 'Weekly', monthly: 'Monthly', annual: 'Annual' }[tab];
  const empty = !nd && !nw && !lDis && !lP && !lI;
  const notes = [
    'Loan balances include interest compounded monthly on each loan\'s anniversary date, calculated by the system from the loan records.',
    'Interest accrued is the balancing figure between opening and closing loan balances (closing = opening + disbursed + interest accrued - principal repaid - interest paid).',
    'Net cash movement = savings deposits + loan repayments received - savings withdrawals - loans disbursed.'
  ];
  if (C.partial) notes.unshift('This period is not yet complete. Figures are shown up to ' + today() + '.');
  if (empty) notes.unshift('No savings or loan transactions were recorded in this period.');
  return {
    file: `${tab}-statement-${P.file}`, title: `${name} Financial Statement`, sub: `${P.label} · Amounts in UGX`,
    audit: `${name} statement, ${P.label}`, by: `${u.name} (${initials(u)})`, sign: SIG,
    meta: [['Statement period', P.label], ['Covers', `${fD(P.from)} to ${fD(addD(P.to, -1))}`], ['Registered members', String(S.members.length)], ['Members with savings activity', String(Object.keys(accs).filter(a => accs[a].dep || accs[a].wd).length)], ['Generated', `${today()} by ${u.name} (${initials(u)})`]],
    kpis: [['Deposits', dep], ['Withdrawals', wd], ['Loans disbursed', lDis], ['Repayments received', lP + lI], ['Closing savings', sClose], ['Loans outstanding', lClose]],
    chart: { labels: bk.short, series: [{ n: 'Deposits', c: '#1B3C91', v: B.dep }, { n: 'Loans disbursed', c: '#E07A1F', v: B.dis }, { n: 'Repayments', c: '#2E9E5B', v: B.pr.map((x, i) => x + B.ip[i]) }] },
    sections: [
      { title: 'Savings movement', head: ['Item', 'UGX'], num: [1], bold: [3], rows: [['Opening savings balance', sOpen], [`Add: deposits received (${nd})`, dep], [`Less: withdrawals paid (${nw})`, wd], ['Closing savings balance', sClose]] },
      { title: 'Loan portfolio movement', head: ['Item', 'UGX'], num: [1], bold: [5], rows: [['Opening loans outstanding', lOpen], [`Add: loans disbursed (${nLoans})`, lDis], ['Add: interest accrued (calculated)', lAcc], ['Less: principal repaid', lP], ['Less: interest paid', lI], ['Closing loans outstanding', lClose], ['Active loans at period end', active]] },
      { title: 'Cash flow', head: ['Item', 'UGX'], num: [1], bold: [3, 6, 7], rows: [['Savings deposits received', dep], ['Loan principal repaid', lP], ['Loan interest received', lI], ['Total cash inflows', inflow], ['Savings withdrawals paid', wd], ['Loans disbursed', lDis], ['Total cash outflows', outflow], ['Net cash movement', net]] },
      { title: `Activity by ${bk.name.toLowerCase()}`, head: [bk.name, 'Deposits', 'Withdrawals', 'Loans disbursed', 'Principal repaid', 'Interest paid', 'Net cash'], num: [1, 2, 3, 4, 5, 6], bold: [brows.length - 1], rows: brows },
      { title: 'Savings by channel', head: ['Channel', 'Deposits', 'Withdrawals'], num: [1, 2], rows: chRows, empty: 'No savings transactions in this period.' },
      { title: 'Loans disbursed by category', head: ['Category', 'Loans', 'Amount'], num: [1, 2], rows: catRows, empty: 'No loans were disbursed in this period.' },
      { title: 'Member savings activity', head: ['Account', 'Member', 'Opening balance', 'Deposits', 'Withdrawals', 'Closing balance'], num: [2, 3, 4, 5], bold: accRows.length ? [accRows.length - 1] : [], rows: accRows, empty: 'No member savings activity in this period.' },
      { title: 'Savings transactions', head: ['Date', 'Ref', 'Account', 'Member', 'Type', 'Channel', 'Slip no.', 'Deposit', 'Withdrawal'], num: [7, 8], rows: srows, empty: 'No savings transactions in this period.' },
      { title: 'Loan activity', head: ['Date', 'Loan ref', 'Account', 'Borrower', 'Particulars', 'Disbursed', 'Principal repaid', 'Interest paid', 'Loan balance'], num: [5, 6, 7, 8], rows: lrows.map(x => x.r), empty: 'No loan disbursements or repayments in this period.' }
    ],
    notes
  };
};

/* ---------- member statement ---------- */
const buildMember = (S, m, P) => {
  const C = core(P), u = curUser();
  let open = 0, dep = 0, wd = 0;
  const list = [];
  (S.savings || []).filter(s => s.acc == m.acc).forEach(s => {
    const { t, a } = tx.sv(s);
    if (t < C.t0) open += a; else if (t < C.t1) list.push(s);
  });
  list.sort((a, b) => new Date(a.date) - new Date(b.date));
  let run = open;
  const srows = [['', '', '', '', 'Opening balance', '', '', open]];
  list.forEach(s => { s.w ? (wd += s.amt, run -= s.amt) : (dep += s.amt, run += s.amt); srows.push([fD(new Date(s.date)), s.ref || '', s.ch || '', s.slip || '', s.rm || '', s.w ? '' : s.amt, s.w ? s.amt : '', run]); });
  const sClose = open + dep - wd;
  srows.push(['', '', '', '', 'Closing balance', dep, wd, sClose]);

  const L = loanData(S, C, l => l.acc == m.acc).filter(x => x.open >= .5 || x.dis || x.rs.length);
  let lOpen = 0, lClose = 0, lDis = 0, lP = 0, lI = 0, lAcc = 0;
  const lsum = [], ltx = [];
  L.forEach(x => {
    lOpen += x.open; lClose += x.close; lDis += x.dis; lP += x.p; lI += x.it; lAcc += x.accr;
    const due = dueOf(x.l), st = x.close < .5 ? 'Cleared' : (due && due < C.asAt ? 'Overdue' : 'Active');
    lsum.push([x.ref, x.l.cat || '', fD(new Date(x.l.date)), x.l.term ? x.l.term + ' mo' : '', x.l.rate != null ? x.l.rate + '%/mo' : '', x.l.amt, due ? fD(due) : '', x.p + x.it, x.close, st]);
    if (x.dis) ltx.push({ t: +new Date(x.l.date), r: [fD(new Date(x.l.date)), x.ref, 'Loan disbursement' + (x.l.cat ? ' - ' + x.l.cat : ''), x.dis, '', '', x.l.amt] });
    x.rs.forEach(r => ltx.push({ t: +new Date(r.date), r: [fD(new Date(r.date)), x.ref, 'Repayment' + (r.type ? ' (' + r.type + ')' : ''), '', r.p, r.i, r.bal] }));
  });
  ltx.sort((a, b) => a.t - b.t);
  const ltxRows = ltx.map(x => x.r);
  if (ltxRows.length) ltxRows.push(['', '', 'Totals for the period', lDis, lP, lI, lClose]);
  const net = sClose - lClose, name = m.first + ' ' + m.last;
  const notes = [
    'Loan balances include interest compounded monthly on each loan\'s anniversary date. Repayments are applied to accrued interest first, then to principal.',
    'Net position = closing savings balance less closing loan balance.',
    'Please report any discrepancy to the SACCO office within 14 days of receiving this statement.'
  ];
  if (C.partial) notes.unshift('This period is not yet complete. Figures are shown up to ' + today() + '.');
  if (!list.length && !L.length) notes.unshift('No savings or loan transactions were recorded for this member in this period.');
  return {
    file: `member-statement-${m.acc.replace(/\s+/g, '-')}-${P.file}`, title: 'Member Account Statement', sub: `${m.acc} · ${name} · ${P.label} · Amounts in UGX`,
    audit: `Member statement ${m.acc} - ${name}, ${P.label}`, by: `${u.name} (${initials(u)})`, sign: ['Authorised signatory (SACCO)', 'Member acknowledgement'],
    meta: [['Account', m.acc], ['Member', name], ['Telephone', m.tel || ''], ['Address', m.addr || ''], ['Statement period', P.label], ['Covers', `${fD(P.from)} to ${fD(addD(P.to, -1))}`], ['Generated', `${today()} by ${u.name} (${initials(u)})`]],
    kpis: [['Opening savings', open], ['Deposits', dep], ['Withdrawals', wd], ['Closing savings', sClose], ['Closing loan balance', lClose], ['Net position', net]],
    sections: [
      { title: 'Savings summary', head: ['Item', 'UGX'], num: [1], bold: [3], rows: [['Opening savings balance', open], ['Add: deposits', dep], ['Less: withdrawals', wd], ['Closing savings balance', sClose]] },
      { title: 'Loan summary', head: ['Item', 'UGX'], num: [1], bold: [5, 6], rows: [['Opening loan balance', lOpen], ['Add: loans disbursed', lDis], ['Add: interest accrued (calculated)', lAcc], ['Less: principal repaid', lP], ['Less: interest paid', lI], ['Closing loan balance', lClose], ['Net position (savings less loans)', net]] },
      { title: 'Savings transactions', head: ['Date', 'Ref', 'Channel', 'Slip no.', 'Remarks', 'Deposit', 'Withdrawal', 'Balance'], num: [5, 6, 7], bold: [0, srows.length - 1], rows: srows },
      { title: 'Loans', head: ['Loan ref', 'Category', 'Disbursed', 'Term', 'Rate', 'Principal', 'Due date', 'Paid in period', 'Balance at period end', 'Status'], num: [5, 7, 8], rows: lsum, empty: 'No loans for this member in this period.' },
      { title: 'Loan transactions', head: ['Date', 'Loan ref', 'Particulars', 'Disbursed', 'Principal repaid', 'Interest paid', 'Loan balance'], num: [3, 4, 5, 6], bold: ltxRows.length ? [ltxRows.length - 1] : [], rows: ltxRows, empty: 'No loan transactions in this period.' }
    ],
    notes
  };
};

/* ------------------------------ renderers ------------------------------ */
const cell = c => c == null || c === '' ? '' : typeof c == 'number' ? Math.round(c).toLocaleString('en-US') : esc(c);
const tblH = s => {
  const nm = new Set(s.num || []), bd = new Set(s.bold || []);
  return `<div class="tw"><table><tr>${s.head.map((h, i) => `<th class="${nm.has(i) ? 'n' : ''}">${esc(h)}</th>`).join('')}</tr>${s.rows.length
    ? s.rows.map((r, ri) => `<tr class="${bd.has(ri) ? 'tot' : ''}">${r.map((c, i) => `<td class="${nm.has(i) ? 'n' : ''}">${cell(c)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${s.head.length}">${esc(s.empty || 'No records in this period.')}</td></tr>`}</table></div>`;
};
const chartSVG = c => {
  const W = 560, H = 190, n = c.labels.length, bw = W / n, k = c.series.length, mx = Math.max(1, ...c.series.flatMap(s => s.v));
  const bars = c.labels.map((lb, i) => c.series.map((s, j) => {
    const h = s.v[i] / mx * (H - 10), w = (bw - 8) / k - 1;
    return `<rect x="${i * bw + 4 + j * (bw - 8) / k}" y="${H - h}" width="${w}" height="${h}" fill="${s.c}"><title>${esc(s.n)}: ${Math.round(s.v[i]).toLocaleString('en-US')}</title></rect>`;
  }).join('') + `<text x="${i * bw + bw / 2}" y="${H + 14}" font-size="${n > 8 ? 8 : 9}" text-anchor="middle" fill="#52639c">${esc(lb)}</text>`).join('');
  return `<h3>Activity trend</h3><svg viewBox="0 0 ${W} ${H + 20}" width="100%" role="img" aria-label="Activity trend chart">${bars}</svg><div class="lg">${c.series.map(s => `<span><b style="background:${s.c}"></b>${esc(s.n)}</span>`).join('')}</div>`;
};
const docHTML = d => `<div class="card stdoc"><h2 style="font-size:1.35rem">Elite SACCO Mbarara — ${esc(d.title)}</h2><p class="note">${esc(d.sub)}</p>
<div class="stmeta">${d.meta.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v) || '—'}</b></div>`).join('')}</div>
<div class="kpis">${d.kpis.map(([k, v]) => `<div class="kpi">${esc(k)}<b>${fmt(v)}</b></div>`).join('')}</div>
${d.chart ? chartSVG(d.chart) : ''}${d.sections.map(s => `<h3 style="margin-top:1.2rem">${esc(s.title)}</h3>${tblH(s)}`).join('')}
<div class="note" style="margin-top:1rem">${d.notes.map(t => `<p>${esc(t)}</p>`).join('')}</div>
<div class="stsig"><div>Prepared by: ${esc(d.by)}<br>Date:</div>${d.sign.map(t => `<div>${esc(t)}<br>Date:</div>`).join('')}</div></div>`;

/* ------------------------------ exports ------------------------------ */
const toAOA = d => {
  const A = [['ELITE SACCO MBARARA'], [d.title], [d.sub], [], ...d.meta.map(([k, v]) => [k, v]), [], ['KEY FIGURES (UGX)'], ...d.kpis.map(([k, v]) => [k, Math.round(v)]), []];
  d.sections.forEach(s => A.push([s.title.toUpperCase()], s.head, ...(s.rows.length ? s.rows.map(r => r.map(c => typeof c == 'number' ? Math.round(c) : c)) : [[s.empty || 'No records in this period.']]), []));
  A.push(['NOTES'], ...d.notes.map(t => [t]), [], ['Prepared by: ' + d.by, 'Signature: ____________', 'Date: ____________'], ...d.sign.map(t => [t, 'Signature: ____________', 'Date: ____________']));
  return A;
};
const toCSV = d => '\ufeff' + toAOA(d).map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
const toXLSX = d => {
  if (!window.XLSX) return false;
  const ws = XLSX.utils.aoa_to_sheet(toAOA(d));
  Object.keys(ws).forEach(k => { if (k[0] != '!' && ws[k].t == 'n') ws[k].z = '#,##0'; });
  const w = Math.max(...d.sections.map(s => s.head.length));
  ws['!cols'] = [{ wch: 40 }, ...Array.from({ length: w }, (_, i) => ({ wch: i < 3 ? 22 : 16 }))];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Statement');
  XLSX.writeFile(wb, 'elite-sacco-' + d.file + '.xlsx'); return true;
};
const cl = s => String(s ?? '').replace(/[—–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/·/g, '-').replace(/[^\x20-\xFF]/g, '');
const pn = c => c == null || c === '' ? '' : typeof c == 'number' ? Math.round(c).toLocaleString('en-US') : cl(c);
const toPDF = d => {
  if (!(window.jspdf && jspdf.jsPDF)) return false;
  const P = new jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  if (typeof P.autoTable != 'function') return false;
  const ph = P.internal.pageSize.getHeight(), pw = P.internal.pageSize.getWidth();
  P.setFontSize(16); P.setTextColor(27, 60, 145); P.text('Elite SACCO Mbarara', 40, 38);
  P.setFontSize(12); P.setTextColor(0); P.text(cl(d.title), 40, 56);
  P.setFontSize(8.5); let y = 72;
  for (let i = 0; i < d.meta.length; i += 3) { P.text(cl(d.meta.slice(i, i + 3).map(([k, v]) => k + ': ' + v).join('     ')), 40, y); y += 12; }
  const foot = () => { P.setFontSize(7); P.setTextColor(120); P.text(cl('Elite SACCO Mbarara - ' + d.title + ' - ' + d.sub.split(' · ')[0] + ' - Page ' + P.internal.getNumberOfPages()), 40, ph - 18); P.setTextColor(0); };
  const sec = (title, head, rows, num, bold, w) => {
    if (y > ph - 100) { P.addPage(); y = 40; }
    P.setFontSize(10); P.setTextColor(27, 60, 145); P.text(cl(title), 40, y + 6); P.setTextColor(0);
    const nm = new Set(num || []), bd = new Set(bold || []);
    P.autoTable({
      startY: y + 12, head: [head.map(cl)], body: rows.map(r => r.map(pn)), styles: { fontSize: head.length > 8 ? 7 : 8, cellPadding: 3 },
      headStyles: { fillColor: [27, 60, 145] }, tableWidth: w || 'auto', margin: { left: 40, right: 40, bottom: 34 },
      columnStyles: Object.fromEntries(head.map((_, i) => [i, { halign: nm.has(i) ? 'right' : 'left' }])),
      didParseCell: h => { if (h.section == 'body' && bd.has(h.row.index)) { h.cell.styles.fontStyle = 'bold'; h.cell.styles.fillColor = [233, 238, 251]; } },
      didDrawPage: foot
    });
    y = P.lastAutoTable.finalY + 16;
  };
  sec('Key figures', ['Item', 'UGX'], d.kpis.map(([k, v]) => [k, v]), [1], [], 340);
  d.sections.forEach(s => sec(s.title, s.head, s.rows.length ? s.rows : [[s.empty || 'No records in this period.', ...s.head.slice(1).map(() => '')]], s.num, s.bold, s.head.length <= 2 ? 340 : 'auto'));
  P.setFontSize(7.5); const ns = d.notes.flatMap(t => P.splitTextToSize(cl('Note: ' + t), pw - 80));
  if (y + ns.length * 10 + 70 > ph - 30) { P.addPage(); y = 40; }
  ns.forEach(l => { P.text(l, 40, y); y += 10; }); y += 26;
  const cw = (pw - 80) / (d.sign.length + 1);
  ['Prepared by: ' + d.by, ...d.sign].forEach((t, i) => { const x = 40 + i * cw; P.line(x, y, x + cw - 20, y); P.text(cl(t), x, y + 10); P.text('Date:', x, y + 22); });
  P.save('elite-sacco-' + d.file + '.pdf'); return true;
};

/* ------------------------------ UI ------------------------------ */
const TABS = [['weekly', 'Weekly statement'], ['monthly', 'Monthly statement'], ['annual', 'Annual statement'], ['member', 'Member statement']];
const now0 = new Date();
const ST = {
  tab: 'weekly', kind: 'monthly', acc: '', filter: '',
  p: { date: today(), month: today().slice(0, 7), year: now0.getFullYear(), q: Math.floor(now0.getMonth() / 3) + 1, from: fD(new Date(now0.getFullYear(), 0, 1)), to: today() }
};
let cur = null;

const css = () => {
  if ($('#st-css')) return;
  const s = document.createElement('style'); s.id = 'st-css';
  s.textContent = `.st-tabs{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.8rem}
.st-tabs button{border:1.5px solid var(--blue);background:#fff;color:var(--blue);font:700 .88rem var(--font);padding:.55rem 1rem;border-radius:12px;cursor:pointer}
.st-tabs button[aria-selected="true"]{background:var(--blue);color:#fff}
.stmeta{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:.35rem 1.5rem;font-size:.85rem;margin:.6rem 0 1rem}
.stmeta span{display:block;color:#5a6890;font-size:.74rem;font-weight:600}.stmeta b{font-weight:700}
.stdoc tr.tot td{font-weight:800;background:var(--blue-soft)}
.stsig{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1.5rem;margin-top:2rem;font-size:.85rem}
.stsig div{border-top:1.5px solid #000;padding-top:.4rem}
.st-actions .btn[disabled]{opacity:.5;cursor:not-allowed}
@media print{#rep .tw{overflow:visible}#rep table{font-size:.68rem}#rep th{position:static}#rep th,#rep td{white-space:normal;padding:.3rem .4rem}#rep .card{box-shadow:none}}`;
  document.head.appendChild(s);
};

const note = (t, err) => { const m = $('#st-msg'); if (m) { m.className = 'msg' + (err ? ' err' : ''); m.textContent = t; } };
const activeKind = () => ST.tab == 'member' ? ST.kind : ST.tab;

const ctlHTML = () => {
  const S = loadS(), k = activeKind(), p = ST.p; let h = '';
  if (ST.tab == 'member') {
    const q = ST.filter.toLowerCase(), ms = S.members.filter(m => !q || (m.acc + ' ' + m.first + ' ' + m.last).toLowerCase().includes(q));
    h += `<div><label for="st-q">Find member</label><input id="st-q" placeholder="Name or account no." value="${esc(ST.filter)}" autocomplete="off"></div>
<div><label for="st-a">Member (account)</label><select id="st-a"><option value="">— select member —</option>${ms.map(m => `<option value="${esc(m.acc)}"${m.acc == ST.acc ? ' selected' : ''}>${esc(m.acc)} — ${esc(m.first)} ${esc(m.last)}</option>`).join('')}</select></div>
<div><label for="st-k">Statement period</label><select id="st-k">${KINDS.map(([v, l]) => `<option value="${v}"${v == ST.kind ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
  }
  if (k == 'weekly') h += `<div><label for="st-date">Any date in the week (Mon–Sun)</label><input id="st-date" type="date" value="${esc(p.date)}"></div>`;
  if (k == 'monthly') h += `<div><label for="st-month">Month</label><input id="st-month" type="month" value="${esc(p.month)}"></div>`;
  if (k == 'quarterly') h += `<div><label for="st-q2">Quarter</label><select id="st-q2">${[1, 2, 3, 4].map(q => `<option value="${q}"${q == p.q ? ' selected' : ''}>Q${q} (${MON3[(q - 1) * 3]} - ${MON3[q * 3 - 1]})</option>`).join('')}</select></div>`;
  if (k == 'quarterly' || k == 'annual') h += `<div><label for="st-year">Year</label><input id="st-year" type="number" min="2000" max="2100" value="${esc(p.year)}"></div>`;
  if (k == 'custom') h += `<div><label for="st-from">From</label><input id="st-from" type="date" value="${esc(p.from)}"></div><div><label for="st-to">To</label><input id="st-to" type="date" value="${esc(p.to)}"></div>`;
  return h;
};
const drawCtl = () => {
  const c = $('#st-ctl'); if (!c) return; c.innerHTML = ctlHTML();
  const st = document.querySelectorAll('#st-card [data-step]'); st.forEach(b => b.style.display = activeKind() == 'custom' ? 'none' : '');
};
const readCtl = () => {
  const g = id => { const e = $('#' + id); return e ? e.value : undefined; };
  [['date', 'st-date'], ['month', 'st-month'], ['year', 'st-year'], ['q', 'st-q2'], ['from', 'st-from'], ['to', 'st-to']].forEach(([k, id]) => { const v = g(id); if (v !== undefined && v !== '') ST.p[k] = v; });
  const a = g('st-a'); if (a !== undefined) ST.acc = a;
};
const step = n => {
  const k = activeKind(), p = ST.p;
  if (k == 'weekly') p.date = fD(addD(pdate(p.date) || new Date(), 7 * n));
  else if (k == 'monthly') { const m = String(p.month).match(/^(\d{4})-(\d\d)$/), d = new Date(+m[1], +m[2] - 1 + n, 1); p.month = `${d.getFullYear()}-${p2(d.getMonth() + 1)}`; }
  else if (k == 'quarterly') { let q = (+p.q) + n, y = +p.year; while (q > 4) { q -= 4; y++; } while (q < 1) { q += 4; y--; } p.q = q; p.year = y; }
  else if (k == 'annual') p.year = (+p.year) + n;
};
const drawDoc = () => {
  const S = loadS(), P = mkP(activeKind(), ST.p); let d = null, msg = '';
  if (!P) msg = 'Choose a valid range: the end date must be on or after the start date.';
  else if (ST.tab == 'member') { const m = memOf(S, ST.acc); if (!m) msg = 'Select a member to view their statement.'; else d = buildMember(S, m, P); }
  else d = buildInst(S, ST.tab, P);
  cur = d;
  const r = $('#rep'); if (r) r.innerHTML = d ? docHTML(d) : `<div class="card"><p class="note">${esc(msg)}</p></div>`;
  document.querySelectorAll('#st-card [data-x]').forEach(b => b.disabled = !d);
};
const doExport = f => {
  if (!cur) return;
  try {
    if (f == 'print') { aud('Statement printed', cur.audit); window.print(); return; }
    if (f == 'csv') { dl(new Blob([toCSV(cur)], { type: 'text/csv' }), 'elite-sacco-' + cur.file + '.csv'); aud('Statement exported', 'Exported ' + cur.audit + ' to CSV'); note('CSV downloaded.'); return; }
    if (f == 'xlsx') { if (!toXLSX(cur)) return note('Excel library could not load — check your internet connection.', 1); aud('Statement exported', 'Exported ' + cur.audit + ' to Excel'); note('Excel file downloaded.'); return; }
    if (f == 'pdf') { if (!toPDF(cur)) return note('PDF library could not load — check your internet connection.', 1); aud('Statement exported', 'Exported ' + cur.audit + ' to PDF'); note('PDF downloaded.'); }
  } catch (e) { note('Export failed: ' + e.message, 1); }
};

const mount = () => {
  const V = $('#view'); if (!V) return;
  css();
  const S = loadS(), u = curUser(), tabs = TABS.filter(([id]) => allowed(S, u, id));
  if (!tabs.some(([id]) => id == ST.tab)) ST.tab = tabs[0][0];
  const vt = $('#vt'); if (vt) vt.textContent = 'Statements';
  V.innerHTML = `<div class="card noprint" id="st-card"><h3>Statements</h3>
<div class="st-tabs" role="tablist">${tabs.map(([id, l]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id == ST.tab}">${l}</button>`).join('')}</div>
<div class="row" id="st-ctl"></div>
<div class="st-actions"><button class="btn alt2" type="button" data-step="-1">◀ Previous</button><button class="btn alt2" type="button" data-step="1">Next ▶</button>
<button class="btn" type="button" data-x="pdf">Export PDF</button><button class="btn alt2" type="button" data-x="xlsx">Export Excel</button><button class="btn alt2" type="button" data-x="csv">Export CSV</button><button class="btn alt2" type="button" data-x="print">Print</button></div>
<div id="st-msg" class="msg" role="status"></div></div><div id="rep"></div>`;
  const card = $('#st-card');
  card.addEventListener('click', e => {
    const t = e.target.closest('[data-tab]'), s = e.target.closest('[data-step]'), x = e.target.closest('[data-x]');
    if (t) { ST.tab = t.dataset.tab; card.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', b === t)); note(''); drawCtl(); drawDoc(); }
    else if (s) { readCtl(); step(+s.dataset.step); drawCtl(); drawDoc(); }
    else if (x) doExport(x.dataset.x);
  });
  const onChange = e => {
    if (e.target.id == 'st-q') {                                    // member search box: rebuild the member list only
      ST.filter = e.target.value; readCtl(); drawCtl();
      const f = $('#st-q'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
      return;
    }
    if (e.target.id == 'st-k') { ST.kind = e.target.value; drawCtl(); drawDoc(); return; }
    readCtl(); drawDoc();
  };
  card.addEventListener('input', e => { if (e.target.tagName != 'SELECT') onChange(e); });
  card.addEventListener('change', e => { if (e.target.tagName == 'SELECT') onChange(e); });
  drawCtl(); drawDoc();
};

/* ------------------------------ hook into the app ------------------------------ */
const b = bridge();
if (b && b.R) b.R.reports = mount;                                  // clean hook (when the bridge line is added)
document.addEventListener('click', e => {                           // fallback hook (works without any change to index.html)
  const btn = e.target.closest && e.target.closest('#side [data-v="reports"]');
  if (btn && !(bridge() && bridge().R)) setTimeout(() => { if (document.body.classList.contains('in')) mount(); }, 0);
}, true);

window.EliteStatements = { mount, buildInst, buildMember, mkP, buckets, toCSV, toAOA };
})();
