const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly, requirePerm } = require('../middleware/auth');
const db = { prepare: (...a) => getDb().prepare(...a) };

// --- PUBLIK: branding halaman login (tanpa token, hanya kunci login_*) ---
// Sengaja dipisah SEBELUM authMiddleware karena halaman login belum punya token.
router.get('/public/login', (req, res) => {
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'login_%'").all();
    const obj = {};
    rows.forEach(r => obj[r.key] = r.value);
    res.json(obj);
  } catch(e) { res.json({}); }
});

router.use(authMiddleware);

// GET all settings (public to logged-in users for receipt printing)
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const obj = {};
    rows.forEach(r => obj[r.key] = r.value);
    res.json(obj);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST/update settings (admin only)
router.post('/', requirePerm('settings.edit','settings.receipt','settings.login'), (req, res) => {
  try {
    const entries = Object.entries(req.body).filter(([k]) => k !== '_ts');
    // Cegah penyimpanan kunci acak yang tidak dikenal
    const allowedPrefix = ['receipt_','login_','pos_','prod_','app_','store_'];
    for (const [k] of entries) {
      if (!allowedPrefix.some(pfx => String(k).startsWith(pfx))) {
        return res.status(400).json({ error: `Kunci pengaturan tidak dikenal: ${k}` });
      }
    }
    entries.forEach(([key, value]) => {
      db.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?, updated_at=datetime('now','+7 hours')")
        .run(key, value, value);
    });
    res.json({ message: 'Pengaturan struk berhasil disimpan' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
