const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly, SECRET } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const { sanitizePermissions } = require('../utils/permissions');
const { setUserBranches, branchIdsOfUser, accessibleBranches } = require('../utils/branch-access');
const db = { prepare: (...a) => getDb().prepare(...a) };

/** Hitung permission efektif seorang user. */
function resolvePermissions(user) {
  if (!user) return [];
  if (user.role === 'admin') return ['*'];
  let row = null;
  if (user.role_id) row = db.prepare('SELECT permissions FROM roles WHERE id=?').get(user.role_id);
  if (!row && user.role) row = db.prepare('SELECT permissions FROM roles WHERE code=?').get(user.role);
  if (!row) return [];
  // Nilai di DB sudah tersaring saat penyimpanan, jadi '*' di sini tepercaya
  // (dipakai oleh role bawaan Administrator). Input dari klien tetap ditolak
  // wildcard-nya di routes/roles.js.
  try { return sanitizePermissions(JSON.parse(row.permissions || '[]'), true); } catch(e) { return []; }
}

// LOGIN
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });
  const user = db.prepare('SELECT u.*, b.name as branch_name FROM users u LEFT JOIN branches b ON u.branch_id=b.id WHERE u.username=? AND u.is_active=1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    logActivity({ user: null, module: 'auth', action: 'login_failed', description: `Percobaan login gagal untuk username: ${username}` });
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  // Hak akses efektif: dari role_id (tabel roles), fallback ke kolom role teks
  const perms = resolvePermissions(user);
  // Daftar cabang ikut dibawa agar UI bisa menampilkan pilihan yang benar.
  // Penegakan aksesnya tetap dibaca ulang dari database di tiap permintaan,
  // supaya pencabutan akses berlaku tanpa menunggu user login ulang.
  const branchIds = user.role === 'admin' ? [] : branchIdsOfUser(user.id);
  const payload = { id:user.id, username:user.username, role:user.role, role_id:user.role_id,
    full_name:user.full_name, branch_id:user.branch_id, branch_name:user.branch_name,
    branch_ids:branchIds, permissions:perms };
  const token = jwt.sign(payload, SECRET, { expiresIn: '12h' });
  logActivity({ user, module: 'auth', action: 'login', description: `${user.full_name} berhasil login (${user.role})` });
  const roleRow = user.role_id ? db.prepare('SELECT name FROM roles WHERE id=?').get(user.role_id) : null;
  res.json({ token, user: { id:user.id, username:user.username, full_name:user.full_name, role:user.role,
    role_id:user.role_id, role_name: roleRow?.name || (user.role==='admin'?'Administrator':'Kasir'),
    branch_id:user.branch_id, branch_name:user.branch_name, branch_ids:branchIds,
    branches: accessibleBranches({ id:user.id, role:user.role, branch_id:user.branch_id }),
    permissions:perms } });
});

// CURRENT USER
router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT u.id,u.username,u.full_name,u.role,u.role_id,u.branch_id,b.name as branch_name,r.name as role_name FROM users u LEFT JOIN branches b ON u.branch_id=b.id LEFT JOIN roles r ON u.role_id=r.id WHERE u.id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  user.permissions = resolvePermissions(user);
  user.branch_ids = user.role === 'admin' ? [] : branchIdsOfUser(user.id);
  user.branches = accessibleBranches(user);
  res.json(user);
});

