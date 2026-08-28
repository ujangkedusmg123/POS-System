const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'pos.db');
let db = null, sqlDbInternal = null, saveTimeout = null;

/**
 * Tulis isi database ke berkas SEKARANG JUGA.
 * Dipakai saat aplikasi dimatikan: penulisan biasa ditunda 800 ms untuk
 * menggabungkan banyak perubahan jadi satu tulisan. Kalau proses dihentikan
 * tepat di jeda itu, perubahan terakhir hilang — dan karena seluruh database
 * ada dalam satu berkas, yang hilang bisa banyak sekaligus.
 */
function flushNow() {
  if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
  try {
    if (sqlDbInternal) fs.writeFileSync(DB_PATH, Buffer.from(sqlDbInternal.export()));
    return true;
  } catch (e) {
    console.error('Gagal menyimpan database:', e.message);
    return false;
  }
}

function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => { try { if(sqlDbInternal) fs.writeFileSync(DB_PATH, Buffer.from(sqlDbInternal.export())); } catch(e){} }, 800);
}

function createSyncWrapper(sqlDb) {
  sqlDbInternal = sqlDb;
  function fa(args) { const r=[]; args.forEach(a=>Array.isArray(a)?r.push(...a):r.push(a)); return r; }
  return {
    prepare: (sql) => ({
      run: (...args) => { const s=sqlDb.prepare(sql),f=fa(args); s.run(f.length?f:[]); s.free(); scheduleSave(); const res=sqlDb.exec('SELECT last_insert_rowid()'); return { changes:sqlDb.getRowsModified(), lastInsertRowid:res[0]?.values[0][0] }; },
      get: (...args) => { const s=sqlDb.prepare(sql),f=fa(args); if(f.length)s.bind(f); let r; if(s.step()){const c=s.getColumnNames(),v=s.get();r={};c.forEach((k,i)=>r[k]=v[i]);} s.free(); return r; },
      all: (...args) => { const s=sqlDb.prepare(sql),f=fa(args); if(f.length)s.bind(f); const rs=[]; while(s.step()){const c=s.getColumnNames(),v=s.get();const o={};c.forEach((k,i)=>o[k]=v[i]);rs.push(o);} s.free(); return rs; }
    }),
    exec: (sql) => { sqlDb.run(sql); scheduleSave(); },
    pragma: ()=>{},
    transaction: (fn) => (...args) => { sqlDb.run('BEGIN'); try{const r=fn(...args);sqlDb.run('COMMIT');scheduleSave();return r;}catch(e){try{sqlDb.run('ROLLBACK');}catch(re){}throw e;} }
  };
}

