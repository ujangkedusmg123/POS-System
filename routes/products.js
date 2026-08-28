const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const db = { prepare: (...a) => getDb().prepare(...a) };

router.use(authMiddleware);

router.get('/', requirePerm('products.view', 'pos.view'), (req, res) => {
  const { search, category_id, include_variants, only_variants_of, pos_only } = req.query;
  let q = `SELECT p.*,c.name as category_name,
             (SELECT COUNT(*) FROM products v WHERE v.parent_product_id=p.id AND v.is_active=1) as variant_count
           FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.is_active=1`;
  const p = [];
  if (only_variants_of) { q += ' AND p.parent_product_id=?'; p.push(only_variants_of); }
  else if (!include_variants) { q += ' AND p.parent_product_id IS NULL'; }
  if (pos_only) { q += ' AND COALESCE(p.show_in_pos,1)=1'; }
  if (search) { q+=` AND (p.name LIKE ? OR p.code LIKE ?)`; p.push(`%${search}%`,`%${search}%`); }
  if (category_id) { q+=` AND p.category_id=?`; p.push(category_id); }
  q+=` ORDER BY p.category_id, p.name`;
  res.json(db.prepare(q).all(...p));
});

router.get('/meta/categories', (req, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY id').all()));

router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT p.*,c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error:'Produk tidak ditemukan' });
  res.json(p);
});

router.post('/', requirePerm('products.create'), (req, res) => {
  const { code, barcode, name, category_id, supplier_id, buy_price, sell_price, is_mochi, track_stock, unit, description, show_in_pos, is_mix, mix_size, pcs_per_porsi, needs_cooking } = req.body;
  if (!code||!name||!sell_price) return res.status(400).json({ error:'Kode, nama, dan harga jual wajib diisi' });
  try {
    const { image_url } = req.body;
    const ppp = Math.max(1, parseInt(pcs_per_porsi) || 1);
  const r = db.prepare('INSERT INTO products (code,barcode,name,category_id,supplier_id,buy_price,sell_price,is_mochi,track_stock,is_mix,mix_size,pcs_per_porsi,unit,description,image_url,show_in_pos,needs_cooking) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(code,barcode||null,name,category_id||null,supplier_id||null,buy_price||0,sell_price,is_mochi?1:0,track_stock?1:0,is_mix?1:0,parseInt(mix_size)||0,ppp,unit||'porsi',description||null,image_url||null,show_in_pos===0?0:1,needs_cooking===0?0:1);
    res.json({ id:r.lastInsertRowid, message:'Produk berhasil ditambahkan' });
  } catch(e) { res.status(400).json({ error:'Kode sudah digunakan' }); }
});

router.put('/:id', requirePerm('products.edit'), (req, res) => {
  const { code, barcode, name, category_id, supplier_id, buy_price, sell_price, is_mochi, track_stock, unit, description, is_active, image_url, show_in_pos, is_mix, mix_size, pcs_per_porsi, needs_cooking } = req.body;
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error:'Produk tidak ditemukan' });
  try {
    const ts = track_stock !== undefined ? (track_stock?1:0) : prod.track_stock;
    const sip = show_in_pos !== undefined ? (show_in_pos?1:0) : (prod.show_in_pos !== undefined ? prod.show_in_pos : 1);
    const mix = is_mix !== undefined ? (is_mix?1:0) : (prod.is_mix||0);
    const msize = mix_size !== undefined ? (parseInt(mix_size)||0) : (prod.mix_size||0);
    const ppp = pcs_per_porsi !== undefined ? Math.max(1, parseInt(pcs_per_porsi)||1) : (prod.pcs_per_porsi||1);
    // Produk yang tidak dimasak tidak pernah muncul di layar dapur
    const cook = needs_cooking !== undefined ? (needs_cooking?1:0) : (prod.needs_cooking !== undefined && prod.needs_cooking !== null ? prod.needs_cooking : 1);
    db.prepare('UPDATE products SET code=?,barcode=?,name=?,category_id=?,supplier_id=?,buy_price=?,sell_price=?,is_mochi=?,track_stock=?,is_mix=?,mix_size=?,pcs_per_porsi=?,unit=?,description=?,is_active=?,image_url=?,show_in_pos=?,needs_cooking=? WHERE id=?').run(code||prod.code,barcode||null,name||prod.name,category_id||null,supplier_id||null,buy_price||0,sell_price||prod.sell_price,is_mochi?1:0,ts,mix,msize,ppp,unit||prod.unit,description||null,is_active!==undefined?is_active:prod.is_active,image_url!==undefined?image_url:prod.image_url,sip,cook,req.params.id);
    res.json({ message:'Produk berhasil diupdate' });
  } catch(e) { res.status(400).json({ error:'Kode sudah digunakan' }); }
});

