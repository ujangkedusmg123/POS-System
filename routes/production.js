const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly, requirePerm } = require('../middleware/auth');
const db = { prepare: (...a) => getDb().prepare(...a) };

router.use(authMiddleware);

const CONST_KEYS = {
  hpp_resep: 'prod_hpp_resep',
  harga_jual: 'prod_harga_jual',
  hpp_packaging: 'prod_hpp_packaging',
  opex_harian: 'prod_opex_harian',
  pcs_per_porsi: 'prod_pcs_per_porsi',
  pcs_per_resep: 'prod_pcs_per_resep',
};
const DEFAULTS = { hpp_resep: 65040, harga_jual: 14000, hpp_packaging: 1100, opex_harian: 650000, pcs_per_porsi: 4, pcs_per_resep: 37 };

function getConfig() {
  const cfg = { ...DEFAULTS };
  Object.entries(CONST_KEYS).forEach(([k, sk]) => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(sk);
    if (row && row.value !== null && row.value !== '') cfg[k] = parseFloat(row.value);
  });
  if (!cfg.pcs_per_porsi || cfg.pcs_per_porsi <= 0) cfg.pcs_per_porsi = 4;
  return cfg;
}

// Hitung semua kolom turunan untuk 1 baris produksi
function computeRow(log, cfg) {
  const jumlahResep = Number(log.jumlah_resep) || 0;
  const output = Number(log.output_pcs) || 0;
  const opex = (log.opex_harian !== null && log.opex_harian !== undefined) ? Number(log.opex_harian) : cfg.opex_harian;

  const outputPerResep = jumlahResep > 0 ? output / jumlahResep : 0;
  const uangKeluar = cfg.hpp_resep * jumlahResep;
  const porsi = output / cfg.pcs_per_porsi;
  const uangPackaging = porsi * cfg.hpp_packaging;
  const uangMasuk = porsi * cfg.harga_jual;
  const grossMargin = uangMasuk - uangKeluar - uangPackaging;
  const grossMarginPct = uangMasuk > 0 ? grossMargin / uangMasuk : 0;
  const rasioHppPct = 1 - grossMarginPct;
  const surplus = grossMargin - opex;
  const surplusPct = uangMasuk > 0 ? surplus / uangMasuk : 0;

  return {
    id: log.id,
    log_date: log.log_date,
    branch_id: log.branch_id,
    branch_name: log.branch_name,
    notes: log.notes,
    // input
    jumlah_resep: jumlahResep,
    output_pcs: output,
    opex_harian: opex,
    // hasil
    output_per_resep: outputPerResep,
    rasio_hpp_pct: rasioHppPct,
    gross_margin_pct: grossMarginPct,
    uang_keluar: uangKeluar,
    porsi: porsi,
    uang_packaging: uangPackaging,
    uang_masuk: uangMasuk,
    gross_margin: grossMargin,
    surplus: surplus,
    surplus_pct: surplusPct,
  };
}

// GET konstanta
router.get('/config', requirePerm('production.view'), (req, res) => {
  res.json(getConfig());
});

