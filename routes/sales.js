const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly, can, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const { openSessionFor } = require('./cashier');
const { createTicketForSale, cancelTicketForSale, deleteTicketForSale } = require('./kitchen');
const { branchScopeSql, accessibleBranches, canUseBranch } = require('../utils/branch-access');
const { todayWib } = require('../utils/waktu');
const db = { prepare: (...a) => getDb().prepare(...a), transaction: (...a) => getDb().transaction(...a) };

router.use(authMiddleware);



function generateInvoice(branchId) {
  const tgl = todayWib().replace(/-/g, '');   // nomor invoice mengikuti tanggal WIB
  const prefix = `UK${String(branchId||0).padStart(2,'0')}${tgl}`;
  const last = db.prepare(`SELECT invoice_number FROM sales WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}%`);
  const seq = last ? parseInt(last.invoice_number.slice(-4)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4,'0')}`;
}

router.get('/', requirePerm('sales.view'), (req, res) => {
  try {
    const { start_date, end_date, payment_method, channel, branch_id, cashier_id, product_search, limit=100, offset=0 } = req.query;
    let q = `SELECT s.*,u.full_name as cashier_name,c.name as customer_name,b.name as branch_name,
      (SELECT GROUP_CONCAT(si.product_name || ' ×' || si.quantity, ', ') FROM sale_items si WHERE si.sale_id=s.id) as items_summary
      FROM sales s LEFT JOIN users u ON s.cashier_id=u.id LEFT JOIN customers c ON s.customer_id=c.id LEFT JOIN branches b ON s.branch_id=b.id WHERE s.status='completed'`;
    const p = [];
    const bs = branchScopeSql(req.user, 's.branch_id', branch_id);
    q += bs.sql; bs.params.forEach((v) => p.push(v));
    if (start_date) { q+=' AND DATE(s.created_at)>=?'; p.push(start_date); }
    if (end_date) { q+=' AND DATE(s.created_at)<=?'; p.push(end_date); }
    if (payment_method) { q+=' AND s.payment_method=?'; p.push(payment_method); }
    if (channel) { q+=' AND s.channel=?'; p.push(channel); }
    if (cashier_id) { q+=' AND s.cashier_id=?'; p.push(cashier_id); }
    if (product_search) {
      q+=` AND s.id IN (SELECT DISTINCT si.sale_id FROM sale_items si JOIN products p ON si.product_id=p.id WHERE LOWER(p.name) LIKE LOWER(?))`;
      p.push('%'+product_search+'%');
    }
    q+=' ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
    p.push(parseInt(limit),parseInt(offset));
    const sales = db.prepare(q).all(...p);
    const countQ = q.replace(/SELECT.*?FROM/,'SELECT COUNT(*) as c FROM').replace(/ORDER BY.*/,'');
    const total = db.prepare(countQ).get(...p.slice(0,-2));
    res.json({ sales, total:total?.c||0 });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET meta: cashiers list for filter
router.get('/meta/cashiers', requirePerm('sales.view', 'pos.view'), (req, res) => {
  try {
    const cashiers = db.prepare("SELECT id,full_name,branch_id FROM users WHERE role IN ('cashier','admin') AND is_active=1 ORDER BY full_name").all();
    res.json(cashiers);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get('/meta/customers', requirePerm('sales.view', 'pos.view'), (req, res) =>
  res.json(db.prepare('SELECT id,name,phone FROM customers ORDER BY id').all()));

router.get('/:id', requirePerm('sales.view', 'pos.sell'), (req, res) => {
  const sale = db.prepare(`SELECT s.*,u.full_name as cashier_name,c.name as customer_name,b.name as branch_name FROM sales s LEFT JOIN users u ON s.cashier_id=u.id LEFT JOIN customers c ON s.customer_id=c.id LEFT JOIN branches b ON s.branch_id=b.id WHERE s.id=?`).get(req.params.id);
  if (!sale) return res.status(404).json({ error:'Transaksi tidak ditemukan' });
  if (sale.branch_id && !canUseBranch(req.user, sale.branch_id)) {
    return res.status(403).json({ error:'Transaksi ini milik cabang lain' });
  }
  const items = db.prepare('SELECT si.*,p.unit FROM sale_items si LEFT JOIN products p ON si.product_id=p.id WHERE si.sale_id=?').all(req.params.id);
  res.json({ ...sale, items });
});

router.post('/', requirePerm('pos.sell'), (req, res) => {
  const { customer_id, items, discount_amount=0, tax_percent=0, payment_method='cash', payment_amount, notes, channel='langsung', payment_reference, receipt_template_id } = req.body;
  if (!items||items.length===0) return res.status(400).json({ error:'Item tidak boleh kosong' });

  // --- Validasi metode pembayaran terhadap master termin ---
  const pm = db.prepare('SELECT * FROM payment_methods WHERE code=? AND is_active=1').get(payment_method);
  if (!pm) return res.status(400).json({ error: `Metode pembayaran "${payment_method}" tidak tersedia atau sudah dinonaktifkan` });
  if (pm.needs_reference && !String(payment_reference||'').trim()) {
    return res.status(400).json({ error: `Metode ${pm.name} membutuhkan nomor referensi/approval` });
  }

  // --- Gerbang shift: transaksi harus berada di dalam sesi kasir yang terbuka ---
  const activeSession = openSessionFor(req.user.id);
  if (!activeSession) {
    return res.status(409).json({ error: 'Kasir belum dibuka. Lakukan Buka Kasir dan input saldo awal terlebih dahulu.', code: 'NO_OPEN_SESSION' });
  }

  // --- Diskon butuh hak akses khusus ---
  if ((parseFloat(discount_amount)||0) > 0 && !can(req.user, 'pos.discount')) {
    return res.status(403).json({ error: 'Anda tidak punya hak akses untuk memberi diskon' });
  }
  // Cabang transaksi MENGIKUTI SESI KASIR yang sedang dibuka, bukan kiriman
  // klien. Tanpa ini, penjualan bisa tercatat di cabang lain sementara
  // rekonsiliasi shift memakai cabang sesi — laporan tutup kasir jadi tidak
  // cocok dan uang laci tidak bisa dipertanggungjawabkan.
  const branchId = activeSession.branch_id || req.user.branch_id || null;
  if (req.body.branch_id && parseInt(req.body.branch_id) !== branchId) {
    return res.status(400).json({
      error: 'Cabang transaksi harus sama dengan cabang shift kasir yang sedang dibuka.',
      code: 'BRANCH_MISMATCH',
    });
  }
  const feePct = 0; // Komisi platform tidak dihitung di sistem

  const doSale = db.transaction(() => {
    let subtotal=0; const processedItems=[]; let mochiCount=0;
    for (const item of items) {
      const p = db.prepare('SELECT * FROM products WHERE id=? AND is_active=1').get(item.product_id);
      if (!p) throw new Error(`Produk tidak ditemukan`);
      const qty=parseInt(item.quantity)||1;
      const price=item.sell_price||p.sell_price;
      const discPct=item.discount_percent||0;
      const itemSub=price*qty*(1-discPct/100);
      subtotal+=itemSub;
      // Komposisi Mix (dipilih di kasir): [{product_id, pcs, name}]
      let mixComponents = null;
      if (Array.isArray(item.mix_components) && item.mix_components.length) {
        mixComponents = item.mix_components
          .map(c => ({ product_id: parseInt(c.product_id), pcs: parseInt(c.pcs)||0, name: c.name||null }))
          .filter(c => c.product_id && c.pcs > 0);
      }
      processedItems.push({p,qty,price,discPct,itemSub,mixComponents});
      if (p.is_mochi) mochiCount+=qty;
    }
    const discAmt=parseFloat(discount_amount)||0;
    const taxAmt=(subtotal-discAmt)*(parseFloat(tax_percent)/100);
    const total=subtotal-discAmt+taxAmt;
    const feeAmt=Math.round(total*feePct/100);
    const netRev=total-feeAmt;
    let payAmt=parseFloat(payment_amount)||0;
    // Metode tanpa kembalian (QRIS/transfer/dll) selalu dibayar pas
    if (!pm.gives_change) payAmt = total;
    if (payAmt<total) throw new Error('Pembayaran kurang dari total');
    const invNum=generateInvoice(branchId);
    const sr=db.prepare(`INSERT INTO sales (invoice_number,branch_id,channel,platform_fee_percent,platform_fee_amount,customer_id,cashier_id,subtotal,discount_amount,tax_percent,tax_amount,total,net_revenue,payment_method,payment_amount,change_amount,notes,session_id,payment_reference,receipt_template_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(invNum,branchId,channel,feePct,feeAmt,customer_id||null,req.user.id,subtotal,discAmt,tax_percent,taxAmt,total,netRev,payment_method,payAmt,payAmt-total,notes||null,activeSession.id,payment_reference||null,receipt_template_id||null);
    for (const pi of processedItems) {
      const sir = db.prepare('INSERT INTO sale_items (sale_id,product_id,product_name,product_code,quantity,buy_price,sell_price,discount_percent,subtotal,is_mochi) VALUES (?,?,?,?,?,?,?,?,?,?)').run(sr.lastInsertRowid,pi.p.id,pi.p.name,pi.p.code,pi.qty,pi.p.buy_price,pi.price,pi.discPct,pi.itemSub,pi.p.is_mochi);
      pi.saleItemId = sir.lastInsertRowid;
      if (pi.mixComponents && pi.mixComponents.length) {
        for (const c of pi.mixComponents) {
          db.prepare('INSERT INTO sale_item_components (sale_item_id,sale_id,component_product_id,component_name,pcs) VALUES (?,?,?,?,?)').run(pi.saleItemId, sr.lastInsertRowid, c.product_id, c.name, c.pcs);
        }
      }
    }
    // --- Kirim pesanan ke DAPUR ---
    // Dibuat di dalam transaksi yang sama: kalau penjualan gagal, tiket dapur
    // ikut batal — jangan sampai juru masak menggoreng pesanan yang tidak jadi.
    const custRow = customer_id ? db.prepare('SELECT name FROM customers WHERE id=?').get(customer_id) : null;
    createTicketForSale(
      { id: sr.lastInsertRowid, invoice_number: invNum, branch_id: branchId, channel,
        cashier_id: req.user.id, notes: notes || null, customer_name: custRow ? custRow.name : null },
      processedItems.map((pi) => ({
        sale_item_id: pi.saleItemId, product: pi.p, qty: pi.qty, mixComponents: pi.mixComponents,
      })),
    );

    let stockAfter=null;
    // Prioritas: kalau produk punya stock_link → kurangi item stok yang di-link.
    // Kalau tidak ada link tapi track_stock=1 → kurangi dirinya sendiri.
    if (branchId) {
      const decrementStock = (itemProductId, qty, note) => {
        let stk = db.prepare('SELECT current_stock FROM product_stock WHERE product_id=? AND branch_id=?').get(itemProductId, branchId);
        if (!stk) {
          db.prepare('INSERT INTO product_stock (product_id,branch_id,current_stock,min_stock) VALUES (?,?,0,5)').run(itemProductId, branchId);
          stk = { current_stock: 0 };
        }
        const before = stk.current_stock;
        const after = Math.max(0, before - qty);
        db.prepare("UPDATE product_stock SET current_stock=?,updated_at=datetime('now','+7 hours') WHERE product_id=? AND branch_id=?").run(after, itemProductId, branchId);
        db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,sale_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(itemProductId, branchId, 'terjual', -qty, before, after, note, sr.lastInsertRowid, req.user.id);
      };
      for (const pi of processedItems) {
        // Mix: kurangi stok tiap komponen sesuai pcs × qty (lewati jalur link/track_stock)
        if (pi.mixComponents && pi.mixComponents.length) {
          for (const c of pi.mixComponents) {
            decrementStock(c.product_id, c.pcs * pi.qty, `${invNum} (${channel}) mix ${pi.p.name}`);
          }
          continue;
        }
        const links = db.prepare('SELECT stock_item_id, quantity FROM product_stock_link WHERE product_id=? AND stock_item_id != ?').all(pi.p.id, pi.p.id);
        if (links.length > 0) {
          for (const lnk of links) {
            const totalQty = Math.ceil(lnk.quantity * pi.qty);
            decrementStock(lnk.stock_item_id, totalQty, `${invNum} (${channel}) dari ${pi.p.name}`);
          }
        } else if (pi.p.track_stock) {
          const ppp = Math.max(1, parseInt(pi.p.pcs_per_porsi) || 1);
          decrementStock(pi.p.id, ppp * pi.qty, `${invNum} (${channel})`);
        }
      }
    }
    if (customer_id&&customer_id>1) { const pts=Math.floor(total/10000); if(pts>0) db.prepare('UPDATE customers SET loyalty_points=loyalty_points+? WHERE id=?').run(pts,customer_id); }
    return { id:sr.lastInsertRowid, session_id:activeSession.id, invoice_number:invNum, total, net_revenue:netRev, platform_fee:feeAmt, change:payAmt-total, mochi_stock_after:stockAfter, mochi_sold:mochiCount };
  });

  try {
    const result=doSale();
    logActivity({ user: req.user, module: 'sales', action: 'create', description: `Transaksi ${result.invoice_number} — Rp ${result.total.toLocaleString('id-ID')} (${payment_method})`, entity_type: 'sale', entity_id: result.id });
    res.json({ success:true, ...result });
  }
  catch(e) { res.status(400).json({ error:e.message }); }
});

