// Zona waktu proses dipaku ke WIB. Server hosting sering memakai UTC; tanpa
// baris ini, `new Date()` di kode dan `datetime('now','+7 hours')` di SQL bisa
// menunjuk hari yang berbeda dan laporan harian jadi meleset.
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase, flushNow } = require('./database/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Di belakang reverse proxy (Nginx / Caddy / Cloudflare), alamat IP asli klien
// ada di header X-Forwarded-For. Tanpa ini, pembatasan percobaan login akan
// melihat semua orang sebagai satu IP yang sama.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.disable('x-powered-by');

// CORS dibatasi ke daftar asal yang diizinkan. Tanpa pembatasan, halaman mana
// pun di internet bisa memanggil API ini memakai token pengguna.
const ASAL_DIIZINKAN = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((x) => x.trim()).filter(Boolean);
app.use(cors(ASAL_DIIZINKAN.length ? {
  origin: (origin, cb) => cb(null, !origin || ASAL_DIIZINKAN.includes(origin)),
  credentials: true,
} : {}));

// Header pengaman dasar (menggantikan helmet supaya tidak menambah dependensi).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

// Tidak ada tag HTML yang boleh tersimpan ke database. Lihat utils/sanitize.js
// untuk alasannya — ini penjaga utama terhadap XSS tersimpan.
const { sanitizeBody } = require('./utils/sanitize');
app.use('/api', sanitizeBody);

/* --------------------------------------------------------------------------
   BATAS PERCOBAAN LOGIN
   Tanpa ini, siapa pun bisa menebak password admin sebanyak-banyaknya. Hitungan
   disimpan di memori: cukup untuk satu proses, dan otomatis bersih saat restart.
   -------------------------------------------------------------------------- */
const percobaan = new Map();
const MAKS_GAGAL = Number(process.env.LOGIN_MAX_ATTEMPTS || 8);
const JEDA_MS = Number(process.env.LOGIN_LOCK_MINUTES || 10) * 60000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of percobaan) if (now - v.sejak > JEDA_MS) percobaan.delete(k);
}, 60000).unref();

app.use('/api/auth/login', (req, res, next) => {
  const kunci = (req.ip || 'x') + '|' + String((req.body && req.body.username) || '').toLowerCase();
  const rec = percobaan.get(kunci);
  if (rec && rec.gagal >= MAKS_GAGAL && Date.now() - rec.sejak < JEDA_MS) {
    const sisa = Math.ceil((JEDA_MS - (Date.now() - rec.sejak)) / 60000);
    return res.status(429).json({ error: `Terlalu banyak percobaan login. Coba lagi dalam ${sisa} menit.` });
  }
  // Catat hasilnya setelah handler login selesai menjawab
  res.on('finish', () => {
    if (res.statusCode === 200) { percobaan.delete(kunci); return; }
    if (res.statusCode !== 401) return;
    const cur = percobaan.get(kunci);
    if (!cur || Date.now() - cur.sejak >= JEDA_MS) percobaan.set(kunci, { gagal: 1, sejak: Date.now() });
    else cur.gagal += 1;
  });
  next();
});
// no-cache: tanpa ini browser bisa terus memakai app.js/CSS versi lama
// setelah aplikasi diperbarui, sehingga bug yang sudah diperbaiki tampak
// "masih ada".
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

