const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { authMiddleware } = require('../middleware/auth');

/* ==========================================================================
   EKSPOR EXCEL (.xlsx)
   --------------------------------------------------------------------------
   Satu endpoint untuk seluruh laporan. Halaman mana pun cukup mengirim data
   yang sudah tampil di layar beserta keterangan kolomnya, lalu server yang
   merapikan: judul, keterangan periode, header berwarna, format Rupiah,
   lebar kolom, baris beku, filter, dan baris TOTAL.

   Alasan dikerjakan di server, bukan di browser: formatnya jadi satu resep
   yang sama untuk semua halaman. Kalau tiap halaman merangkai file sendiri,
   cepat atau lambat ada laporan yang formatnya beda sendiri.
   ========================================================================== */

router.use(authMiddleware);

const WARNA = {
  judul: 'FF0F1F3D',      // navy
  header: 'FF1E6FE8',     // biru
  headerTeks: 'FFFFFFFF',
  garis: 'FFD9E2EC',
  zebra: 'FFF7FAFC',
  total: 'FFEAF2FE',
};

/** Format angka per jenis kolom. */
const FORMAT = {
  money: '#,##0;[Red]-#,##0',
  number: '#,##0',
  decimal: '#,##0.00',
  percent: '0.0"%"',
  date: 'dd/mm/yyyy',
  datetime: 'dd/mm/yyyy hh:mm',
  text: '@',
};

/** Batas wajar supaya satu permintaan tidak menghabiskan memori server. */
const MAKS_BARIS = 50000;
const MAKS_KOLOM = 80;

function bersihkanNama(v, fallback) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return fallback;
  // Excel melarang karakter ini pada nama sheet, dan maksimal 31 karakter
  return s.replace(/[\\/*?:[\]]/g, '-').slice(0, 31);
}

/** Ubah nilai mentah jadi nilai yang dimengerti Excel (angka tetap angka). */
function nilaiSel(raw, tipe) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (tipe === 'money' || tipe === 'number' || tipe === 'decimal' || tipe === 'percent') {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  }
  if (tipe === 'date' || tipe === 'datetime') {
    // Tanggal di database sudah berupa waktu setempat (WIB). Kalau dibuat lewat
    // `new Date('...')` biasa, Node menganggapnya waktu lokal server lalu Excel
    // menyimpannya sebagai UTC — jamnya jadi bergeser beberapa jam di file.
    // Karena itu komponennya dirakit langsung sebagai UTC: angka yang tersimpan
    // di Excel sama persis dengan yang tertulis di database.
    const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) {
      const d = new Date(String(raw));
      return isNaN(d.getTime()) ? String(raw) : d;
    }
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  }
  return typeof raw === 'object' ? JSON.stringify(raw) : raw;
}