async function initDatabase() {
  const SQL = await initSqlJs();
  let sqlDb;
  if (fs.existsSync(DB_PATH)) { sqlDb = new SQL.Database(fs.readFileSync(DB_PATH)); }
  else { sqlDb = new SQL.Database(); }
  db = createSyncWrapper(sqlDb);

  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS branches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT, phone TEXT, is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, full_name TEXT NOT NULL, role TEXT DEFAULT 'cashier', branch_id INTEGER, is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, created_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, contact_person TEXT, created_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, loyalty_points INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, barcode TEXT, name TEXT NOT NULL, category_id INTEGER, supplier_id INTEGER, buy_price REAL NOT NULL DEFAULT 0, sell_price REAL NOT NULL DEFAULT 0, is_mochi INTEGER DEFAULT 0, track_stock INTEGER DEFAULT 0, unit TEXT DEFAULT 'porsi', description TEXT, image_url TEXT, is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT (datetime('now','+7 hours')));

    -- NEW: per-product per-branch stock (multi-variant)
    CREATE TABLE IF NOT EXISTS product_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      current_stock INTEGER DEFAULT 0,
      min_stock INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT (datetime('now','+7 hours')),
      UNIQUE(product_id, branch_id)
    );
    CREATE TABLE IF NOT EXISTS product_stock_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      quantity_change INTEGER NOT NULL,
      quantity_before INTEGER NOT NULL,
      quantity_after INTEGER NOT NULL,
      notes TEXT,
      sale_id INTEGER,
      created_by INTEGER,
      created_at DATETIME DEFAULT (datetime('now','+7 hours'))
    );

    -- Mapping: saat product_id (yang dijual di POS) terjual, item stok stock_item_id berkurang sebanyak quantity.
    -- Bila tidak ada mapping, dan produk sendiri track_stock=1, maka produk itu sendiri yang berkurang.
    CREATE TABLE IF NOT EXISTS product_stock_link (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      stock_item_id INTEGER NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      UNIQUE(product_id, stock_item_id)
    );

    -- legacy tables kept for compat
    CREATE TABLE IF NOT EXISTS mochi_stock (id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER UNIQUE NOT NULL, current_stock INTEGER DEFAULT 0, updated_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS mochi_stock_log (id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL, type TEXT NOT NULL, quantity_change INTEGER NOT NULL, quantity_before INTEGER NOT NULL, quantity_after INTEGER NOT NULL, notes TEXT, sale_id INTEGER, created_by INTEGER, created_at DATETIME DEFAULT (datetime('now','+7 hours')));

    CREATE TABLE IF NOT EXISTS raw_materials (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT DEFAULT 'kg', current_stock REAL DEFAULT 0, min_stock REAL DEFAULT 1, notes TEXT, is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS raw_material_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, material_id INTEGER NOT NULL, type TEXT NOT NULL, quantity_change REAL NOT NULL, quantity_before REAL NOT NULL, quantity_after REAL NOT NULL, notes TEXT, created_by INTEGER, created_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT UNIQUE NOT NULL, branch_id INTEGER, channel TEXT DEFAULT 'langsung', platform_fee_percent REAL DEFAULT 0, platform_fee_amount REAL DEFAULT 0, customer_id INTEGER, cashier_id INTEGER NOT NULL, subtotal REAL NOT NULL DEFAULT 0, discount_amount REAL DEFAULT 0, tax_percent REAL DEFAULT 0, tax_amount REAL DEFAULT 0, total REAL NOT NULL DEFAULT 0, net_revenue REAL DEFAULT 0, payment_method TEXT DEFAULT 'cash', payment_amount REAL NOT NULL DEFAULT 0, change_amount REAL DEFAULT 0, status TEXT DEFAULT 'completed', notes TEXT, created_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS sale_items (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, product_id INTEGER NOT NULL, product_name TEXT NOT NULL, product_code TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, buy_price REAL NOT NULL DEFAULT 0, sell_price REAL NOT NULL DEFAULT 0, discount_percent REAL DEFAULT 0, subtotal REAL NOT NULL DEFAULT 0, is_mochi INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS expense_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, is_hpp INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER, branch_id INTEGER, description TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, expense_date DATE NOT NULL, payment_method TEXT DEFAULT 'cash', reference_number TEXT, notes TEXT, created_by INTEGER, created_at DATETIME DEFAULT (datetime('now','+7 hours')));
    CREATE TABLE IF NOT EXISTS settings (key TEXT UNIQUE NOT NULL, value TEXT, updated_at DATETIME DEFAULT (datetime('now','+7 hours')));

    -- Channel penjualan (dinamis, dikelola admin)
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6b7280',
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now','+7 hours'))
    );

    -- Log Aktivitas Sistem (audit trail)
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      description TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      metadata TEXT,
      created_at DATETIME DEFAULT (datetime('now','+7 hours'))
    );


    -- Dompet & Kas Kecil (Petty Cash / Bank / E-Wallet)
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'petty_cash',
      branch_id INTEGER,
      current_balance REAL NOT NULL DEFAULT 0,
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now','+7 hours'))
    );
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT,
      reference TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT (datetime('now','+7 hours'))
    );
    CREATE TABLE IF NOT EXISTS wallet_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'asset',
      icon TEXT DEFAULT '📦',
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now','+7 hours'))
    );
  `);

  const tryAlter = (sql) => { try { sqlDb.run(sql); } catch(e) {} };
  tryAlter('ALTER TABLE products ADD COLUMN track_stock INTEGER DEFAULT 0');
  tryAlter('ALTER TABLE products ADD COLUMN image_url TEXT');
  tryAlter('ALTER TABLE products ADD COLUMN parent_product_id INTEGER');
  tryAlter('ALTER TABLE products ADD COLUMN show_in_pos INTEGER DEFAULT 1');
  tryAlter('ALTER TABLE branches ADD COLUMN is_production_center INTEGER DEFAULT 0');
  // Beban bisa dibayar dari dompet tertentu (saldo berkurang otomatis)
  tryAlter('ALTER TABLE expenses ADD COLUMN wallet_id INTEGER');
  // Dompet: kategori bisa dikelola sendiri + jenis aset/hutang
  tryAlter("ALTER TABLE wallets ADD COLUMN category_id INTEGER");
  tryAlter("ALTER TABLE wallets ADD COLUMN kind TEXT DEFAULT 'asset'");
  try {
    const wc = db.prepare('SELECT COUNT(*) c FROM wallet_categories').get();
    if (!wc || wc.c === 0) {
      const cats = [
        ['Kas Kecil','asset','💵'], ['Bank','asset','🏦'], ['E-Wallet','asset','📱'],
        ['Kas Besar','asset','💰'], ['Hutang','liability','📕'],
      ];
      cats.forEach(c => db.prepare('INSERT INTO wallet_categories (name,kind,icon) VALUES (?,?,?)').run(...c));
    }
    // Backfill kategori & kind untuk wallet lama berdasarkan type
    const catByName = {};
    db.prepare('SELECT id,name,kind FROM wallet_categories').all().forEach(c => catByName[c.name.toLowerCase()] = c);
    const typeMap = { petty_cash:'Kas Kecil', bank:'Bank', ewallet:'E-Wallet', other:'Kas Kecil', tunai:'Kas Kecil', qris:'E-Wallet' };
    db.prepare('SELECT id,type,category_id FROM wallets WHERE category_id IS NULL').all().forEach(w => {
      const catName = (typeMap[w.type] || w.type || 'Kas Kecil');
      const cat = catByName[String(catName).toLowerCase()] || catByName['kas kecil'];
      if (cat) db.prepare('UPDATE wallets SET category_id=?, kind=? WHERE id=?').run(cat.id, cat.kind, w.id);
    });
  } catch(e) {}
  // Produk Mix (dikomposisi di kasir) — is_mix + jumlah total pcs per porsi
  tryAlter('ALTER TABLE products ADD COLUMN is_mix INTEGER DEFAULT 0');
  tryAlter('ALTER TABLE products ADD COLUMN mix_size INTEGER DEFAULT 0');
  // Isi per porsi (pcs) — berapa pcs stok berkurang tiap 1 porsi produk ini terjual
  tryAlter('ALTER TABLE products ADD COLUMN pcs_per_porsi INTEGER DEFAULT 1');
  // Migrasi: pindahkan self-link lama (produk→dirinya sendiri) menjadi kolom pcs_per_porsi, lalu hapus self-link
  try {
    db.prepare(`UPDATE products SET pcs_per_porsi = COALESCE(
      (SELECT quantity FROM product_stock_link WHERE product_id=products.id AND stock_item_id=products.id), pcs_per_porsi, 1)
      WHERE EXISTS (SELECT 1 FROM product_stock_link WHERE product_id=products.id AND stock_item_id=products.id)`).run();
    db.prepare('DELETE FROM product_stock_link WHERE product_id = stock_item_id').run();
  } catch(e) {}
  // Isi per porsi (pcs) — berapa pcs stok berkurang tiap 1 porsi terjual
  tryAlter('ALTER TABLE products ADD COLUMN pcs_per_porsi INTEGER DEFAULT 1');
  tryAlter('ALTER TABLE sale_items ADD COLUMN pcs_per_porsi INTEGER DEFAULT 1');
  // Rincian komposisi mix per item penjualan (untuk restore stok saat batal)
  tryAlter(`CREATE TABLE IF NOT EXISTS sale_item_components (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_item_id INTEGER NOT NULL,
    sale_id INTEGER NOT NULL,
    component_product_id INTEGER NOT NULL,
    component_name TEXT,
    pcs INTEGER NOT NULL DEFAULT 0
  )`);
  // Log produksi harian (untuk rekap hasil produksi & dashboard)
  tryAlter(`CREATE TABLE IF NOT EXISTS production_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date DATE NOT NULL,
    branch_id INTEGER,
    jumlah_resep REAL NOT NULL DEFAULT 0,
    output_pcs REAL NOT NULL DEFAULT 0,
    opex_harian REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT (datetime('now','+7 hours'))
  )`);

  // Stock transfers antar cabang
  tryAlter(`CREATE TABLE IF NOT EXISTS stock_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_code TEXT UNIQUE NOT NULL,
    from_branch_id INTEGER NOT NULL,
    to_branch_id INTEGER NOT NULL,
    notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT (datetime('now','+7 hours'))
  )`);
  tryAlter(`CREATE TABLE IF NOT EXISTS stock_transfer_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL
  )`);

  /* ============================================================
     ROLE & PERMISSION (hak akses granular)
     ============================================================ */
  tryAlter(`CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_system INTEGER DEFAULT 0,
    permissions TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT (datetime('now','+7 hours'))
  )`);
  tryAlter('ALTER TABLE users ADD COLUMN role_id INTEGER');

  /* ============================================================
     TERMIN / METODE PEMBAYARAN
     ============================================================ */
  tryAlter(`CREATE TABLE IF NOT EXISTS payment_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    kind TEXT DEFAULT 'cash',        -- cash | cashless | credit
    icon TEXT DEFAULT '💳',
    fee_percent REAL DEFAULT 0,
    needs_reference INTEGER DEFAULT 0, -- minta no. referensi/approval
    gives_change INTEGER DEFAULT 0,    -- boleh ada kembalian
    counted_in_drawer INTEGER DEFAULT 0, -- masuk hitungan fisik laci kasir
    term_days INTEGER DEFAULT 0,       -- termin jatuh tempo (hari)
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','+7 hours'))
  )`);

  /* ============================================================
     TEMPLATE STRUK CUSTOM (tidak mengubah struk default)
     ============================================================ */
  tryAlter(`CREATE TABLE IF NOT EXISTS receipt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    customer_id INTEGER,
    config TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_by INTEGER,
    created_at DATETIME DEFAULT (datetime('now','+7 hours')),
    updated_at DATETIME DEFAULT (datetime('now','+7 hours'))
  )`);

  /* ============================================================
     BUKA / TUTUP KASIR (shift) + CASH OUT
     ============================================================ */
  tryAlter(`CREATE TABLE IF NOT EXISTS cash_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_code TEXT UNIQUE NOT NULL,
    branch_id INTEGER,
    user_id INTEGER NOT NULL,
    opening_balance REAL NOT NULL DEFAULT 0,
    opening_notes TEXT,
    opened_at DATETIME DEFAULT (datetime('now','+7 hours')),
    closed_at DATETIME,
    closed_by INTEGER,
    counted_cash REAL,
    expected_cash REAL,
    difference REAL,
    closing_notes TEXT,
    snapshot TEXT,
    status TEXT DEFAULT 'open'
  )`);
  tryAlter(`CREATE TABLE IF NOT EXISTS cash_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    type TEXT NOT NULL,             -- in | out
    amount REAL NOT NULL DEFAULT 0,
    category TEXT,
    reason TEXT,
    reference TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT (datetime('now','+7 hours'))
  )`);
  tryAlter('ALTER TABLE sales ADD COLUMN session_id INTEGER');
  tryAlter('ALTER TABLE sales ADD COLUMN payment_reference TEXT');
  tryAlter('ALTER TABLE sales ADD COLUMN receipt_template_id INTEGER');

  /* ======================================================================
     DAPUR — ANTRIAN MASAK (Kitchen Display)
     ----------------------------------------------------------------------
     Satu transaksi kasir menghasilkan satu "tiket" dapur. Tiap baris tiket
     adalah satu unit yang harus dimasak. Produk Mix DIURAIKAN menjadi
     komponen rasanya, karena yang benar-benar digoreng adalah rasa dasarnya
     — tanpa penguraian ini juru masak tidak tahu harus menggoreng apa.
     ====================================================================== */
  tryAlter(`CREATE TABLE IF NOT EXISTS kitchen_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER UNIQUE,
    invoice_number TEXT,
    branch_id INTEGER,
    channel TEXT DEFAULT 'langsung',
    customer_name TEXT,
    cashier_id INTEGER,
    notes TEXT,
    status TEXT DEFAULT 'pending',      -- pending | cooking | done | cancelled
    created_at DATETIME DEFAULT (datetime('now','+7 hours')),
    started_at DATETIME,
    done_at DATETIME,
    done_by INTEGER
  )`);
  tryAlter(`CREATE TABLE IF NOT EXISTS kitchen_ticket_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    sale_item_id INTEGER,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    parent_name TEXT,                   -- diisi bila baris ini komponen dari produk Mix
    qty REAL NOT NULL DEFAULT 1,        -- jumlah yang harus dimasak
    unit TEXT DEFAULT 'pcs',
    status TEXT DEFAULT 'pending',      -- pending | cooking | done
    started_at DATETIME,
    done_at DATETIME,
    done_by INTEGER
  )`);
  tryAlter('CREATE INDEX IF NOT EXISTS idx_kitchen_tickets_status ON kitchen_tickets(status, branch_id)');
  tryAlter('CREATE INDEX IF NOT EXISTS idx_kitchen_items_ticket ON kitchen_ticket_items(ticket_id)');
  tryAlter('CREATE INDEX IF NOT EXISTS idx_kitchen_items_status ON kitchen_ticket_items(status)');

  // Produk yang tidak perlu dimasak (mis. add-on saus botolan) tidak dikirim ke dapur.
  tryAlter('ALTER TABLE products ADD COLUMN needs_cooking INTEGER DEFAULT 1');
  try {
    const kf = db.prepare("SELECT value FROM settings WHERE key='kitchen_defaults_v1'").get();
    if (!kf || kf.value !== '1') {
      // Default masuk akal: kategori "Tambahan"/add-on tidak perlu masak.
      db.prepare(`UPDATE products SET needs_cooking=0 WHERE id IN (
        SELECT p.id FROM products p LEFT JOIN categories c ON p.category_id=c.id
        WHERE LOWER(COALESCE(c.name,'')) LIKE '%tambahan%' OR LOWER(COALESCE(p.code,'')) LIKE 'addon%')`).run();
      db.prepare("INSERT INTO settings (key,value) VALUES ('kitchen_defaults_v1','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    }
  } catch (e) {}


  /* ======================================================================
     CABANG & HAK AKSES CABANG PER USER
     ----------------------------------------------------------------------
     Satu user bisa dipercaya memegang beberapa cabang (mis. supervisor area).
     Kolom users.branch_id dipertahankan sebagai "cabang utama" agar kode lama
     tetap jalan, tetapi penentu hak akses yang sebenarnya adalah tabel
     user_branches — itulah yang dipakai untuk membatasi Buka Kasir.
     ====================================================================== */
  tryAlter('ALTER TABLE branches ADD COLUMN is_outlet INTEGER DEFAULT 1');
  tryAlter(`CREATE TABLE IF NOT EXISTS user_branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    UNIQUE(user_id, branch_id)
  )`);
  tryAlter('CREATE INDEX IF NOT EXISTS idx_user_branches_user ON user_branches(user_id)');
  // User lama hanya punya satu cabang di kolom users.branch_id — pindahkan.
  try {
    db.prepare('INSERT OR IGNORE INTO user_branches (user_id,branch_id) SELECT id, branch_id FROM users WHERE branch_id IS NOT NULL').run();
  } catch (e) {}

  // Seed role bawaan
  const seedRoles = [
    ['admin', 'Administrator', 'Akses penuh ke seluruh sistem', 1, '["*"]'],
    ['cashier', 'Kasir', 'Akses operasional kasir', 1, JSON.stringify([
      'pos.view','pos.sell','pos.print','pos.session_open','pos.session_close','pos.cash_out',
      'sales.view','stock.view','settings.view','shift.view_own'
    ])],
    ['supervisor', 'Supervisor', 'Pengawas operasional cabang', 0, JSON.stringify([
      'pos.view','pos.sell','pos.print','pos.void','pos.discount',
      'pos.session_open','pos.session_close','pos.cash_out',
      'sales.view','sales.cancel','stock.view','stock.edit','shift.view_all','shift.report',
      'reports.view','customers.view','settings.view'
    ])],
    ['kitchen', 'Dapur / Juru Masak', 'Hanya layar antrian masak — tanpa akses kasir, stok, dan keuangan', 0, JSON.stringify([
      'kitchen.view','kitchen.cook'
    ])],
    ['production', 'Tim Produksi', 'Produksi, bahan baku, dan stok — tanpa akses kasir & keuangan', 0, JSON.stringify([
      'production.view','production.edit','production.recipe',
      'stock.view','stock.edit','stock.transfer',
      'bahan.view','bahan.edit',
      'products.view','settings.view'
    ])],
  ];
  seedRoles.forEach(([code, name, desc, sys, perms]) => {
    try { sqlDb.run('INSERT OR IGNORE INTO roles (code,name,description,is_system,permissions) VALUES (?,?,?,?,?)', [code, name, desc, sys, perms]); } catch(e) {}
  });
  // Sinkronkan role_id user lama berdasarkan kolom role teks
  try { sqlDb.run('UPDATE users SET role_id=(SELECT id FROM roles WHERE roles.code=users.role) WHERE role_id IS NULL'); } catch(e) {}

  // Seed metode pembayaran bawaan
  const seedPm = [
    ['cash','Tunai','cash','💵',0,0,1,1,0,1],
    ['qris','QRIS','cashless','📱',0,0,0,0,0,2],
    ['transfer','Transfer Bank','cashless','🏦',0,1,0,0,0,3],
    ['debit','Kartu Debit','cashless','💳',0,1,0,0,0,4],
    ['piutang','Piutang / Tempo','credit','🧾',0,1,0,0,7,5],
  ];
  seedPm.forEach((r) => {
    try { sqlDb.run('INSERT OR IGNORE INTO payment_methods (code,name,kind,icon,fee_percent,needs_reference,gives_change,counted_in_drawer,term_days,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)', r); } catch(e) {}
  });

  // Default receipt settings — Ujang Kedu
  const defaultSettings = [
    // --- Tampilan halaman login (bisa diubah admin) ---
    ['login_title', 'Ujang Kedu'],
    ['login_subtitle', 'Sistem Kuliner Udang Semarang'],
    ['login_welcome', 'Selamat datang kembali'],
    ['login_logo', ''],
    ['login_emoji', '🦐'],
    ['login_bg_from', '#0f1f3d'],
    ['login_bg_to', '#1e6fe8'],
    ['login_bg_image', ''],
    ['login_footer', ''],
    ['login_layout', 'center'],
    // --- Notifikasi & cetak POS ---
    ['pos_sound_enabled', '1'],
    ['pos_sound_type', 'chime'],
    ['pos_autoprint', '0'],
    ['pos_direct_print', '1'],
    ['receipt_logo', ''],
    ['receipt_show_logo', '1'],
    ['receipt_logo_width', '55'],   // persen dari lebar area cetak
    ['receipt_paper', '58'],        // 58 | 80 (mm)
    ['receipt_margin', '3'],        // margin kiri/kanan struk (mm)
    ['receipt_store_name', 'Ujang Kedu'],
    ['receipt_tagline', 'Kuliner Udang Semarang'],
    ['receipt_address', 'Semarang, Jawa Tengah'],
    ['receipt_phone', '0881-0000-0000'],
    ['receipt_instagram', '@ujangkedu.smg'],
    ['receipt_footer', 'Terima kasih sudah membeli!\nUjang Kedu, gurih & maknyus 🦐'],
    ['receipt_show_cashier', '1'],
    ['receipt_show_datetime', '1'],
    ['receipt_show_invoice', '1'],
    // Konstanta perhitungan produksi (bisa diubah di halaman Produksi)
    ['prod_hpp_resep', '65040'],
    ['prod_harga_jual', '14000'],
    ['prod_hpp_packaging', '1100'],
    ['prod_opex_harian', '650000'],
    ['prod_pcs_per_porsi', '4'],
    ['prod_pcs_per_resep', '37'],
  ];
  defaultSettings.forEach(([k,v]) => {
    try { sqlDb.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)", [k, v]); } catch(e) {}
  });

  const cnt = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (!cnt || cnt.c === 0) {
    console.log('🌱 Setup data Ujang Kedu...');
    seedFresh();
    console.log('✅ Siap! Data awal Ujang Kedu berhasil dimuat');
  }

  // Terapkan menu Ujang Kedu terbaru SETELAH seed (idempoten, menonaktifkan menu lama, tidak menghapus riwayat)
  try { applyMenuV2(db); } catch(e) { console.log('Menu v2 note:', e.message); }
  // Konversi self-link lama → kolom pcs_per_porsi (sekali jalan)
  try { migrateSelfLinksToPcs(db); } catch(e) { console.log('Pcs migrate note:', e.message); }
  // Cabang Ujang Kedu yang sebenarnya + akun contoh per cabang (sekali jalan)
  try { applyBranchesV3(db, bcrypt); } catch(e) { console.log('Branches v3 note:', e.message); }
  // Akun operasional lengkap (kasir & koki tiap cabang, produksi, runner)
  try { applyAkunV4(db, bcrypt); } catch(e) { console.log('Akun v4 note:', e.message); }

  scheduleSave();
  return db;
}

function seedFresh() {
  // 3 cabang: 1 pusat produksi (bisa transfer stok) + 2 outlet
  db.prepare('INSERT INTO branches (name,address,phone,is_production_center) VALUES (?,?,?,?)').run('Dapur Produksi Pusat','Jl. Kedu Raya No.1, Semarang','0881-0000-0001',1);
  db.prepare('INSERT INTO branches (name,address,phone,is_production_center) VALUES (?,?,?,?)').run('Outlet Semarang Barat','Jl. Pemuda No.10, Semarang','0881-0000-0002',0);
  db.prepare('INSERT INTO branches (name,address,phone,is_production_center) VALUES (?,?,?,?)').run('Outlet Semarang Timur','Jl. MT Haryono No.5, Semarang','0881-0000-0003',0);

  // Users
  db.prepare('INSERT INTO users (username,password,full_name,role,branch_id) VALUES (?,?,?,?,?)').run('admin',bcrypt.hashSync('admin123',10),'Owner Ujang Kedu','admin',null);
  db.prepare('INSERT INTO users (username,password,full_name,role,branch_id) VALUES (?,?,?,?,?)').run('kasir1',bcrypt.hashSync('kasir123',10),'Kasir Semarang Barat','cashier',2);
  db.prepare('INSERT INTO users (username,password,full_name,role,branch_id) VALUES (?,?,?,?,?)').run('kasir2',bcrypt.hashSync('kasir123',10),'Kasir Semarang Timur','cashier',3);

  // Kategori produk
  [
    ['Menu Utama','Aneka menu udang'],
    ['Minuman','Aneka minuman'],
    ['Tambahan','Nasi, sambal, dsb.'],
  ].forEach(c=>db.prepare('INSERT INTO categories (name,description) VALUES (?,?)').run(...c));

  // Kategori beban (akun laporan keuangan)
  // is_hpp=1: masuk HPP/Laba Kotor
  [
    ['Bahan Baku','Udang, bumbu, minyak, dsb.',1],
    ['Kemasan','Dus, plastik, sendok',1],
    ['Sewa Tempat','Sewa outlet/booth',0],
    ['Listrik & Air','Utilitas outlet',0],
    ['Gaji Karyawan','Upah kasir & dapur',0],
    ['Transportasi','Bensin, ongkir bahan',0],
    ['Pemasaran','Promo, sosmed, iklan',0],
    ['Lain-lain','Pengeluaran umum',0],
  ].forEach(e=>db.prepare('INSERT INTO expense_categories (name,description,is_hpp) VALUES (?,?,?)').run(...e));

  db.prepare('INSERT INTO customers (name) VALUES (?)').run('Pelanggan Umum');

  // Menu Ujang Kedu — setiap menu = 1 produk = 1 stok tersendiri.
  // track_stock=1 → stok dimonitor & otomatis berkurang tiap penjualan.
  const products=[
    // code, name, cat, buy, sell, is_mochi, track_stock, unit
    ['UK001','Udang Keju',     1, 0, 30000, 0, 1, 'porsi'],
    ['UK002','Udang Rambutan', 1, 0, 32000, 0, 1, 'porsi'],
    ['UK003','Udang Bakar',    1, 0, 28000, 0, 1, 'porsi'],
    ['UK004','Udang Minang',   1, 0, 30000, 0, 1, 'porsi'],
    ['UK005','Udang Nanas',    1, 0, 33000, 0, 1, 'porsi'],
    // Tambahan / minuman — tidak wajib dimonitor stoknya
    ['UK010','Es Teh Manis',   2, 0, 5000,  0, 0, 'gelas'],
    ['UK011','Es Jeruk',       2, 0, 7000,  0, 0, 'gelas'],
    ['UK012','Air Mineral',    2, 0, 4000,  0, 0, 'botol'],
    ['UK013','Nasi Putih',     3, 0, 5000,  0, 0, 'porsi'],
    ['UK014','Sambal Extra',   3, 0, 3000,  0, 0, 'porsi'],
  ];
  products.forEach(p=>db.prepare('INSERT INTO products (code,name,category_id,buy_price,sell_price,is_mochi,track_stock,unit) VALUES (?,?,?,?,?,?,?,?)').run(...p));

  // Inisialisasi baris product_stock untuk tiap produk track_stock di tiap cabang (stok awal 0)
  const trackedProducts = db.prepare('SELECT id FROM products WHERE track_stock=1').all();
  const allBranches = db.prepare('SELECT id FROM branches').all();
  trackedProducts.forEach(p => {
    allBranches.forEach(b => {
      db.prepare('INSERT OR IGNORE INTO product_stock (product_id, branch_id, current_stock, min_stock) VALUES (?,?,0,5)').run(p.id, b.id);
    });
  });

  // Bahan baku
  const materials=[
    ['Udang Segar','kg',0,5,'Bahan utama'],
    ['Tepung Bumbu','kg',0,2,''],
    ['Minyak Goreng','liter',0,5,''],
    ['Bawang Putih','kg',0,1,''],
    ['Cabai','kg',0,1,''],
    ['Telur Asin','butir',0,20,''],
    ['Beras','kg',0,10,''],
    ['Kemasan Dus','pcs',0,50,''],
    ['Plastik','pack',0,5,''],
  ];
  materials.forEach(m=>db.prepare('INSERT INTO raw_materials (name,unit,current_stock,min_stock,notes) VALUES (?,?,?,?,?)').run(...m));

  // Dompet & Kas Kecil default
  const walletSeed = [
    ['Kas Kecil Outlet Barat', 'petty_cash', 2, 'Kas operasional Outlet Barat'],
    ['Kas Kecil Outlet Timur', 'petty_cash', 3, 'Kas operasional Outlet Timur'],
    ['Rekening Bank BCA', 'bank', null, 'Rekening operasional utama'],
    ['E-Wallet (GoPay/OVO)', 'ewallet', null, 'Terima QRIS dan pembayaran digital'],
  ];
  const _wtCat = { petty_cash:'Kas Kecil', bank:'Bank', ewallet:'E-Wallet' };
  walletSeed.forEach(([n,t,b,notes])=>{
    const c = db.prepare('SELECT id,kind FROM wallet_categories WHERE name=?').get(_wtCat[t]||'Kas Kecil');
    db.prepare('INSERT INTO wallets (name,type,branch_id,current_balance,notes,category_id,kind) VALUES (?,?,?,0,?,?,?)').run(n,t,b,notes, c?c.id:null, c?c.kind:'asset');
  });

  // Channel penjualan default
  [
    ['langsung',   'Langsung / Dine-in', '#6b7280', 1],
    ['takeaway',   'Take Away',          '#0891b2', 2],
    ['gofood',     'GoFood',             '#dc2626', 3],
    ['grabfood',   'GrabFood',           '#059669', 4],
    ['shopeefood', 'ShopeeFood',         '#ea580c', 5],
    ['whatsapp',   'Pesan via WhatsApp', '#16a34a', 6],
  ].forEach(([c,n,col,ord]) => db.prepare('INSERT INTO channels (code,name,color,sort_order) VALUES (?,?,?,?)').run(c,n,col,ord));

  // ============================================================
  // DATA CONTOH
  // Hanya dibuat kalau diminta eksplisit lewat SEED_DUMMY=true. Pemasangan
  // baru di hosting harus mulai bersih — data karangan yang ikut terbawa ke
  // sistem yang dipakai sungguhan jauh lebih merepotkan daripada menekan
  // tombol "Isi Data Contoh" di halaman Pengaturan.
  // ============================================================
  if (process.env.SEED_DUMMY === 'true') {
    try { seedDummyData(db); }
    catch(e) { console.log('Data contoh dilewati (init tetap lanjut):', e.message); }
  }
}

/**
 * DATA CONTOH 30 HARI — Ujang Kedu
 * ---------------------------------------------------------------------------
 * Dibuat supaya angkanya masuk akal untuk warung kuliner udang di Semarang:
 *  - jam ramai sore–malam (15:00–22:00), bukan tersebar rata sepanjang hari
 *  - akhir pekan lebih ramai daripada hari kerja
 *  - stok digoreng di Dapur Produksi Pusat lalu dikirim ke tiap cabang
 *  - tiap hari tiap cabang punya satu shift kasir yang dibuka lalu ditutup
 *  - penjualan hari ini masuk ke antrian dapur supaya layar dapur ada isinya
 * Semua transaksi menempel ke sesi kasir, jadi Laporan Kasir ikut cocok.
 */
function seedDummyData(db) {
  const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  /** Pilih berdasarkan bobot: [[nilai, bobot], ...] */
  const weighted = (pairs) => {
    const total = pairs.reduce((a, p) => a + p[1], 0);
    let r = Math.random() * total;
    for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
    return pairs[pairs.length - 1][0];
  };
  const pad = (n, l) => String(n).padStart(l, '0');

  // --- Kalender: pakai tanggal nyata supaya nomor invoice & tanggal cocok ---
  const today = new Date();
  const dayOf = (daysAgo) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    d.setDate(d.getDate() - daysAgo);
    return d;
  };
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  const ts = (d, h, m, s) => ymd(d) + ' ' + pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s || 0, 2);
  const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

  const DAYS = 45;   // cukup panjang agar perbandingan bulan lalu ada isinya

  // --- Cabang: satu dapur produksi + outlet penjualan ---
  const prodBranch = db.prepare('SELECT id FROM branches WHERE is_production_center=1 ORDER BY id LIMIT 1').get();
  const PROD_ID = prodBranch ? prodBranch.id : 1;
  const outlets = db.prepare('SELECT id,name FROM branches WHERE COALESCE(is_outlet,1)=1 AND is_active=1 ORDER BY id').all();
  if (!outlets.length) { console.log('Tidak ada cabang outlet — data contoh dilewati'); return; }

  // --- Menu: pakai menu yang benar-benar aktif di kasir ---
  const menu = db.prepare('SELECT id,code,name,sell_price,unit,pcs_per_porsi,track_stock,is_mix,mix_size,needs_cooking FROM products WHERE is_active=1 AND COALESCE(show_in_pos,1)=1 ORDER BY id').all();
  const stokItems = menu.filter((p) => p.track_stock && !p.is_mix);   // yang digoreng & disetok
  const mixProduct = menu.find((p) => p.is_mix);
  const addons = menu.filter((p) => !p.track_stock && !p.is_mix);
  if (!stokItems.length) { console.log('Tidak ada produk berstok — data contoh dilewati'); return; }

  // Rasa reguler jauh lebih laris daripada menu special yang harganya dua kali lipat
  const menuWeighted = stokItems.map((p) => [p, p.sell_price >= 25000 ? 1 : 3]);
  const mixComponents = mixProduct
    ? db.prepare('SELECT stock_item_id FROM product_stock_link WHERE product_id=?').all(mixProduct.id)
      .map((l) => stokItems.find((s) => s.id === l.stock_item_id)).filter(Boolean)
    : [];

  console.log('Membuat data contoh ' + DAYS + ' hari untuk ' + outlets.length + ' cabang...');

  // --- Pelanggan reguler ---
  const customers = [
    ['Bu Ratna Wijayanti', '081234567890', 'ratna.w@gmail.com', 'Perum Pandanaran B-12'],
    ['Pak Budi Santoso', '081298765432', 'budi.santoso@gmail.com', 'Jl. Diponegoro No.45'],
    ['Sari Wulandari', '087712345678', 'sari.wulan@gmail.com', 'Perum Semarang Indah C-3'],
    ['Andi Wijaya', '085678901234', '', 'Jl. Pahlawan No.21'],
    ['Dewi Kartika', '089876543210', 'dewi.kartika@gmail.com', 'Kompleks Pemuda D-8'],
    ['Rudi Hartono', '081345678901', '', 'Jl. Suratmo No.14'],
    ['Ny. Susilawati', '087654321098', '', 'Perum Puri Anjasmoro A-5'],
    ['Tono Rahmadi', '089012345678', 'tono.r@gmail.com', 'Jl. Kedungmundu No.100'],
    ['Mbak Fitri Anisa', '082133445566', '', 'Tembalang Regency H-2'],
    ['Pak Hendra Kusuma', '081577889900', 'hendra.k@gmail.com', 'Jl. Ngesrep Timur V'],
  ];
  const custIds = customers.map((c) =>
    db.prepare('INSERT INTO customers (name,phone,email,address) VALUES (?,?,?,?)').run(...c).lastInsertRowid);

  // --- Kasir per cabang (ikut hak akses cabang yang sudah diatur) ---
  const usersByBranch = {};
  outlets.forEach((o) => {
    let rows = [];
    try {
      rows = db.prepare("SELECT u.id FROM users u WHERE u.is_active=1 AND u.role NOT IN ('admin','kitchen') AND u.id IN (SELECT user_id FROM user_branches WHERE branch_id=?)").all(o.id);
    } catch (e) { rows = []; }
    if (!rows.length) rows = db.prepare("SELECT id FROM users WHERE is_active=1 AND branch_id=? AND role NOT IN ('admin','kitchen')").all(o.id);
    usersByBranch[o.id] = rows.length ? rows.map((r) => r.id) : [1];
  });

  /* ================= 1) PRODUKSI DI DAPUR PUSAT ================= */
  const stokPusat = {};
  stokItems.forEach((p) => { stokPusat[p.id] = 0; });

  for (let d = DAYS; d >= 0; d -= 2) {
    const tanggal = dayOf(d);
    stokItems.forEach((p) => {
      // Sekali produksi harus cukup untuk kiriman ke seluruh cabang selama 2 hari
      const qty = p.sell_price >= 25000 ? rand(150, 200) : rand(430, 530);
      const before = stokPusat[p.id];
      const after = before + qty;
      stokPusat[p.id] = after;
      db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,created_by,created_at) VALUES (?,?,?,?,?,?,?,1,?)')
        .run(p.id, PROD_ID, 'produksi', qty, before, after, 'Produksi harian dapur pusat', ts(tanggal, 6, rand(0, 59)));
    });
    db.prepare('INSERT INTO production_logs (log_date,branch_id,jumlah_resep,output_pcs,opex_harian,notes,created_by,created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(ymd(tanggal), PROD_ID, rand(8, 14), stokItems.length * 120, rand(150000, 250000), 'Produksi rutin', ts(tanggal, 6, 30));
  }

  /* ================= 2) KIRIM STOK KE TIAP CABANG ================= */
  const stokOutlet = {};
  outlets.forEach((o) => { stokOutlet[o.id] = {}; stokItems.forEach((p) => { stokOutlet[o.id][p.id] = 0; }); });

  let tfSeq = 0;
  for (let d = DAYS; d >= 0; d -= 2) {
    const tanggal = dayOf(d);
    outlets.forEach((o) => {
      tfSeq++;
      const kode = 'TF' + pad(o.id, 2) + ymd(tanggal).replace(/-/g, '') + pad(tfSeq, 3);
      const waktu = ts(tanggal, 9, rand(0, 45));
      const tr = db.prepare('INSERT INTO stock_transfers (transfer_code,from_branch_id,to_branch_id,notes,created_by,created_at) VALUES (?,?,?,?,1,?)')
        .run(kode, PROD_ID, o.id, 'Kiriman rutin dari dapur pusat', waktu);
      stokItems.forEach((p) => {
        // 1 porsi rasa reguler = 4 pcs, jadi kirimannya harus dalam ratusan
        const qty = p.sell_price >= 25000 ? rand(45, 65) : rand(135, 175);
        if (stokPusat[p.id] < qty) return;
        const pBef = stokPusat[p.id]; const pAft = pBef - qty; stokPusat[p.id] = pAft;
        db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,created_by,created_at) VALUES (?,?,?,?,?,?,?,1,?)')
          .run(p.id, PROD_ID, 'transfer_out', -qty, pBef, pAft, kode, waktu);
        const oBef = stokOutlet[o.id][p.id]; const oAft = oBef + qty; stokOutlet[o.id][p.id] = oAft;
        db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,created_by,created_at) VALUES (?,?,?,?,?,?,?,1,?)')
          .run(p.id, o.id, 'transfer_in', qty, oBef, oAft, kode, waktu);
        db.prepare('INSERT INTO stock_transfer_items (transfer_id,product_id,quantity) VALUES (?,?,?)')
          .run(tr.lastInsertRowid, p.id, qty);
      });
    });
  }

  /* ================= 3) DOMPET — SALDO AWAL ================= */
  const walletBalance = {};
  const wallets = db.prepare('SELECT id,name,type,branch_id FROM wallets').all();
  wallets.forEach((w) => { walletBalance[w.id] = 0; });
  const walletCash = {};
  outlets.forEach((o) => {
    const w = wallets.find((x) => x.branch_id === o.id && x.type === 'petty_cash')
      || wallets.find((x) => x.type === 'petty_cash');
    walletCash[o.id] = w ? w.id : null;
  });
  const walletBank = (wallets.find((w) => w.type === 'bank') || {}).id || null;
  const walletEwallet = (wallets.find((w) => w.type === 'ewallet') || {}).id || null;

  const saldoAwal = [];
  const kasSudah = {};
  outlets.forEach((o) => {
    const wid = walletCash[o.id];
    if (wid && !kasSudah[wid]) { kasSudah[wid] = 1; saldoAwal.push([wid, 2000000, 'Saldo awal kas kecil ' + o.name]); }
  });
  if (walletBank) saldoAwal.push([walletBank, 25000000, 'Saldo awal rekening operasional']);
  if (walletEwallet) saldoAwal.push([walletEwallet, 1500000, 'Saldo awal e-wallet / QRIS']);
  const tglAwal = ts(dayOf(DAYS), 7, 0);
  saldoAwal.forEach((row) => {
    const wid = row[0]; const amount = row[1]; const note = row[2];
    const before = walletBalance[wid]; const after = before + amount; walletBalance[wid] = after;
    db.prepare('INSERT INTO wallet_transactions (wallet_id,type,amount,balance_before,balance_after,description,created_by,created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(wid, 'topup', amount, before, after, note, tglAwal);
  });

  /* ================= 4) PENJUALAN HARIAN + SHIFT KASIR ================= */
  const pmRows = db.prepare('SELECT code,gives_change FROM payment_methods WHERE is_active=1').all();
  const pmCodes = pmRows.map((p) => p.code);
  const paymentMix = [];
  if (pmCodes.indexOf('cash') >= 0) paymentMix.push(['cash', 45]);
  if (pmCodes.indexOf('qris') >= 0) paymentMix.push(['qris', 33]);
  if (pmCodes.indexOf('transfer') >= 0) paymentMix.push(['transfer', 12]);
  if (pmCodes.indexOf('debit') >= 0) paymentMix.push(['debit', 10]);
  if (!paymentMix.length) paymentMix.push([pmCodes[0] || 'cash', 1]);

  const chCodes = db.prepare('SELECT code FROM channels WHERE is_active=1').all().map((c) => c.code);
  const channelMix = [];
  const chWant = [['langsung', 42], ['takeaway', 16], ['gofood', 16], ['grabfood', 12], ['shopeefood', 9], ['whatsapp', 5]];
  chWant.forEach((c) => { if (chCodes.indexOf(c[0]) >= 0) channelMix.push(c); });
  if (!channelMix.length) channelMix.push(['langsung', 1]);

  // Jam operasional 15:00–21:00, puncaknya 18:00–20:00
  const jamMix = [[15, 5], [16, 9], [17, 14], [18, 19], [19, 20], [20, 15], [21, 8]];

  // Jam & menit sekarang menurut WIB — batas atas untuk transaksi hari ini
  const _wibNow = new Date(Date.now() + (7 * 60 + new Date().getTimezoneOffset()) * 60000);
  const jamSekarang = _wibNow.getHours();
  const menitSekarang = _wibNow.getMinutes();

  const invSeqByDayBranch = {};
  let totalSales = 0;
  const salesHariIni = [];

  for (let d = DAYS; d >= 0; d--) {
    const tanggal = dayOf(d);
    const tglStr = ymd(tanggal);

    outlets.forEach((o) => {
      const kasirId = pick(usersByBranch[o.id]);

      // --- Buka kasir ---
      const modalAwal = 300000;
      const sesiKode = 'SH' + pad(o.id, 2) + tglStr.replace(/-/g, '') + pad(1, 3);
      const sesi = db.prepare("INSERT INTO cash_sessions (session_code,branch_id,user_id,opening_balance,opening_notes,opened_at,status) VALUES (?,?,?,?,?,?,'open')")
        .run(sesiKode, o.id, kasirId, modalAwal, 'Modal laci awal shift', ts(tanggal, 14, rand(30, 55)));
      const sesiId = sesi.lastInsertRowid;

      const trxHariIni = isWeekend(tanggal) ? rand(52, 78) : rand(30, 46);
      let tunaiMasuk = 0; let kembalianKeluar = 0;

      for (let t = 0; t < trxHariIni; t++) {
        const baris = [];
        const jumlahBaris = weighted([[1, 45], [2, 35], [3, 20]]);
        for (let i = 0; i < jumlahBaris; i++) {
          // Sesekali pelanggan pesan Mix (racik beberapa rasa dalam 1 porsi)
          if (mixProduct && mixComponents.length >= 2 && Math.random() < 0.12) {
            const size = mixProduct.mix_size || 4;
            const a = pick(mixComponents);
            let b = pick(mixComponents);
            let guard = 0;
            while (b.id === a.id && guard++ < 5) b = pick(mixComponents);
            const pcsA = Math.ceil(size / 2);
            const pcsB = size - pcsA;
            const komponen = [{ p: a, pcs: pcsA }];
            if (pcsB > 0 && b.id !== a.id) komponen.push({ p: b, pcs: pcsB });
            else komponen[0].pcs = size;
            const cukup = komponen.every((k) => stokOutlet[o.id][k.p.id] >= k.pcs);
            if (!cukup) continue;
            komponen.forEach((k) => { stokOutlet[o.id][k.p.id] -= k.pcs; });
            baris.push({ produk: mixProduct, qty: 1, komponen: komponen });
            continue;
          }
          const produk = weighted(menuWeighted);
          const qty = weighted([[1, 70], [2, 25], [3, 5]]);
          const butuh = Math.max(1, produk.pcs_per_porsi || 1) * qty;
          if (stokOutlet[o.id][produk.id] < butuh) continue;
          stokOutlet[o.id][produk.id] -= butuh;
          const sudahAda = baris.find((b) => b.produk.id === produk.id && !b.komponen);
          if (sudahAda) sudahAda.qty += qty; else baris.push({ produk: produk, qty: qty });
        }
        // Add-on hanya pelengkap — porsinya kecil supaya tidak menyalip menu utama
        if (addons.length && Math.random() < 0.10) baris.push({ produk: pick(addons), qty: 1 });
        if (!baris.length) continue;

        let subtotal = 0;
        baris.forEach((b) => { subtotal += b.produk.sell_price * b.qty; });
        const total = subtotal;
        const payment = weighted(paymentMix);
        const channel = weighted(channelMix);
        const pmRow = pmRows.find((p) => p.code === payment) || {};
        // Pelanggan tunai biasanya menyodorkan pecahan bulat di atas total
        const bayar = pmRow.gives_change ? Math.ceil(total / 5000) * 5000 + (Math.random() < 0.3 ? 5000 : 0) : total;
        const kembali = bayar - total;
        const customerId = Math.random() < 0.28 ? pick(custIds) : null;

        // Hari ini belum selesai — transaksi tidak boleh bertanggal di masa depan.
        const jamTersedia = d === 0 ? jamMix.filter((j) => j[0] <= jamSekarang) : jamMix;
        if (!jamTersedia.length) continue;
        const jam = weighted(jamTersedia);
        const menitMaks = (d === 0 && jam === jamSekarang) ? menitSekarang : 59;
        const waktu = ts(tanggal, jam, rand(0, Math.max(0, menitMaks)), rand(0, 59));

        const key = o.id + '-' + tglStr;
        invSeqByDayBranch[key] = (invSeqByDayBranch[key] || 0) + 1;
        const invNumber = 'UK' + pad(o.id, 2) + tglStr.replace(/-/g, '') + pad(invSeqByDayBranch[key], 4);

        const saleId = db.prepare("INSERT INTO sales (invoice_number,branch_id,channel,customer_id,cashier_id,subtotal,discount_amount,tax_percent,tax_amount,total,net_revenue,payment_method,payment_amount,change_amount,status,session_id,created_at) VALUES (?,?,?,?,?,?,0,0,0,?,?,?,?,?,'completed',?,?)")
          .run(invNumber, o.id, channel, customerId, kasirId, subtotal, total, total, payment, bayar, kembali, sesiId, waktu)
          .lastInsertRowid;
        totalSales++;
        if (d === 0) salesHariIni.push({ saleId: saleId, invNumber: invNumber, branchId: o.id, channel: channel, kasirId: kasirId, waktu: waktu, baris: baris });

        baris.forEach((b) => {
          const stotal = b.produk.sell_price * b.qty;
          const si = db.prepare('INSERT INTO sale_items (sale_id,product_id,product_name,product_code,quantity,sell_price,buy_price,discount_percent,subtotal,is_mochi,pcs_per_porsi) VALUES (?,?,?,?,?,?,0,0,?,0,?)')
            .run(saleId, b.produk.id, b.produk.name, b.produk.code, b.qty, b.produk.sell_price, stotal, b.produk.pcs_per_porsi || 1);
          b.saleItemId = si.lastInsertRowid;

          if (b.komponen) {
            b.komponen.forEach((k) => {
              db.prepare('INSERT INTO sale_item_components (sale_item_id,sale_id,component_product_id,component_name,pcs) VALUES (?,?,?,?,?)')
                .run(b.saleItemId, saleId, k.p.id, k.p.name, k.pcs);
              const keluar = k.pcs * b.qty;
              const before = stokOutlet[o.id][k.p.id] + keluar;
              db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,sale_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .run(k.p.id, o.id, 'terjual', -keluar, before, before - keluar, invNumber + ' (mix)', saleId, kasirId, waktu);
            });
          } else if (b.produk.track_stock) {
            const keluar = Math.max(1, b.produk.pcs_per_porsi || 1) * b.qty;
            const before = stokOutlet[o.id][b.produk.id] + keluar;
            db.prepare('INSERT INTO product_stock_log (product_id,branch_id,type,quantity_change,quantity_before,quantity_after,notes,sale_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
              .run(b.produk.id, o.id, 'terjual', -keluar, before, before - keluar, invNumber, saleId, kasirId, waktu);
          }
        });

        // --- Uang masuk ke dompet sesuai metode bayar ---
        let wid = null;
        if (payment === 'cash') { wid = walletCash[o.id]; tunaiMasuk += total; kembalianKeluar += kembali; }
        else if (payment === 'transfer' || payment === 'debit') wid = walletBank;
        else if (payment === 'qris') wid = walletEwallet;
        if (wid) {
          const before = walletBalance[wid]; const after = before + total; walletBalance[wid] = after;
          db.prepare("INSERT INTO wallet_transactions (wallet_id,type,amount,balance_before,balance_after,description,reference,created_by,created_at) VALUES (?,'topup',?,?,?,?,?,?,?)")
            .run(wid, total, before, after, 'Penjualan ' + invNumber, invNumber, kasirId, waktu);
        }
      }

      // --- Tutup kasir. Shift hari ini sengaja dibiarkan terbuka. ---
      if (d > 0) {
        const seharusnya = modalAwal + tunaiMasuk - kembalianKeluar;
        // Selisih kecil sesekali — wajar untuk hitungan uang fisik
        const selisih = Math.random() < 0.25 ? pick([-5000, -2000, 1000, 2000, 5000]) : 0;
        db.prepare("UPDATE cash_sessions SET status='closed', closed_at=?, closed_by=?, counted_cash=?, expected_cash=?, difference=?, closing_notes=? WHERE id=?")
          .run(ts(tanggal, 22, rand(5, 40)), kasirId, seharusnya + selisih, seharusnya, selisih,
            selisih === 0 ? 'Cocok' : (selisih > 0 ? 'Lebih sedikit, kemungkinan pembulatan kembalian' : 'Kurang sedikit'), sesiId);
      }
    });
  }

  // --- Simpan stok akhir dapur pusat & tiap cabang ---
  stokItems.forEach((p) => {
    db.prepare('INSERT OR IGNORE INTO product_stock (product_id,branch_id,current_stock,min_stock) VALUES (?,?,0,10)').run(p.id, PROD_ID);
    db.prepare('UPDATE product_stock SET current_stock=?,min_stock=10 WHERE product_id=? AND branch_id=?').run(stokPusat[p.id], p.id, PROD_ID);
    outlets.forEach((o) => {
      db.prepare('INSERT OR IGNORE INTO product_stock (product_id,branch_id,current_stock,min_stock) VALUES (?,?,0,10)').run(p.id, o.id);
      db.prepare('UPDATE product_stock SET current_stock=?,min_stock=10 WHERE product_id=? AND branch_id=?').run(stokOutlet[o.id][p.id], p.id, o.id);
    });
  });

  /* ================= 5) ANTRIAN DAPUR HARI INI ================= */
  let tiketDibuat = 0;
  salesHariIni.forEach((s, idx) => {
    const rows = [];
    s.baris.forEach((b) => {
      if (b.komponen) {
        b.komponen.forEach((k) => rows.push({ pid: k.p.id, nama: k.p.name, induk: b.produk.name, qty: k.pcs * b.qty, unit: 'pcs' }));
      } else if (b.produk.needs_cooking !== 0) {
        const ppp = Math.max(1, b.produk.pcs_per_porsi || 1);
        rows.push({ pid: b.produk.id, nama: b.produk.name, induk: null, qty: ppp * b.qty, unit: ppp > 1 ? 'pcs' : (b.produk.unit || 'porsi') });
      }
    });
    if (!rows.length) return;
    // Pesanan lama sudah matang; sebagian pesanan terakhir dibiarkan masih antri
    const masihAntri = idx >= salesHariIni.length - 8;
    const status = masihAntri ? (Math.random() < 0.35 ? 'cooking' : 'pending') : 'done';
    const t = db.prepare('INSERT INTO kitchen_tickets (sale_id,invoice_number,branch_id,channel,cashier_id,status,created_at,started_at,done_at,done_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(s.saleId, s.invNumber, s.branchId, s.channel, s.kasirId, status, s.waktu,
        status === 'pending' ? null : s.waktu, status === 'done' ? s.waktu : null, status === 'done' ? s.kasirId : null);
    rows.forEach((r) => {
      const itemStatus = status === 'done' ? 'done' : (status === 'cooking' && Math.random() < 0.5 ? 'cooking' : 'pending');
      db.prepare('INSERT INTO kitchen_ticket_items (ticket_id,sale_item_id,product_id,product_name,parent_name,qty,unit,status,started_at,done_at,done_by) VALUES (?,NULL,?,?,?,?,?,?,?,?,?)')
        .run(t.lastInsertRowid, r.pid, r.nama, r.induk, r.qty, r.unit, itemStatus,
          itemStatus === 'pending' ? null : s.waktu, itemStatus === 'done' ? s.waktu : null, itemStatus === 'done' ? s.kasirId : null);
    });
    tiketDibuat++;
  });

  /* ================= 6) BEBAN OPERASIONAL ================= */
  const kat = {};
  db.prepare('SELECT id,name FROM expense_categories').all().forEach((c) => { kat[c.name] = c.id; });
  const kasKecilPusat = walletCash[outlets[0].id] || null;

  const sewaPerOutlet = [3500000, 3000000, 2800000];
  const bebanBulanan = [];
  outlets.forEach((o, i) => {
    bebanBulanan.push(['Sewa Tempat', 'Sewa booth ' + o.name, sewaPerOutlet[i % sewaPerOutlet.length], o.id]);
    bebanBulanan.push(['Listrik & Air', 'Listrik & air ' + o.name, rand(1100000, 1500000), o.id]);
    bebanBulanan.push(['Gaji Karyawan', 'Gaji kasir & juru masak ' + o.name, rand(4800000, 6200000), o.id]);
  });

  // Tim dapur pusat juga digaji — tanpa ini biaya tenaga kerja terlihat terlalu ringan
  if (kat['Gaji Karyawan']) bebanBulanan.push(['Gaji Karyawan', 'Gaji tim produksi dapur pusat', rand(9500000, 12500000), null]);

  const bulanTercakup = {};
  for (let d = DAYS; d >= 0; d--) { const t = dayOf(d); bulanTercakup[t.getFullYear() + '-' + pad(t.getMonth() + 1, 2)] = 1; }
  Object.keys(bulanTercakup).forEach((bulan) => {
    const tglBayar = bulan + '-03';
    if (tglBayar > ymd(today) || tglBayar < ymd(dayOf(DAYS))) return;
    bebanBulanan.forEach((row) => {
      if (!kat[row[0]]) return;
      db.prepare("INSERT INTO expenses (category_id,branch_id,description,amount,expense_date,payment_method,notes,created_by,wallet_id,created_at) VALUES (?,?,?,?,?,'transfer','Beban rutin bulanan',1,?,?)")
        .run(kat[row[0]], row[3], row[1], row[2], tglBayar, walletBank, tglBayar + ' 09:00:00');
    });
  });

  // Beban harian: bahan baku & kemasan (masuk HPP) + operasional kecil
  for (let d = DAYS; d >= 0; d--) {
    const tanggal = dayOf(d);
    const tglStr = ymd(tanggal);
    if (d % 2 === 0 && kat['Bahan Baku']) {
      db.prepare("INSERT INTO expenses (category_id,branch_id,description,amount,expense_date,payment_method,notes,created_by,wallet_id,created_at) VALUES (?,?,?,?,?,'cash','Belanja bahan untuk produksi',1,?,?)")
        .run(kat['Bahan Baku'], null, 'Belanja udang, keju, tepung & minyak', rand(2800000, 3600000), tglStr, kasKecilPusat, ts(tanggal, 6, 0));
    }
    if (d % 4 === 0 && kat['Kemasan']) {
      db.prepare("INSERT INTO expenses (category_id,branch_id,description,amount,expense_date,payment_method,notes,created_by,wallet_id,created_at) VALUES (?,?,?,?,?,'cash','Stok kemasan',1,?,?)")
        .run(kat['Kemasan'], null, 'Dus, mika, kantong & sendok', rand(700000, 1100000), tglStr, kasKecilPusat, ts(tanggal, 7, 0));
    }
    if (d % 5 === 0 && kat['Transportasi']) {
      db.prepare("INSERT INTO expenses (category_id,branch_id,description,amount,expense_date,payment_method,notes,created_by,wallet_id,created_at) VALUES (?,?,?,?,?,'cash','Antar stok ke cabang',1,?,?)")
        .run(kat['Transportasi'], null, 'Bensin & parkir pengiriman stok', rand(200000, 350000), tglStr, kasKecilPusat, ts(tanggal, 10, 0));
    }
    if (d % 6 === 0 && kat['Lain-lain']) {
      db.prepare("INSERT INTO expenses (category_id,branch_id,description,amount,expense_date,payment_method,notes,created_by,wallet_id,created_at) VALUES (?,?,?,?,?,'cash','Operasional harian',1,?,?)")
        .run(kat['Lain-lain'], pick(outlets).id, pick(['Gas LPG & perlengkapan goreng', 'Servis kompor & alat', 'Sabun, tisu & kebersihan', 'Air galon & es batu']), rand(180000, 420000), tglStr, kasKecilPusat, ts(tanggal, 9, 0));
    }
    if (d % 7 === 0 && kat['Pemasaran']) {
      db.prepare("INSERT INTO expenses (category_id,branch_id,description,amount,expense_date,payment_method,notes,created_by,wallet_id,created_at) VALUES (?,?,?,?,?,'transfer','Promo mingguan',1,?,?)")
        .run(kat['Pemasaran'], pick(outlets).id, 'Iklan Instagram & promo ongkir', rand(400000, 700000), tglStr, walletBank, ts(tanggal, 11, 0));
    }
  }

  // Beban yang dibayar dari dompet ikut mengurangi saldo dompet
  db.prepare('SELECT wallet_id, SUM(amount) total FROM expenses WHERE wallet_id IS NOT NULL GROUP BY wallet_id').all()
    .forEach((r) => {
      if (walletBalance[r.wallet_id] === undefined) return;
      const before = walletBalance[r.wallet_id];
      const after = before - r.total;
      walletBalance[r.wallet_id] = after;
      db.prepare("INSERT INTO wallet_transactions (wallet_id,type,amount,balance_before,balance_after,description,created_by,created_at) VALUES (?,'withdraw',?,?,?,?,1,?)")
        .run(r.wallet_id, r.total, before, after, 'Pembayaran beban operasional 30 hari', ts(today, 8, 0));
    });
  Object.keys(walletBalance).forEach((wid) =>
    db.prepare('UPDATE wallets SET current_balance=? WHERE id=?').run(walletBalance[wid], parseInt(wid, 10)));

  const totalOmzet = db.prepare("SELECT COALESCE(SUM(total),0) t FROM sales WHERE status='completed'").get().t;
  console.log('Data contoh siap: ' + totalSales + ' transaksi (Rp ' + Math.round(totalOmzet).toLocaleString('id-ID') + '), ' + tiketDibuat + ' tiket dapur, ' + outlets.length + ' cabang.');
}

// ============================================================
// MENU UJANG KEDU v2 — rasa = item stok (pcs), + produk Mix (komposisi di kasir)
// Idempoten: hanya jalan sekali (ditandai settings menu_v2_applied), tidak menghapus riwayat.
// ============================================================
function applyMenuV2(db) {
  const flag = db.prepare("SELECT value FROM settings WHERE key='menu_v2_applied'").get();
  if (flag && flag.value === '1') return;

  const getCat = (name, desc) => {
    let c = db.prepare('SELECT id FROM categories WHERE name=?').get(name);
    if (!c) { const r = db.prepare('INSERT INTO categories (name,description) VALUES (?,?)').run(name, desc||''); return r.lastInsertRowid; }
    return c.id;
  };
  const catReguler = getCat('Reguler Menu', 'Udang 4 pcs per porsi');
  const catSpecial = getCat('Special Menu', 'Menu spesial Ujang Kedu');
  const catAddon   = getCat('Tambahan', 'Add-on & pelengkap');

  const branches = db.prepare('SELECT id FROM branches').all();

  // Buat / perbarui produk berdasarkan code. Return id.
  const upsertProduct = (code, f) => {
    const ex = db.prepare('SELECT id FROM products WHERE code=?').get(code);
    if (ex) {
      db.prepare(`UPDATE products SET name=?, category_id=?, sell_price=?, track_stock=?, is_mix=?, mix_size=?, unit=?, description=?, is_active=1, show_in_pos=1 WHERE id=?`)
        .run(f.name, f.category_id, f.sell_price, f.track_stock?1:0, f.is_mix?1:0, f.mix_size||0, f.unit||'pcs', f.description||null, ex.id);
      return ex.id;
    }
    const r = db.prepare(`INSERT INTO products (code,name,category_id,buy_price,sell_price,is_mochi,track_stock,is_mix,mix_size,unit,description,show_in_pos) VALUES (?,?,?,0,?,0,?,?,?,?,?,1)`)
      .run(code, f.name, f.category_id, f.sell_price, f.track_stock?1:0, f.is_mix?1:0, f.mix_size||0, f.unit||'pcs', f.description||null);
    return r.lastInsertRowid;
  };
  const ensureStockRows = (productId) => {
    branches.forEach(b => db.prepare('INSERT OR IGNORE INTO product_stock (product_id,branch_id,current_stock,min_stock) VALUES (?,?,0,10)').run(productId, b.id));
  };
  const setSelfLink = (productId, pcs) => {
    // Simpan sebagai kolom pcs_per_porsi (sumber kebenaran), bukan self-link
    db.prepare('DELETE FROM product_stock_link WHERE product_id=? AND stock_item_id=?').run(productId, productId);
    db.prepare('UPDATE products SET pcs_per_porsi=? WHERE id=?').run(pcs, productId);
  };

  // 1) RASA (item stok, pcs). Dijual satuan = 1 porsi (isi ditentukan self-link).
  //    code, nama, harga, pcs/porsi, deskripsi
  const flavors = [
    ['RASA-ORI',  'Udang Keju Original',  15000, 4, 'Udang keju pada umumnya'],
    ['RASA-NASH', 'Udang Keju Nashville', 15000, 4, 'Udang keju + chili oil (lumayan pedas)'],
    ['RASA-RMB',  'Udang Rambutan',       15000, 4, 'Adonan udang, coating kulit pangsit'],
    ['RASA-CB',   'Cheesy Bomb',          15000, 4, 'Udang keju dengan bubble crumb'],
    ['RASA-LL',   'Lumpia Lumer',         15000, 4, 'Udang keju dengan kulit lumpia'],
  ];
  const flavorIds = {};
  flavors.forEach(([code,name,price,pcs,desc]) => {
    const id = upsertProduct(code, { name, category_id: catReguler, sell_price: price, track_stock: 1, unit: 'pcs', description: desc });
    ensureStockRows(id);
    setSelfLink(id, pcs);
    flavorIds[code] = id;
  });

  // 2) SPECIAL (item stok, pcs)
  const specials = [
    ['SPC-MENTAI', 'Udang Keju Mentai',   27000, 6, 'Udang keju topping saus mentai (6 pcs)'],
    ['SPC-LLM',    'Lumpia Lumer Mentai', 27000, 6, 'Lumpia lumer topping saus mentai (6 pcs)'],
    ['SPC-BRUTAL', 'Udang Keju Brutaalll',35000, 1, 'Udang keju jumbo 25 cm'],
  ];
  specials.forEach(([code,name,price,pcs,desc]) => {
    const id = upsertProduct(code, { name, category_id: catSpecial, sell_price: price, track_stock: 1, unit: 'pcs', description: desc });
    ensureStockRows(id);
    setSelfLink(id, pcs);
  });

  // 3) MIX — dikomposisi di kasir (4 pcs). Komponen = 5 rasa reguler.
  const mixId = upsertProduct('MIX-4', { name: 'Mix Udang (4 pcs)', category_id: catReguler, sell_price: 15000, track_stock: 0, is_mix: 1, mix_size: 4, unit: 'porsi', description: 'Pilih campuran 4 pcs dari rasa reguler' });
  // Komponen mix = stock-link ke tiap rasa (quantity = default pcs saran). Default: Original 4, lainnya 0.
  db.prepare('DELETE FROM product_stock_link WHERE product_id=?').run(mixId);
  const mixDefaults = { 'RASA-ORI': 4, 'RASA-NASH': 0, 'RASA-RMB': 0, 'RASA-CB': 0, 'RASA-LL': 0 };
  Object.entries(mixDefaults).forEach(([code, dq]) => {
    db.prepare('INSERT OR IGNORE INTO product_stock_link (product_id,stock_item_id,quantity) VALUES (?,?,?)').run(mixId, flavorIds[code], dq);
  });

  // 4) Add-on tanpa stok
  upsertProduct('ADDON-NASH', { name: 'Nashville Oil (Add-on)', category_id: catAddon, sell_price: 2000, track_stock: 0, unit: 'porsi', description: 'Tambahan chili oil Nashville' });

  // 5) Sembunyikan menu demo lama (UK001-…) tanpa menghapus riwayat penjualannya
  db.prepare("UPDATE products SET is_active=0, show_in_pos=0 WHERE code LIKE 'UK%'").run();

  db.prepare("INSERT INTO settings (key,value) VALUES ('menu_v2_applied','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  console.log('✅ Menu Ujang Kedu v2 diterapkan (rasa pcs + Mix). Menu demo lama disembunyikan.');
}

// Konversi self-link (product_id == stock_item_id) menjadi kolom pcs_per_porsi, lalu hapus self-link.
// Idempoten via flag 'pcs_selflink_migrated'. Ini menyatukan cara set "isi per porsi".
function migrateSelfLinksToPcs(db) {
  const f = db.prepare("SELECT value FROM settings WHERE key='pcs_selflink_migrated'").get();
  if (f && f.value === '1') return;
  const selfLinks = db.prepare('SELECT product_id, quantity FROM product_stock_link WHERE product_id = stock_item_id').all();
  selfLinks.forEach(l => {
    db.prepare('UPDATE products SET pcs_per_porsi=? WHERE id=?').run(Math.max(1, parseInt(l.quantity) || 1), l.product_id);
  });
  db.prepare('DELETE FROM product_stock_link WHERE product_id = stock_item_id').run();
  db.prepare("INSERT INTO settings (key,value) VALUES ('pcs_selflink_migrated','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  if (selfLinks.length) console.log(`✅ ${selfLinks.length} produk: self-link dikonversi ke kolom "isi per porsi (pcs)".`);
}


// ============================================================
// CABANG UJANG KEDU — lokasi sebenarnya
// Idempoten (ditandai settings branches_ujangkedu_v3). Dapur Produksi Pusat
// tidak melayani penjualan (is_outlet=0) — dia menggoreng lalu mengirim stok
// ke ketiga cabang. Nomor id dipatok agar riwayat lama tetap menempel ke
// cabang yang sama.
// ============================================================
function applyBranchesV3(db, bcrypt) {
  const flag = db.prepare("SELECT value FROM settings WHERE key='branches_ujangkedu_v3'").get();
  if (flag && flag.value === '1') return;

  const want = [
    { id: 1, name: 'Dapur Produksi Pusat', address: null, pc: 1, outlet: 0 },
    { id: 2, name: 'Cabang Pahlawan', address: 'Jl. Pahlawan (depan Gedung Pramuka)', pc: 0, outlet: 1 },
    { id: 3, name: 'Cabang Suratmo', address: 'Jl. Suratmo (seberang The Arena Mini Soccer)', pc: 0, outlet: 1 },
    { id: 4, name: 'Cabang Tembalang', address: 'Depan WM Makmur Gondang', pc: 0, outlet: 1 },
  ];
  want.forEach((w) => {
    const ex = db.prepare('SELECT id FROM branches WHERE id=?').get(w.id);
    if (ex) {
      db.prepare('UPDATE branches SET name=?,address=?,phone=NULL,is_production_center=?,is_outlet=?,is_active=1 WHERE id=?')
        .run(w.name, w.address, w.pc, w.outlet, w.id);
    } else {
      db.prepare('INSERT INTO branches (id,name,address,phone,is_production_center,is_outlet,is_active) VALUES (?,?,?,NULL,?,?,1)')
        .run(w.id, w.name, w.address, w.pc, w.outlet);
    }
  });
  // Cabang lain di luar keempat itu (kalau ada) dinonaktifkan, bukan dihapus,
  // supaya riwayat transaksinya tidak putus.
  db.prepare('UPDATE branches SET is_active=0 WHERE id NOT IN (1,2,3,4)').run();

  // Baris stok untuk tiap produk berstok di tiap cabang
  const tracked = db.prepare('SELECT id FROM products WHERE track_stock=1').all();
  want.forEach((w) => tracked.forEach((p) => {
    db.prepare('INSERT OR IGNORE INTO product_stock (product_id,branch_id,current_stock,min_stock) VALUES (?,?,0,10)').run(p.id, w.id);
  }));

  // Dompet kas kecil per cabang penjualan
  const kasCat = db.prepare("SELECT id,kind FROM wallet_categories WHERE name='Kas Kecil'").get();
  want.filter((w) => w.outlet).forEach((w) => {
    const ada = db.prepare("SELECT id FROM wallets WHERE branch_id=? AND type='petty_cash'").get(w.id);
    if (!ada) {
      db.prepare('INSERT INTO wallets (name,type,branch_id,current_balance,notes,category_id,kind) VALUES (?,?,?,0,?,?,?)')
        .run('Kas Kecil ' + w.name, 'petty_cash', w.id, 'Kas operasional ' + w.name,
          kasCat ? kasCat.id : null, kasCat ? kasCat.kind : 'asset');
    } else {
      db.prepare('UPDATE wallets SET name=? WHERE id=?').run('Kas Kecil ' + w.name, ada.id);
    }
  });
  // Dompet kas kecil milik cabang yang sudah tidak aktif ikut dinonaktifkan
  db.prepare('UPDATE wallets SET is_active=0 WHERE branch_id IS NOT NULL AND branch_id NOT IN (1,2,3,4)').run();

  // --- Akun contoh per cabang (idempoten berdasarkan username) ---
  const roleId = (code) => {
    const r = db.prepare('SELECT id FROM roles WHERE code=?').get(code);
    return r ? r.id : null;
  };
  const akun = [
    ['kasir1', 'Kasir Pahlawan', 'cashier', 'kasir123', [2]],
    ['kasir2', 'Kasir Suratmo', 'cashier', 'kasir123', [3]],
    ['kasir3', 'Kasir Tembalang', 'cashier', 'kasir123', [4]],
    ['dapur1', 'Koki Pahlawan', 'kitchen', 'dapur123', [2]],
    ['dapur2', 'Koki Suratmo', 'kitchen', 'dapur123', [3]],
    ['dapur3', 'Koki Tembalang', 'kitchen', 'dapur123', [4]],
    // Contoh user yang memegang lebih dari satu cabang
    ['spv1', 'Supervisor Area', 'supervisor', 'spv123', [2, 3, 4]],
  ];
  akun.forEach((a) => {
    const username = a[0]; const nama = a[1]; const kode = a[2]; const pw = a[3]; const cabang = a[4];
    const rid = roleId(kode);
    let u = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (!u) {
      const r = db.prepare('INSERT INTO users (username,password,full_name,role,role_id,branch_id,is_active) VALUES (?,?,?,?,?,?,1)')
        .run(username, bcrypt.hashSync(pw, 10), nama, kode, rid, cabang[0]);
      u = { id: r.lastInsertRowid };
    } else {
      db.prepare('UPDATE users SET full_name=?,role=?,role_id=?,branch_id=?,is_active=1 WHERE id=?')
        .run(nama, kode, rid, cabang[0], u.id);
    }
    db.prepare('DELETE FROM user_branches WHERE user_id=?').run(u.id);
    cabang.forEach((bid) => db.prepare('INSERT OR IGNORE INTO user_branches (user_id,branch_id) VALUES (?,?)').run(u.id, bid));
  });

  db.prepare("INSERT INTO settings (key,value) VALUES ('branches_ujangkedu_v3','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  console.log('Cabang Ujang Kedu diterapkan: Dapur Pusat + Pahlawan, Suratmo, Tembalang.');
}


// ============================================================
// AKUN OPERASIONAL — kasir, koki, tim produksi, tim runner
// Idempoten (ditandai settings akun_ujangkedu_v4). Password bawaan hanya untuk
// pemasangan pertama; sistem memaksa gantinya lewat peringatan di layar login
// selama masih memakai password bawaan.
// ============================================================
function applyAkunV4(db, bcrypt) {
  // Role Runner: hanya untuk mengantar stok antar cabang. Sengaja tidak diberi
  // akses kasir maupun keuangan — tugasnya memindahkan barang, bukan menjual.
  const runnerPerms = JSON.stringify([
    'stock.view', 'stock.transfer', 'products.view', 'branches.view',
  ]);
  const r = db.prepare("SELECT id FROM roles WHERE code='runner'").get();
  if (!r) {
    db.prepare('INSERT INTO roles (code,name,description,is_system,permissions) VALUES (?,?,?,0,?)')
      .run('runner', 'Tim Runner', 'Mengantar & mencatat transfer stok antar cabang', runnerPerms);
  }

  const flag = db.prepare("SELECT value FROM settings WHERE key='akun_ujangkedu_v4'").get();
  if (flag && flag.value === '1') return;

  const roleId = (code) => {
    const row = db.prepare('SELECT id FROM roles WHERE code=?').get(code);
    return row ? row.id : null;
  };
  const semuaCabang = db.prepare('SELECT id FROM branches WHERE is_active=1 ORDER BY id').all().map((b) => b.id);
  const outlet = db.prepare('SELECT id FROM branches WHERE is_active=1 AND COALESCE(is_outlet,1)=1 ORDER BY id').all().map((b) => b.id);
  const pusat = db.prepare('SELECT id FROM branches WHERE is_production_center=1 ORDER BY id LIMIT 1').get();
  const pusatId = pusat ? pusat.id : (semuaCabang[0] || null);

  const akun = [
    // username, nama, role, password, cabang
    ['produksi1', 'Tim Produksi Dapur', 'production', 'produksi123', [pusatId]],
    ['produksi2', 'Asisten Produksi', 'production', 'produksi123', [pusatId]],
    // Runner berpindah antar cabang, jadi diberi akses ke semuanya
    ['runner1', 'Runner Pengantaran 1', 'runner', 'runner123', semuaCabang],
    ['runner2', 'Runner Pengantaran 2', 'runner', 'runner123', semuaCabang],
  ].filter((a) => a[4].filter(Boolean).length);

  akun.forEach((a) => {
    const username = a[0]; const nama = a[1]; const kode = a[2]; const pw = a[3];
    const cabang = a[4].filter(Boolean);
    const rid = roleId(kode);
    let u = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (!u) {
      const res = db.prepare('INSERT INTO users (username,password,full_name,role,role_id,branch_id,is_active) VALUES (?,?,?,?,?,?,1)')
        .run(username, bcrypt.hashSync(pw, 10), nama, kode, rid, cabang[0]);
      u = { id: res.lastInsertRowid };
    } else {
      db.prepare('UPDATE users SET full_name=?,role=?,role_id=?,branch_id=?,is_active=1 WHERE id=?')
        .run(nama, kode, rid, cabang[0], u.id);
    }
    db.prepare('DELETE FROM user_branches WHERE user_id=?').run(u.id);
    cabang.forEach((bid) => db.prepare('INSERT OR IGNORE INTO user_branches (user_id,branch_id) VALUES (?,?)').run(u.id, bid));
  });

  // Kasir & koki dipastikan lengkap untuk SETIAP cabang penjualan, bukan hanya
  // tiga cabang yang kebetulan ada saat pemasangan pertama.
  outlet.forEach((bid, i) => {
    const nm = db.prepare('SELECT name FROM branches WHERE id=?').get(bid);
    const label = nm ? nm.name.replace(/^Cabang\s+/i, '') : ('Cabang ' + bid);
    [['kasir', 'cashier', 'Kasir', 'kasir123'], ['dapur', 'kitchen', 'Koki', 'dapur123']].forEach((jenis) => {
      const username = jenis[0] + (i + 1);
      const rid = roleId(jenis[1]);
      let u = db.prepare('SELECT id FROM users WHERE username=?').get(username);
      if (!u) {
        const res = db.prepare('INSERT INTO users (username,password,full_name,role,role_id,branch_id,is_active) VALUES (?,?,?,?,?,?,1)')
          .run(username, bcrypt.hashSync(jenis[3], 10), jenis[2] + ' ' + label, jenis[1], rid, bid);
        u = { id: res.lastInsertRowid };
        db.prepare('INSERT OR IGNORE INTO user_branches (user_id,branch_id) VALUES (?,?)').run(u.id, bid);
      }
    });
  });

  db.prepare("INSERT INTO settings (key,value) VALUES ('akun_ujangkedu_v4','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  console.log('Akun operasional siap: kasir & koki tiap cabang, tim produksi, tim runner.');
}

module.exports = { initDatabase, getDb: () => db, seedDummyData, flushNow };
