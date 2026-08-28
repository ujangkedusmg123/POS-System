const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const { branchScopeSql, accessibleBranches, canUseBranch } = require('../utils/branch-access');
const db = { prepare: (...a) => getDb().prepare(...a), transaction: (...a) => getDb().transaction(...a) };

router.use(authMiddleware);

// Helper: pastikan row product_stock ada
function ensureStockRow(productId, branchId) {
  const row = db.prepare('SELECT * FROM product_stock WHERE product_id=? AND branch_id=?').get(productId, branchId);
  if (!row) {
    db.prepare('INSERT INTO product_stock (product_id, branch_id, current_stock, min_stock) VALUES (?,?,0,5)').run(productId, branchId);
    return { product_id: productId, branch_id: branchId, current_stock: 0, min_stock: 5 };
  }
  return row;
}

// GET semua stok per produk (dengan filter cabang)
router.get('/products', requirePerm('stock.view'), (req, res) => {
  try {
    const qBranch = req.query.branch_id;
    let params = [];
    const bs = branchScopeSql(req.user, 'ps.branch_id', qBranch);
    const branchFilter = bs.sql;
    bs.params.forEach((v) => params.push(v));
    // Auto-create rows untuk kombinasi produk (track_stock=1) x cabang aktif yang belum ada
    const tracked = db.prepare('SELECT id FROM products WHERE track_stock=1 AND is_active=1').all();
    const branches = db.prepare('SELECT id FROM branches WHERE is_active=1').all();
    tracked.forEach(p => branches.forEach(b => {
      const ex = db.prepare('SELECT id FROM product_stock WHERE product_id=? AND branch_id=?').get(p.id, b.id);
      if (!ex) db.prepare('INSERT INTO product_stock (product_id, branch_id, current_stock, min_stock) VALUES (?,?,0,5)').run(p.id, b.id);
    }));

    const q = `SELECT ps.*, p.name as product_name, p.code as product_code, p.unit,
                 c.name as category_name, b.name as branch_name
               FROM product_stock ps
               JOIN products p ON ps.product_id=p.id
               LEFT JOIN categories c ON p.category_id=c.id
               JOIN branches b ON ps.branch_id=b.id
               WHERE p.is_active=1 AND p.track_stock=1 AND b.is_active=1 ${branchFilter}
               ORDER BY b.name, c.name, p.name`;
    const stocks = db.prepare(q).all(...params);
    res.json({ stocks, total: stocks.reduce((s,x)=>s+x.current_stock,0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET log riwayat stok
router.get('/log', requirePerm('stock.view'), (req, res) => {
  try {
    const { limit=200, branch_id, product_id, type, start_date, end_date } = req.query;
    let q = `SELECT l.*, p.name as product_name, p.unit, b.name as branch_name, u.full_name as operator_name
             FROM product_stock_log l
             LEFT JOIN products p ON l.product_id=p.id
             LEFT JOIN branches b ON l.branch_id=b.id
             LEFT JOIN users u ON l.created_by=u.id WHERE 1=1`;
    const params = [];
    const bsLog = branchScopeSql(req.user, 'l.branch_id', branch_id);
    q += bsLog.sql; bsLog.params.forEach((v) => params.push(v));
    if (product_id) { q += ' AND l.product_id=?'; params.push(product_id); }
    if (type) { q += ' AND l.type=?'; params.push(type); }
    if (start_date) { q += " AND DATE(l.created_at)>=?"; params.push(start_date); }
    if (end_date)   { q += " AND DATE(l.created_at)<=?"; params.push(end_date); }
    q += ' ORDER BY l.created_at DESC LIMIT ?'; params.push(parseInt(limit));
    res.json(db.prepare(q).all(...params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST produksi/tambah stok (untuk produk tertentu di cabang tertentu)
router.post('/produksi', requirePerm('stock.edit'), (req, res) => {
  const { product_id, branch_id, quantity, notes } = req.body;
  if (!product_id) return res.status(400).json({ error: 'Produk wajib dipilih' });
  if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Jumlah harus lebih dari 0' });
  let bid = branch_id ? parseInt(branch_id) : (req.user.branch_id || null);
  if (!bid) {
    const mine = accessibleBranches(req.user);
    if (mine.length === 1) bid = mine[0].id;
  }
  if (!bid) return res.status(400).json({ error: 'Pilih cabang terlebih dahulu' });
  if (!canUseBranch(req.user, bid)) return res.status(403).json({ error: 'Anda tidak punya akses ke cabang tersebut' });

  const prod = db.prepare('SELECT * FROM products WHERE id=? AND is_active=1').get(product_id);
  if (!prod) return res.status(404).json({ error: 'Produk tidak ditemukan' });

  const doAdd = db.transaction(() => {
    const cur = ensureStockRow(product_id, bid);
    const before = cur.current_stock;
    const after = before + parseInt(quantity);
    db.prepare("UPDATE product_stock SET current_stock=?, updated_at=datetime('now','+7 hours') WHERE product_id=? AND branch_id=?").run(after, product_id, bid);
    db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,created_by) VALUES (?,?,?,?,?,?,?,?)').run(product_id, bid, 'produksi', parseInt(quantity), before, after, notes||'', req.user.id);
    return { before, after };
  });

  try {
    const r = doAdd();
    logActivity({ user: req.user, module: 'stock', action: 'produksi', description: `Produksi +${quantity} ${prod.unit} ${prod.name}`, entity_type: 'product', entity_id: product_id, metadata: { branch_id: bid, ...r } });
    res.json({ message: `+${quantity} ${prod.unit} ${prod.name} ditambahkan`, ...r });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// POST koreksi stok manual (set nilai absolut)
router.post('/koreksi', requirePerm('stock.edit'), (req, res) => {
  const { product_id, branch_id, quantity, notes } = req.body;
  if (!product_id) return res.status(400).json({ error: 'Produk wajib dipilih' });
  if (quantity === undefined || quantity < 0) return res.status(400).json({ error: 'Jumlah tidak valid' });
  if (!branch_id) return res.status(400).json({ error: 'Pilih cabang' });
  if (!canUseBranch(req.user, branch_id)) return res.status(403).json({ error: 'Anda tidak punya akses ke cabang tersebut' });

  const doK = db.transaction(() => {
    const cur = ensureStockRow(product_id, branch_id);
    const before = cur.current_stock;
    const after = parseInt(quantity);
    const change = after - before;
    db.prepare("UPDATE product_stock SET current_stock=?, updated_at=datetime('now','+7 hours') WHERE product_id=? AND branch_id=?").run(after, product_id, branch_id);
    db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,created_by) VALUES (?,?,?,?,?,?,?,?)').run(product_id, branch_id, 'koreksi', change, before, after, notes||'Koreksi manual', req.user.id);
    return { before, after, change };
  });
  try {
    const r = doK();
    const prod = db.prepare('SELECT name FROM products WHERE id=?').get(product_id);
    logActivity({ user: req.user, module: 'stock', action: 'koreksi', description: `Koreksi stok ${prod?.name||'?'}: ${r.before} → ${r.after} (${r.change>0?'+':''}${r.change})`, entity_type: 'product', entity_id: product_id, metadata: { branch_id, ...r } });
    res.json({ message:'Stok berhasil dikoreksi', ...r });
  }
  catch(e) { res.status(400).json({ error: e.message }); }
});

// PUT min_stock (batas minimum untuk alert)
router.put('/min-stock', requirePerm('stock.edit'), (req, res) => {
  const { product_id, branch_id, min_stock } = req.body;
  if (!canUseBranch(req.user, branch_id)) return res.status(403).json({ error: 'Anda tidak punya akses ke cabang tersebut' });
  try {
    ensureStockRow(product_id, branch_id);
    db.prepare('UPDATE product_stock SET min_stock=? WHERE product_id=? AND branch_id=?').run(parseInt(min_stock)||0, product_id, branch_id);
    res.json({ message: 'Batas minimum diperbarui' });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// DELETE log entry (kecuali log 'terjual')
router.delete('/log/:id', requirePerm('stock.delete'), (req, res) => {
  try {
    const log = db.prepare('SELECT * FROM product_stock_log WHERE id=?').get(req.params.id);
    if (!log) return res.status(404).json({ error: 'Log tidak ditemukan' });
    if (log.branch_id && !canUseBranch(req.user, log.branch_id)) {
      return res.status(403).json({ error: 'Log ini milik cabang lain' });
    }
    if (log.type === 'terjual') return res.status(400).json({ error: 'Log penjualan tidak bisa dihapus manual' });
    db.prepare('DELETE FROM product_stock_log WHERE id=?').run(req.params.id);
    res.json({ message: 'Log berhasil dihapus' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET daftar supplier
router.get('/suppliers', requirePerm('stock.view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM suppliers ORDER BY name').all());
});

// ==== Legacy mochi endpoints (redirect to new system) — dibiarkan agar UI lama tidak error ====
router.get('/mochi', (req, res) => res.json({ stocks: [], total: 0 }));
router.get('/mochi/log', (req, res) => res.json([]));

// ==== TRANSFER STOK ANTAR CABANG ====
router.post('/transfer', requirePerm('stock.transfer'), (req, res) => {
  const { from_branch_id, to_branch_id, items, notes } = req.body;
  if (!from_branch_id || !to_branch_id) return res.status(400).json({ error:'Cabang asal & tujuan wajib diisi' });
  if (from_branch_id === to_branch_id) return res.status(400).json({ error:'Cabang asal & tujuan tidak boleh sama' });
  // Kedua ujung transfer harus cabang yang memang jadi hak user ini
  if (!canUseBranch(req.user, from_branch_id) || !canUseBranch(req.user, to_branch_id)) {
    return res.status(403).json({ error:'Anda tidak punya akses ke salah satu cabang pada transfer ini' });
  }
  if (!Array.isArray(items) || items.length===0) return res.status(400).json({ error:'Item transfer kosong' });

  const doT = db.transaction(() => {
    // Generate transfer code
    const now = new Date();
    const prefix = `TF${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
    const last = db.prepare('SELECT transfer_code FROM stock_transfers WHERE transfer_code LIKE ? ORDER BY id DESC LIMIT 1').get(prefix+'%');
    const seq = last ? parseInt(last.transfer_code.slice(-4))+1 : 1;
    const code = `${prefix}${String(seq).padStart(4,'0')}`;

    const tr = db.prepare('INSERT INTO stock_transfers (transfer_code,from_branch_id,to_branch_id,notes,created_by) VALUES (?,?,?,?,?)').run(code,from_branch_id,to_branch_id,notes||null,req.user.id);

    for (const it of items) {
      const pid = parseInt(it.product_id);
      const qty = parseInt(it.quantity);
      if (!pid || !qty || qty<=0) continue;
      // Cek stok cukup
      const fromStk = db.prepare('SELECT current_stock FROM product_stock WHERE product_id=? AND branch_id=?').get(pid, from_branch_id);
      if (!fromStk) throw new Error('Stok tidak ditemukan di cabang asal');
      if (fromStk.current_stock < qty) {
        const p = db.prepare('SELECT name FROM products WHERE id=?').get(pid);
        throw new Error(`Stok ${p?.name||'produk'} di cabang asal tidak cukup (tersedia ${fromStk.current_stock})`);
      }
      // Kurangi asal
      const fBefore = fromStk.current_stock;
      const fAfter = fBefore - qty;
      db.prepare("UPDATE product_stock SET current_stock=?, updated_at=datetime('now','+7 hours') WHERE product_id=? AND branch_id=?").run(fAfter, pid, from_branch_id);
      db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,created_by) VALUES (?,?,?,?,?,?,?,?)').run(pid, from_branch_id, 'transfer_out', -qty, fBefore, fAfter, code, req.user.id);
      // Tambah tujuan
      let toStk = db.prepare('SELECT current_stock FROM product_stock WHERE product_id=? AND branch_id=?').get(pid, to_branch_id);
      if (!toStk) {
        db.prepare('INSERT INTO product_stock (product_id,branch_id,current_stock,min_stock) VALUES (?,?,0,5)').run(pid, to_branch_id);
        toStk = { current_stock: 0 };
      }
      const tBefore = toStk.current_stock;
      const tAfter = tBefore + qty;
      db.prepare("UPDATE product_stock SET current_stock=?, updated_at=datetime('now','+7 hours') WHERE product_id=? AND branch_id=?").run(tAfter, pid, to_branch_id);
      db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,created_by) VALUES (?,?,?,?,?,?,?,?)').run(pid, to_branch_id, 'transfer_in', qty, tBefore, tAfter, code, req.user.id);

      db.prepare('INSERT INTO stock_transfer_items (transfer_id,product_id,quantity) VALUES (?,?,?)').run(tr.lastInsertRowid, pid, qty);
    }
    return code;
  });

  try {
    const code = doT();
    const fromB = db.prepare('SELECT name FROM branches WHERE id=?').get(from_branch_id);
    const toB = db.prepare('SELECT name FROM branches WHERE id=?').get(to_branch_id);
    const totalQty = items.reduce((s,i)=>s+(parseInt(i.quantity)||0), 0);
    logActivity({ user: req.user, module: 'stock', action: 'transfer', description: `Transfer ${code}: ${fromB?.name} → ${toB?.name} (${items.length} item, ${totalQty} unit)`, entity_type: 'transfer', metadata: { code, from_branch_id, to_branch_id, items } });
    res.json({ message:'Transfer berhasil', transfer_code: code });
  }
  catch(e) { res.status(400).json({ error: e.message }); }
});

// GET daftar transfer
router.get('/transfers', requirePerm('stock.view', 'stock.transfer'), (req, res) => {
  try {
    const { start_date, end_date, limit=50 } = req.query;
    let q = `SELECT t.*, bf.name as from_branch_name, bt.name as to_branch_name, u.full_name as operator_name,
             (SELECT COUNT(*) FROM stock_transfer_items ti WHERE ti.transfer_id=t.id) as item_count,
             (SELECT SUM(quantity) FROM stock_transfer_items ti WHERE ti.transfer_id=t.id) as total_qty
             FROM stock_transfers t
             LEFT JOIN branches bf ON t.from_branch_id=bf.id
             LEFT JOIN branches bt ON t.to_branch_id=bt.id
             LEFT JOIN users u ON t.created_by=u.id WHERE 1=1`;
    const p = [];
    if (start_date) { q += " AND DATE(t.created_at)>=?"; p.push(start_date); }
    if (end_date) { q += " AND DATE(t.created_at)<=?"; p.push(end_date); }
    q += ' ORDER BY t.created_at DESC LIMIT ?'; p.push(parseInt(limit));
    res.json(db.prepare(q).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET detail transfer
router.get('/transfers/:id', requirePerm('stock.view', 'stock.transfer'), (req, res) => {
  const tr = db.prepare(`SELECT t.*, bf.name as from_branch_name, bt.name as to_branch_name, u.full_name as operator_name FROM stock_transfers t LEFT JOIN branches bf ON t.from_branch_id=bf.id LEFT JOIN branches bt ON t.to_branch_id=bt.id LEFT JOIN users u ON t.created_by=u.id WHERE t.id=?`).get(req.params.id);
  if (!tr) return res.status(404).json({ error:'Transfer tidak ditemukan' });
  const items = db.prepare(`SELECT ti.*, p.name as product_name, p.code as product_code, p.unit FROM stock_transfer_items ti LEFT JOIN products p ON ti.product_id=p.id WHERE ti.transfer_id=?`).all(req.params.id);
  res.json({ ...tr, items });
});

module.exports = router;