function tulisSheet(wb, spec, index) {
  const kolom = Array.isArray(spec.columns) ? spec.columns.slice(0, MAKS_KOLOM) : [];
  const baris = Array.isArray(spec.rows) ? spec.rows.slice(0, MAKS_BARIS) : [];
  const ws = wb.addWorksheet(bersihkanNama(spec.name, 'Sheet' + (index + 1)), {
    views: [{ state: 'frozen', ySplit: 0 }],
    pageSetup: { paperSize: 9, orientation: kolom.length > 7 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const lebarKolom = Math.max(1, kolom.length);

  let r = 1;
  // --- Judul ---
  if (spec.title) {
    ws.mergeCells(r, 1, r, lebarKolom);
    const c = ws.getCell(r, 1);
    c.value = String(spec.title);
    c.font = { bold: true, size: 14, color: { argb: WARNA.judul } };
    c.alignment = { vertical: 'middle' };
    ws.getRow(r).height = 22;
    r++;
  }
  // --- Keterangan (periode, cabang, dll) ---
  const meta = Array.isArray(spec.meta) ? spec.meta : [];
  meta.forEach((m) => {
    const label = Array.isArray(m) ? m[0] : m;
    const isi = Array.isArray(m) ? m[1] : '';
    ws.mergeCells(r, 1, r, lebarKolom);
    const c = ws.getCell(r, 1);
    c.value = isi === '' ? String(label) : String(label) + ': ' + String(isi);
    c.font = { size: 10, color: { argb: 'FF5A6A7E' } };
    r++;
  });
  if (spec.title || meta.length) r++; // satu baris kosong pemisah

  if (!kolom.length) {
    ws.getCell(r, 1).value = 'Tidak ada data.';
    return;
  }

  // --- Header ---
  const barisHeader = r;
  kolom.forEach((k, i) => {
    const c = ws.getCell(barisHeader, i + 1);
    c.value = String(k.header || k.key || '');
    c.font = { bold: true, color: { argb: WARNA.headerTeks }, size: 11 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARNA.header } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: WARNA.header } } };
  });
  ws.getRow(barisHeader).height = 20;
  r++;

  // --- Isi ---
  const kananUntuk = { money: 'right', number: 'right', decimal: 'right', percent: 'right' };
  baris.forEach((row, idx) => {
    kolom.forEach((k, i) => {
      const tipe = k.type || 'text';
      const raw = Array.isArray(row) ? row[i] : row[k.key];
      const c = ws.getCell(r, i + 1);
      c.value = nilaiSel(raw, tipe);
      c.numFmt = FORMAT[tipe] || FORMAT.text;
      c.alignment = { horizontal: kananUntuk[tipe] || (tipe === 'date' || tipe === 'datetime' ? 'center' : 'left'), vertical: 'middle', wrapText: false };
      c.font = { size: 10 };
      c.border = { bottom: { style: 'hair', color: { argb: WARNA.garis } } };
      if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARNA.zebra } };
    });
    r++;
  });

  // --- Baris TOTAL ---
  if (spec.totals && typeof spec.totals === 'object') {
    kolom.forEach((k, i) => {
      const tipe = k.type || 'text';
      const raw = Array.isArray(spec.totals) ? spec.totals[i] : spec.totals[k.key];
      const c = ws.getCell(r, i + 1);
      c.value = nilaiSel(raw, raw === undefined ? 'text' : tipe);
      if (raw !== undefined && raw !== null) c.numFmt = FORMAT[tipe] || FORMAT.text;
      c.font = { bold: true, size: 10, color: { argb: WARNA.judul } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARNA.total } };
      c.alignment = { horizontal: kananUntuk[tipe] || 'left', vertical: 'middle' };
      c.border = { top: { style: 'thin', color: { argb: WARNA.header } } };
    });
    r++;
  }

  // --- Lebar kolom: ikuti isi terpanjang, tetap dalam batas wajar ---
  kolom.forEach((k, i) => {
    let lebar = k.width;
    if (!lebar) {
      let maks = String(k.header || '').length;
      baris.forEach((row) => {
        const raw = Array.isArray(row) ? row[i] : row[k.key];
        const teks = raw === null || raw === undefined ? '' : String(raw);
        if (teks.length > maks) maks = teks.length;
      });
      const tipe = k.type || 'text';
      if (tipe === 'money' || tipe === 'number' || tipe === 'decimal') maks = Math.max(maks, 12);
      if (tipe === 'date') maks = Math.max(maks, 12);
      if (tipe === 'datetime') maks = Math.max(maks, 18);
      lebar = Math.min(46, Math.max(9, maks + 3));
    }
    ws.getColumn(i + 1).width = lebar;
  });

  // Header dibekukan + bisa difilter — laporan panjang tetap enak dibaca
  ws.views = [{ state: 'frozen', ySplit: barisHeader }];
  if (baris.length) {
    ws.autoFilter = {
      from: { row: barisHeader, column: 1 },
      to: { row: barisHeader + baris.length, column: kolom.length },
    };
  }
}

/**
 * POST /api/export/xlsx
 * body: { filename, sheets: [{ name, title, meta, columns, rows, totals }] }
 * Data dikirim oleh halaman yang sudah menampilkannya — jadi isi file persis
 * sama dengan yang dilihat pengguna, termasuk filter yang sedang aktif.
 */
router.post('/xlsx', async (req, res) => {
  try {
    const body = req.body || {};
    const sheets = Array.isArray(body.sheets) ? body.sheets.filter((s) => s && typeof s === 'object') : [];
    if (!sheets.length) return res.status(400).json({ error: 'Tidak ada data untuk diekspor' });
    const totalBaris = sheets.reduce((a, s) => a + (Array.isArray(s.rows) ? s.rows.length : 0), 0);
    if (totalBaris > MAKS_BARIS) {
      return res.status(413).json({ error: `Data terlalu banyak (${totalBaris.toLocaleString('id-ID')} baris). Persempit rentang tanggal lalu coba lagi.` });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Ujang Kedu POS';
    wb.created = new Date();
    sheets.forEach((s, i) => tulisSheet(wb, s, i));

    const nama = bersihkanNama(String(body.filename || 'laporan').replace(/\.xlsx$/i, ''), 'laporan');
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nama}.xlsx"`);
    res.setHeader('Content-Length', buf.byteLength);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('Export xlsx error:', e);
    res.status(500).json({ error: 'Gagal membuat file Excel: ' + e.message });
  }
});

module.exports = router;
