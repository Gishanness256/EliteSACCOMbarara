/* ==========================================================================
   Elite SACCO Mbarara — app.js
   Start-up, sidebar menu and view routing.

   Other modules (members, savings, loans, reports...) plug in by registering
   a render function:   ESACCO.R.members = () => { ... ESACCO.V.innerHTML = ... }
   and, if needed, a title:  ESACCO.T.members = 'Members'
   and access rules:         ESACCO.LA.members = ['Admin','Treasurer']
   ========================================================================== */
(() => {
'use strict';

/* ---------- tiny helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const p2 = n => String(n).padStart(2, '0');
const iso = d => new Date(d).toISOString().slice(0, 10);
const fmtD = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const today = () => fmtD(new Date());
const fmt = n => 'UGX ' + Math.round(n || 0).toLocaleString();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- roles & permissions ---------- */
const PERMS = ['Approve loans', 'Acknowledge savings/deposits', 'Acknowledge loan repayments', 'Set interest rates',
  'Create/remove system users', 'Create/remove member accounts', 'Weekly reports', 'Monthly reports', 'Annual reports'];
const ROLES = ['Admin', 'Treasurer', 'Credit Supervisor', 'Credit Officer'];
const defaultRoles = () => {
  const r = {};
  ROLES.forEach(x => r[x] = PERMS.map((_, j) =>
    x == 'Admin' ||
    (x == 'Treasurer' && [1, 2, 6, 7, 8].includes(j)) ||
    (x == 'Credit Supervisor' && [0, 2, 3, 6, 7].includes(j)) ||
    (x == 'Credit Officer' && [1, 2].includes(j))));
  return r;
};

/* ---------- application state (persisted in localStorage) ---------- */
const STORE_KEY = 'esacco';
let S = {
  users: [{ name: 'System Admin', email: 'admin@elitesacco.co.ug', role: 'Admin' }],
  members: [], savings: [], loans: [], roles: defaultRoles(), seq: 0, non: []
};
try { const x = localStorage.getItem(STORE_KEY); if (x) S = JSON.parse(x); } catch (e) { /* storage unavailable */ }
S.non = S.non || [];
S.reqs = S.reqs || [];
S.lseq = S.lseq || 0;
S.audit = S.audit || [];
S.sseq = S.sseq || 0;
S.roles = S.roles || defaultRoles();
S.users = S.users && S.users.length ? S.users : [{ name: 'System Admin', email: 'admin@elitesacco.co.ug', role: 'Admin' }];

const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } };

/* ---------- current user & audit trail ---------- */
let cu = S.users[0];
const ini = u => u.ini || (u.name || '').split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 3);
const me = () => ini(cu);
const isAdmin = () => cu.role == 'Admin';

const audit = (act, part, u) => {
  u = u || cu;
  (S.audit = S.audit || []).push({ t: new Date().toISOString(), ini: ini(u), user: u.name, role: u.role, act, part });
  if (S.audit.length > 5000) S.audit.splice(0, S.audit.length - 5000);
  save();
};

/* ---------- view registry, titles and access rules ---------- */
const R = {};   // view renderers, filled by this file and by the other modules
const T = {     // page titles
  home: 'Dashboard', users: 'Users', access: 'Access Levels', members: 'Members',
  sdep: 'Deposits / Withdrawals', sacc: 'Member Accounts', audit: 'System Auditor',
  ledger: 'Ledger', liquidity: 'Liquidity — Portfolio at Risk (PAR)',
  reports: 'Statements', regrep: 'Auditing — Regulatory Returns',
  lreq: 'Loan Requests', lapp: 'Loan Approval', lsec: 'Loans Section'
};
// Views restricted to named roles (views not listed are open to every signed-in user)
const LA = {
  lreq: ['Admin', 'Credit Officer', 'Credit Supervisor'],
  lapp: ['Admin'],
  audit: ['Admin', 'Treasurer'],
  regrep: ['Admin', 'Treasurer', 'Credit Supervisor']
};
LA.lsec = LA.lreq;

const can = v => !LA[v] || LA[v].includes(cu.role);

/* show/hide sidebar entries according to the signed-in role */
const menuVis = () => {
  let anyLoan = 0;
  $$('#lnm [data-v]').forEach(b => {
    const ok = can(b.dataset.v);
    b.style.display = ok ? '' : 'none';
    if (ok) anyLoan = 1;
  });
  $('#lnmBtn').style.display = anyLoan ? '' : 'none';
  if (!anyLoan) $('#lnm').classList.remove('show');
  ['audit', 'regrep'].forEach(v => {
    const b = document.querySelector(`#side [data-v="${v}"]`);
    if (b) b.style.display = can(v) ? '' : 'none';
  });
};

