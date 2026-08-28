const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Kunci penandatangan token.
 *
 * Dulu nilainya ditulis langsung di kode. Begitu aplikasi dipasang di
 * hosting, siapa pun yang pernah melihat sumbernya bisa membuat token admin
 * palsu. Sekarang urutannya:
 *   1. process.env.JWT_SECRET  -> cara yang benar untuk produksi
 *   2. berkas rahasia lokal    -> dibuat acak sekali, disimpan agar sesi
 *                                 pengguna tidak putus setiap server restart
 * Berkas rahasia sengaja diletakkan di folder database dan sudah masuk
 * .gitignore, jadi tidak ikut terbawa saat kode disalin.
 */
function resolveSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) return process.env.JWT_SECRET;
  const file = path.join(__dirname, '..', 'database', '.jwt-secret');
  try {
    if (fs.existsSync(file)) {
      const isi = fs.readFileSync(file, 'utf8').trim();
      if (isi.length >= 32) return isi;
    }
    const baru = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, baru, { mode: 0o600 });
    console.warn('\u26a0\ufe0f  JWT_SECRET belum diset. Kunci acak dibuat di database/.jwt-secret.');
    console.warn('   Untuk hosting, set variabel lingkungan JWT_SECRET agar kunci tidak ikut tersalin.');
    return baru;
  } catch (e) {
    console.error('\u274c Gagal menyiapkan JWT secret:', e.message);
    return crypto.randomBytes(48).toString('hex'); // sesi putus tiap restart, tapi tetap aman
  }
}
const SECRET = resolveSecret();
const { permsInclude } = require('../utils/permissions');

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token tidak ditemukan' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) { res.status(401).json({ error: 'Token tidak valid atau kadaluarsa' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Hanya admin yang dapat mengakses' });
  next();
}

/** Ambil daftar permission efektif user dari token. */
function userPermissions(user) {
  if (!user) return [];
  if (user.role === 'admin') return ['*'];
  return Array.isArray(user.permissions) ? user.permissions : [];
}

/** Cek satu permission. */
function can(user, key) {
  return permsInclude(userPermissions(user), key);
}

/**
 * Middleware penjaga permission.
 * Pemakaian: router.post('/', requirePerm('products.create'), handler)
 * Beberapa kunci = cukup punya salah satu.
 */
function requirePerm(...keys) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Belum login' });
    if (keys.some((k) => can(req.user, k))) return next();
    return res.status(403).json({
      error: 'Anda tidak punya hak akses untuk tindakan ini',
      required: keys,
    });
  };
}

module.exports = { authMiddleware, adminOnly, requirePerm, can, userPermissions, SECRET };