// Soft delete (nonaktifkan)
router.delete('/:id', requirePerm('products.delete'), (req, res) => {
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error:'Produk tidak ditemukan' });
  // Check if product has sales history
  const hasSales = db.prepare('SELECT COUNT(*) as c FROM sale_items WHERE product_id=?').get(req.params.id);
  if (hasSales?.c > 0) {
    // Soft delete to preserve history
    db.prepare('UPDATE products SET is_active=0 WHERE id=?').run(req.params.id);
    res.json({ message:'Produk dinonaktifkan (ada riwayat penjualan)' });
  } else {
    // Hard delete if no sales history
    db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
    res.json({ message:'Produk berhasil dihapus permanen' });
  }
});

// GET varian dari sebuah produk induk
router.get('/:id/variants', (req, res) => {
  try {
    const rows = db.prepare(`SELECT p.*, c.name as category_name FROM products p
      LEFT JOIN categories c ON p.category_id=c.id
      WHERE p.parent_product_id=? AND p.is_active=1 ORDER BY p.name`).all(req.params.id);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST varian baru (produk anak dari induk)
router.post('/:id/variants', requirePerm('products.create'), (req, res) => {
  const parentId = parseInt(req.params.id);
  const { code, name, sell_price } = req.body;
  if (!code || !name || !sell_price) return res.status(400).json({ error: 'Kode, nama, dan harga wajib diisi' });
  try {
    const parent = db.prepare('SELECT * FROM products WHERE id=?').get(parentId);
    if (!parent) return res.status(404).json({ error: 'Produk induk tidak ditemukan' });
    const r = db.prepare('INSERT INTO products (code,name,category_id,buy_price,sell_price,is_mochi,track_stock,unit,description,parent_product_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      code, name, parent.category_id, 0, sell_price, 0, 1, parent.unit||'porsi', null, parentId);
    res.json({ id: r.lastInsertRowid, message: 'Varian ditambahkan' });
  } catch(e) { res.status(400).json({ error: 'Kode sudah digunakan' }); }
});

// GET stock-link (item stok yang dikurangi saat produk ini terjual)
router.get('/:id/stock-link', (req, res) => {
  try {
    const rows = db.prepare(`SELECT psl.id, psl.stock_item_id, psl.quantity,
        p.code as stock_item_code, p.name as stock_item_name, p.unit as stock_item_unit
      FROM product_stock_link psl JOIN products p ON psl.stock_item_id=p.id
      WHERE psl.product_id=? ORDER BY p.name`).all(req.params.id);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT stock-link (replace all)
router.put('/:id/stock-link', requirePerm('products.edit'), (req, res) => {
  const { items } = req.body; // [{stock_item_id, quantity}, ...]
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items harus array' });
  const productId = parseInt(req.params.id);
  try {
    db.prepare('DELETE FROM product_stock_link WHERE product_id=?').run(productId);
    items.forEach(it => {
      const sid = parseInt(it.stock_item_id);
      let qty = parseFloat(it.quantity);
      if (isNaN(qty) || qty < 0) qty = 1; // 0 diperbolehkan (default komponen mix)
      if (sid) {
        db.prepare('INSERT OR IGNORE INTO product_stock_link (product_id, stock_item_id, quantity) VALUES (?,?,?)').run(productId, sid, qty);
      }
    });
    res.json({ message: 'Pengurangan stok tersimpan', count: items.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET daftar item stok (produk yang di-monitor) untuk dropdown
router.get('/meta/stock-items', (req, res) => {
  try {
    const rows = db.prepare(`SELECT p.id, p.code, p.name, p.unit, c.name as category_name
      FROM products p LEFT JOIN categories c ON p.category_id=c.id
      WHERE p.track_stock=1 AND p.is_active=1
      ORDER BY c.name, p.name`).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH track_stock quick toggle
router.patch('/:id/track', requirePerm('products.edit'), (req, res) => {
  const { track_stock } = req.body;
  try {
    db.prepare('UPDATE products SET track_stock=? WHERE id=?').run(track_stock?1:0, req.params.id);
    res.json({ message: track_stock?'Produk mulai dimonitor':'Produk berhenti dimonitor' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
