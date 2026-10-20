/*!
 * Elite SACCO Mbarara — member registration & accounts (members.js)
 *
 * What it does
 *  1. Public "Create Account" form  -> saved as a PENDING membership application
 *     (separate localStorage key, so it can never be overwritten by the app's own saves).
 *  2. Members screen (staff)        -> adds a "Membership applications" card where staff
 *     enter DOB + gender and Approve (creates the member + account number) or Reject.
 *  3. Members screen "Save member"  -> validates before the app saves: names, age 18+,
 *     NIN format, Uganda phone format, duplicate NIN / phone / email. Phone and NIN are
 *     normalised (0772123456, uppercase NIN).
 *  4. EMembers API                   -> register(), update(), find(), summary(), applications.
 *
 * Install
 *  a) In index.html, inside the main IIFE (right after the line `const save=...`), add ONE line:
 *       window.ESaccoApp={get S(){return S},save,audit,bal,sv,get user(){return cu},go:v=>go(v)};
 *     (without it, the public form and validation still work, but approving applications and
 *      the staff panel are disabled — the app keeps its data in memory and would overwrite
 *      anything written behind its back.)
 *  b) Add  <script src="members.js"></script>  just before </body>.
 */
(function (g) {
  'use strict';

  var APPS_KEY = 'esacco_member_apps';
  var cfg = {
    prefix: 'ES',        // account number: ES-F 000001
    strictNIN: true,     // Ugandan NIN = CM/CF + 8 digits + 4 letters (14 chars)
    minAge: 18,
    panel: true          // show the applications card on the Members screen
  };

  /* ---------- tiny helpers ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var p = function (n, w) { return String(n).padStart(w || 2, '0'); };
  var today = function () { var d = new Date(); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  var bridge = function () { return g.ESaccoApp || null; };

  function state() {
    var a = bridge(); if (a) return a.S;
    try { return JSON.parse(localStorage.getItem('esacco')) || { members: [], savings: [], loans: [], seq: 0 }; }
    catch (e) { return { members: [], savings: [], loans: [], seq: 0 }; }
  }
  function persist(S) {
    var a = bridge();
    if (a) a.save(); else try { localStorage.setItem('esacco', JSON.stringify(S)); } catch (e) {}
  }
  function audit(act, part) { var a = bridge(); if (a && a.audit) a.audit(act, part); }

  /* ---------- normalisers & validators ---------- */
  function normPhone(v) {                       // -> 07XXXXXXXX or '' if invalid
    var d = String(v || '').replace(/[\s\-().]/g, '');
    d = d.replace(/^\+?256/, '').replace(/^0/, '');
    return /^[37]\d{8}$/.test(d) ? '0' + d : '';
  }
  function normNIN(v) { return String(v || '').toUpperCase().replace(/\s+/g, ''); }
  function validNIN(v) { return cfg.strictNIN ? /^C[MF]\d{8}[A-Z]{4}$/.test(v) : /^[A-Z0-9]{14}$/.test(v); }
  function validName(v) { return /^[A-Za-z][A-Za-z'’.\- ]{1,}$/.test(v); }
  function ageOf(dob) {
    var b = new Date(dob), n = new Date();
    if (isNaN(b)) return NaN;
    var a = n.getFullYear() - b.getFullYear();
    if (n.getMonth() < b.getMonth() || (n.getMonth() == b.getMonth() && n.getDate() < b.getDate())) a--;
    return a;
  }
  function cap(s) { return String(s).trim().replace(/\s+/g, ' ').replace(/(^|[\s\-'])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); }); }

  function pendingApps() { return loadApps().filter(function (a) { return a.status === 'Pending'; }); }

  /**
   * d: {first,last,dob,gender,addr,nin,tel,email}; opts: {exclude: acc, appId: id, partial: true}
   * partial = public application (DOB / gender not collected yet).
   */
  function validate(d, opts) {
    opts = opts || {};
    var S = state(), errors = [], warnings = [];
    var c = {
      first: cap(d.first || ''), last: cap(d.last || ''), dob: d.dob || '', gender: d.gender || '',
      addr: String(d.addr || '').trim(), nin: normNIN(d.nin), tel: normPhone(d.tel),
      email: String(d.email || '').trim().toLowerCase(), photo: d.photo || ''
    };
    if (!validName(c.first)) errors.push('Enter a valid first name.');
    if (!validName(c.last)) errors.push('Enter a valid last name.');
    if (c.addr.length < 3) errors.push('Address is required.');
    if (!c.tel) errors.push('Enter a valid Ugandan phone number (e.g. 0772 123 456 or +256 772 123 456).');
    if (!validNIN(c.nin)) errors.push(cfg.strictNIN ? 'NIN must be 14 characters, e.g. CM12345678ABCD.' : 'NIN must be 14 letters/digits.');
    if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) errors.push('Email address is not valid.');
    if (!opts.partial || c.dob) {
      var a = ageOf(c.dob);
      if (!c.dob || isNaN(a)) errors.push('Date of birth is required.');
      else if (a < cfg.minAge) errors.push('Member must be at least ' + cfg.minAge + ' years old.');
      else if (a > 110) errors.push('Check the date of birth.');
    }
    if (!opts.partial || c.gender) {
      if (c.gender !== 'M' && c.gender !== 'F') errors.push('Select the gender (M or F).');
      else if (validNIN(c.nin) && c.nin[1] !== c.gender) warnings.push('The NIN suggests ' + (c.nin[1] === 'F' ? 'female' : 'male') + ' but the selected gender differs.');
    }
    S.members.forEach(function (m) {
      if (m.acc === opts.exclude) return;
      if (c.nin && String(m.nin).toUpperCase() === c.nin) errors.push('NIN already registered to ' + m.acc + ' (' + m.first + ' ' + m.last + ').');
      if (c.tel && normPhone(m.tel) === c.tel) errors.push('Phone number already used by ' + m.acc + ' (' + m.first + ' ' + m.last + ').');
      if (c.email && String(m.email || '').toLowerCase() === c.email) errors.push('Email already used by ' + m.acc + '.');
    });
    loadApps().forEach(function (x) {
      if (x.status !== 'Pending' || x.id === opts.appId) return;
      if (c.nin && x.nin === c.nin) (opts.partial ? errors : warnings).push('A pending application (' + x.id + ') already uses this NIN.');
    });
    return { ok: !errors.length, errors: errors, warnings: warnings, clean: c };
  }

  /* ---------- accounts ---------- */
  function nextAccount(gender) { var S = state(); return cfg.prefix + '-' + gender + ' ' + p((S.seq || 0) + 1, 6); }
  function find(q) {
    q = String(q || '').trim().toLowerCase(); if (!q) return [];
    return state().members.filter(function (m) {
      return (m.acc + ' ' + m.first + ' ' + m.last + ' ' + m.tel + ' ' + m.nin).toLowerCase().indexOf(q) >= 0;
    });
  }
  function register(d, opts) {
    var v = validate(d, opts);
    if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };
    var S = state(), c = v.clean;
    S.seq = (S.seq || 0) + 1;
    var acc = cfg.prefix + '-' + c.gender + ' ' + p(S.seq, 6);
    S.members.push({ acc: acc, first: c.first, last: c.last, dob: c.dob, addr: c.addr, nin: c.nin, tel: c.tel, email: c.email, photo: c.photo });
    persist(S);
    audit('Member created', 'Registered member ' + acc + ' — ' + c.first + ' ' + c.last);
    return { ok: true, acc: acc, warnings: v.warnings };
  }
  function update(acc, patch) {
    var S = state(), m = S.members.filter(function (x) { return x.acc === acc; })[0];
    if (!m) return { ok: false, errors: ['Account not found.'] };
    var merged = Object.assign({}, m, { gender: acc.split(' ')[0].slice(-1) }, patch);
    merged.addr = merged.addr; merged.first = merged.first; merged.last = merged.last;
    var v = validate(merged, { exclude: acc });
    if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };
    var c = v.clean;
    Object.assign(m, { first: c.first, last: c.last, dob: c.dob, addr: c.addr, nin: c.nin, tel: c.tel, email: c.email, photo: c.photo || m.photo });
    persist(S); audit('Member updated', 'Updated member ' + acc + ' — ' + c.first + ' ' + c.last);
    return { ok: true, acc: acc, warnings: v.warnings };
  }
  function summary(acc) {
    var S = state(), a = bridge(), m = S.members.filter(function (x) { return x.acc === acc; })[0];
    if (!m) return null;
    var sd = (S.savings || []).filter(function (s) { return s.acc === acc; });
    var dep = sd.filter(function (s) { return !s.w; }).reduce(function (t, s) { return t + s.amt; }, 0);
    var wd = sd.filter(function (s) { return s.w; }).reduce(function (t, s) { return t + s.amt; }, 0);
    var ls = (S.loans || []).filter(function (l) { return l.acc === acc; });
    var out = a ? ls.reduce(function (t, l) { return t + a.bal(l).b; }, 0) : null;   // needs the app's interest engine
    var act = a ? ls.filter(function (l) { return a.bal(l).b >= 0.5; }).length : null;
    return { member: m, deposits: dep, withdrawals: wd, savings: dep - wd, loansTaken: ls.length, activeLoans: act, loanOutstanding: out, net: out == null ? null : dep - wd - out };
  }

  /* ---------- membership applications ---------- */
  function loadApps() { try { return JSON.parse(localStorage.getItem(APPS_KEY)) || []; } catch (e) { return []; } }
  function saveApps(a) { try { localStorage.setItem(APPS_KEY, JSON.stringify(a)); } catch (e) {} }

  function apply(d) {
    var v = validate(d, { partial: true });
    if (!v.ok) return { ok: false, errors: v.errors };
    var apps = loadApps(), n = apps.reduce(function (m, a) { return Math.max(m, +String(a.id).slice(3) || 0); }, 0) + 1, c = v.clean;
    var rec = { id: 'MA-' + p(n, 4), date: today(), first: c.first, last: c.last, addr: c.addr, tel: c.tel, email: c.email, nin: c.nin, status: 'Pending' };
    apps.push(rec); saveApps(apps);
    return { ok: true, id: rec.id };
  }
  function canManage() {
    var a = bridge(); if (!a) return false;
    var u = a.user, r = a.S.roles && a.S.roles[u.role];
    return u.role === 'Admin' || !!(r && r[5]);            // "Create/remove member accounts"
  }
  function approve(id, extra) {
    if (!canManage()) return { ok: false, errors: ['You do not have permission to approve members.'] };
    var apps = loadApps(), x = apps.filter(function (a) { return a.id === id; })[0];
    if (!x || x.status !== 'Pending') return { ok: false, errors: ['Application not found or already decided.'] };
    var r = register(Object.assign({}, x, { dob: extra.dob, gender: extra.gender, photo: extra.photo }), { appId: id });
    if (!r.ok) return r;
    x.status = 'Approved'; x.acc = r.acc; x.by = bridge().user.name; x.on = today(); saveApps(apps);
    return r;
  }
  function reject(id, reason) {
    if (!canManage()) return { ok: false, errors: ['You do not have permission.'] };
    if (!String(reason || '').trim()) return { ok: false, errors: ['Give a reason for rejecting the application.'] };
    var apps = loadApps(), x = apps.filter(function (a) { return a.id === id; })[0];
    if (!x || x.status !== 'Pending') return { ok: false, errors: ['Application not found or already decided.'] };
    x.status = 'Rejected'; x.reason = reason.trim(); x.by = bridge().user.name; x.on = today(); saveApps(apps);
    audit('Application rejected', id + ' — ' + x.first + ' ' + x.last + ' · ' + x.reason);
    return { ok: true };
  }

  /* ---------- public Create Account form ---------- */
  function hookPublicForm() {
    var f = $('#regform'); if (!f || f.dataset.mh) return; f.dataset.mh = 1;
    f.addEventListener('submit', function (e) {
      e.preventDefault(); e.stopImmediatePropagation();      // replaces the placeholder alert()
      var m = $('#pwmsg'); if (m) m.textContent = '';
      if (!f.checkValidity()) { f.reportValidity(); return; }
      var el = function (n) { return f.elements[n].value; };
      if (el('password') !== el('confirm_password')) { m.textContent = 'Passwords do not match.'; return; }
      var r = apply({ first: el('first_name'), last: el('last_name'), addr: el('address'), tel: el('phone'), email: el('email'), nin: el('nin') });
      if (!r.ok) { m.textContent = r.errors[0]; return; }
      // The password is deliberately NOT stored: members do not sign in to this system.
      alert('Thank you. Your application (' + r.id + ') has been received. The SACCO office will contact you to complete registration.');
      f.reset(); var d = $('#regmodal'); if (d && d.close) d.close();
    }, true);
  }

  /* ---------- Members screen: validation before the app saves ---------- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#ms'); if (!b || !$('#mf')) return;
    var v = function (id) { return $(id) ? $(id).value : ''; };
    var editing = $('#mh') && $('#mh').textContent === 'Edit member', acc = editing ? $('#an').textContent : '';
    var gender = editing ? acc.split(' ')[0].slice(-1) : v('#mg');
    var res = validate({ first: v('#mf'), last: v('#ml'), dob: v('#md'), gender: gender, addr: v('#ma'), nin: v('#mn'), tel: v('#mt'), email: v('#me') }, { exclude: acc });
    var msg = $('#msg');
    if (!res.ok) {
      e.stopImmediatePropagation(); e.preventDefault();
      if (msg) { msg.className = 'msg err'; msg.textContent = res.errors[0] + (res.errors.length > 1 ? ' (+' + (res.errors.length - 1) + ' more)' : ''); }
      return;
    }
    if (res.warnings.length && !confirm(res.warnings.join('\n') + '\n\nSave anyway?')) { e.stopImmediatePropagation(); e.preventDefault(); return; }
    var c = res.clean;                                       // let the app save the normalised values
    $('#mf').value = c.first; $('#ml').value = c.last; $('#mt').value = c.tel; $('#mn').value = c.nin; if ($('#me')) $('#me').value = c.email;
  }, true);

  /* ---------- Members screen: applications panel ---------- */
  function panel() {
    var V = $('#view'), vt = $('#vt');
    if (!cfg.panel || !V || !vt || vt.textContent !== 'Members' || $('#mapps') || !bridge()) return;
    var apps = loadApps(), pend = apps.filter(function (a) { return a.status === 'Pending'; });
    var done = apps.filter(function (a) { return a.status !== 'Pending'; }).slice(-10).reverse();
    var allow = canManage();
    var th = function (a) { return a.map(function (x) { return '<th>' + x + '</th>'; }).join(''); };
    var rows = pend.map(function (a) {
      return '<tr><td>' + a.id + '</td><td>' + a.date + '</td><td>' + esc(a.first + ' ' + a.last) + '</td><td>' + esc(a.tel) + '</td><td>' + esc(a.nin) + '</td><td>' + esc(a.addr) + '</td>' +
        (allow ? '<td><input type="date" data-dob="' + a.id + '" max="' + today() + '" style="min-width:140px"></td>' +
          '<td><select data-g="' + a.id + '"><option value="">—</option><option value="F"' + (a.nin[1] === 'F' ? ' selected' : '') + '>F</option><option value="M"' + (a.nin[1] === 'M' ? ' selected' : '') + '>M</option></select></td>' +
          '<td><button class="btn sm" data-ok="' + a.id + '">Approve</button> <button class="btn alt2 sm" style="color:#D62828;border-color:#D62828" data-no="' + a.id + '">Reject</button></td>' : '<td colspan="3">No permission</td>') + '</tr>';
    }).join('') || '<tr><td colspan="9">No pending applications.</td></tr>';
    var hist = done.map(function (a) {
      return '<tr><td>' + a.id + '</td><td>' + esc(a.first + ' ' + a.last) + '</td><td>' + (a.status === 'Approved' ? '<span class="bd ok">Approved</span> ' + esc(a.acc) : '<span class="bd no">Rejected</span> ' + esc(a.reason || '')) + '</td><td>' + esc(a.by || '') + '</td><td>' + (a.on || '') + '</td></tr>';
    }).join('');
    var d = document.createElement('div');
    d.id = 'mapps'; d.className = 'card';
    d.innerHTML = '<h3>Membership applications (' + pend.length + ' pending)</h3><div id="mamsg" class="msg"></div>' +
      '<div class="tw"><table><tr>' + th(['Ref', 'Date', 'Applicant', 'Phone', 'NIN', 'Address', 'Date of birth', 'Gender', 'Decision']) + '</tr>' + rows + '</table></div>' +
      (hist ? '<h3 style="margin-top:1rem">Recent decisions</h3><div class="tw"><table><tr>' + th(['Ref', 'Applicant', 'Outcome', 'By', 'Date']) + '</tr>' + hist + '</table></div>' : '');
    V.insertBefore(d, V.firstChild);
    var say = function (t, err) { var m = $('#mamsg'); m.className = 'msg' + (err ? ' err' : ''); m.textContent = t; };
    d.querySelectorAll('[data-ok]').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.ok, r = approve(id, { dob: $('[data-dob="' + id + '"]').value, gender: $('[data-g="' + id + '"]').value });
        if (!r.ok) return say(r.errors[0], 1);
        bridge().go('members');
        setTimeout(function () { var m = $('#msg'); if (m) { m.className = 'msg'; m.textContent = 'Application ' + id + ' approved. Account number: ' + r.acc; } }, 0);
      };
    });
    d.querySelectorAll('[data-no]').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.no, why = prompt('Reason for rejecting ' + id + ':'); if (why === null) return;
        var r = reject(id, why); if (!r.ok) return say(r.errors[0], 1);
        bridge().go('members');
      };
    });
  }
  function watch() {
    var V = $('#view'); if (!V) return;
    new MutationObserver(panel).observe(V, { childList: true });
    panel();
  }

  /* ---------- public API ---------- */
  g.EMembers = {
    configure: function (o) { Object.assign(cfg, o || {}); },
    validate: validate, register: register, update: update, find: find, summary: summary,
    nextAccount: nextAccount, normalizePhone: normPhone, normalizeNIN: normNIN,
    applications: { list: loadApps, pending: pendingApps, apply: apply, approve: approve, reject: reject }
  };

  function boot() { hookPublicForm(); watch(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
