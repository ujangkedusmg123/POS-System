const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, requirePerm, can } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const { branchScopeSql, accessibleBranches, canUseBranch } = require('../utils/branch-access');
const db = { prepare: (...a) => getDb().prepare(...a), transaction: (...a) => getDb().transaction(...a) };

/* ==========================================================================
   DAPUR — ANTRIAN MASAK (Kitchen Display System)
   --------------------------------------------------------------------------
   Alurnya: kasir menyimpan transaksi -> otomatis terbit satu TIKET dapur.
   Juru masak melihat tiket itu di layar dapur dan mencentang tiap item yang
   sudah matang. Status tiket TIDAK pernah dikirim mentah-mentah oleh klien —
   selalu dihitung ulang di server dari status item-itemnya, supaya dua juru
   masak yang bekerja bersamaan tidak bisa saling menimpa jadi status ngawur.

   Dua cara melihat antrian:
     1. Per pesanan  — kartu per transaksi (untuk memastikan tidak ada yang
        terlewat dan pesanan keluar utuh).
     2. Gabung goreng — item produk SEJENIS dari pesanan yang waktunya
        BERDEKATAN dikumpulkan jadi satu batch, supaya sekali turun wajan
        bisa menggoreng untuk beberapa pesanan sekaligus.
   ========================================================================== */

const NOW = "datetime('now','+7 hours')";

/* ------------------------------------------------------------ PEMBUATAN TIKET */

/**
 * Terbitkan tiket dapur untuk sebuah penjualan.
 * Dipanggil dari routes/sales.js DI DALAM transaksi penjualan, jadi kalau
 * penjualan gagal tiketnya ikut batal (tidak ada tiket hantu di dapur).
 *
 * Produk Mix diuraikan jadi komponen rasanya: yang digoreng adalah rasa
 * dasarnya, bukan "Mix Udang" yang tidak ada wujudnya di wajan.
 *
 * @param {object} sale  { id, invoice_number, branch_id, channel, cashier_id, notes, customer_name }
 * @param {Array}  items [{ sale_item_id, product, qty, mixComponents }]
 * @returns {number|null} id tiket, atau null kalau tidak ada yang perlu dimasak
 */
function createTicketForSale(sale, items) {
  const rows = [];
  for (const it of items) {
    const p = it.product;
    const qty = parseInt(it.qty) || 1;

    // Mix: uraikan jadi rasa-rasa penyusunnya (pcs × jumlah porsi)
    if (Array.isArray(it.mixComponents) && it.mixComponents.length) {
      for (const c of it.mixComponents) {
        const comp = db.prepare('SELECT id,name,unit,needs_cooking FROM products WHERE id=?').get(c.product_id);
        if (comp && comp.needs_cooking === 0) continue;
        rows.push({
          sale_item_id: it.sale_item_id,
          product_id: c.product_id,
          product_name: (comp && comp.name) || c.name || 'Item',
          parent_name: p.name,
          qty: (parseInt(c.pcs) || 0) * qty,
          unit: 'pcs',
        });
      }
      continue;
    }

    if (p.needs_cooking === 0) continue;
    // Produk satuan yang 1 porsinya berisi beberapa pcs -> tampilkan pcs asli
    const ppp = Math.max(1, parseInt(p.pcs_per_porsi) || 1);
    rows.push({
      sale_item_id: it.sale_item_id,
      product_id: p.id,
      product_name: p.name,
      parent_name: null,
      qty: ppp * qty,
      unit: ppp > 1 ? 'pcs' : (p.unit || 'porsi'),
    });
  }

  if (!rows.length) return null; // pesanan tidak butuh dapur (mis. hanya add-on)

  const t = db.prepare(`INSERT INTO kitchen_tickets
      (sale_id,invoice_number,branch_id,channel,customer_name,cashier_id,notes,status)
      VALUES (?,?,?,?,?,?,?,'pending')`)
    .run(sale.id, sale.invoice_number, sale.branch_id || null, sale.channel || 'langsung',
      sale.customer_name || null, sale.cashier_id || null, sale.notes || null);

  const ins = db.prepare(`INSERT INTO kitchen_ticket_items
    (ticket_id,sale_item_id,product_id,product_name,parent_name,qty,unit,status)
    VALUES (?,?,?,?,?,?,?,'pending')`);
  for (const r of rows) {
    ins.run(t.lastInsertRowid, r.sale_item_id, r.product_id, r.product_name, r.parent_name, r.qty, r.unit);
  }
  return t.lastInsertRowid;
}

