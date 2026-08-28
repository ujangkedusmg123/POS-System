/**
 * HAK AKSES CABANG
 * ---------------------------------------------------------------------------
 * Satu user bisa dipercaya memegang beberapa cabang. Sumber kebenarannya
 * adalah tabel `user_branches`, BUKAN isi token — token bisa berumur 12 jam,
 * jadi kalau admin mencabut akses cabang hari ini, pencabutan itu harus
 * langsung berlaku tanpa menunggu user login ulang. Karena itu setiap
 * pemeriksaan di sini membaca database.
 *
 * Kolom `users.branch_id` tetap dipakai sebagai "cabang utama" (untuk tampilan
 * dan kompatibilitas kode lama), tetapi tidak pernah menjadi penentu akses.
 */
const { getDb } = require('../database/db');
const db = { prepare: (...a) => getDb().prepare(...a) };

/** Administrator selalu melihat seluruh cabang. */
function isAllBranches(user) {
  return !!user && user.role === 'admin';
}

/**
 * Daftar id cabang yang boleh disentuh user.
 * @returns {number[]|null} null berarti "semua cabang" (admin).
 */
function allowedBranchIds(user) {
  if (!user) return [];
  if (isAllBranches(user)) return null;
  let rows = [];
  try { rows = db.prepare('SELECT branch_id FROM user_branches WHERE user_id=?').all(user.id); } catch (e) { rows = []; }
  const ids = rows.map((r) => r.branch_id).filter((v) => !!v);
  // User lama yang belum punya baris user_branches: pakai cabang utamanya.
  if (!ids.length && user.branch_id) return [user.branch_id];
  return ids;
}

/** Boleh bertransaksi / membuka kasir di cabang ini? */
function canUseBranch(user, branchId) {
  const ids = allowedBranchIds(user);
  if (ids === null) return true;
  return ids.indexOf(parseInt(branchId)) >= 0;
}

/**
 * Potongan SQL penyaring cabang untuk query daftar.
 * Kalau user meminta satu cabang tertentu lewat query, permintaan itu hanya
 * dituruti bila cabangnya memang boleh dia lihat — kalau tidak, disempitkan
 * ke seluruh cabang miliknya (bukan ditolak diam-diam ke semua cabang).
 *
 * @param {object} user      req.user
 * @param {string} col       nama kolom, mis. 's.branch_id'
 * @param {*}      requested req.query.branch_id
 */
function branchScopeSql(user, col, requested) {
  const ids = allowedBranchIds(user);
  const req = requested ? parseInt(requested) : null;
  if (ids === null) {
    return req ? { sql: ' AND ' + col + '=?', params: [req] } : { sql: '', params: [] };
  }
  if (!ids.length) return { sql: ' AND 1=0', params: [] }; // belum diberi cabang -> tidak ada data
  if (req && ids.indexOf(req) >= 0) return { sql: ' AND ' + col + '=?', params: [req] };
  return { sql: ' AND ' + col + ' IN (' + ids.map(() => '?').join(',') + ')', params: ids.slice() };
}

/**
 * Daftar cabang yang boleh dipakai user.
 * @param {object} opts { onlyOutlet: true } -> hanya cabang yang melayani penjualan
 */
function accessibleBranches(user, opts) {
  const onlyOutlet = !!(opts && opts.onlyOutlet);
  const ids = allowedBranchIds(user);
  let q = 'SELECT id,name,address,is_production_center,COALESCE(is_outlet,1) AS is_outlet FROM branches WHERE is_active=1';
  const p = [];
  if (ids !== null) {
    if (!ids.length) return [];
    q += ' AND id IN (' + ids.map(() => '?').join(',') + ')';
    ids.forEach((i) => p.push(i));
  }
  if (onlyOutlet) q += ' AND COALESCE(is_outlet,1)=1';
  q += ' ORDER BY id';
  return db.prepare(q).all(...p);
}

/** Simpan daftar cabang seorang user (dipakai saat admin menyimpan user). */
function setUserBranches(userId, branchIds) {
  const clean = [...new Set((branchIds || []).map((b) => parseInt(b)).filter((b) => b > 0))];
  db.prepare('DELETE FROM user_branches WHERE user_id=?').run(userId);
  clean.forEach((b) => db.prepare('INSERT OR IGNORE INTO user_branches (user_id,branch_id) VALUES (?,?)').run(userId, b));
  return clean;
}

/** Daftar id cabang milik seorang user (dipakai untuk menampilkan di UI). */
function branchIdsOfUser(userId) {
  try {
    return db.prepare('SELECT branch_id FROM user_branches WHERE user_id=? ORDER BY branch_id').all(userId).map((r) => r.branch_id);
  } catch (e) { return []; }
}

module.exports = {
  isAllBranches, allowedBranchIds, canUseBranch, branchScopeSql,
  accessibleBranches, setUserBranches, branchIdsOfUser,
};
