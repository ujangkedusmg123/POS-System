/**
 * Katalog hak akses (permission) terpusat.
 * Dipakai bersama oleh backend (penegakan) dan frontend (menyembunyikan menu).
 *
 * Format kunci: <modul>.<aksi>
 * Wildcard '*' = akses penuh (khusus role Administrator).
 */

const PERMISSION_GROUPS = [
  {
    key: 'pos', label: 'Kasir / POS', icon: '🛒',
    items: [
      ['pos.view',          'Membuka halaman kasir'],
      ['pos.sell',          'Memproses transaksi penjualan'],
      ['pos.print',         'Mencetak struk'],
      ['pos.discount',      'Memberi diskon pada transaksi'],
      ['pos.void',          'Membatalkan item / void keranjang'],
      ['pos.price_edit',    'Mengubah harga jual saat transaksi'],
      ['pos.session_open',  'Buka kasir (input saldo awal)'],
      ['pos.session_close', 'Tutup kasir (rekonsiliasi)'],
      ['pos.cash_out',      'Mencatat kas keluar saat shift'],
      ['pos.custom_receipt','Memakai format struk custom'],
    ],
  },
  {
    key: 'sales', label: 'Penjualan', icon: '💰',
    items: [
      ['sales.view',   'Melihat riwayat penjualan'],
      ['sales.export', 'Ekspor data penjualan'],
      ['sales.cancel', 'Membatalkan transaksi'],
      ['sales.delete', 'Menghapus transaksi permanen'],
    ],
  },
  {
    key: 'shift', label: 'Buka/Tutup Kasir', icon: '🔐',
    items: [
      ['shift.view_own', 'Melihat shift sendiri'],
      ['shift.view_all', 'Melihat shift semua kasir'],
      ['shift.report',   'Membuka laporan buka/tutup kasir'],
      ['shift.reopen',   'Membuka kembali shift yang sudah ditutup'],
    ],
  },
  {
    key: 'kitchen', label: 'Dapur / Masak', icon: '👨‍🍳',
    items: [
      ['kitchen.view',   'Membuka layar dapur (antrian masak)'],
      ['kitchen.cook',   'Menandai masakan mulai digoreng / selesai'],
      ['kitchen.manage', 'Membatalkan tiket & membuka kembali pesanan yang sudah selesai'],
    ],
  },
  {
    key: 'products', label: 'Produk', icon: '🦐',
    items: [
      ['products.view',   'Melihat daftar produk'],
      ['products.create', 'Menambah produk'],
      ['products.edit',   'Mengubah produk'],
      ['products.delete', 'Menghapus produk'],
    ],
  },
  {
    key: 'stock', label: 'Stok', icon: '🧮',
    items: [
      ['stock.view',     'Melihat stok'],
      ['stock.edit',     'Produksi & koreksi stok'],
      ['stock.transfer', 'Transfer stok antar cabang'],
      ['stock.delete',   'Menghapus log stok'],
      ['bahan.view',     'Melihat bahan baku'],
      ['bahan.edit',     'Mengelola bahan baku'],
    ],
  },
  {
    key: 'production', label: 'Produksi', icon: '🏭',
    items: [
      ['production.view',    'Melihat data produksi & surplus'],
      ['production.edit',    'Mencatat hasil produksi'],
      ['production.delete',  'Menghapus catatan produksi'],
      ['production.recipe',  'Mengatur resep & HPP produksi'],
    ],
  },
  {
    key: 'finance', label: 'Keuangan', icon: '📈',
    items: [
      ['finance.view',    'Dashboard keuangan'],
      ['expenses.view',   'Melihat beban & pengeluaran'],
      ['expenses.edit',   'Mengelola beban & pengeluaran'],
      ['wallets.view',    'Melihat dompet & kas kecil'],
      ['wallets.edit',    'Mengelola dompet & kas kecil'],
      ['reports.view',    'Melihat laporan keuangan'],
    ],
  },
  {
    key: 'master', label: 'Data Master', icon: '🏪',
    items: [
      ['customers.view', 'Melihat pelanggan'],
      ['customers.edit', 'Mengelola pelanggan'],
      ['branches.view',  'Melihat cabang'],
      ['branches.edit',  'Mengelola cabang'],
      ['channels.view',  'Melihat channel penjualan'],
      ['channels.edit',  'Mengelola channel penjualan'],
    ],
  },
  {
    key: 'settings', label: 'Pengaturan & Sistem', icon: '⚙️',
    items: [
      ['settings.view',        'Membuka halaman pengaturan'],
      ['settings.edit',        'Mengubah pengaturan umum'],
      ['settings.receipt',     'Mengatur struk default'],
      ['settings.receipt_custom','Mengelola template struk custom'],
      ['settings.login',       'Mengatur tampilan halaman login'],
      ['settings.payment',     'Mengelola termin & metode pembayaran'],
      ['users.view',           'Melihat daftar user'],
      ['users.edit',           'Mengelola user'],
      ['roles.view',           'Melihat role & hak akses'],
      ['roles.edit',           'Mengelola role & hak akses'],
      ['activity.view',        'Melihat log aktivitas'],
      ['dashboard.view',       'Melihat dashboard utama'],
    ],
  },
];

/** Daftar datar semua kunci permission yang valid. */
const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map(([k]) => k));

/** Apakah daftar permission mengandung kunci tertentu (mendukung '*' dan 'modul.*'). */
function permsInclude(perms, key) {
  if (!Array.isArray(perms)) return false;
  if (perms.includes('*')) return true;
  if (perms.includes(key)) return true;
  const mod = String(key).split('.')[0];
  return perms.includes(mod + '.*');
}

/** Buang kunci yang tidak dikenal supaya data tetap bersih. */
/**
 * Bersihkan daftar permission dari kunci yang tidak dikenal.
 *
 * PENTING (keamanan): wildcard '*' HANYA boleh dimiliki role bawaan
 * Administrator. Tanpa pembatasan ini, siapa pun yang bisa membuat/mengubah
 * role dapat menuliskan '*' dan langsung mengambil akses penuh sistem —
 * termasuk melucuti admin lain. Karena itu '*' hanya diterima bila pemanggil
 * secara eksplisit mengizinkannya (allowWildcard = true), dan itu hanya
 * dilakukan untuk role sistem 'admin'.
 *
 * @param {string[]} list          daftar permission mentah dari klien
 * @param {boolean}  allowWildcard izinkan '*' (khusus role admin bawaan)
 */
function sanitizePermissions(list, allowWildcard) {
  if (!Array.isArray(list)) return [];
  if (list.includes('*')) {
    if (allowWildcard === true) return ['*'];
    // '*' dibuang; sisanya tetap disaring seperti biasa
    list = list.filter((k) => k !== '*');
  }
  return [...new Set(list.filter((k) => ALL_PERMISSIONS.includes(k)))];
}

module.exports = { PERMISSION_GROUPS, ALL_PERMISSIONS, permsInclude, sanitizePermissions };
