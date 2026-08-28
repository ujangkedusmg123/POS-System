const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const { PERMISSION_GROUPS, sanitizePermissions } = require('../utils/permissions');
const db = { prepare: (...a) => getDb().prepare(...a) };

router.use(authMiddleware);

const parse = (r) => {
  let perms = [];
  try { perms = JSON.parse(r.permissions || '[]'); } catch (e) { perms = []; }
  return { ...r, permissions: perms };
};

/** Katalog permission — dipakai UI untuk menggambar daftar centang. */
router.get('/catalog', requirePerm('roles.view', 'users.edit'), (req, res) => res.json(PERMISSION_GROUPS));

/** Daftar role + jumlah user yang memakainya. */
router.get('/', requirePerm('roles.view', 'users.edit'), (req, res) => {
  try {
    const rows = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id=r.id AND u.is_active=1) as user_count
      FROM roles r ORDER BY r.is_system DESC, r.id`).all();
    res.json(rows.map(parse));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePerm('roles.view', 'users.edit'), (req, res) => {
  const r = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Role tidak ditemukan' });
  res.json(parse(r));
});

router.post('/', requirePerm('roles.edit'), (req, res) => {
  try {
    const { code, name, description, permissions } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama role wajib diisi' });
    const finalCode = (code || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!finalCode) return res.status(400).json({ error: 'Kode role tidak valid' });
    if (db.prepare('SELECT id FROM roles WHERE code=?').get(finalCode)) {
      return res.status(400).json({ error: 'Kode role sudah digunakan' });
    }
    const perms = sanitizePermissions(permissions);
    const r = db.prepare('INSERT INTO roles (code,name,description,is_system,permissions) VALUES (?,?,?,0,?)')
      .run(finalCode, name, description || '', JSON.stringify(perms));
    logActivity({ user: req.user, module: 'roles', action: 'create', description: `Membuat role ${name}`, entity_type: 'role', entity_id: r.lastInsertRowid });
    res.json({ id: r.lastInsertRowid, message: 'Role berhasil dibuat' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requirePerm('roles.edit'), (req, res) => {
  try {
    const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
    if (!role) return res.status(404).json({ error: 'Role tidak ditemukan' });
    const { name, description, permissions } = req.body;
    // Role admin harus selalu punya akses penuh — mencegah admin mengunci dirinya sendiri
    let perms = role.code === 'admin' ? ['*'] : sanitizePermissions(permissions);
    db.prepare('UPDATE roles SET name=?,description=?,permissions=? WHERE id=?')
      .run(name || role.name, description !== undefined ? description : role.description, JSON.stringify(perms), req.params.id);
    logActivity({ user: req.user, module: 'roles', action: 'update', description: `Update hak akses role ${name || role.name} (${perms.length} izin)`, entity_type: 'role', entity_id: parseInt(req.params.id) });
    res.json({ message: 'Role berhasil diperbarui. User terkait perlu login ulang agar hak akses baru berlaku.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePerm('roles.edit'), (req, res) => {
  try {
    const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
    if (!role) return res.status(404).json({ error: 'Role tidak ditemukan' });
    if (role.is_system) return res.status(400).json({ error: 'Role bawaan sistem tidak bisa dihapus' });
    const used = db.prepare('SELECT COUNT(*) as c FROM users WHERE role_id=?').get(req.params.id);
    if (used && used.c > 0) return res.status(400).json({ error: `Role masih dipakai ${used.c} user. Pindahkan user tersebut dulu.` });
    db.prepare('DELETE FROM roles WHERE id=?').run(req.params.id);
    logActivity({ user: req.user, module: 'roles', action: 'delete', description: `Hapus role ${role.name}`, entity_type: 'role', entity_id: parseInt(req.params.id) });
    res.json({ message: 'Role berhasil dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