/** Tandai tiket sebuah penjualan sebagai batal (dipakai saat transaksi dibatalkan). */
function cancelTicketForSale(saleId) {
  const t = db.prepare('SELECT id FROM kitchen_tickets WHERE sale_id=?').get(saleId);
  if (!t) return;
  db.prepare(`UPDATE kitchen_tickets SET status='cancelled' WHERE id=?`).run(t.id);
}

/** Buang tiket beserta itemnya (dipakai saat penjualan dihapus permanen). */
function deleteTicketForSale(saleId) {
  const t = db.prepare('SELECT id FROM kitchen_tickets WHERE sale_id=?').get(saleId);
  if (!t) return;
  db.prepare('DELETE FROM kitchen_ticket_items WHERE ticket_id=?').run(t.id);
  db.prepare('DELETE FROM kitchen_tickets WHERE id=?').run(t.id);
}

/* --------------------------------------------------------- HITUNG ULANG STATUS */

/**
 * Status tiket selalu turunan dari item-itemnya:
 *   semua item done            -> done
 *   ada yang cooking/done      -> cooking
 *   selain itu                 -> pending
 * Tiket yang sudah dibatalkan tidak ikut dihitung ulang.
 */
function recomputeTicket(ticketId, userId) {
  const t = db.prepare('SELECT * FROM kitchen_tickets WHERE id=?').get(ticketId);
  if (!t || t.status === 'cancelled') return t;
  const items = db.prepare('SELECT status FROM kitchen_ticket_items WHERE ticket_id=?').all(ticketId);
  if (!items.length) return t;

  const allDone = items.every((i) => i.status === 'done');
  const anyStarted = items.some((i) => i.status !== 'pending');
  const status = allDone ? 'done' : (anyStarted ? 'cooking' : 'pending');

  if (status === 'done') {
    db.prepare(`UPDATE kitchen_tickets SET status='done',
      started_at=COALESCE(started_at,${NOW}), done_at=COALESCE(done_at,${NOW}), done_by=COALESCE(done_by,?)
      WHERE id=?`).run(userId || null, ticketId);
  } else if (status === 'cooking') {
    db.prepare(`UPDATE kitchen_tickets SET status='cooking',
      started_at=COALESCE(started_at,${NOW}), done_at=NULL, done_by=NULL WHERE id=?`).run(ticketId);
  } else {
    db.prepare(`UPDATE kitchen_tickets SET status='pending', started_at=NULL, done_at=NULL, done_by=NULL
      WHERE id=?`).run(ticketId);
  }
  return db.prepare('SELECT * FROM kitchen_tickets WHERE id=?').get(ticketId);
}

/** Terapkan status baru ke satu baris item, sekaligus cap waktunya. */
function setItemStatus(itemId, status, userId) {
  if (status === 'done') {
    db.prepare(`UPDATE kitchen_ticket_items SET status='done',
      started_at=COALESCE(started_at,${NOW}), done_at=${NOW}, done_by=? WHERE id=?`).run(userId || null, itemId);
  } else if (status === 'cooking') {
    db.prepare(`UPDATE kitchen_ticket_items SET status='cooking',
      started_at=COALESCE(started_at,${NOW}), done_at=NULL, done_by=NULL WHERE id=?`).run(itemId);
  } else {
    db.prepare(`UPDATE kitchen_ticket_items SET status='pending',
      started_at=NULL, done_at=NULL, done_by=NULL WHERE id=?`).run(itemId);
  }
}

