const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const db = { prepare: (...a) => getDb().prepare(...a) };

router.use(authMiddleware);

// LIST — dengan agregat stok & jumlah kasir & jumlah item termonitor
router.get('/', (req, res) => {
  const branches = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM users u WHERE u.branch_id=b.id AND u.is_active=1) as user_count,
      COALESCE((
        SELECT SUM(ps.current_stock) FROM product_stock ps
        JOIN products p ON ps.product_id=p.id
        WHERE ps.branch_id=b.id AND p.track_stock=1 AND p.is_active=1
      ), 0) as total_stock,
      COALESCE((
        SELECT COUNT(*) FROM product_stock ps
        JOIN products p ON ps.product_id=p.id
        WHERE ps.branch_id=b.id AND p.track_stock=1 AND p.is_active=1
      ), 0) as tracked_item_count
    FROM branches b
    ORDER BY b.is_production_center DESC, b.id
  `).all();
  res.json(branches);
});

// CREATE
router.post('/', requirePerm('branches.edit'), (req, res) => {
  const { name, address, phone, is_production_center } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama cabang wajib diisi' });
  const r = db.prepare('INSERT INTO branches (name,address,phone,is_production_center) VALUES (?,?,?,?)').run(name, address||'', phone||'', is_production_center?1:0);
  res.json({ id: r.lastInsertRowid, message: 'Cabang berhasil dibuat' });
});

// UPDATE
router.put('/:id', requirePerm('branches.edit'), (req, res) => {
  const { name, address, phone, is_active, is_production_center } = req.body;
  const b = db.prepare('SELECT * FROM branches WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Cabang tidak ditemukan' });
  db.prepare('UPDATE branches SET name=?,address=?,phone=?,is_active=?,is_production_center=? WHERE id=?').run(
    name||b.name,
    address!==undefined?address:b.address,
    phone!==undefined?phone:b.phone,
    is_active!==undefined?is_active:b.is_active,
    is_production_center!==undefined?(is_production_center?1:0):b.is_production_center,
    req.params.id
  );
  res.json({ message: 'Cabang berhasil diupdate' });
});

// DELETE (soft only, jangan hard karena banyak referensi)
router.delete('/:id', requirePerm('branches.edit'), (req, res) => {
  const b = db.prepare('SELECT * FROM branches WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Cabang tidak ditemukan' });
  db.prepare('UPDATE branches SET is_active=0 WHERE id=?').run(req.params.id);
  res.json({ message: 'Cabang dinonaktifkan' });
});

module.exports = router;
