/* ==========================================================================
   Elite SACCO Mbarara — Export helpers (export.js)
   --------------------------------------------------------------------------
   Needs (loaded before use):  xlsx.full.min.js, jspdf.umd.min.js,
                               jspdf.plugin.autotable.min.js
   No dependency on the app's closure — everything is passed in.

   API  (window.EliteExport)
     download(blob, filename)
     cleanText(str)                       -> ASCII-safe text for PDF
     toCSV(rows)                          -> CSV string (quoted, with BOM)
     exportCSV(rows, filename)
     exportXLSX(sheets, filename, opts)   -> sheets: [{name, rows, cols?, formats?}]
     exportPDF(opts)                      -> see below
   ========================================================================== */
(function (global) {
  'use strict';

  var BLUE = [27, 60, 145], SOFT = [233, 238, 251], GREY = [120, 120, 120];

  function missing(lib) {
    throw new Error(lib + ' library could not load — check your internet connection.');
  }

  /* ---------- generic ---------- */
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // jsPDF's built-in fonts only cover Latin-1 — swap common symbols, drop the rest.
  function cleanText(s) {
    return String(s == null ? '' : s)
      .replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/÷/g, '/')
      .replace(/[—–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/→/g, '->').replace(/✔/g, '').replace(/●/g, '*')
      .replace(/[^\x00-\x7F]/g, '');
  }

  var num = function (v) { return typeof v === 'number' && isFinite(v); };
  var fmtNum = function (v) { return Math.round(v).toLocaleString(); };

  /* ---------- CSV ---------- */
  function toCSV(rows) {
    return '\ufeff' + rows.map(function (r) {
      return r.map(function (x) {
        return '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\n');
  }

  function exportCSV(rows, filename) {
    download(new Blob([toCSV(rows)], { type: 'text/csv' }), filename);
  }

  /* ---------- Excel ----------
     sheets: [{
        name:    'Statement',                    // max 31 chars, no \ / ? * [ ]
        rows:    [[...], [...]],                 // array of arrays (header = first row, or use header rows you add)
        cols:    [30, 14, 14],                   // optional column widths (characters)
        formats: { 3: '#,##0', 4: '0.00%' }      // optional: column index -> number format
     }]
     opts.headerRow: index of the header row to bold/fill (default 0, -1 = none)
  */
  function exportXLSX(sheets, filename, opts) {
    if (!global.XLSX) missing('Excel');
    opts = opts || {};
    var hdr = opts.headerRow == null ? 0 : opts.headerRow;
    var wb = XLSX.utils.book_new();

    sheets.forEach(function (sh, si) {
      var ws = XLSX.utils.aoa_to_sheet(sh.rows);

      // column widths: explicit, else auto-fit from content (capped)
      if (sh.cols) ws['!cols'] = sh.cols.map(function (w) { return { wch: w }; });
      else {
        var w = [];
        sh.rows.forEach(function (r) {
          r.forEach(function (c, i) {
            var l = String(c == null ? '' : c).length;
            w[i] = Math.min(60, Math.max(w[i] || 8, l + 2));
          });
        });
        ws['!cols'] = w.map(function (x) { return { wch: x }; });
      }

      // number formats
      var fm = sh.formats || {};
      sh.rows.forEach(function (r, ri) {
        r.forEach(function (c, ci) {
          var cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })];
          if (!cell || cell.t !== 'n') return;
          cell.z = fm[ci] || '#,##0';
        });
      });

      // freeze header
      if (hdr >= 0) ws['!freeze'] = { xSplit: 0, ySplit: hdr + 1 };

      var name = String(sh.name || 'Sheet' + (si + 1)).replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, name);
    });

    XLSX.writeFile(wb, filename);
  }

  /* ---------- PDF ----------
     exportPDF({
       filename:   'report.pdf',
       title:      'Elite SACCO Mbarara',
       subtitle:   'Member Account Statement - March 2026',
       meta:       ['Account: ES-F 000001', 'Generated: 2026-10-21'],   // small lines under the title
       summary:    { head:['Savings','UGX'], body:[['Opening','1,000']] },   // optional small table
       head:       ['Date','Ref', ...],
       body:       [[...], [...]],             // strings or numbers (numbers are formatted)
       rightCols:  [3,4,5],                    // right-aligned column indexes
       boldRows:   [0, 12],                    // body row indexes to bold + shade
       orientation:'landscape'|'portrait',     // default landscape
       format:     'a4'|'a3',                  // default a4
       notes:      ['text', ...],              // printed after the table
       signatures: ['Prepared by: ...', 'Reviewed by ...', 'Approved by ...'],  // optional signature lines
       footer:     'Elite SACCO Mbarara - Statement'   // page footer prefix
     })
  */
  function exportPDF(o) {
    if (!global.jspdf || !global.jspdf.jsPDF) missing('PDF');
    var P = new global.jspdf.jsPDF({
      orientation: o.orientation || 'landscape', unit: 'pt', format: o.format || 'a4'
    });
    if (typeof P.autoTable !== 'function') missing('PDF table');

    var pw = P.internal.pageSize.getWidth(), ph = P.internal.pageSize.getHeight();
    var cl = cleanText;
    var cellText = function (x) { return num(x) ? fmtNum(x) : cl(x); };

    // title block
    var y = 38;
    P.setFontSize(16); P.setTextColor(BLUE[0], BLUE[1], BLUE[2]);
    P.text(cl(o.title || 'Elite SACCO Mbarara'), 40, y);
    if (o.subtitle) { y += 18; P.setFontSize(11); P.setTextColor(0); P.text(cl(o.subtitle), 40, y); }
    P.setFontSize(9); P.setTextColor(0);
    (o.meta || []).forEach(function (m) { y += 13; P.text(cl(m), 40, y); });
    y += 12;

    // optional summary table
    if (o.summary) {
      var sRight = {};
      (o.summary.rightCols || []).forEach(function (i) { sRight[i] = { halign: 'right' }; });
      P.autoTable({
        startY: y, head: [o.summary.head.map(cl)], body: o.summary.body.map(function (r) { return r.map(cellText); }),
        styles: { fontSize: 8, cellPadding: 2.5 }, headStyles: { fillColor: BLUE },
        columnStyles: sRight, tableWidth: o.summary.width || 520
      });
      y = P.lastAutoTable.finalY + 14;
    }

    // main table
    var right = {};
    (o.rightCols || []).forEach(function (i) { right[i] = { halign: 'right' }; });
    var bold = {};
    (o.boldRows || []).forEach(function (i) { bold[i] = 1; });
    var colCount = o.head.length;

    P.autoTable({
      startY: y,
      head: [o.head.map(cl)],
      body: o.body.map(function (r) { return r.map(cellText); }),
      styles: { fontSize: colCount > 10 ? 6.5 : 7.5, cellPadding: 2.5 },
      headStyles: { fillColor: BLUE },
      columnStyles: right,
      didParseCell: function (h) {
        if (h.section === 'body' && bold[h.row.index]) {
          h.cell.styles.fontStyle = 'bold';
          h.cell.styles.fillColor = SOFT;
        }
      },
      didDrawPage: function () {
        P.setFontSize(7); P.setTextColor(GREY[0], GREY[1], GREY[2]);
        P.text(cl((o.footer || o.title || 'Elite SACCO Mbarara') + ' - Page ' + P.internal.getNumberOfPages()),
               40, ph - 18);
        P.setTextColor(0);
      }
    });
    y = P.lastAutoTable.finalY + 14;

    // notes
    if (o.notes && o.notes.length) {
      P.setFontSize(7.5); P.setTextColor(0);
      var lines = o.notes.reduce(function (a, t) {
        return a.concat(P.splitTextToSize(cl('Note: ' + t), pw - 80));
      }, []);
      if (y + lines.length * 10 > ph - 40) { P.addPage(); y = 40; }
      lines.forEach(function (l) { P.text(l, 40, y); y += 10; });
    }

    // signature lines
    if (o.signatures && o.signatures.length) {
      y += 26;
      if (y + 40 > ph - 30) { P.addPage(); y = 60; }
      var cw = (pw - 80) / o.signatures.length;
      P.setFontSize(7.5);
      o.signatures.forEach(function (t, i) {
        var x = 40 + i * cw;
        P.line(x, y, x + cw - 20, y);
        P.text(cl(t), x, y + 10);
        P.text('Date:', x, y + 22);
      });
    }

    P.save(o.filename || 'export.pdf');
  }

  global.EliteExport = {
    download: download,
    cleanText: cleanText,
    toCSV: toCSV,
    exportCSV: exportCSV,
    exportXLSX: exportXLSX,
    exportPDF: exportPDF
  };
})(window);