// CANCEL sale
router.patch('/:id/cancel', requirePerm('sales.cancel'), (req, res) => {
  const { reason } = req.body;
  const target = db.prepare('SELECT branch_id FROM sales WHERE id=?').get(req.params.id);
  if (target && target.branch_id && !canUseBranch(req.user, target.branch_id)) {
    return res.status(403).json({ error: 'Transaksi ini milik cabang lain' });
  }
  const doCancel = db.transaction(() => {
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(req.params.id);
    if (!sale) throw new Error('Transaksi tidak ditemukan');
    if (sale.status==='cancelled') throw new Error('Transaksi sudah dibatalkan');
    db.prepare("UPDATE sales SET status='cancelled',notes=? WHERE id=?").run((sale.notes?sale.notes+' | ':'')+'BATAL: '+(reason||''), req.params.id);
    cancelTicketForSale(sale.id); // pesanan ditarik dari antrian dapur
    // Restore stok — aware stock_link
    const items = db.prepare('SELECT si.*, p.track_stock, p.pcs_per_porsi FROM sale_items si JOIN products p ON si.product_id=p.id WHERE si.sale_id=?').all(req.params.id);
    if (sale.branch_id) {
      const restoreStock = (itemProductId, qty, note) => {
        const stk = db.prepare('SELECT current_stock FROM product_stock WHERE product_id=? AND branch_id=?').get(itemProductId, sale.branch_id);
        if (stk) {
          const before = stk.current_stock;
          const after = before + qty;
          db.prepare("UPDATE product_stock SET current_stock=?, updated_at=datetime('now','+7 hours') WHERE product_id=? AND branch_id=?").run(after, itemProductId, sale.branch_id);
          db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,sale_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(itemProductId, sale.branch_id, 'koreksi', qty, before, after, note, sale.id, req.user.id);
        }
      };
      for (const it of items) {
        // Mix: kembalikan stok tiap komponen sesuai rincian tersimpan
        const comps = db.prepare('SELECT * FROM sale_item_components WHERE sale_item_id=?').all(it.id);
        if (comps.length) {
          for (const c of comps) restoreStock(c.component_product_id, c.pcs * it.quantity, 'Pembatalan '+sale.invoice_number);
          continue;
        }
        const links = db.prepare('SELECT stock_item_id, quantity FROM product_stock_link WHERE product_id=? AND stock_item_id != ?').all(it.product_id, it.product_id);
        if (links.length > 0) {
          for (const lnk of links) {
            restoreStock(lnk.stock_item_id, Math.ceil(lnk.quantity * it.quantity), 'Pembatalan '+sale.invoice_number);
          }
        } else if (it.track_stock) {
          const ppp = Math.max(1, parseInt(it.pcs_per_porsi) || 1);
          restoreStock(it.product_id, ppp * it.quantity, 'Pembatalan '+sale.invoice_number);
        }
      }
    }
    return sale.invoice_number;
  });
  try {
    const inv = doCancel();
    logActivity({ user: req.user, module: 'sales', action: 'cancel', description: `Batalkan transaksi ${inv} — alasan: ${reason||'-'}`, entity_type: 'sale', entity_id: parseInt(req.params.id) });
    res.json({ message:'Transaksi berhasil dibatalkan' });
  }
  catch(e) { res.status(400).json({ error:e.message }); }
});

// DELETE sale (admin only, permanent)
router.delete('/:id', requirePerm('sales.delete'), (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(req.params.id);
  if (!sale) return res.status(404).json({ error:'Transaksi tidak ditemukan' });
  if (sale.branch_id && !canUseBranch(req.user, sale.branch_id)) {
    return res.status(403).json({ error:'Transaksi ini milik cabang lain' });
  }
  deleteTicketForSale(sale.id);
  db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(req.params.id);
  db.prepare('DELETE FROM sales WHERE id=?').run(req.params.id);
  logActivity({ user: req.user, module: 'sales', action: 'delete', description: `Hapus permanen transaksi ${sale.invoice_number}`, entity_type: 'sale', entity_id: parseInt(req.params.id) });
  res.json({ message:'Transaksi berhasil dihapus permanen' });
});

module.exports = router;