/* --------------------------------------------------------------- PENGELOMPOKAN */

/** Ubah 'YYYY-MM-DD HH:MM:SS' (WIB) jadi milidetik untuk perbandingan jarak waktu. */
function toMs(v) {
  if (!v) return 0;
  const d = new Date(String(v).replace(' ', 'T'));
  const ms = d.getTime();
  return isNaN(ms) ? 0 : ms;
}

/**
 * Kelompokkan item yang belum matang: produk SAMA + waktu pesan BERDEKATAN.
 *
 * Sebuah batch dimulai dari item terlama, lalu menyerap item produk yang sama
 * selama masih dalam rentang `windowMin` menit dari item pertama batch itu.
 * Kalau `maxPerBatch` > 0, batch juga dipotong saat kapasitas wajan terlampaui —
 * tanpa ini juru masak bisa dapat "batch" 80 pcs yang mustahil sekali goreng.
 *
 * @param {Array}  items       item outstanding (sudah termasuk order_at)
 * @param {number} windowMin   rentang menit yang dianggap "berdekatan"
 * @param {number} maxPerBatch kapasitas maksimum per batch (0 = tanpa batas)
 */
function buildBatches(items, windowMin, maxPerBatch) {
  const windowMs = Math.max(0, windowMin) * 60000;
  const byProduct = new Map();
  for (const it of items) {
    if (!byProduct.has(it.product_id)) byProduct.set(it.product_id, []);
    byProduct.get(it.product_id).push(it);
  }

  const batches = [];
  for (const [productId, list] of byProduct) {
    list.sort((a, b) => (a._ms - b._ms) || (a.id - b.id));
    let cur = null;
    for (const it of list) {
      const overWindow = cur && (it._ms - cur._firstMs) > windowMs;
      const overCap = cur && maxPerBatch > 0 && (cur.total_qty + it.qty) > maxPerBatch && cur.items.length > 0;
      if (!cur || overWindow || overCap) {
        cur = {
          key: `p${productId}-b${batches.length}`,
          product_id: productId,
          product_name: it.product_name,
          unit: it.unit,
          total_qty: 0,
          order_count: 0,
          first_order_at: it.order_at,
          last_order_at: it.order_at,
          _firstMs: it._ms,
          items: [],
        };
        batches.push(cur);
      }
      cur.items.push(it);
      cur.total_qty += it.qty;
      cur.last_order_at = it.order_at;
    }
  }

  for (const b of batches) {
    b.order_count = new Set(b.items.map((i) => i.ticket_id)).size;
    b.status = b.items.every((i) => i.status === 'cooking') ? 'cooking'
      : (b.items.some((i) => i.status === 'cooking') ? 'partial' : 'pending');
    b.item_ids = b.items.map((i) => i.id);
    b.items = b.items.map((i) => ({
      id: i.id, ticket_id: i.ticket_id, invoice_number: i.invoice_number,
      channel: i.channel, qty: i.qty, unit: i.unit, status: i.status,
      parent_name: i.parent_name, order_at: i.order_at,
    }));
    delete b._firstMs;
  }
  // Yang paling lama menunggu naik ke atas — itu yang paling mendesak digoreng.
  batches.sort((a, b) => toMs(a.first_order_at) - toMs(b.first_order_at));
  return batches;
}

/* ------------------------------------------------------------------- ENDPOINT */

router.use(authMiddleware);

/** Cabang yang boleh dilihat user ini. Non-admin dikunci ke cabangnya sendiri. */
function branchFilter(req) {
  return branchScopeSql(req.user, 't.branch_id', req.query.branch_id);
}

