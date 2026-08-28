const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const db = { prepare: (...a) => getDb().prepare(...a) };

router.use(authMiddleware);

/** Daftar metode/termin pembayaran. ?all=1 termasuk yang nonaktif. */
router.get('/', (req, res) => {
  try {
    const q = req.query.all === '1'
      ? 'SELECT * FROM payment_methods ORDER BY sort_order, id'
      : 'SELECT * FROM payment_methods WHERE is_active=1 ORDER BY sort_order, id';
    res.json(db.prepare(q).all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const readBody = (b, base) => ({
  name: b.name !== undefined ? String(b.name).trim() : base?.name,
  kind: ['cash', 'cashless', 'credit'].includes(b.kind) ? b.kind : (base?.kind || 'cashless'),
  icon: b.icon !== undefined ? (b.icon || '💳') : (base?.icon || '💳'),
  fee_percent: Math.max(0, Math.min(100, parseFloat(b.fee_percent) || 0)),
  needs_reference: b.needs_reference ? 1 : 0,
  gives_change: b.gives_change ? 1 : 0,
  counted_in_drawer: b.counted_in_drawer ? 1 : 0,
  term_days: Math.max(0, parseInt(b.term_days) || 0),
  is_active: b.is_active === undefined ? (base ? base.is_active : 1) : (b.is_active ? 1 : 0),
  sort_order: b.sort_order !== undefined ? (parseInt(b.sort_order) || 0) : (base?.sort_order || 0),
});

router.post('/', requirePerm('settings.payment'), (req, res) => {
  try {
    const v = readBody(req.body);
    if (!v.name) return res.status(400).json({ error: 'Nama metode pembayaran wajib diisi' });
    const code = (req.body.code || v.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!code) return res.status(400).json({ error: 'Kode metode tidak valid' });
    if (db.prepare('SELECT id FROM payment_methods WHERE code=?').get(code)) {
      return res.status(400).json({ error: 'Kode metode pembayaran sudah digunakan' });
    }
    const r = db.prepare(`INSERT INTO payment_methods
      (code,name,kind,icon,fee_percent,needs_reference,gives_change,counted_in_drawer,term_days,is_active,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(code, v.name, v.kind, v.icon, v.fee_percent, v.needs_reference, v.gives_change, v.counted_in_drawer, v.term_days, v.is_active, v.sort_order);
    logActivity({ user: req.user, module: 'payment_methods', action: 'create', description: `Tambah metode pembayaran ${v.name}`, entity_type: 'payment_method', entity_id: r.lastInsertRowid });
    res.json({ id: r.lastInsertRowid, code, message: 'Metode pembayaran ditambahkan' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requirePerm('settings.payment'), (req, res) => {
  try {
    const base = db.prepare('SELECT * FROM payment_methods WHERE id=?').get(req.params.id);
    if (!base) return res.status(404).json({ error: 'Metode pembayaran tidak ditemukan' });
    const v = readBody(req.body, base);
    if (!v.name) return res.status(400).json({ error: 'Nama metode pembayaran wajib diisi' });
    // Metode tunai wajib tetap aktif — POS butuh minimal satu jalur tunai
    if (base.code === 'cash' && !v.is_active) {
      return res.status(400).json({ error: 'Metode Tunai tidak bisa dinonaktifkan' });
    }
    db.prepare(`UPDATE payment_methods SET name=?,kind=?,icon=?,fee_percent=?,needs_reference=?,
      gives_change=?,counted_in_drawer=?,term_days=?,is_active=?,sort_order=? WHERE id=?`)
      .run(v.name, v.kind, v.icon, v.fee_percent, v.needs_reference, v.gives_change, v.counted_in_drawer, v.term_days, v.is_active, v.sort_order, req.params.id);
    logActivity({ user: req.user, module: 'payment_methods', action: 'update', description: `Update metode pembayaran ${v.name}`, entity_type: 'payment_method', entity_id: parseInt(req.params.id) });
    res.json({ message: 'Metode pembayaran diperbarui' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePerm('settings.payment'), (req, res) => {
  try {
    const pm = db.prepare('SELECT * FROM payment_methods WHERE id=?').get(req.params.id);
    if (!pm) return res.status(404).json({ error: 'Metode pembayaran tidak ditemukan' });
    if (pm.code === 'cash') return res.status(400).json({ error: 'Metode Tunai tidak bisa dihapus' });
    const used = db.prepare('SELECT COUNT(*) as c FROM sales WHERE payment_method=?').get(pm.code);
    if (used && used.c > 0) {
      // Ada riwayat transaksi — nonaktifkan saja agar laporan lama tetap utuh
      db.prepare('UPDATE payment_methods SET is_active=0 WHERE id=?').run(req.params.id);
      logActivity({ user: req.user, module: 'payment_methods', action: 'deactivate', description: `Nonaktifkan metode ${pm.name} (dipakai ${used.c} transaksi)`, entity_type: 'payment_method', entity_id: parseInt(req.params.id) });
      return res.json({ message: `Metode dipakai ${used.c} transaksi, jadi dinonaktifkan (bukan dihapus) agar laporan lama tetap utuh` });
    }
    db.prepare('DELETE FROM payment_methods WHERE id=?').run(req.params.id);
    logActivity({ user: req.user, module: 'payment_methods', action: 'delete', description: `Hapus metode pembayaran ${pm.name}`, entity_type: 'payment_method', entity_id: parseInt(req.params.id) });
    res.json({ message: 'Metode pembayaran dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
