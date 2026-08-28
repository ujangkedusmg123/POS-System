const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const db = { prepare: (...a) => getDb().prepare(...a), transaction: (...a) => getDb().transaction(...a) };
const { authMiddleware, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const { branchScopeSql, accessibleBranches, canUseBranch } = require('../utils/branch-access');

router.use(authMiddleware);
// Seluruh isi modul ini adalah data keuangan — wajib punya izin beban.
router.use(requirePerm('expenses.view', 'expenses.edit'));

// Helper: ubah saldo dompet + catat mutasi. change<0 mengurangi, change>0 menambah.
function applyWalletChange(walletId, change, type, description, reference, userId) {
  const w = db.prepare('SELECT * FROM wallets WHERE id=?').get(walletId);
  if (!w) throw new Error('Dompet tidak ditemukan');
  const before = w.current_balance;
  const after = before + change;
  db.prepare('UPDATE wallets SET current_balance=? WHERE id=?').run(after, walletId);
  db.prepare('INSERT INTO wallet_transactions (wallet_id,type,amount,balance_before,balance_after,description,reference,created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(walletId, type, change, before, after, description || null, reference || null, userId || null);
  return after;
}

// GET expenses with filters including branch
router.get('/', (req, res) => {
  try {
    const { start_date, end_date, category_id, branch_id } = req.query;
    let q = `SELECT e.*, ec.name as category_name, ec.is_hpp,
              u.full_name as created_by_name, b.name as branch_name,
              w.name as wallet_name
              FROM expenses e
              LEFT JOIN expense_categories ec ON e.category_id=ec.id
              LEFT JOIN users u ON e.created_by=u.id
              LEFT JOIN branches b ON e.branch_id=b.id
              LEFT JOIN wallets w ON e.wallet_id=w.id
              WHERE 1=1`;
    const params = [];
    // Hanya cabang yang diizinkan untuk user ini
    const bs = branchScopeSql(req.user, 'e.branch_id', branch_id);
    q += bs.sql; bs.params.forEach((v) => params.push(v));
    if (start_date) { q += ' AND e.expense_date>=?'; params.push(start_date); }
    if (end_date)   { q += ' AND e.expense_date<=?'; params.push(end_date); }
    if (category_id){ q += ' AND e.category_id=?';  params.push(category_id); }
    q += ' ORDER BY e.expense_date DESC, e.created_at DESC';
    const expenses = db.prepare(q).all(...params);
    const total = expenses.reduce((s,e)=>s+e.amount,0);
    res.json({ expenses, total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET categories
router.get('/categories', (req, res) => {
  try {
    const cats = db.prepare(`SELECT ec.id,ec.name,ec.description,ec.is_hpp,
      COUNT(e.id) as expense_count, COALESCE(SUM(e.amount),0) as total_amount
      FROM expense_categories ec LEFT JOIN expenses e ON ec.id=e.category_id
      GROUP BY ec.id ORDER BY ec.is_hpp DESC, ec.name`).all();
    res.json(cats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST category
router.post('/categories', requirePerm('expenses.edit'), (req, res) => {
  const { name, description, is_hpp } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama kategori wajib diisi' });
  const r = db.prepare('INSERT INTO expense_categories (name,description,is_hpp) VALUES (?,?,?)').run(name,description||null,is_hpp?1:0);
  res.json({ id:r.lastInsertRowid, message:'Kategori berhasil ditambahkan' });
});

// PUT category
router.put('/categories/:id', requirePerm('expenses.edit'), (req, res) => {
  const { name, description, is_hpp } = req.body;
  db.prepare('UPDATE expense_categories SET name=?,description=?,is_hpp=? WHERE id=?').run(name,description||null,is_hpp?1:0,req.params.id);
  res.json({ message:'Kategori diperbarui' });
});

// DELETE category
router.delete('/categories/:id', requirePerm('expenses.edit'), (req, res) => {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM expenses WHERE category_id=?').get(req.params.id);
  if (cnt.c>0) return res.status(400).json({ error:'Masih ada data beban dengan kategori ini' });
  db.prepare('DELETE FROM expense_categories WHERE id=?').run(req.params.id);
  res.json({ message:'Kategori dihapus' });
});

// POST expense
router.post('/', requirePerm('expenses.edit'), (req, res) => {
  try {
    const { category_id, branch_id, description, amount, expense_date, payment_method, reference_number, notes, wallet_id } = req.body;
    if (!description || !amount || !expense_date) return res.status(400).json({ error:'Deskripsi, jumlah, dan tanggal wajib diisi' });
    // Beban hanya boleh dicatat di cabang yang diizinkan untuk user ini
    let bid = branch_id ? parseInt(branch_id) : (req.user.branch_id || null);
    if (bid && !canUseBranch(req.user, bid)) {
      return res.status(403).json({ error: 'Anda tidak punya akses ke cabang tersebut' });
    }
    if (!bid && req.user.role !== 'admin') {
      const mine = accessibleBranches(req.user);
      bid = mine.length === 1 ? mine[0].id : null;
    }
    const wid = wallet_id ? parseInt(wallet_id) : null;
    const amt = parseFloat(amount) || 0;

    const doSave = db.transaction(() => {
      const r = db.prepare(`INSERT INTO expenses (category_id,branch_id,description,amount,expense_date,payment_method,wallet_id,reference_number,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(category_id||null,bid,description,amt,expense_date,payment_method||'cash',wid,reference_number||null,notes||null,req.user.id);
      // Potong saldo dompet bila dipilih
      if (wid) applyWalletChange(wid, -amt, 'expense', 'Beban: '+description, 'EXP#'+r.lastInsertRowid, req.user.id);
      return r.lastInsertRowid;
    });
    const id = doSave();
    logActivity({ user: req.user, module: 'expenses', action: 'create', description: `Beban: ${description} — Rp ${amt.toLocaleString('id-ID')}`, entity_type: 'expense', entity_id: id });
    res.json({ id, message:'Beban berhasil ditambahkan' });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

// PUT expense
router.put('/:id', requirePerm('expenses.edit'), (req, res) => {
  try {
    const { category_id, branch_id, description, amount, expense_date, payment_method, reference_number, notes, wallet_id } = req.body;
    const ex = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error:'Data tidak ditemukan' });
    if (ex.branch_id && !canUseBranch(req.user, ex.branch_id)) {
      return res.status(403).json({ error:'Beban ini milik cabang lain' });
    }
    // Cabang tujuan pun harus yang berhak — jangan sampai beban dipindahkan
    // ke cabang yang tidak boleh disentuh user ini.
    let bid = branch_id !== undefined ? (branch_id ? parseInt(branch_id) : null) : ex.branch_id;
    if (bid && !canUseBranch(req.user, bid)) {
      return res.status(403).json({ error:'Anda tidak punya akses ke cabang tujuan' });
    }
    const newWid = wallet_id !== undefined ? (wallet_id ? parseInt(wallet_id) : null) : ex.wallet_id;
    const newAmt = (amount!==undefined && amount!==null && amount!=='') ? parseFloat(amount) : ex.amount;
    const desc = description||ex.description;

    const doUpdate = db.transaction(() => {
      // Kembalikan efek dompet lama, lalu terapkan yang baru
      if (ex.wallet_id) applyWalletChange(ex.wallet_id, ex.amount, 'expense_refund', 'Revisi beban: '+ex.description, 'EXP#'+ex.id, req.user.id);
      db.prepare(`UPDATE expenses SET category_id=?,branch_id=?,description=?,amount=?,expense_date=?,payment_method=?,wallet_id=?,reference_number=?,notes=? WHERE id=?`)
        .run(category_id||null,bid,desc,newAmt,expense_date||ex.expense_date,payment_method||ex.payment_method,newWid,reference_number||null,notes||null,req.params.id);
      if (newWid) applyWalletChange(newWid, -newAmt, 'expense', 'Beban: '+desc, 'EXP#'+ex.id, req.user.id);
    });
    doUpdate();
    logActivity({ user: req.user, module: 'expenses', action: 'update', description: `Update beban #${req.params.id}`, entity_type: 'expense', entity_id: parseInt(req.params.id) });
    res.json({ message:'Beban berhasil diperbarui' });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

// DELETE expense
router.delete('/:id', requirePerm('expenses.edit'), (req, res) => {
  try {
    let desc = '?';
    const doDelete = db.transaction(() => {
      const ex = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
      if (!ex) throw new Error('Data tidak ditemukan');
      if (ex.branch_id && !canUseBranch(req.user, ex.branch_id)) throw new Error('Beban ini milik cabang lain');
      desc = ex.description;
      // Kembalikan saldo dompet bila beban ini membebani dompet
      if (ex.wallet_id) applyWalletChange(ex.wallet_id, ex.amount, 'expense_refund', 'Hapus beban: '+ex.description, 'EXP#'+ex.id, req.user.id);
      db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
    });
    doDelete();
    logActivity({ user: req.user, module: 'expenses', action: 'delete', description: `Hapus beban: ${desc}`, entity_type: 'expense', entity_id: parseInt(req.params.id) });
    res.json({ message:'Beban berhasil dihapus' });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

module.exports = router;