/** Tiket + itemnya, siap dipakai layar dapur. */
function loadTickets(req, statuses) {
  const bf = branchFilter(req);
  const marks = statuses.map(() => '?').join(',');
  const tickets = db.prepare(`SELECT t.*, b.name as branch_name, u.full_name as cashier_name
    FROM kitchen_tickets t
    LEFT JOIN branches b ON t.branch_id=b.id
    LEFT JOIN users u ON t.cashier_id=u.id
    WHERE t.status IN (${marks})${bf.sql}
    ORDER BY t.created_at ASC, t.id ASC`).all(...statuses, ...bf.params);

  if (!tickets.length) return [];
  const ids = tickets.map((t) => t.id);
  const items = db.prepare(`SELECT i.*, u.full_name as done_by_name FROM kitchen_ticket_items i
    LEFT JOIN users u ON i.done_by=u.id
    WHERE i.ticket_id IN (${ids.map(() => '?').join(',')}) ORDER BY i.id`).all(...ids);
  const byTicket = new Map(ids.map((id) => [id, []]));
  items.forEach((i) => byTicket.get(i.ticket_id)?.push(i));
  tickets.forEach((t) => {
    t.items = byTicket.get(t.id) || [];
    t.total_qty = t.items.reduce((a, i) => a + i.qty, 0);
    t.done_qty = t.items.filter((i) => i.status === 'done').reduce((a, i) => a + i.qty, 0);
  });
  return tickets;
}

/**
 * GET /api/kitchen/queue
 * Antrian aktif + batch gabungan + ringkasan angka. Ini satu-satunya endpoint
 * yang di-poll layar dapur, jadi semua yang dibutuhkan dikirim sekaligus.
 *   ?window=10     rentang menit "berdekatan" untuk gabung goreng
 *   ?max_batch=0   kapasitas maksimum per batch (0 = tanpa batas)
 */
