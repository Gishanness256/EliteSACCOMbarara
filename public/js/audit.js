/* ==========================================================================
   Elite SACCO Mbarara — System Activity Log (audit.js)
   --------------------------------------------------------------------------
   Two-step use inside the main app script:

     1) EARLY (where the old `const audit=...` was):
          const A = EliteAudit.init({ S, save, getUser: () => cu });
          const audit = A.log;            // audit(action, particulars[, user])

     2) LATE (after Object.assign(R,{...}) blocks, before the closing `})();`):
          A.mount({ R, $, V, tbl, esc, fmtD, p2, today, dl, can, getUser: () => cu });

   Log entry: { t: ISO time, ini, user, role, act, part }
   ========================================================================== */
(function (global) {
  'use strict';

  var MAX_ENTRIES = 5000;   // oldest entries are dropped beyond this
  var MAX_ROWS = 500;       // rows rendered on screen (exports include all filtered rows)

  function initials(u) {
    if (!u) return '—';
    if (u.ini) return u.ini;
    return String(u.name || '').split(/\s+/).map(function (w) { return w[0] || ''; })
      .join('').toUpperCase().slice(0, 3);
  }

  function init(cfg) {
    var S = cfg.S, save = cfg.save, getUser = cfg.getUser;
    S.audit = S.audit || [];

    function log(act, part, u) {
      u = u || getUser();
      S.audit = S.audit || [];
      S.audit.push({
        t: new Date().toISOString(),
        ini: initials(u),
        user: (u && u.name) || 'unknown',
        role: (u && u.role) || '—',
        act: act,
        part: part
      });
      if (S.audit.length > MAX_ENTRIES) S.audit.splice(0, S.audit.length - MAX_ENTRIES);
      save();
    }

    function mount(ctx) {
      var R = ctx.R, $ = ctx.$, V = ctx.V, tbl = ctx.tbl, esc = ctx.esc, fmtD = ctx.fmtD,
          p2 = ctx.p2, today = ctx.today, dl = ctx.dl, can = ctx.can;

      R.audit = function () {
        if (!can('audit')) return R.home();

        // newest first, keeping each entry's original sequence number
        var all = (S.audit || []).map(function (x, i) { x = Object.assign({}, x); x.n = i + 1; return x; }).reverse();

        var ts = function (t) {
          var d = new Date(t);
          return fmtD(d) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
        };
        var uniq = function (k) {
          return Array.from(new Set(all.map(function (x) { return x[k]; }))).sort();
        };
        var opts = function (a) { return a.map(function (u) { return '<option>' + esc(u) + '</option>'; }).join(''); };

        V.innerHTML =
          '<div class="card"><h3>System activity log</h3>' +
          '<p class="note">Read-only record of actions performed by system users — time-stamped, with the officer\'s initials. Entries cannot be edited or deleted from here.</p>' +
          '<div class="kpis" id="aks"></div>' +
          '<div class="row">' +
            '<div><label>System user</label><select id="fu"><option value="">All users</option>' + opts(uniq('user')) + '</select></div>' +
            '<div><label>Role</label><select id="fr"><option value="">All roles</option>' + opts(uniq('role')) + '</select></div>' +
            '<div><label>Activity</label><select id="fa"><option value="">All activities</option>' + opts(uniq('act')) + '</select></div>' +
            '<div><label>From</label><input id="f1" type="date"></div>' +
            '<div><label>To</label><input id="f2" type="date"></div>' +
            '<div><label>Search</label><input id="fq" placeholder="Particulars, initials…"></div>' +
          '</div>' +
          '<div class="noprint">' +
            '<button class="btn alt2" id="ac1">Export CSV</button>' +
            '<button class="btn alt2" id="ac2">Export Excel</button>' +
            '<button class="btn alt2" id="ap1">Print</button>' +
            '<button class="btn alt2" id="acl">Clear filters</button>' +
          '</div>' +
          '<p class="note" id="acn"></p><div id="rep"><div id="atb"></div></div></div>';

        var HEAD = ['#', 'Date & time', 'Initials', 'User', 'Role', 'Activity', 'Particulars'];
        var cur = [];

        var kpis = function () {
          var t0 = today(), todayN = all.filter(function (x) { return fmtD(new Date(x.t)) === t0; }).length,
              fails = all.filter(function (x) { return x.act === 'Failed login'; }).length,
              logins = all.filter(function (x) { return x.act === 'Login'; }).length;
          $('#aks').innerHTML =
            '<div class="kpi">Total entries<b>' + all.length + '</b></div>' +
            '<div class="kpi">Today<b>' + todayN + '</b></div>' +
            '<div class="kpi">Logins<b>' + logins + '</b></div>' +
            '<div class="kpi">Failed logins<b>' + fails + '</b></div>';
        };

        var draw = function () {
          var u = $('#fu').value, r = $('#fr').value, a = $('#fa').value,
              d1 = $('#f1').value, d2 = $('#f2').value, q = $('#fq').value.trim().toLowerCase();
          cur = all.filter(function (x) {
            var dt = fmtD(new Date(x.t));
            return (!u || x.user === u) && (!r || x.role === r) && (!a || x.act === a) &&
                   (!d1 || dt >= d1) && (!d2 || dt <= d2) &&
                   (!q || (x.part + ' ' + x.act + ' ' + x.user + ' ' + x.ini).toLowerCase().indexOf(q) > -1);
          });
          $('#acn').textContent = cur.length + ' of ' + all.length + ' entries' +
            (cur.length > MAX_ROWS ? ' — showing the latest ' + MAX_ROWS + ' (export for all)' : '');
          $('#atb').innerHTML = tbl(HEAD, cur.slice(0, MAX_ROWS).map(function (x) {
            return [x.n, ts(x.t), '<b>' + esc(x.ini) + '</b>', esc(x.user), esc(x.role),
                    esc(x.act),
                    '<span style="white-space:normal;display:inline-block;min-width:260px">' + esc(x.part) + '</span>'];
          }));
        };

        ['fu', 'fr', 'fa', 'f1', 'f2', 'fq'].forEach(function (id) { $('#' + id).oninput = draw; });
        $('#acl').onclick = function () {
          ['fu', 'fr', 'fa', 'f1', 'f2', 'fq'].forEach(function (id) { $('#' + id).value = ''; });
          draw();
        };

        var rowsOut = function () {
          return cur.map(function (x) { return [x.n, ts(x.t), x.ini, x.user, x.role, x.act, x.part]; });
        };

        $('#ac1').onclick = function () {
          var q = function (s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; };
          var c = [HEAD].concat(rowsOut()).map(function (r) { return r.map(q).join(','); }).join('\n');
          dl(new Blob(['\ufeff' + c], { type: 'text/csv' }), 'elite-sacco-audit-' + today() + '.csv');
          log('Audit log exported', 'Exported ' + cur.length + ' audit entries to CSV');
        };

        $('#ac2').onclick = function () {
          if (!global.XLSX) { alert('Excel library could not load — check your internet connection.'); return; }
          var ws = XLSX.utils.aoa_to_sheet([HEAD].concat(rowsOut()));
          ws['!cols'] = [{ wch: 6 }, { wch: 20 }, { wch: 9 }, { wch: 22 }, { wch: 18 }, { wch: 24 }, { wch: 80 }];
          var wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, 'Audit log');
          log('Audit log exported', 'Exported ' + cur.length + ' audit entries to Excel');
          XLSX.writeFile(wb, 'elite-sacco-audit-' + today() + '.xlsx');
        };

        $('#ap1').onclick = function () {
          log('Audit log printed', 'Printed ' + cur.length + ' audit entries');
          draw();
          print();
        };

        kpis();
        draw();
      };
    }

    return { log: log, mount: mount };
  }

  global.EliteAudit = { init: init };
})(window);
