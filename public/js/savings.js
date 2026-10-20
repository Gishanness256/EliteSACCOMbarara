/*!
 * savings.js — Elite SACCO Mbarara
 * Deposits, withdrawals and savings import (Excel / CSV).
 *
 * Usage (in index.html, before the main app script):
 *   <script src="savings.js"></script>
 * Then, after the `R` view object is created inside the app script:
 *   SavingsModule.install({
 *     R, $, V, S: () => S, cu: () => cu,
 *     fmt, esc, mem, mopts, tbl, say, sv, dd, me, audit, save,
 *     num, pd, p2, parseFile, dl
 *   });
 * This registers R.sdep (the "Deposits / Withdrawals" view).
 */
(function (global) {
  'use strict';

  const CHANNELS = ['Counter / Cash', 'Mobile money', 'Bank transfer', 'Salary deduction', 'Agent'];
  const SHEET_HEADERS = ['Account', 'Date', 'Amount', 'Type', 'Channel', 'Slip No.', 'Remarks'];
  const PERM_ACK_SAVINGS = 1; // index of 'Acknowledge savings/deposits' in PERMS

  function install(ctx) {
    const { R, $, V, fmt, esc, mem, mopts, tbl, say, sv, dd, me, audit, save, num, pd, p2, parseFile, dl } = ctx;
    const S = () => ctx.S();
    const cu = () => ctx.cu();

    /* ---------- pure helpers ---------- */

    const canRecord = () => {
      const roles = S().roles || {};
      const u = cu();
      return !!(u && roles[u.role] && roles[u.role][PERM_ACK_SAVINGS]);
    };

    const localNow = () => {
      const n = new Date();
      return new Date(n - n.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
    };

    const nextRef = () => {
      const s = S();
      s.sseq = (s.sseq || 0) + 1;
      return 'SV-' + String(s.sseq).padStart(6, '0');
    };

    const isWithdrawal = (v) => /^w/i.test(String(v || '').trim());

    const csvEscape = (x) => '"' + String(x).replace(/"/g, '""') + '"';

    const sampleRows = (acc) => [
      [acc, '2026-03-15', 50000, 'Deposit', 'Counter / Cash', 'SLP-001', 'Monthly savings'],
      [acc, '2026-04-02', 20000, 'Withdrawal', 'Mobile money', 'MM-778', 'Emergency withdrawal']
    ];

    const exampleAccount = () => {
      const m = S().members;
      return m && m[0] ? m[0].acc : 'ES-F 000001';
    };

    /* ---------- recording a deposit / withdrawal ---------- */

    function recordTransaction(input) {
      const { acc, amount, date, withdrawal, channel, slip, remarks } = input;
      if (!acc || !(amount > 0) || !date) {
        return { ok: false, msg: 'Choose a member, amount and date.' };
      }
      if (!mem(acc)) return { ok: false, msg: 'Unknown member account.' };
      if (withdrawal && amount > sv(acc)) {
        return { ok: false, msg: 'Withdrawal exceeds the savings balance (' + fmt(sv(acc)) + ').' };
      }
      const ref = nextRef();
      const m = mem(acc);
      S().savings.push({
        acc, amt: amount, date, w: !!withdrawal, ini: me(), ref,
        ch: channel, slip: slip || '', rm: remarks || ''
      });
      audit(
        withdrawal ? 'Savings withdrawal' : 'Savings deposit',
        ref + ' — ' + acc + ' ' + (m ? m.first + ' ' + m.last : '') +
        ', UGX ' + Math.round(amount).toLocaleString() + ' via ' + channel +
        (slip ? ' (slip ' + slip + ')' : '')
      );
      save();
      return { ok: true, ref };
    }

    /* ---------- importing past savings ---------- */

    // Withdrawals are checked against a running balance so an import can never
    // push a member below zero. Rows are applied in date order.
    function importRows(rows, fileName) {
      let ok = 0, bad = 0, overdrawn = 0;
      const prepared = [];

      rows.forEach((r) => {
        const acc = String(r.account || r['account number'] || r.acc || '').trim();
        const ds = pd(r.date);
        const amt = num(r.amount);
        const tm = String(r.date || '').match(/[T\s](\d{1,2}):(\d{2})/) || [];
        const d = ds
          ? new Date(ds + 'T' + p2(tm[1] || 0) + ':' + (tm[2] || '00') + ':00')
          : new Date(NaN);

        if (mem(acc) && amt > 0 && !isNaN(d)) {
          prepared.push({
            acc, amt, d,
            w: isWithdrawal(r.type),
            ch: String(r.channel || '').trim() || 'Imported',
            slip: String(r['slip no.'] || r['slip no'] || r.slip || '').trim(),
            rm: String(r.remarks || r.remark || '').trim()
          });
        } else {
          bad++;
        }
      });

      prepared.sort((a, b) => a.d - b.d);
      const running = {};
      prepared.forEach((p) => {
        if (running[p.acc] === undefined) running[p.acc] = sv(p.acc);
        if (p.w && p.amt > running[p.acc]) { overdrawn++; return; }
        running[p.acc] += p.w ? -p.amt : p.amt;
        S().savings.push({
          acc: p.acc, amt: p.amt, date: p.d.toISOString(), w: p.w, ini: me(),
          ref: nextRef(), ch: p.ch, slip: p.slip, rm: p.rm
        });
        ok++;
      });

      audit(
        'Savings imported',
        'Imported ' + ok + ' savings record(s) from ' + fileName +
        (bad ? '; ' + bad + ' skipped (invalid)' : '') +
        (overdrawn ? '; ' + overdrawn + ' withdrawal(s) skipped (exceed balance)' : '')
      );
      save();
      return { ok, bad, overdrawn };
    }

    /* ---------- import templates ---------- */

    function downloadExcelTemplate() {
      if (!global.XLSX) return say('Excel library could not load — check your internet connection.', 1);
      const ex = exampleAccount();
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([SHEET_HEADERS, ...sampleRows(ex)]);
      ws['!cols'] = SHEET_HEADERS.map(() => ({ wch: 20 }));
      XLSX.utils.book_append_sheet(wb, ws, 'Savings');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Column', 'Required', 'Notes'],
        ['Account', 'Yes', 'Existing member account number, e.g. ' + ex],
        ['Date', 'Yes', 'YYYY-MM-DD (optionally with time HH:MM)'],
        ['Amount', 'Yes', 'Positive number in UGX, no currency symbol'],
        ['Type', 'Yes', 'Deposit or Withdrawal'],
        ['Channel', 'No', CHANNELS.join(', ')],
        ['Slip No.', 'No', 'Slip / receipt / reference number'],
        ['Remarks', 'No', 'Any note'],
        [],
        ['Delete the two sample rows in the Savings sheet before importing your data.']
      ]), 'Instructions');
      audit('Template downloaded', 'Downloaded savings import template (Excel)');
      XLSX.writeFile(wb, 'elite-sacco-savings-import-template.xlsx');
    }

    function downloadCsvTemplate() {
      const csv = [SHEET_HEADERS, ...sampleRows(exampleAccount())]
        .map((r) => r.map(csvEscape).join(','))
        .join('\n');
      audit('Template downloaded', 'Downloaded savings import template (CSV)');
      dl(new Blob(['\ufeff' + csv], { type: 'text/csv' }), 'elite-sacco-savings-import-template.csv');
    }

    /* ---------- tables ---------- */

    function recentTable() {
      const recent = [...S().savings]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 25);
      return tbl(
        ['Ref', 'Date', 'Account', 'Member', 'Type', 'Amount', 'Channel', 'Slip no.', 'Remarks', 'Officer'],
        recent.map((x) => {
          const m = mem(x.acc);
          return [
            esc(x.ref || '—'), dd(x.date), esc(x.acc),
            esc(m ? m.first + ' ' + m.last : ''),
            x.w ? 'Withdrawal' : 'Deposit',
            Math.round(x.amt).toLocaleString(),
            esc(x.ch || ''), esc(x.slip || ''), esc(x.rm || ''), esc(x.ini || '')
          ];
        }),
        [5]
      );
    }

    function monthlyTable() {
      const months = [...Array(12)].map((_, i) => {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - 11 + i);
        return d;
      });
      const key = (d) => d.getFullYear() + '-' + d.getMonth();
      const rows = S().members.map((m) => {
        const t = {};
        S().savings.filter((s) => s.acc == m.acc).forEach((s) => {
          const k = key(new Date(s.date));
          t[k] = (t[k] || 0) + (s.w ? -s.amt : s.amt);
        });
        return [
          m.acc, esc(m.first + ' ' + m.last),
          ...months.map((d) => (t[key(d)] || 0).toLocaleString()),
          '<b>' + sv(m.acc).toLocaleString() + '</b>'
        ];
      });
      return tbl(
        ['Account', 'Member', ...months.map((d) => d.toLocaleString('en', { month: 'short', year: '2-digit' })), 'Total'],
        rows,
        [...Array(13)].map((_, i) => i + 2)
      );
    }

    /* ---------- the view ---------- */

    R.sdep = function sdep() {
      const rec = canRecord();

      const form = rec
        ? `<div class="row">
            <div><label>Member (account)</label><select id="sa"><option value="">— select member —</option>${mopts()}</select></div>
            <div><label>Request type</label><select id="sk"><option value="d">Deposit</option><option value="w">Withdrawal</option></select></div>
            <div><label>Amount (UGX)</label><input id="sm" type="number" min="1"></div>
            <div><label>Date &amp; time</label><input id="sd" type="datetime-local" value="${localNow()}"></div>
            <div><label>Channel</label><select id="sc">${CHANNELS.map((c) => `<option>${c}</option>`).join('')}</select></div>
            <div><label>Slip / receipt / reference no.</label><input id="sr"></div>
            <div><label>Remarks</label><input id="srm"></div>
          </div>
          <p class="note" id="sbal">Select a member to see their current savings balance.</p>
          <button class="btn" id="ss">Save deposit</button>`
        : '<p class="note">You do not have permission to record savings transactions.</p>';

      const importBlock = rec
        ? `<label>Upload past savings (.xlsx, .xls or .csv — columns: account, date, amount, type, channel, slip no., remarks)</label>
           <input type="file" id="su" accept=".csv,.xls,.xlsx">
           <div class="noprint">
             <button class="btn alt2" id="st1" type="button">Download import template (Excel)</button>
             <button class="btn alt2" id="st2" type="button">Download import template (CSV)</button>
           </div>
           <p class="note">Type is <b>Deposit</b> or <b>Withdrawal</b>. Date format: YYYY-MM-DD (optionally with time, e.g. 2026-03-15 09:30). Account must match an existing member account number. Withdrawals that would exceed a member's balance are skipped.</p>`
        : '';

      V.innerHTML = `<div class="card"><h3>Record a member's deposit or withdrawal request</h3>${form}<div id="msg" class="msg"></div>${importBlock}</div>
        <div class="card"><h3>Recent transactions</h3>${recentTable()}</div>
        <div class="card"><h3>Member savings by month</h3>${monthlyTable()}</div>`;

      if (!rec) return;

      const showBalance = () => {
        const a = $('#sa').value;
        $('#sbal').textContent = a
          ? 'Current savings balance: ' + fmt(sv(a))
          : 'Select a member to see their current savings balance.';
      };
      $('#sa').onchange = showBalance;
      $('#sk').onchange = () => {
        $('#ss').textContent = 'Save ' + ($('#sk').value == 'w' ? 'withdrawal' : 'deposit');
      };

      $('#ss').onclick = () => {
        const res = recordTransaction({
          acc: $('#sa').value,
          amount: num($('#sm').value),
          date: $('#sd').value,
          withdrawal: $('#sk').value == 'w',
          channel: $('#sc').value,
          slip: $('#sr').value.trim(),
          remarks: $('#srm').value.trim()
        });
        if (!res.ok) return say(res.msg, 1);
        R.sdep();
        say('Transaction ' + res.ref + ' recorded.');
      };

      $('#st1').onclick = downloadExcelTemplate;
      $('#st2').onclick = downloadCsvTemplate;

      $('#su').onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        parseFile(file, (rows) => {
          const r = importRows(rows, file.name);
          R.sdep();
          say(
            'Imported ' + r.ok + ' record(s); skipped ' + r.bad + ' (unknown account or invalid row)' +
            (r.overdrawn ? ' and ' + r.overdrawn + ' withdrawal(s) exceeding the balance' : '') + '.',
            !r.ok
          );
        });
      };
    };

    // Exposed for reuse / testing.
    return { recordTransaction, importRows, downloadExcelTemplate, downloadCsvTemplate };
  }

  global.SavingsModule = { install };
})(typeof window !== 'undefined' ? window : globalThis);