/* which sidebar group each view belongs to (so its submenu opens) */
const GROUP = {
  users: 'cfg', access: 'cfg', home: 'cfg',
  sdep: 'svm', sacc: 'svm',
  reports: 'rpm', regrep: 'rpm',
  ledger: 'pfm', liquidity: 'pfm',
  lreq: 'lnm', lapp: 'lnm', lsec: 'lnm'
};
const SUBS = ['cfg', 'svm', 'lnm', 'pfm', 'rpm'];

/* ---------- view routing ---------- */
let V = null;                       // #view container, resolved at start-up
const say = (t, err) => { const m = $('#msg'); if (m) { m.className = 'msg' + (err ? ' err' : ''); m.textContent = t; } };

function go(v) {
  if (!T[v] || !can(v)) v = 'home';
  menuVis();
  document.body.classList.remove('blank');
  $('#vt').textContent = T[v];
  $$('#side [data-v]').forEach(b => b.classList.toggle('on', b.dataset.v == v));
  if (GROUP[v]) $('#' + GROUP[v]).classList.add('show');
  if (typeof R[v] === 'function') R[v]();
  else V.innerHTML = `<div class="card"><h3>${esc(T[v])}</h3><p class="note">This module has not been loaded. Make sure its script is included after app.js.</p></div>`;
  window.scrollTo(0, 0);
}

/* built-in view: dashboard home */
const bal = ESACCO_bal;
function ESACCO_bal(l, d) { return (window.ESACCO && typeof window.ESACCO.bal === 'function') ? window.ESACCO.bal(l, d) : { b: 0, k: 0 }; }
const sv = a => S.savings.filter(s => !a || s.acc == a).reduce((t, s) => t + (s.w ? -s.amt : s.amt), 0);

R.home = () => {
  const ls = S.loans.reduce((t, l) => t + (bal(l).b || 0), 0);
  V.innerHTML = `<div class="kpis">
    <div class="kpi">Members<b>${S.members.length}</b></div>
    <div class="kpi">Total savings<b>${fmt(sv())}</b></div>
    <div class="kpi">Loans outstanding<b>${fmt(ls)}</b></div>
    <div class="kpi">System users<b>${S.users.length}</b></div></div>
  <div class="card"><h3>Welcome to Elite SACCO Mbarara</h3>
  <p>Hover over the left menu to expand it. Use <b>Configurations</b> to manage users and access, <b>Members</b> to register account holders,
  <b>Savings</b>, <b>Loans</b> (application, approval and active loans), the <b>Portfolio</b> (Ledger and Liquidity/PAR),
  and <b>Reports</b> (member <b>Statements</b> and regulatory <b>Auditing</b> returns).</p></div>`;
};

/* ---------- public site: tabs (Login / About / Services) ---------- */
function initTabs() {
  const tabs = $$('[data-tab]');
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(b => b.setAttribute('aria-selected', b === t));
    $$('main section').forEach(s => s.hidden = s.id !== t.dataset.tab);
  }));
}

/* ---------- public site: registration dialog ---------- */
function initRegistration() {
  const dlg = $('#regmodal'), rf = $('#regform');
  if (!dlg || !rf) return;
  $('#openReg').addEventListener('click', e => { e.preventDefault(); dlg.showModal(); });
  $('#closeReg').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  rf.addEventListener('submit', e => {
    e.preventDefault();
    const m = $('#pwmsg'); m.textContent = '';
    if (!rf.checkValidity()) { rf.reportValidity(); return; }
    if (rf.pw1.value !== rf.pw2.value) { m.textContent = 'Passwords do not match.'; rf.pw2.focus(); return; }
    alert('Account details captured. Connect this form to your backend to complete registration.');
    dlg.close();
  });
}