initDatabase().then(() => {
  app.use('/api/auth',     require('./routes/auth'));
  app.use('/api/branches', require('./routes/branches'));
  app.use('/api/products', require('./routes/products'));
  app.use('/api/sales',    require('./routes/sales'));
  app.use('/api/stock',    require('./routes/stock'));
  app.use('/api/expenses', require('./routes/expenses'));
  app.use('/api/reports',  require('./routes/reports'));
  app.use('/api/bahan',    require('./routes/bahan'));
  app.use('/api/admin',    require('./routes/admin'));
  app.use('/api/settings',  require('./routes/settings'));
  app.use('/api/customers', require('./routes/customers'));
  app.use('/api/wallets',   require('./routes/wallets'));
  app.use('/api/channels',  require('./routes/channels'));
  app.use('/api/activity',  require('./routes/activity'));
  app.use('/api/production', require('./routes/production'));
  app.use('/api/finance', require('./routes/finance'));
  app.use('/api/roles', require('./routes/roles'));
  app.use('/api/payment-methods', require('./routes/payment-methods'));
  app.use('/api/receipt-templates', require('./routes/receipt-templates'));
  app.use('/api/cashier', require('./routes/cashier').router);
  app.use('/api/kitchen', require('./routes/kitchen').router);
  app.use('/api/export', require('./routes/export'));

  const { nowWib } = require('./utils/waktu');
  app.get('/api/health', (req, res) => res.json({ status:'OK', waktu_wib: nowWib(), zona: 'WIB (UTC+7)' }));
  // Endpoint API tak dikenal -> balas 404 JSON.
  // (Dulu request-nya dibiarkan menggantung sampai timeout.)
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan: ' + req.originalUrl }));

  // Path tak dikenal -> arahkan ke halaman login, JANGAN sajikan dashboard.
  // Dulu URL asal-asalan pun membalas index.html sehingga kerangka sistem
  // sempat terlihat sebelum penjaga login sempat jalan.
  app.get('*', (req, res) => {
    if (req.path === '/' || req.path === '/index.html') {
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    res.redirect('/login.html');
  });

  // Handler error global — supaya payload kelewat besar / JSON rusak
  // membalas pesan yang jelas, bukan HTML error bawaan Express.
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Data terlalu besar. Perkecil ukuran logo (maks ~1MB).' });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Format data tidak valid' });
    }
    console.error('❌', err);
    res.status(500).json({ error: err.message || 'Kesalahan server' });
  });

  // Peringatkan kalau password bawaan masih dipakai — ini hal pertama yang
  // harus diganti sebelum aplikasi dibuka ke internet.
  try {
    const bcrypt = require('bcryptjs');
    const { getDb } = require('./database/db');
    const bawaan = { admin: 'admin123', kasir1: 'kasir123', spv1: 'spv123', runner1: 'runner123', produksi1: 'produksi123' };
    const masihBawaan = Object.entries(bawaan).filter(([u, p]) => {
      const row = getDb().prepare('SELECT password FROM users WHERE username=? AND is_active=1').get(u);
      return row && bcrypt.compareSync(p, row.password);
    }).map(([u]) => u);
    if (masihBawaan.length) {
      console.warn(`\n⚠️  ${masihBawaan.length} akun masih memakai password bawaan: ${masihBawaan.join(', ')}`);
      console.warn('   Ganti lewat Manajemen User sebelum aplikasi dibuka ke internet.\n');
    }
  } catch (e) {}

  /* Simpan database sebelum proses benar-benar berhenti. Tanpa ini, perintah
     restart dari process manager (pm2/systemd) atau deploy ulang bisa memotong
     penulisan yang masih tertunda dan mengembalikan database ke kondisi
     beberapa saat sebelumnya. */
  let sedangTutup = false;
  const tutupRapi = (sinyal) => {
    if (sedangTutup) return;
    sedangTutup = true;
    console.log(`
${sinyal} diterima — menyimpan database...`);
    const ok = flushNow();
    console.log(ok ? 'Database tersimpan. Selesai.' : 'Database GAGAL disimpan.');
    process.exit(ok ? 0 : 1);
  };
  ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach((sig) => {
    try { process.on(sig, () => tutupRapi(sig)); } catch (e) {}
  });
  process.on('uncaughtException', (err) => {
    console.error('Kesalahan tak tertangani:', err);
    flushNow();
    process.exit(1);
  });

  app.listen(PORT, () => {
    console.log(`\n🦐 Ujang Kedu POS — http://localhost:${PORT}`);
    console.log(`\n   Owner    : admin   / admin123   (semua cabang)`);
    console.log(`   Supervisor: spv1   / spv123     (Pahlawan, Suratmo, Tembalang)`);
    console.log(`   Kasir    : kasir1 / kasir123   (Cabang Pahlawan)`);
    console.log(`              kasir2 / kasir123   (Cabang Suratmo)`);
    console.log(`              kasir3 / kasir123   (Cabang Tembalang)`);
    console.log(`   Dapur    : dapur1 / dapur123   (Cabang Pahlawan)`);
    console.log(`              dapur2 / dapur123   (Cabang Suratmo)`);
    console.log(`              dapur3 / dapur123   (Cabang Tembalang)`);
    console.log(`   Produksi : produksi1 / produksi123  (Dapur Produksi Pusat)`);
    console.log(`              produksi2 / produksi123`);
    console.log(`   Runner   : runner1 / runner123      (semua cabang)`);
    console.log(`              runner2 / runner123\n`);
  });
}).catch(e => { console.error('❌ DB Error:', e); process.exit(1); });
