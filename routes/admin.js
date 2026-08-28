const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const db = { prepare: (...a) => getDb().prepare(...a), exec: (...a) => getDb().exec(...a), transaction: (...a) => getDb().transaction(...a) };

router.use(authMiddleware, adminOnly);

/**
 * HAPUS SEMUA DATA TRANSAKSIONAL
 * Menghapus data operasional harian. Master data (produk, cabang, user, dompet, channel) tetap ada.
 * Reset saldo dompet & stok produk ke 0.
 */
router.post('/reset-data', (req, res) => {
  const { confirmation } = req.body;
  if (confirmation !== 'HAPUS TOTAL DATA') {
    return res.status(400).json({ error: 'Konfirmasi tidak sesuai. Ketik: HAPUS TOTAL DATA' });
  }
  try {
    const summary = {};
    const doReset = db.transaction(() => {
      // PENJUALAN
      summary.sale_items = db.prepare('SELECT COUNT(*) as c FROM sale_items').get().c;
      summary.sales = db.prepare('SELECT COUNT(*) as c FROM sales').get().c;
      db.exec('DELETE FROM sale_items');
      db.exec('DELETE FROM sales');

      // STOK LOG + reset semua stok ke 0
      summary.product_stock_log = db.prepare('SELECT COUNT(*) as c FROM product_stock_log').get().c;
      db.exec('DELETE FROM product_stock_log');
      db.exec('UPDATE product_stock SET current_stock=0');

      // TRANSFER ANTAR CABANG
      summary.stock_transfers = db.prepare('SELECT COUNT(*) as c FROM stock_transfers').get().c;
      db.exec('DELETE FROM stock_transfer_items');
      db.exec('DELETE FROM stock_transfers');

      // DOMPET & KAS — reset saldo ke 0
      summary.wallet_transactions = db.prepare('SELECT COUNT(*) as c FROM wallet_transactions').get().c;
      db.exec('DELETE FROM wallet_transactions');
      db.exec('UPDATE wallets SET current_balance=0');

      // BEBAN OPERASIONAL
      summary.expenses = db.prepare('SELECT COUNT(*) as c FROM expenses').get().c;
      db.exec('DELETE FROM expenses');

      // PELANGGAN (kecuali id=1 = Pelanggan Umum)
      summary.customers = Math.max(0, db.prepare('SELECT COUNT(*) as c FROM customers').get().c - 1);
      db.exec('DELETE FROM customers WHERE id>1');
      db.exec('UPDATE customers SET loyalty_points=0 WHERE id=1');

      // SHIFT KASIR (buka/tutup) + kas laci
      summary.cash_sessions = db.prepare('SELECT COUNT(*) as c FROM cash_sessions').get().c;
      db.exec('DELETE FROM cash_movements');
      db.exec('DELETE FROM cash_sessions');

      // ANTRIAN DAPUR
      try {
        summary.kitchen_tickets = db.prepare('SELECT COUNT(*) as c FROM kitchen_tickets').get().c;
        db.exec('DELETE FROM kitchen_ticket_items');
        db.exec('DELETE FROM kitchen_tickets');
      } catch (e) {}

      // LOG PRODUKSI HARIAN
      try { db.exec('DELETE FROM production_logs'); } catch (e) {}

      // LOG AKTIVITAS
      summary.activity_logs = db.prepare('SELECT COUNT(*) as c FROM activity_logs').get().c;
      db.exec('DELETE FROM activity_logs');

      // Reset auto-increment counters
      db.exec("DELETE FROM sqlite_sequence WHERE name IN ('sales','sale_items','sale_item_components','product_stock_log','stock_transfers','stock_transfer_items','wallet_transactions','expenses','activity_logs','cash_sessions','cash_movements','kitchen_tickets','kitchen_ticket_items','production_logs')");
    });
    doReset();

    // Log aksi reset itu sendiri (akan jadi log pertama setelah reset bersih)
    logActivity({
      user: req.user, module: 'admin', action: 'reset_data',
      description: `Reset total data — Hapus ${summary.sales} transaksi, ${summary.wallet_transactions} tx dompet, ${summary.expenses} beban, ${summary.product_stock_log} log stok, ${summary.stock_transfers} transfer, ${summary.customers} pelanggan`,
      metadata: summary
    });

    res.json({
      message: 'Semua data transaksi berhasil dihapus. Master data (produk, cabang, user, dompet, channel, kategori) tetap ada.',
      deleted: summary
    });
  } catch(e) {
    console.error('Reset data error:', e);
    res.status(500).json({ error: 'Gagal reset: ' + e.message });
  }
});

/**
 * GENERATE DATA CONTOH (45 hari) — untuk uji coba.
 * Membersihkan data transaksional lebih dulu (agar tidak dobel / bentrok nomor invoice), lalu isi ulang.
 * Master data (produk, cabang, user, dompet, kategori, channel) tetap ada.
 */
router.post('/generate-dummy', (req, res) => {
  try {
    const { seedDummyData } = require('../database/db');
    const database = getDb();
    const doGen = db.transaction(() => {
      // Bersihkan data transaksional (samakan dengan reset, tanpa konfirmasi)
      db.exec('DELETE FROM sale_items');
      db.exec('DELETE FROM sales');
      try { db.exec('DELETE FROM sale_item_components'); } catch(e) {}
      db.exec('DELETE FROM product_stock_log');
      db.exec('UPDATE product_stock SET current_stock=0');
      db.exec('DELETE FROM stock_transfer_items');
      db.exec('DELETE FROM stock_transfers');
      db.exec('DELETE FROM wallet_transactions');
      db.exec('UPDATE wallets SET current_balance=0');
      db.exec('DELETE FROM expenses');
      db.exec('DELETE FROM customers WHERE id>1');
      // Shift kasir, antrian dapur, dan log produksi ikut dibuat oleh generator,
      // jadi harus dikosongkan dulu supaya tidak menumpuk dobel.
      db.exec('DELETE FROM cash_movements');
      db.exec('DELETE FROM cash_sessions');
      try { db.exec('DELETE FROM kitchen_ticket_items'); db.exec('DELETE FROM kitchen_tickets'); } catch (e) {}
      try { db.exec('DELETE FROM production_logs'); } catch (e) {}
      db.exec("DELETE FROM sqlite_sequence WHERE name IN ('sales','sale_items','sale_item_components','product_stock_log','stock_transfers','stock_transfer_items','wallet_transactions','expenses','customers','cash_sessions','cash_movements','kitchen_tickets','kitchen_ticket_items','production_logs')");
      // Isi ulang data contoh 45 hari
      seedDummyData(database);
    });
    doGen();

    const counts = {
      sales: db.prepare('SELECT COUNT(*) as c FROM sales').get().c,
      wallet_transactions: db.prepare('SELECT COUNT(*) as c FROM wallet_transactions').get().c,
      expenses: db.prepare('SELECT COUNT(*) as c FROM expenses').get().c,
      customers: db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
    };
    logActivity({
      user: req.user, module: 'admin', action: 'generate_dummy',
      description: `Generate data contoh 45 hari — ${counts.sales} transaksi, ${counts.wallet_transactions} tx dompet, ${counts.expenses} beban`,
      metadata: counts
    });
    res.json({ message: `Data contoh 45 hari berhasil dibuat: ${counts.sales} transaksi penjualan, ${counts.expenses} beban.`, counts });
  } catch(e) {
    console.error('generate-dummy error:', e);
    res.status(500).json({ error: 'Gagal generate data dummy: ' + e.message });
  }
});

module.exports = router;