// PUT konstanta (admin)
router.put('/config', requirePerm('production.recipe'), (req, res) => {
  try {
    Object.entries(CONST_KEYS).forEach(([k, sk]) => {
      if (req.body[k] !== undefined && req.body[k] !== null && req.body[k] !== '') {
        const val = String(parseFloat(req.body[k]) || 0);
        db.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?, updated_at=datetime('now','+7 hours')").run(sk, val, val);
      }
    });
    res.json({ message: 'Konstanta produksi berhasil disimpan', config: getConfig() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET daftar log + hasil hitung + ringkasan
router.get('/', requirePerm('production.view'), (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const cfg = getConfig();
    let q = `SELECT pl.*, b.name as branch_name FROM production_logs pl LEFT JOIN branches b ON pl.branch_id=b.id WHERE 1=1`;
    const p = [];
    if (start) { q += ' AND pl.log_date >= ?'; p.push(start); }
    if (end)   { q += ' AND pl.log_date <= ?'; p.push(end); }
    if (branch_id) { q += ' AND pl.branch_id = ?'; p.push(branch_id); }
    q += ' ORDER BY pl.log_date ASC, pl.id ASC';
    const rows = db.prepare(q).all(...p).map(r => computeRow(r, cfg));

    // Ringkasan
    const sum = (f) => rows.reduce((s, r) => s + r[f], 0);
    const n = rows.length;
    const totalUangMasuk = sum('uang_masuk');
    const summary = {
      days: n,
      total_resep: sum('jumlah_resep'),
      total_output: sum('output_pcs'),
      total_porsi: sum('porsi'),
      total_uang_masuk: totalUangMasuk,
      total_uang_keluar: sum('uang_keluar'),
      total_packaging: sum('uang_packaging'),
      total_gross_margin: sum('gross_margin'),
      total_opex: sum('opex_harian'),
      total_surplus: sum('surplus'),
      avg_gross_margin_pct: totalUangMasuk > 0 ? sum('gross_margin') / totalUangMasuk : 0,
      avg_surplus_pct: totalUangMasuk > 0 ? sum('surplus') / totalUangMasuk : 0,
      avg_output_per_resep: sum('jumlah_resep') > 0 ? sum('output_pcs') / sum('jumlah_resep') : 0,
    };
    res.json({ config: cfg, rows, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST log baru (admin)
router.post('/', requirePerm('production.edit'), (req, res) => {
  try {
    const { log_date, branch_id, jumlah_resep, output_pcs, opex_harian, notes } = req.body;
    if (!log_date) return res.status(400).json({ error: 'Tanggal wajib diisi' });
    const cfg = getConfig();
    const opex = (opex_harian !== undefined && opex_harian !== null && opex_harian !== '') ? parseFloat(opex_harian) : cfg.opex_harian;
    const r = db.prepare('INSERT INTO production_logs (log_date,branch_id,jumlah_resep,output_pcs,opex_harian,notes,created_by) VALUES (?,?,?,?,?,?,?)')
      .run(log_date, branch_id || null, parseFloat(jumlah_resep) || 0, parseFloat(output_pcs) || 0, opex, notes || null, req.user.id);
    res.json({ id: r.lastInsertRowid, message: 'Data produksi ditambahkan' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT log (admin)
router.put('/:id', requirePerm('production.edit'), (req, res) => {
  try {
    const ex = db.prepare('SELECT * FROM production_logs WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'Data tidak ditemukan' });
    const { log_date, branch_id, jumlah_resep, output_pcs, opex_harian, notes } = req.body;
    const opex = (opex_harian !== undefined && opex_harian !== null && opex_harian !== '') ? parseFloat(opex_harian) : ex.opex_harian;
    db.prepare('UPDATE production_logs SET log_date=?,branch_id=?,jumlah_resep=?,output_pcs=?,opex_harian=?,notes=? WHERE id=?')
      .run(log_date || ex.log_date, branch_id !== undefined ? (branch_id || null) : ex.branch_id,
        jumlah_resep !== undefined ? parseFloat(jumlah_resep) || 0 : ex.jumlah_resep,
        output_pcs !== undefined ? parseFloat(output_pcs) || 0 : ex.output_pcs,
        opex, notes !== undefined ? notes : ex.notes, req.params.id);
    res.json({ message: 'Data produksi diperbarui' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE log (admin)
router.delete('/:id', requirePerm('production.delete'), (req, res) => {
  db.prepare('DELETE FROM production_logs WHERE id=?').run(req.params.id);
  res.json({ message: 'Data produksi dihapus' });
});

module.exports = router;
module.exports.computeRow = computeRow;
module.exports.getConfig = getConfig;
module.exports.DEFAULTS = DEFAULTS;
