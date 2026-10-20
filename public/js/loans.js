/*!
 * loans.js — Elite SACCO Mbarara
 * Loan requests, Admin approval, Loans Section (repayments, exports) and loan import.
 *
 * Usage (in index.html, before the main app script):
 *   <script src="loans.js"></script>
 * Then, once the shared helpers exist inside the app script:
 *   LoansModule.install({
 *     R, $, V, S: () => S, cu: () => cu,
 *     fmt, esc, mem, mopts, tbl, say, sv, me, audit, save, num, pd, dl,
 *     bal, sim, who, nmv, bd, today, fmtD, addM, paid, PMT, lref, lstat, ltel,
 *     can, isAdmin
 *   });
 * This registers the views R.lreq, R.lapp and R.lsec and returns the pricing
 * helpers (CATS, calcRate) and importRows for reuse.
 */
(function (global) {
  'use strict';

  /* ===================== PRICING ===================== */

  // Monthly interest rates by category (% per month). Edit here to change pricing.
  const CATS = {
    'Normal Loan': 3,
    'Special Loan': 2.5,
    'Secured Business Loan': 2.5,
    'Agricultural Loan': 2,
    'School Fees Loan': 2
  };
  const NONMEM_EXTRA = 1; // extra % per month charged to non-members
  const termAdj = (t) => (t <= 6 ? 0 : t <= 12 ? 0.25 : 0.5); // extra % per month for longer terms
  const calcRate = (cat, term, member) => {
    const b = CATS[cat] ?? 3;
    const t = termAdj(+term || 0);
    const n = member ? 0 : NONMEM_EXTRA;
    return { b, t, n, r: +(b + t + n).toFixed(2) };
  };

  /* ===================== IMPORT COLUMN ALIASES ===================== */

  const AL = {
    acc: ['account', 'account number', 'acc', 'member account'],
    name: ['name', 'names', 'borrower', 'full name'],
    tel: ['telephone', 'phone', 'contact', 'tel'],
    cat: ['category', 'loan category', 'loan type', 'type'],
    term: ['term (months)', 'term', 'months'],
    amt: ['principal', 'amount', 'loan amount', 'amount borrowed'],
    rate: ['rate (% per month)', 'rate', 'interest rate', 'rate %'],
    date: ['date disbursed', 'date', 'disbursed', 'disbursement date'],
    paid: ['amount paid', 'paid', 'total paid'],
    bal: ['balance', 'outstanding', 'outstanding balance'],
    st: ['status'],
    clr: ['date cleared', 'cleared date', 'closed date']
  };
  const gv = (o, k) => {
    for (const a of AL[k]) {
      if (o[a] !== undefined && String(o[a]).trim() !== '') return String(o[a]).trim();
    }
    return '';
  };

  // Export / template headers.
  const LH = ['Loan Ref', 'Account', 'Name', 'Telephone', 'Category', 'Term (months)', 'Principal',
    'Rate (% per month)', 'Date Disbursed', 'Due Date', 'Amount Paid', 'Balance', 'Status'];

  const csvCell = (x) => '"' + String(x).replace(/"/g, '""') + '"';

  /* ===================== INSTALL ===================== */

  function install(ctx) {
    const { R, $, V, fmt, esc, mem, mopts, tbl, say, sv, me, audit, save, num, pd, dl,
      bal, sim, who, nmv, bd, today, fmtD, addM, paid, PMT, lref, lstat, ltel, can, isAdmin } = ctx;
    const S = () => ctx.S();
    const cu = () => ctx.cu();
    const n0 = (x) => Math.round(x).toLocaleString();
    const loanRef = () => 'LN-' + String(S().loans.length + 1).padStart(4, '0');

    /* ---------- non-member borrowers ---------- */

    const findNon = (name, tel, nin) => {
      const s = S();
      let n = s.non.find((x) =>
        (nin && x.nin && x.nin.toUpperCase() == nin.toUpperCase()) ||
        (x.name.toLowerCase() == name.toLowerCase() && (!tel || !x.tel || x.tel == tel)));
      if (!n) {
        n = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, tel: tel || '', nin: nin || '' };
        s.non.push(n);
      }
      return n;
    };

    /* ================= 1. LOAN REQUESTS ================= */

    function submitRequest(d) {
      const s = S();
      const { isMember, acc, name, tel, email, addr, nin, cat, term, amt, rate, date } = d;
      if (isMember && !acc) return { ok: false, msg: 'Select a member.' };
      if (!name) return { ok: false, msg: 'Applicant name is required.' };
      if (!tel) return { ok: false, msg: 'Contact telephone is required.' };
      if (!date) return { ok: false, msg: 'Choose the date.' };
      if (amt <= 0) return { ok: false, msg: 'Enter the amount to borrow.' };
      if (term < 1 || term > 60) return { ok: false, msg: 'Loan term must be 1–60 months.' };
      if (rate <= 0 || rate > 30) return { ok: false, msg: 'Enter an interest rate between 0.01 and 30 % per month.' };

      const nid = isMember ? undefined : findNon(name, tel, nin).id;
      s.lseq = (s.lseq || 0) + 1;
      const id = 'LR-' + String(s.lseq).padStart(4, '0');
      s.reqs.push({
        id, date, type: isMember ? 'm' : 'n', acc: isMember ? acc : '', nid, name, tel,
        email, addr, cat, term, amt, rate, status: 'Pending', by: cu().name, byIni: me()
      });
      audit('Loan request submitted',
        id + ' — ' + name + ', ' + cat + ', UGX ' + n0(amt) + ', ' + rate + '% per month, ' + term + ' months');
      save();
      return { ok: true, id };
    }

    R.lreq = function lreq() {
      const s = S();
      V.innerHTML = `<div class="card"><h3>New loan request</h3>
 <div class="row"><div><label>Applicant type</label><select id="qt"><option value="m">SACCO member</option><option value="n">Non-member</option></select></div>
 <div id="qmw"><label>Member (account)</label><select id="qm"><option value="">— select member —</option>${mopts()}</select></div>
 <div><label>Applicant name(s)</label><input id="qn" readonly></div><div><label>Date</label><input id="qd" type="date" value="${today()}"></div></div>
 <div class="row"><div><label>Telephone</label><input id="qp" type="tel"></div><div><label>Email</label><input id="qe" type="email"></div><div><label>Address</label><input id="qad"></div><div id="qxw" style="display:none"><label>NIN (optional)</label><input id="qx" style="text-transform:uppercase"></div></div>
 <div class="row"><div><label>Loan category / type</label><select id="qc">${Object.keys(CATS).map((c) => `<option>${c}</option>`).join('')}</select></div>
 <div><label>Loan term (months)</label><input id="ql" type="number" min="1" max="60" value="6"></div>
 <div><label>Amount to borrow (UGX)</label><input id="qam" type="number" min="1000" step="1000"></div>
 <div><label>Interest rate (% per month)</label><input id="qr" type="number" min="0.01" max="30" step="0.01" placeholder="e.g. 3"></div></div>
 <p class="note" id="qrn"></p><button class="btn" id="qs">Submit loan request</button><button class="btn alt2" id="qx2">Clear</button><div id="msg" class="msg"></div></div>
 <div class="card"><h3>Loan requests</h3>${tbl(
        ['Ref', 'Date', 'Applicant', 'Type', 'Category', 'Term', 'Amount', 'Rate %/mo', 'Requested by', 'Status', 'Remark'],
        [...s.reqs].reverse().map((q) => [
          q.id, q.date, q.type == 'm' ? esc(q.name) : `<i>${esc(q.name)}</i>`,
          q.type == 'm' ? 'Member' : 'Non-member', esc(q.cat), q.term + ' mo', n0(q.amt), q.rate,
          esc(q.by), bd(q.status), esc(q.remark || '')]),
        [6, 7])}</div>`;

      const isMem = () => $('#qt').value == 'm';
      const suggest = () => {
        const c = calcRate($('#qc').value, $('#ql').value, isMem());
        if (!$('#qr').dataset.m) $('#qr').value = c.r.toFixed(2);
        $('#qrn').textContent = 'Suggested rate: ' + c.r.toFixed(2) + '% per month (base ' + c.b + '% + term ' + c.t + '%' +
          (c.n ? ' + non-member ' + c.n + '%' : '') +
          '). Edit the rate if needed — the rate you enter is the one applied, compounded monthly on the outstanding balance.';
      };
      const switchMode = () => {
        const m = isMem();
        delete $('#qr').dataset.m;
        $('#qmw').style.display = m ? '' : 'none';
        $('#qxw').style.display = m ? 'none' : '';
        $('#qn').readOnly = m;
        ['qm', 'qn', 'qp', 'qe', 'qad', 'qx'].forEach((i) => ($('#' + i).value = ''));
        suggest();
      };

      $('#qt').onchange = switchMode;
      $('#qc').onchange = $('#ql').oninput = suggest;
      $('#qr').oninput = () => { $('#qr').dataset.m = 1; };
      $('#qm').onchange = () => {
        const m = mem($('#qm').value);
        $('#qn').value = m ? m.first + ' ' + m.last : '';
        $('#qp').value = m ? m.tel : '';
        $('#qe').value = m ? m.email || '' : '';
        $('#qad').value = m ? m.addr || '' : '';
      };
      $('#qx2').onclick = R.lreq;
      suggest();

      $('#qs').onclick = () => {
        const res = submitRequest({
          isMember: isMem(), acc: $('#qm').value, name: $('#qn').value.trim(), tel: $('#qp').value.trim(),
          email: $('#qe').value.trim(), addr: $('#qad').value.trim(), nin: $('#qx').value.trim(),
          cat: $('#qc').value, term: Math.round(num($('#ql').value)), amt: num($('#qam').value),
          rate: +num($('#qr').value).toFixed(2), date: $('#qd').value
        });
        if (!res.ok) return say(res.msg, 1);
        R.lreq();
        say('Request ' + res.id + ' submitted for Admin approval.');
      };
    };

    /* ================= 2. LOAN APPROVAL (Admin) ================= */

    function decideRequest(id, status, remark) {
      const s = S();
      const q = s.reqs.find((x) => x.id == id);
      if (!q || !isAdmin()) return { ok: false, msg: 'Not permitted.' };
      if (!['Pending', 'On Hold'].includes(q.status)) return { ok: false, msg: id + ' has already been decided.' };
      if (status != 'Approved' && !remark) {
        return { ok: false, msg: 'Add a remark before rejecting or holding ' + id + '.' };
      }
      q.status = status;
      q.remark = remark;
      q.decBy = cu().name;
      q.decOn = today();
      if (status == 'Approved') {
        s.loans.push({
          ref: loanRef(), req: q.id, acc: q.acc || '', nid: q.nid, amt: q.amt, rate: q.rate,
          date: today(), cat: q.cat, term: q.term, tel: q.tel, reps: [], ini: me()
        });
      }
      audit('Loan ' + status.toLowerCase(),
        q.id + ' — ' + q.name + ', UGX ' + n0(q.amt) + ' at ' + q.rate + '%/month' + (remark ? ' · Remark: ' + remark : ''));
      save();
      return { ok: true, q };
    }

    R.lapp = function lapp() {
      const s = S();
      const pend = s.reqs.filter((q) => q.status == 'Pending' || q.status == 'On Hold');
      const done = s.reqs.filter((q) => q.status == 'Approved' || q.status == 'Rejected');
      const standing = (q) => {
        if (q.type != 'm') return '—';
        const lb = s.loans.filter((l) => l.acc == q.acc).reduce((t, l) => t + bal(l).b, 0);
        return `Savings ${fmt(sv(q.acc))}<br>Loans ${fmt(lb)}`;
      };

      V.innerHTML = `<div class="card"><h3>Awaiting decision</h3><div id="msg" class="msg"></div>${tbl(
        ['Ref', 'Date', 'Applicant', 'Contact', 'Category', 'Term', 'Amount', 'Rate %/mo', 'Member standing',
          'Requested by', 'Status', 'Remark (required for Reject / Hold)', 'Decision'],
        pend.map((q) => [
          q.id, q.date, q.type == 'm' ? esc(q.name) : `<i>${esc(q.name)}</i> (non-member)`, esc(q.tel), esc(q.cat),
          q.term + ' mo', n0(q.amt), q.rate, standing(q), esc(q.by), bd(q.status),
          `<input data-rm="${q.id}" value="${esc(q.remark || '')}" style="min-width:170px">`,
          `<button class="btn sm" data-d="Approved" data-id="${q.id}">Approve</button> <button class="btn alt2 sm" data-d="On Hold" data-id="${q.id}">Hold</button> <button class="btn alt2 sm" style="color:#D62828;border-color:#D62828" data-d="Rejected" data-id="${q.id}">Reject</button>`]),
        [6, 7])}</div>
 <div class="card"><h3>Decision history</h3>${tbl(
        ['Ref', 'Applicant', 'Category', 'Amount', 'Status', 'Decided by', 'Date', 'Remark'],
        [...done].reverse().map((q) => [q.id, esc(q.name), esc(q.cat), n0(q.amt), bd(q.status),
          esc(q.decBy || ''), q.decOn || '', esc(q.remark || '')]),
        [3])}</div>`;

      V.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => {
        const id = b.dataset.id, st = b.dataset.d;
        const remark = V.querySelector(`[data-rm="${id}"]`).value.trim();
        const res = decideRequest(id, st, remark);
        if (!res.ok) return say(res.msg, 1);
        R.lapp();
        say(res.q.id + ' ' + (st == 'Approved' ? 'approved — loan is now active in the Loans Section'
          : st == 'Rejected' ? 'rejected' : 'put on hold') + '.');
      }));
    };

    /* ================= 3. REPAYMENTS ================= */

    // Validates and records a repayment against loan index `i`.
    function recordRepayment(i, { type, date, amount }) {
      const l = S().loans[i];
      if (!l) return { ok: false, msg: 'Loan not found.' };
      if (!date || date < l.date || date > today()) {
        return { ok: false, msg: 'Choose a valid date (not before disbursement, not in the future).' };
      }
      const last = (l.reps || []).reduce((m, x) => (x.date > m ? x.date : m), '');
      if (last && date < last) return { ok: false, msg: 'Date cannot be earlier than the last recorded payment (' + last + ').' };

      const due = Math.ceil(bal(l, new Date(date)).b);
      const a = type == 'full' ? due : amount;
      if (a <= 0) return { ok: false, msg: 'Enter an amount.' };
      if (a > due) return { ok: false, msg: 'Amount exceeds the balance due on that date (' + fmt(due) + ').' };

      const label = type == 'full' ? 'Full settlement' : type == 'lump' ? 'Lump sum' : 'Installment';
      (l.reps = l.reps || []).push({ date, amt: a, type: label, ini: me() });
      audit('Loan repayment',
        lref(l, i) + ' — ' + who(l).name + ' paid UGX ' + n0(a) + ' (' + label.toLowerCase() + ') dated ' + date);
      save();
      return { ok: true, amount: a, cleared: bal(l).b < 0.5 };
    }

    /* ================= 4. LOAN EXPORT ROWS ================= */

    const lrows = (rs) => rs.map((r) => {
      const l = r.l;
      return [lref(l, r.i), r.w.acc, r.w.name, ltel(l), l.cat || '', l.term || '', Math.round(l.amt), l.rate,
        l.date, l.term ? fmtD(addM(l.date, l.term)) : '', Math.round(paid(l)), Math.round(r.b),
        r.s === 'Cleared' ? 'Cleared' : 'Active'];
    });

    /* ================= 5. LOAN IMPORT ================= */

    async function readLoanFile(file) {
      if (/\.pdf$/i.test(file.name)) {
        if (!global.pdfjsLib) throw new Error('PDF reader could not load — check your internet connection.');
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          const w = await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js')).text();
          pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([w], { type: 'text/javascript' }));
        }
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        let hdr = null;
        const out = [];
        for (let p = 1; p <= doc.numPages; p++) {
          const tc = await (await doc.getPage(p)).getTextContent();
          const lines = [];
          tc.items
            .filter((it) => it.str.trim())
            .map((it) => ({ s: it.str.trim(), x: it.transform[4], y: it.transform[5] }))
            .sort((a, b) => b.y - a.y)
            .forEach((it) => {
              const L = lines.find((l) => Math.abs(l.y - it.y) < 2.5);
              L ? L.c.push(it) : lines.push({ y: it.y, c: [it] });
            });
          lines.forEach((L) => {
            L.c.sort((a, b) => a.x - b.x);
            if (!hdr) {
              const t = L.c.map((c) => c.s.toLowerCase()).join(' ');
              if (t.includes('name') && t.includes('principal')) hdr = L.c.map((c) => ({ k: c.s.toLowerCase(), x: c.x }));
              return;
            }
            const o = {};
            L.c.forEach((c) => {
              let h = null;
              hdr.forEach((H) => { if (H.x <= c.x + 1.5) h = H; });
              if (h) o[h.k] = (o[h.k] ? o[h.k] + ' ' : '') + c.s;
            });
            if (num(o.principal) > 0) out.push(o);
          });
        }
        if (!hdr) throw new Error('No loans table found in the PDF. Use a PDF exported from this system.');
        return out;
      }
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      return XLSX.utils
        .sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '', dateNF: 'yyyy-mm-dd' })
        .map((o) => {
          const n = {};
          for (const k in o) n[k.trim().toLowerCase()] = o[k];
          return n;
        });
    }

    function importRows(rows) {
      const s = S();
      let ok = 0, dup = 0, bad = 0, unk = 0;

      rows.forEach((o) => {
        const A = num(gv(o, 'amt')), date = pd(gv(o, 'date')), accS = gv(o, 'acc');
        const nm = gv(o, 'name');
        const m = accS ? mem(accS) : null;
        if (!date || A <= 0 || (!m && !nm)) { bad++; return; }
        if (accS && !m) unk++;

        const tel = gv(o, 'tel');
        const nid = m ? undefined : findNon(nm, tel, '').id;
        const key = m ? m.acc : nid;
        if (s.loans.some((x) => (x.acc || x.nid) == key && x.date == date && x.amt == A)) { dup++; return; }

        const cr = gv(o, 'cat');
        const cat = Object.keys(CATS).find((c) =>
          c.toLowerCase() == cr.toLowerCase() || (c.toLowerCase().startsWith(cr.toLowerCase()) && cr)) || cr || 'Normal Loan';
        const term = Math.round(num(gv(o, 'term'))) || 0;
        const rt = num(gv(o, 'rate'));
        const l = {
          ref: loanRef(), acc: m ? m.acc : '', nid, amt: A, rate: rt > 0 ? rt : calcRate(cat, term, !!m).r,
          date, cat, term, tel: tel || (m ? m.tel : ''), reps: [], ini: me(), imported: true
        };

        const st = gv(o, 'st').toLowerCase(), bs = gv(o, 'bal'), pdAmt = num(gv(o, 'paid'));
        if (/clear|closed|settled|fully/.test(st) || (bs !== '' && num(bs) < 0.5 && /cleared/.test(st))) {
          let d = pd(gv(o, 'clr')) || today();
          if (d < date) d = date;
          const b = bal(l, new Date(d)).b;
          if (b >= 0.5) l.reps.push({ date: d, amt: Math.ceil(b), type: 'Imported settlement', ini: me() });
        } else if (bs !== '') {
          const diff = bal(l).b - num(bs);
          if (diff >= 0.5) l.reps.push({ date: today(), amt: Math.round(diff), type: 'Imported payments', ini: me() });
        } else if (pdAmt > 0) {
          l.reps.push({ date: today(), amt: Math.min(pdAmt, Math.ceil(bal(l).b)), type: 'Imported payments', ini: me() });
        }
        s.loans.push(l);
        ok++;
      });

      save();
      return `Imported ${ok} loan(s)${dup ? `, skipped ${dup} duplicate(s)` : ''}${bad ? `, ${bad} row(s) skipped (missing name/amount/date)` : ''}${unk ? `; ${unk} unknown account number(s) were treated as non-members` : ''}.`;
    }

    function downloadImportTemplate() {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Account', 'Name', 'Telephone', 'Category', 'Term (months)', 'Principal', 'Rate (% per month)', 'Date Disbursed', 'Status', 'Balance', 'Date Cleared'],
        ['ES-M 000001', 'Jane Doe', '0772000000', 'Normal Loan', 6, 1000000, 3, '2025-03-15', 'Active', 650000, ''],
        ['', 'John Visitor (non-member)', '0701000000', 'Special Loan', 12, 2000000, 3.5, '2024-01-10', 'Cleared', 0, '2025-01-10']
      ]), 'Loans');
      XLSX.writeFile(wb, 'elite-sacco-loans-import-template.xlsx');
    }

    /* ================= 6. LOANS SECTION ================= */

    R.lsec = function lsec() {
      const s = S();
      let flt = 'active', qs = '', sel = null, pm = '';

      const list = () => s.loans
        .map((l, i) => ({ l, i, w: who(l), s: lstat(l), b: bal(l).b }))
        .filter((r) => (flt == 'all' || (flt == 'cleared') == (r.s == 'Cleared')) &&
          (!qs || (r.w.name + ' ' + r.w.acc + ' ' + lref(r.l, r.i)).toLowerCase().includes(qs)));

      V.innerHTML = `<div class="kpis" id="lk"></div><div class="card"><h3>Loans</h3>
 <div class="row"><div><label>Show</label><select id="lf"><option value="active">Active loans</option><option value="cleared">Cleared loans</option><option value="all">All loans</option></select></div><div><label>Search</label><input id="ls" placeholder="Name, account or loan ref"></div></div>
 <div class="noprint"><button class="btn" id="ex1">Export Excel</button><button class="btn alt2" id="ex2">Export CSV</button><button class="btn alt2" id="ex3">Export PDF</button><button class="btn alt2" id="tp">Download import template</button></div>
 <label>Import old cleared and active loans (.xlsx, .xls, .csv or .pdf)</label><input type="file" id="lu" accept=".xlsx,.xls,.csv,.pdf"><p class="note">Columns: Account (blank for non-members), Name, Telephone, Category, Term (months), Principal, Rate (% per month), Date Disbursed, Status (Active/Cleared), Balance or Amount Paid, Date Cleared. PDFs must be text-based tables such as ones exported from this system.</p>
 <div id="msg" class="msg"></div><div id="lt"></div></div><div id="ld"></div>`;

      const drawKpis = () => {
        const all = s.loans.map((l) => ({ l, b: bal(l).b }));
        const ac = all.filter((x) => x.b >= 0.5);
        $('#lk').innerHTML =
          `<div class="kpi">Active loans<b>${ac.length}</b></div>` +
          `<div class="kpi">Principal out<b>${fmt(ac.reduce((t, x) => t + x.l.amt, 0))}</b></div>` +
          `<div class="kpi">Outstanding (incl. interest)<b>${fmt(ac.reduce((t, x) => t + x.b, 0))}</b></div>` +
          `<div class="kpi">Cleared loans<b>${all.length - ac.length}</b></div>`;
      };

      const detailMsg = (t, e) => {
        const m = $('#dm');
        m.className = 'msg' + (e ? ' err' : '');
        m.textContent = t;
      };

      const drawTable = () => {
        drawKpis();
        $('#lt').innerHTML = tbl(
          ['✔', 'Ref', 'Account', 'Borrower', 'Category', 'Term', 'Principal', 'Rate %/mo', 'Disbursed', 'Due',
            'Paid', 'Balance', 'Status', ''],
          list().map((r) => [
            r.s == 'Cleared' ? '<span class="chk" title="Cleared — zero balance">✔</span>' : '',
            lref(r.l, r.i), esc(r.w.acc), nmv(r.w), esc(r.l.cat || ''), r.l.term ? r.l.term + ' mo' : '',
            n0(r.l.amt), r.l.rate, r.l.date, r.l.term ? fmtD(addM(r.l.date, r.l.term)) : '',
            n0(paid(r.l)), n0(r.b), bd(r.s),
            `<button class="btn alt2 sm" data-m="${r.i}">${can('lsec') ? 'Manage' : 'View'}</button>`]),
          [6, 7, 10, 11]);
        V.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => {
          sel = +b.dataset.m;
          pm = '';
          drawDetail();
          $('#ld').scrollIntoView({ behavior: 'smooth' });
        }));
      };

      const drawDetail = () => {
        const D = $('#ld');
        if (sel == null || !s.loans[sel]) { D.innerHTML = ''; return; }
        const l = s.loans[sel], w = who(l), b = bal(l).b, done = b < 0.5;
        const inst = l.term ? Math.round(PMT(l.amt, l.rate / 100, l.term)) : 0;
        const canPay = !!(s.roles[cu().role] && s.roles[cu().role][2]);
        const hist = sim(l).map((x) => [x.date, esc(x.type || 'Payment'), n0(x.p), n0(x.i), n0(x.bal), esc(x.ini || '')]);

        D.innerHTML = `<div class="card"><h3>${lref(l, sel)} — ${nmv(w)} ${bd(lstat(l))}</h3><div class="kpis"><div class="kpi">Principal<b>${fmt(l.amt)}</b></div><div class="kpi">Rate<b>${l.rate}% / month</b></div><div class="kpi">Total paid<b>${fmt(paid(l))}</b></div><div class="kpi">Balance (principal + interest)<b>${fmt(b)}</b></div>${inst && !done ? `<div class="kpi">Suggested installment<b>${fmt(inst)}</b></div>` : ''}</div>
  ${done
    ? `<div class="tagline" style="color:#0a7a3b;border-color:#0a7a3b;background:#DDF4E6">✔ Cleared — zero balance. Principal and all accrued interest have been settled.</div>`
    : canPay
      ? `<h3>Record payment</h3><div class="row"><div><label>Payment type</label><select id="pt"><option value="inst">Installment</option><option value="lump">Lump sum</option><option value="full">Clear full balance</option></select></div><div><label>Amount (UGX)</label><input id="pam" type="number" min="1" value="${inst || ''}"></div><div><label>Date</label><input id="pdt" type="date" value="${today()}" min="${l.date}" max="${today()}"></div></div><button class="btn" id="pb">Record payment</button>`
      : '<p class="note">You do not have permission to record repayments.</p>'}
  <div id="dm" class="msg ${pm.err ? 'err' : ''}">${esc(pm.t || '')}</div><h3>Repayment history</h3>${tbl(['Date', 'Type', 'Principal paid', 'Interest paid', 'Balance after', 'By'], hist, [2, 3, 4])}</div>`;

        if (!done && canPay) {
          const fill = () => {
            const full = $('#pt').value == 'full';
            $('#pam').readOnly = full;
            if (full) $('#pam').value = Math.ceil(bal(l, new Date($('#pdt').value || today())).b);
          };
          $('#pt').onchange = $('#pdt').onchange = fill;
          $('#pb').onclick = () => {
            const res = recordRepayment(sel, { type: $('#pt').value, date: $('#pdt').value, amount: num($('#pam').value) });
            if (!res.ok) return detailMsg(res.msg, 1);
            pm = { t: res.cleared ? 'Payment recorded. Loan fully cleared ✔' : 'Payment of ' + fmt(res.amount) + ' recorded.' };
            drawTable();
            drawDetail();
          };
        }
      };

      $('#lf').onchange = (e) => { flt = e.target.value; drawTable(); };
      $('#ls').oninput = (e) => { qs = e.target.value.trim().toLowerCase(); drawTable(); };

      const fileName = () => 'elite-sacco-loans-' + flt + '-' + today();

      $('#ex1').onclick = () => {
        if (!global.XLSX) return say('Excel library could not load — check your internet connection.', 1);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([LH, ...lrows(list())]), 'Loans');
        audit('Loans exported', 'Exported loans to Excel (' + flt + ')');
        XLSX.writeFile(wb, fileName() + '.xlsx');
      };
      $('#ex2').onclick = () => {
        const csv = [LH, ...lrows(list())].map((r) => r.map(csvCell).join(',')).join('\n');
        audit('Loans exported', 'Exported loans to CSV (' + flt + ')');
        dl(new Blob(['\ufeff' + csv], { type: 'text/csv' }), fileName() + '.csv');
      };
      $('#ex3').onclick = () => {
        if (!global.jspdf) return say('PDF library could not load — check your internet connection.', 1);
        const d = new jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a3' });
        d.setFontSize(14);
        d.text('Elite SACCO Mbarara — Loans (' + flt + ') as at ' + today(), 40, 36);
        d.autoTable({
          startY: 50,
          head: [LH],
          body: lrows(list()).map((r) => r.map((x, i) => (typeof x == 'number' && [6, 10, 11].includes(i) ? x.toLocaleString() : String(x)))),
          styles: { fontSize: 7, cellPadding: 3, halign: 'left' },
          headStyles: { fillColor: [27, 60, 145] }
        });
        audit('Loans exported', 'Exported loans to PDF (' + flt + ')');
        d.save(fileName() + '.pdf');
      };
      $('#tp').onclick = () => {
        if (!global.XLSX) return say('Excel library could not load — check your internet connection.', 1);
        downloadImportTemplate();
      };
      $('#lu').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          const rows = await readLoanFile(f);
          const t = importRows(rows);
          audit('Loans imported', t + ' File: ' + f.name);
          R.lsec();
          say(t, /Imported 0 /.test(t));
        } catch (x) {
          say('Import failed: ' + x.message, 1);
        }
      };

      drawTable();
    };

    return { CATS, calcRate, importRows, submitRequest, decideRequest, recordRepayment, readLoanFile, lrows };
  }

  global.LoansModule = { install, CATS, calcRate };
})(typeof window !== 'undefined' ? window : globalThis);