/* ---------- login / logout ---------- */
function initAuth() {
  const f = $('#login form');
  f.onsubmit = e => {
    e.preventDefault();
    const id = f.querySelector('[name=id]').value.trim().toLowerCase();
    const pw = f.querySelector('[name=pw]').value;
    let m = $('#lerr');
    if (!m) {
      m = document.createElement('p');
      m.id = 'lerr';
      m.style.cssText = 'color:#D62828;font-weight:700;margin-top:1rem;text-align:center';
      f.appendChild(m);
    }
    const u = S.users.find(x =>
      (x.email.toLowerCase() == id || x.email.toLowerCase() == id + '@elitesacco.co.ug') &&
      (x.pw ? x.pw == pw : (x.role == 'Admin' && pw == 'Admin')));
    if (u) {
      cu = u;
      audit('Login', 'Signed in successfully');
      m.textContent = '';
      document.body.classList.add('in');
      $('#who').textContent = 'Signed in as ' + u.email + ' · ' + u.role;
      $('#sbLogo').src = document.querySelector('.brand img').src;
      $('#wmLogo').src = document.querySelector('#login>img').src;
      go('home');
    } else {
      audit('Failed login', 'Failed sign-in attempt for "' + id + '"', { name: id || 'unknown', role: '—', ini: '—' });
      m.textContent = 'Invalid email or password.';
    }
  };

  $('#logout').onclick = () => {
    audit('Logout', 'Signed out');
    document.body.classList.remove('in', 'blank');
    pinReset();
    SUBS.forEach(id => $('#' + id).classList.remove('show'));
    f.reset();
  };
}

/* ---------- sidebar behaviour ---------- */
const pinReset = () => {
  const s = $('#side');
  s.classList.remove('manual', 'pin', 'open');
  document.body.classList.remove('pinned');
  $('#pinBtn').setAttribute('aria-expanded', 'false');
  $('#pinTx').textContent = 'Hide dashboard';
  $('#pinBtn').title = 'Hide the dashboard';
};

function initSidebar() {
  const side = $('#side');

  // menu clicks: sub-menu toggles and view links
  side.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.sub) {
      $('#' + b.dataset.sub).classList.toggle('show');
      if (side.classList.contains('manual')) {
        if (!side.classList.contains('pin')) {            // expand a collapsed rail so sub-items are visible
          side.classList.add('pin');
          document.body.classList.add('pinned');
          $('#pinTx').textContent = 'Hide dashboard';
          $('#pinBtn').setAttribute('aria-expanded', 'true');
          $('#pinBtn').title = 'Hide the dashboard';
        }
      } else side.classList.add('open');
    } else if (b.dataset.v) {
      go(b.dataset.v);
      if (matchMedia('(hover:none)').matches) side.classList.remove('open');
    }
  });

  // "Hide / Show dashboard" button (pins or collapses the rail)
  $('#pinBtn').onclick = () => {
    const show = !(side.classList.contains('pin') ||
      (!side.classList.contains('manual') && (side.matches(':hover') || side.classList.contains('open'))));
    side.classList.add('manual');
    side.classList.remove('open');
    side.classList.toggle('pin', show);
    document.body.classList.toggle('pinned', show);
    $('#pinBtn').setAttribute('aria-expanded', show);
    $('#pinTx').textContent = show ? 'Hide dashboard' : 'Show dashboard';
    $('#pinBtn').title = show ? 'Hide the dashboard' : 'Show the dashboard';
    if (!show) side.querySelectorAll('.sub.show').forEach(x => x.classList.remove('show'));
  };

  // clicking the logo blanks the workspace (watermark view) and collapses all menus
  const blank = () => {
    document.body.classList.toggle('blank');
    side.classList.remove('open');
    SUBS.forEach(id => $('#' + id).classList.remove('show'));
    $$('#side .on').forEach(b => b.classList.remove('on'));
  };
  const top = $('#side .top');
  top.onclick = blank;
  top.onkeydown = e => { if (e.key == 'Enter' || e.key == ' ') { e.preventDefault(); blank(); } };
}

/* ---------- start-up ---------- */
function start() {
  V = $('#view');
  initTabs();
  initRegistration();
  initAuth();
  initSidebar();
  menuVis();
}

/* ---------- shared namespace for the other modules ---------- */
window.ESACCO = Object.assign(window.ESACCO || {}, {
  // state & persistence
  get S() { return S; }, set S(v) { S = v; }, save,
  // session
  get cu() { return cu; }, me, ini, isAdmin, audit,
  // routing
  R, T, LA, go, can, menuVis, say,
  get V() { return V; },
  // constants
  PERMS, ROLES, defaultRoles,
  // helpers
  $, $$, p2, iso, fmtD, today, fmt, esc, sv
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
})();