// CHANGE OWN PASSWORD
router.put('/change-password', authMiddleware, (req, res) => {
  const { old_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(old_password, user.password)) return res.status(400).json({ error: 'Password lama tidak sesuai' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  logActivity({ user: req.user, module: 'auth', action: 'password_change', description: `Ganti password sendiri` });
  res.json({ message: 'Password berhasil diubah' });
});

// ===================== USER MANAGEMENT (Admin Only) =====================

// LIST USERS
router.get('/users', authMiddleware, adminOnly, (req, res) => {
  const users = db.prepare('SELECT u.id,u.username,u.full_name,u.role,u.role_id,u.branch_id,u.is_active,u.created_at,b.name as branch_name,r.name as role_name,r.code as role_code FROM users u LEFT JOIN branches b ON u.branch_id=b.id LEFT JOIN roles r ON u.role_id=r.id ORDER BY u.id').all();
  const namaCabang = {};
  db.prepare('SELECT id,name FROM branches').all().forEach((b) => { namaCabang[b.id] = b.name; });
  users.forEach((u) => {
    u.branch_ids = branchIdsOfUser(u.id);
    u.branch_names = u.branch_ids.map((id) => namaCabang[id]).filter(Boolean);
  });
  res.json(users);
});

// CREATE USER
router.post('/users', authMiddleware, adminOnly, (req, res) => {
  const { username, password, full_name } = req.body;
  // Hak akses cabang: boleh lebih dari satu. branch_id lama tetap diterima
  // sebagai bentuk ringkas supaya pemanggil lama tidak rusak.
  const branchIds = Array.isArray(req.body.branch_ids) && req.body.branch_ids.length
    ? req.body.branch_ids.map((b) => parseInt(b)).filter((b) => b > 0)
    : (req.body.branch_id ? [parseInt(req.body.branch_id)] : []);
  const branch_id = branchIds[0] || null;
  let { role, role_id } = req.body;
  if (!username || !password || !full_name) return res.status(400).json({ error: 'Username, password, dan nama wajib diisi' });
  if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(400).json({ error: 'Username sudah digunakan' });
  // role_id adalah sumber kebenaran; kolom role teks dipertahankan untuk kompatibilitas
  const roleRow = role_id ? db.prepare('SELECT * FROM roles WHERE id=?').get(role_id)
                          : db.prepare('SELECT * FROM roles WHERE code=?').get(role || 'cashier');
  if (!roleRow) return res.status(400).json({ error: 'Role tidak ditemukan' });
  role = roleRow.code; role_id = roleRow.id;
  if (role !== 'admin' && !branchIds.length) return res.status(400).json({ error: 'User non-admin harus diberi minimal satu cabang' });
  const sah = branchIds.filter((b) => db.prepare('SELECT id FROM branches WHERE id=? AND is_active=1').get(b));
  if (role !== 'admin' && !sah.length) return res.status(400).json({ error: 'Cabang yang dipilih tidak ditemukan' });
  const r = db.prepare('INSERT INTO users (username,password,full_name,role,role_id,branch_id) VALUES (?,?,?,?,?,?)').run(username, bcrypt.hashSync(password,10), full_name, role, role_id, branch_id||null);
  setUserBranches(r.lastInsertRowid, role === 'admin' ? [] : sah);
  logActivity({ user: req.user, module: 'users', action: 'create', description: `Membuat user ${full_name} (${role})`, entity_type: 'user', entity_id: r.lastInsertRowid });
  res.json({ id: r.lastInsertRowid, message: 'User berhasil dibuat' });
});

// UPDATE USER
router.put('/users/:id', authMiddleware, adminOnly, (req, res) => {
  const { full_name, is_active } = req.body;
  const branchIds = Array.isArray(req.body.branch_ids)
    ? req.body.branch_ids.map((b) => parseInt(b)).filter((b) => b > 0)
    : (req.body.branch_id ? [parseInt(req.body.branch_id)] : null);
  const branch_id = branchIds ? (branchIds[0] || null) : undefined;
  let { role, role_id } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  const roleRow = role_id ? db.prepare('SELECT * FROM roles WHERE id=?').get(role_id)
                : (role ? db.prepare('SELECT * FROM roles WHERE code=?').get(role) : null);
  const finalRole = roleRow ? roleRow.code : user.role;
  const finalRoleId = roleRow ? roleRow.id : user.role_id;
  if (finalRole !== 'admin' && branchIds !== null && !branchIds.length) {
    return res.status(400).json({ error: 'User non-admin harus diberi minimal satu cabang' });
  }
  // Jangan sampai admin terakhir dinonaktifkan / diturunkan perannya
  if (user.role === 'admin' && (finalRole !== 'admin' || is_active === 0)) {
    const c = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin' AND is_active=1 AND id!=?").get(req.params.id);
    if (!c || c.c === 0) return res.status(400).json({ error: 'Minimal harus ada satu administrator aktif' });
  }
  const branchFinal = branch_id !== undefined ? branch_id : user.branch_id;
  db.prepare('UPDATE users SET full_name=?,role=?,role_id=?,branch_id=?,is_active=? WHERE id=?').run(full_name||user.full_name, finalRole, finalRoleId, branchFinal||null, is_active!==undefined?is_active:user.is_active, req.params.id);
  if (branchIds !== null) setUserBranches(parseInt(req.params.id), finalRole === 'admin' ? [] : branchIds);
  logActivity({ user: req.user, module: 'users', action: 'update', description: `Update user ${user.full_name}`, entity_type: 'user', entity_id: parseInt(req.params.id) });
  res.json({ message: 'User berhasil diupdate' });
});

// RESET PASSWORD (Admin)
router.patch('/users/:id/password', authMiddleware, adminOnly, (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  const target = db.prepare('SELECT full_name FROM users WHERE id=?').get(req.params.id);
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(new_password,10), req.params.id);
  logActivity({ user: req.user, module: 'users', action: 'reset_password', description: `Reset password user ${target?.full_name||'?'}`, entity_type: 'user', entity_id: parseInt(req.params.id) });
  res.json({ message: 'Password berhasil direset' });
});

// DELETE USER
router.delete('/users/:id', authMiddleware, adminOnly, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' });
  const target = db.prepare('SELECT full_name,role FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User tidak ditemukan' });
  if (target.role === 'admin') {
    const c = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin' AND is_active=1 AND id!=?").get(req.params.id);
    if (!c || c.c === 0) return res.status(400).json({ error: 'Minimal harus ada satu administrator aktif' });
  }
  db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(req.params.id);
  logActivity({ user: req.user, module: 'users', action: 'deactivate', description: `Nonaktifkan user ${target?.full_name||'?'}`, entity_type: 'user', entity_id: parseInt(req.params.id) });
  res.json({ message: 'User berhasil dinonaktifkan' });
});

module.exports = router;
