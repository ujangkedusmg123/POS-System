const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly, requirePerm } = require('../middleware/auth');
const db = { prepare: (...a) => getDb().prepare(...a) };

router.use(authMiddleware);
router.use(requirePerm('activity.view'));

// LIST dengan filter
router.get('/', (req, res) => {
  try {
    const { start_date, end_date, user_id, module, action, limit = 300 } = req.query;
    let q = `SELECT al.*, u.username FROM activity_logs al LEFT JOIN users u ON al.user_id=u.id WHERE 1=1`;
    const p = [];
    if (start_date) { q += " AND DATE(al.created_at)>=?"; p.push(start_date); }
    if (end_date)   { q += " AND DATE(al.created_at)<=?"; p.push(end_date); }
    if (user_id)    { q += ' AND al.user_id=?'; p.push(user_id); }
    if (module)     { q += ' AND al.module=?'; p.push(module); }
    if (action)     { q += ' AND al.action=?'; p.push(action); }
    q += ' ORDER BY al.created_at DESC LIMIT ?'; p.push(parseInt(limit));
    const logs = db.prepare(q).all(...p);
    res.json({ logs, count: logs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Modules & Actions untuk dropdown filter
router.get('/meta', (req, res) => {
  const modules = db.prepare('SELECT DISTINCT module FROM activity_logs ORDER BY module').all().map(r => r.module);
  const actions = db.prepare('SELECT DISTINCT action FROM activity_logs ORDER BY action').all().map(r => r.action);
  const users = db.prepare('SELECT DISTINCT user_id, user_name FROM activity_logs WHERE user_id IS NOT NULL ORDER BY user_name').all();
  res.json({ modules, actions, users });
});

module.exports = router;
