const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const db = { prepare: (...a) => getDb().prepare(...a) };

router.use(authMiddleware);

router.get('/', requirePerm('customers.view'), (req, res) => {
  const { with_stats, start_date, end_date } = req.query;
  if (with_stats) {
    let dateFilter = '';
    const params = [];
    if (start_date) { dateFilter += " AND DATE(s.created_at)>=?"; params.push(start_date); }
    if (end_date)   { dateFilter += " AND DATE(s.created_at)<=?"; params.push(end_date); }
    const rows = db.prepare(`
      SELECT c.*,
        COALESCE(COUNT(s.id),0) as total_orders,
        COALESCE(SUM(s.total),0) as total_spent,
        COALESCE(AVG(s.total),0) as avg_order,
        MAX(s.created_at) as last_order_at
      FROM customers c
      LEFT JOIN sales s ON s.customer_id=c.id AND s.status='completed' ${dateFilter}
      GROUP BY c.id
      ORDER BY total_orders DESC, total_spent DESC
    `).all(...params);
    return res.json(rows);
  }
  res.json(db.prepare('SELECT * FROM customers ORDER BY id').all());
});

// GET analytics ringkasan top customer
router.get('/analytics/top', requirePerm('customers.view'), (req, res) => {
  try {
    const { limit=10, start_date, end_date } = req.query;
    let dateFilter = '';
    const params = [];
    if (start_date) { dateFilter += " AND DATE(s.created_at)>=?"; params.push(start_date); }
    if (end_date)   { dateFilter += " AND DATE(s.created_at)<=?"; params.push(end_date); }
    const top = db.prepare(`
      SELECT c.id, c.name, c.phone, c.loyalty_points,
        COUNT(s.id) as total_orders,
        COALESCE(SUM(s.total),0) as total_spent,
        COALESCE(AVG(s.total),0) as avg_order,
        MAX(s.created_at) as last_order_at
      FROM customers c
      JOIN sales s ON s.customer_id=c.id AND s.status='completed' ${dateFilter}
      WHERE c.id > 1
      GROUP BY c.id
      HAVING COUNT(s.id) > 0
      ORDER BY total_orders DESC, total_spent DESC
      LIMIT ?
    `).all(...params, parseInt(limit));
    res.json(top);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePerm('customers.edit'), (req, res) => {
  const { name, phone, email, address } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama pelanggan wajib diisi' });
  const exists = db.prepare('SELECT id FROM customers WHERE phone=? AND phone!=?').get(phone||'___', '');
  if (exists && phone) return res.status(400).json({ error: 'Nomor telepon sudah terdaftar' });
  const r = db.prepare('INSERT INTO customers (name,phone,email,address) VALUES (?,?,?,?)').run(name, phone||'', email||'', address||'');
  res.json({ id: r.lastInsertRowid, message: 'Pelanggan berhasil ditambahkan' });
});

router.put('/:id', requirePerm('customers.edit'), (req, res) => {
  const { name, phone, email, address } = req.body;
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
  db.prepare('UPDATE customers SET name=?,phone=?,email=?,address=? WHERE id=?').run(name||c.name, phone||c.phone, email||c.email, address||c.address, req.params.id);
  res.json({ message: 'Data pelanggan diperbarui' });
});

router.delete('/:id', requirePerm('customers.edit'), (req, res) => {
  if (parseInt(req.params.id) === 1) return res.status(400).json({ error: 'Pelanggan Umum tidak bisa dihapus' });
  db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  res.json({ message: 'Pelanggan berhasil dihapus' });
});

module.exports = router;