router.get('/queue', requirePerm('kitchen.view'), (req, res) => {
  try {
    const windowMin = Math.min(240, Math.max(0, parseInt(req.query.window) || 10));
    const maxBatch = Math.max(0, parseInt(req.query.max_batch) || 0);
    const active = loadTickets(req, ['pending', 'cooking']);

    // Item yang belum matang, dibawa serta konteks pesanannya untuk pengelompokan
    const outstanding = [];
    for (const t of active) {
      for (const i of t.items) {
        if (i.status === 'done') continue;
        outstanding.push({
          id: i.id, ticket_id: t.id, invoice_number: t.invoice_number, channel: t.channel,
          product_id: i.product_id, product_name: i.product_name, parent_name: i.parent_name,
          qty: i.qty, unit: i.unit, status: i.status, order_at: t.created_at, _ms: toMs(t.created_at),
        });
      }
    }

    const batches = buildBatches(outstanding, windowMin, maxBatch);
    const bf = branchFilter(req);
    const doneToday = db.prepare(`SELECT COUNT(*) c FROM kitchen_tickets t
      WHERE t.status='done' AND DATE(t.created_at)=DATE(${NOW})${bf.sql}`).get(...bf.params);

    res.json({
      tickets: active,
      batches,
      window: windowMin,
      max_batch: maxBatch,
      stats: {
        antrian: active.length,
        pending: active.filter((t) => t.status === 'pending').length,
        cooking: active.filter((t) => t.status === 'cooking').length,
        item_outstanding: outstanding.length,
        qty_outstanding: outstanding.reduce((a, i) => a + i.qty, 0),
        selesai_hari_ini: doneToday ? doneToday.c : 0,
      },
      server_time: db.prepare(`SELECT ${NOW} as t`).get().t,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/kitchen/history — tiket yang sudah selesai/batal hari ini (atau tanggal tertentu). */
router.get('/history', requirePerm('kitchen.view'), (req, res) => {
  try {
    const bf = branchFilter(req);
    const date = req.query.date || null;
    const tickets = db.prepare(`SELECT t.*, b.name as branch_name, u.full_name as done_by_name
      FROM kitchen_tickets t
      LEFT JOIN branches b ON t.branch_id=b.id
      LEFT JOIN users u ON t.done_by=u.id
      WHERE t.status IN ('done','cancelled') AND DATE(t.created_at)=DATE(?)${bf.sql}
      ORDER BY COALESCE(t.done_at,t.created_at) DESC LIMIT 200`)
      .all(date || db.prepare(`SELECT DATE(${NOW}) d`).get().d, ...bf.params);
    if (tickets.length) {
      const ids = tickets.map((t) => t.id);
      const items = db.prepare(`SELECT * FROM kitchen_ticket_items WHERE ticket_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
      const by = new Map(ids.map((id) => [id, []]));
      items.forEach((i) => by.get(i.ticket_id)?.push(i));
      tickets.forEach((t) => { t.items = by.get(t.id) || []; });
    }
    res.json({ tickets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Pastikan tiket ada dan berada di cabang yang boleh disentuh user ini. */
function assertTicketAccess(req, ticket) {
  if (!ticket) return 'Tiket dapur tidak ditemukan';
  if (!canUseBranch(req.user, ticket.branch_id)) return 'Tiket ini milik cabang lain';
  return null;
}

const ITEM_STATUSES = ['pending', 'cooking', 'done'];

/** PATCH /api/kitchen/items/:id — centang / batal centang satu item. */
router.patch('/items/:id', requirePerm('kitchen.cook'), (req, res) => {
  try {
    const status = String(req.body.status || '').toLowerCase();
    if (!ITEM_STATUSES.includes(status)) return res.status(400).json({ error: 'Status tidak dikenal' });
    const item = db.prepare('SELECT * FROM kitchen_ticket_items WHERE id=?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item tidak ditemukan' });
    const ticket = db.prepare('SELECT * FROM kitchen_tickets WHERE id=?').get(item.ticket_id);
    const err = assertTicketAccess(req, ticket);
    if (err) return res.status(403).json({ error: err });
    if (ticket.status === 'cancelled') return res.status(409).json({ error: 'Pesanan ini sudah dibatalkan' });
    // Membuka kembali item yang sudah matang = koreksi, butuh hak khusus
    if (item.status === 'done' && status !== 'done' && !can(req.user, 'kitchen.manage')) {
      return res.status(403).json({ error: 'Tidak boleh membuka kembali item yang sudah selesai' });
    }

    setItemStatus(item.id, status, req.user.id);
    const t = recomputeTicket(item.ticket_id, req.user.id);
    res.json({ success: true, ticket_status: t ? t.status : null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/** PATCH /api/kitchen/tickets/:id — set seluruh isi satu pesanan sekaligus. */
router.patch('/tickets/:id', requirePerm('kitchen.cook'), (req, res) => {
  try {
    const status = String(req.body.status || '').toLowerCase();
    const ticket = db.prepare('SELECT * FROM kitchen_tickets WHERE id=?').get(req.params.id);
    const err = assertTicketAccess(req, ticket);
    if (err) return res.status(ticket ? 403 : 404).json({ error: err });

    if (status === 'cancelled') {
      if (!can(req.user, 'kitchen.manage')) return res.status(403).json({ error: 'Tidak punya hak membatalkan tiket dapur' });
      db.prepare(`UPDATE kitchen_tickets SET status='cancelled' WHERE id=?`).run(ticket.id);
      logActivity({ user: req.user, module: 'kitchen', action: 'cancel', description: `Batalkan tiket dapur ${ticket.invoice_number}`, entity_type: 'kitchen_ticket', entity_id: ticket.id });
      return res.json({ success: true, status: 'cancelled' });
    }
    if (!ITEM_STATUSES.includes(status)) return res.status(400).json({ error: 'Status tidak dikenal' });
    if (ticket.status === 'done' && status !== 'done' && !can(req.user, 'kitchen.manage')) {
      return res.status(403).json({ error: 'Tidak boleh membuka kembali pesanan yang sudah selesai' });
    }
    if (ticket.status === 'cancelled' && !can(req.user, 'kitchen.manage')) {
      return res.status(409).json({ error: 'Pesanan ini sudah dibatalkan' });
    }

    const apply = db.transaction(() => {
      const items = db.prepare('SELECT id FROM kitchen_ticket_items WHERE ticket_id=?').all(ticket.id);
      items.forEach((i) => setItemStatus(i.id, status, req.user.id));
      if (ticket.status === 'cancelled') db.prepare(`UPDATE kitchen_tickets SET status='pending' WHERE id=?`).run(ticket.id);
      return recomputeTicket(ticket.id, req.user.id);
    });
    const t = apply();
    if (status === 'done') {
      logActivity({ user: req.user, module: 'kitchen', action: 'done', description: `Pesanan ${ticket.invoice_number} selesai dimasak`, entity_type: 'kitchen_ticket', entity_id: ticket.id });
    }
    res.json({ success: true, status: t ? t.status : status });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * POST /api/kitchen/batch — kerjakan sekelompok item sekaligus ("goreng barengan").
 * body: { item_ids: [1,2,3], status: 'cooking' | 'done' | 'pending' }
 */
router.post('/batch', requirePerm('kitchen.cook'), (req, res) => {
  try {
    const status = String(req.body.status || '').toLowerCase();
    if (!ITEM_STATUSES.includes(status)) return res.status(400).json({ error: 'Status tidak dikenal' });
    const ids = Array.isArray(req.body.item_ids)
      ? req.body.item_ids.map((n) => parseInt(n)).filter((n) => n > 0) : [];
    if (!ids.length) return res.status(400).json({ error: 'Tidak ada item yang dipilih' });

    const marks = ids.map(() => '?').join(',');
    const items = db.prepare(`SELECT i.*, t.branch_id, t.status as ticket_status, t.invoice_number
      FROM kitchen_ticket_items i JOIN kitchen_tickets t ON i.ticket_id=t.id
      WHERE i.id IN (${marks})`).all(...ids);
    if (!items.length) return res.status(404).json({ error: 'Item tidak ditemukan' });

    const foreign = items.find((i) => !canUseBranch(req.user, i.branch_id));
    if (foreign) return res.status(403).json({ error: 'Ada item dari cabang lain di dalam batch' });
    if (status !== 'done' && items.some((i) => i.status === 'done') && !can(req.user, 'kitchen.manage')) {
      return res.status(403).json({ error: 'Batch berisi item yang sudah selesai' });
    }

    const apply = db.transaction(() => {
      const touched = new Set();
      for (const i of items) {
        if (i.ticket_status === 'cancelled') continue; // pesanan batal tidak ikut dimasak
        setItemStatus(i.id, status, req.user.id);
        touched.add(i.ticket_id);
      }
      touched.forEach((tid) => recomputeTicket(tid, req.user.id));
      return touched.size;
    });
    const affected = apply();
    if (status === 'done') {
      const label = items[0] ? items[0].product_name : 'item';
      const qty = items.reduce((a, i) => a + i.qty, 0);
      logActivity({ user: req.user, module: 'kitchen', action: 'batch_done', description: `Batch selesai: ${label} ${qty} — ${affected} pesanan`, entity_type: 'kitchen_batch', entity_id: null });
    }
    res.json({ success: true, items: items.length, tickets: affected });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/** GET /api/kitchen/meta — cabang untuk pemilih layar dapur. */
router.get('/meta/branches', requirePerm('kitchen.view'), (req, res) => {
  try {
    res.json(accessibleBranches(req.user, { onlyOutlet: true }).map((b) => ({ id: b.id, name: b.name })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, createTicketForSale, cancelTicketForSale, deleteTicketForSale };
