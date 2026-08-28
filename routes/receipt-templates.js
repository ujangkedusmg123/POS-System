const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const db = { prepare: (...a) => getDb().prepare(...a) };

router.use(authMiddleware);

/**
 * Template struk custom.
 *
 * PENTING: modul ini benar-benar terpisah dari pengaturan struk default
 * (tabel `settings`). Menyimpan/menghapus template TIDAK PERNAH menyentuh
 * baris `receipt_*` di tabel settings, sehingga format default tidak bisa
 * rusak karena eksperimen di sini.
 */

const parse = (r) => {
  let cfg = {};
  try { cfg = JSON.parse(r.config || '{}'); } catch (e) { cfg = {}; }
  return { ...r, config: cfg };
};

/** Field yang boleh ada di config — kunci lain dibuang. */
const ALLOWED = new Set([
  'receipt_logo', 'receipt_show_logo', 'receipt_logo_width', 'receipt_paper',
  'receipt_margin',
  'receipt_store_name', 'receipt_tagline', 'receipt_address', 'receipt_phone',
  'receipt_instagram', 'receipt_footer', 'receipt_header_note',
  'receipt_show_cashier', 'receipt_show_datetime', 'receipt_show_invoice',
  'receipt_show_customer', 'receipt_show_signature', 'receipt_signature_label',
]);

function cleanConfig(cfg) {
  const out = {};
  if (cfg && typeof cfg === 'object') {
    Object.keys(cfg).forEach((k) => {
      if (ALLOWED.has(k)) out[k] = cfg[k] == null ? '' : String(cfg[k]);
    });
  }
  return out;
}

/** Daftar template. Kasir hanya melihat yang aktif. */
router.get('/', (req, res) => {
  try {
    const all = req.query.all === '1';
    const q = `SELECT t.*, c.name as customer_name FROM receipt_templates t
               LEFT JOIN customers c ON t.customer_id=c.id
               ${all ? '' : 'WHERE t.is_active=1'}
               ORDER BY t.sort_order, t.id`;
    res.json(db.prepare(q).all().map(parse));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM receipt_templates WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Template tidak ditemukan' });
  res.json(parse(r));
});

router.post('/', requirePerm('settings.receipt_custom'), (req, res) => {
  try {
    const { name, description, customer_id, config, is_active, sort_order } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nama template wajib diisi' });
    const r = db.prepare(`INSERT INTO receipt_templates (name,description,customer_id,config,is_active,sort_order,created_by)
      VALUES (?,?,?,?,?,?,?)`).run(
      String(name).trim(), description || '', customer_id || null,
      JSON.stringify(cleanConfig(config)),
      is_active === 0 ? 0 : 1, parseInt(sort_order) || 0, req.user.id);
    logActivity({ user: req.user, module: 'receipt_templates', action: 'create', description: `Buat template struk "${name}"`, entity_type: 'receipt_template', entity_id: r.lastInsertRowid });
    res.json({ id: r.lastInsertRowid, message: 'Template struk custom dibuat' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requirePerm('settings.receipt_custom'), (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM receipt_templates WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Template tidak ditemukan' });
    const { name, description, customer_id, config, is_active, sort_order } = req.body;
    db.prepare(`UPDATE receipt_templates SET name=?,description=?,customer_id=?,config=?,is_active=?,sort_order=?,
      updated_at=(datetime('now','+7 hours')) WHERE id=?`).run(
      (name && String(name).trim()) || t.name,
      description !== undefined ? description : t.description,
      customer_id !== undefined ? (customer_id || null) : t.customer_id,
      config !== undefined ? JSON.stringify(cleanConfig(config)) : t.config,
      is_active !== undefined ? (is_active ? 1 : 0) : t.is_active,
      sort_order !== undefined ? (parseInt(sort_order) || 0) : t.sort_order,
      req.params.id);
    logActivity({ user: req.user, module: 'receipt_templates', action: 'update', description: `Update template struk "${name || t.name}"`, entity_type: 'receipt_template', entity_id: parseInt(req.params.id) });
    res.json({ message: 'Template struk diperbarui' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Duplikat template — memudahkan bikin varian tanpa mengulang dari nol. */
router.post('/:id/duplicate', requirePerm('settings.receipt_custom'), (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM receipt_templates WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Template tidak ditemukan' });
    const r = db.prepare(`INSERT INTO receipt_templates (name,description,customer_id,config,is_active,sort_order,created_by)
      VALUES (?,?,?,?,?,?,?)`).run(t.name + ' (salinan)', t.description, t.customer_id, t.config, 0, t.sort_order, req.user.id);
    res.json({ id: r.lastInsertRowid, message: 'Template diduplikat' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePerm('settings.receipt_custom'), (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM receipt_templates WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Template tidak ditemukan' });
    db.prepare('DELETE FROM receipt_templates WHERE id=?').run(req.params.id);
    logActivity({ user: req.user, module: 'receipt_templates', action: 'delete', description: `Hapus template struk "${t.name}"`, entity_type: 'receipt_template', entity_id: parseInt(req.params.id) });
    res.json({ message: 'Template struk dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
