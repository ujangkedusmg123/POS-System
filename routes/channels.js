const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const db = { prepare: (...a) => getDb().prepare(...a) };

router.use(authMiddleware);

// LIST — semua bisa read (kasir juga butuh untuk POS)
router.get('/', (req, res) => {
  const activeOnly = req.query.active === '1';
  let q = 'SELECT * FROM channels';
  if (activeOnly) q += ' WHERE is_active=1';
  q += ' ORDER BY sort_order, name';
  res.json(db.prepare(q).all());
});

// CREATE — admin only
router.post('/', requirePerm('channels.edit'), (req, res) => {
  const { code, name, color, sort_order } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Kode & nama channel wajib diisi' });
  try {
    const r = db.prepare('INSERT INTO channels (code,name,color,sort_order) VALUES (?,?,?,?)').run(
      code.toLowerCase().replace(/[^a-z0-9_]/g,''), name, color || '#6b7280', parseInt(sort_order) || 999
    );
    logActivity({ user: req.user, module: 'channels', action: 'create', description: `Menambah channel: ${name}`, entity_type: 'channel', entity_id: r.lastInsertRowid });
    res.json({ id: r.lastInsertRowid, message: 'Channel berhasil dibuat' });
  } catch (e) { res.status(400).json({ error: 'Kode sudah digunakan' }); }
});

// UPDATE — admin only
router.put('/:id', requirePerm('channels.edit'), (req, res) => {
  const { name, color, sort_order, is_active } = req.body;
  const ch = db.prepare('SELECT * FROM channels WHERE id=?').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Channel tidak ditemukan' });
  db.prepare('UPDATE channels SET name=?, color=?, sort_order=?, is_active=? WHERE id=?').run(
    name || ch.name, color || ch.color, sort_order !== undefined ? sort_order : ch.sort_order,
    is_active !== undefined ? is_active : ch.is_active, req.params.id
  );
  logActivity({ user: req.user, module: 'channels', action: 'update', description: `Mengubah channel: ${name || ch.name}`, entity_type: 'channel', entity_id: parseInt(req.params.id) });
  res.json({ message: 'Channel berhasil diupdate' });
});

// DELETE — admin only (soft delete jika sudah dipakai)
router.delete('/:id', requirePerm('channels.edit'), (req, res) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id=?').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Channel tidak ditemukan' });
  const used = db.prepare('SELECT COUNT(*) as c FROM sales WHERE channel=?').get(ch.code);
  if (used.c > 0) {
    db.prepare('UPDATE channels SET is_active=0 WHERE id=?').run(req.params.id);
    logActivity({ user: req.user, module: 'channels', action: 'deactivate', description: `Menonaktifkan channel: ${ch.name}`, entity_type: 'channel', entity_id: parseInt(req.params.id) });
    return res.json({ message: 'Channel dinonaktifkan (masih dipakai di transaksi lama)' });
  }
  db.prepare('DELETE FROM channels WHERE id=?').run(req.params.id);
  logActivity({ user: req.user, module: 'channels', action: 'delete', description: `Menghapus channel: ${ch.name}`, entity_type: 'channel', entity_id: parseInt(req.params.id) });
  res.json({ message: 'Channel berhasil dihapus' });
});

module.exports = router;
