const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, requirePerm } = require('../middleware/auth');
const db = { prepare: (...a) => getDb().prepare(...a), transaction: (...a) => getDb().transaction(...a) };

router.use(authMiddleware);

// GET semua bahan baku + stok
router.get('/', requirePerm('bahan.view'), (req, res) => {
  try {
    const materials = db.prepare('SELECT * FROM raw_materials WHERE is_active=1 ORDER BY name').all();
    const low = materials.filter(m => m.current_stock <= m.min_stock).length;
    res.json({ materials, low_stock_count: low });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST tambah bahan baku baru
router.post('/', requirePerm('bahan.edit'), (req, res) => {
  const { name, unit, min_stock, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama bahan wajib diisi' });
  const r = db.prepare('INSERT INTO raw_materials (name,unit,current_stock,min_stock,notes) VALUES (?,?,0,?,?)').run(name, unit||'kg', min_stock||1, notes||'');
  res.json({ id: r.lastInsertRowid, message: 'Bahan baku berhasil ditambahkan' });
});

// PUT update bahan baku
router.put('/:id', requirePerm('bahan.edit'), (req, res) => {
  const { name, unit, min_stock, notes, is_active } = req.body;
  const m = db.prepare('SELECT * FROM raw_materials WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Bahan tidak ditemukan' });
  db.prepare('UPDATE raw_materials SET name=?,unit=?,min_stock=?,notes=?,is_active=? WHERE id=?').run(name||m.name, unit||m.unit, min_stock||m.min_stock, notes||m.notes, is_active!==undefined?is_active:m.is_active, req.params.id);
  res.json({ message: 'Bahan baku diperbarui' });
});

// POST refill/restock bahan baku
router.post('/:id/refill', requirePerm('bahan.edit'), (req, res) => {
  const { quantity, notes } = req.body;
  if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Jumlah harus lebih dari 0' });
  const doRefill = db.transaction(() => {
    const m = db.prepare('SELECT * FROM raw_materials WHERE id=?').get(req.params.id);
    if (!m) throw new Error('Bahan tidak ditemukan');
    const before = m.current_stock;
    const after = before + parseFloat(quantity);
    db.prepare('UPDATE raw_materials SET current_stock=? WHERE id=?').run(after, req.params.id);
    db.prepare('INSERT INTO raw_material_logs (material_id,type,quantity_change,quantity_before,quantity_after,notes,created_by) VALUES (?,?,?,?,?,?,?)').run(req.params.id, 'restock', parseFloat(quantity), before, after, notes||'Refill bahan baku', req.user.id);
    return { before, after, quantity: parseFloat(quantity), material_name: m.name };
  });
  try {
    const result = doRefill();
    res.json({ message: `${result.quantity} ${req.body.unit||''} ${result.material_name} berhasil ditambahkan`, ...result });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// POST pakai/kurangi bahan baku
router.post('/:id/pakai', requirePerm('bahan.edit'), (req, res) => {
  const { quantity, notes } = req.body;
  if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Jumlah harus lebih dari 0' });
  const doPakai = db.transaction(() => {
    const m = db.prepare('SELECT * FROM raw_materials WHERE id=?').get(req.params.id);
    if (!m) throw new Error('Bahan tidak ditemukan');
    const before = m.current_stock;
    const after = Math.max(0, before - parseFloat(quantity));
    db.prepare('UPDATE raw_materials SET current_stock=? WHERE id=?').run(after, req.params.id);
    db.prepare('INSERT INTO raw_material_logs (material_id,type,quantity_change,quantity_before,quantity_after,notes,created_by) VALUES (?,?,?,?,?,?,?)').run(req.params.id, 'pakai', -parseFloat(quantity), before, after, notes||'Penggunaan bahan', req.user.id);
    return { before, after };
  });
  try {
    const result = doPakai();
    res.json({ message: 'Stok bahan berhasil dikurangi', ...result });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// POST koreksi stok
router.post('/:id/koreksi', requirePerm('bahan.edit'), (req, res) => {
  const { quantity, notes } = req.body;
  if (quantity === undefined || quantity < 0) return res.status(400).json({ error: 'Jumlah tidak valid' });
  const doKoreksi = db.transaction(() => {
    const m = db.prepare('SELECT * FROM raw_materials WHERE id=?').get(req.params.id);
    if (!m) throw new Error('Bahan tidak ditemukan');
    const before = m.current_stock;
    const after = parseFloat(quantity);
    db.prepare('UPDATE raw_materials SET current_stock=? WHERE id=?').run(after, req.params.id);
    db.prepare('INSERT INTO raw_material_logs (material_id,type,quantity_change,quantity_before,quantity_after,notes,created_by) VALUES (?,?,?,?,?,?,?)').run(req.params.id, 'koreksi', after-before, before, after, notes||'Koreksi manual', req.user.id);
    return { before, after };
  });
  try {
    const result = doKoreksi();
    res.json({ message: 'Koreksi stok berhasil', ...result });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// GET log riwayat
router.get('/log', requirePerm('bahan.view'), (req, res) => {
  try {
    const { material_id, limit=50 } = req.query;
    let q = `SELECT l.*,m.name as material_name,m.unit,u.full_name as operator FROM raw_material_logs l JOIN raw_materials m ON l.material_id=m.id LEFT JOIN users u ON l.created_by=u.id`;
    const p = [];
    if (material_id) { q += ' WHERE l.material_id=?'; p.push(material_id); }
    q += ' ORDER BY l.created_at DESC LIMIT ?';
    p.push(parseInt(limit));
    res.json(db.prepare(q).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE bahan baku (soft delete)
router.delete('/:id', requirePerm('bahan.edit'), (req, res) => {
  try {
    db.prepare('UPDATE raw_materials SET is_active=0 WHERE id=?').run(req.params.id);
    res.json({ message: 'Bahan baku berhasil dihapus' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
