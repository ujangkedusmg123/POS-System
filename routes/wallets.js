const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { branchScopeSql, accessibleBranches, canUseBranch } = require('../utils/branch-access');
const { authMiddleware, adminOnly, requirePerm } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const db = { prepare: (...a) => getDb().prepare(...a), transaction: (...a) => getDb().transaction(...a) };

router.use(authMiddleware);
// Saldo & mutasi dompet adalah data keuangan — wajib punya izin dompet.
router.use(requirePerm('wallets.view', 'wallets.edit'));

// GET all wallets
router.get('/', (req, res) => {
  try {
    let q = `SELECT w.*, b.name as branch_name, c.name as category_name, c.icon as category_icon,
                    COALESCE(w.kind, c.kind, 'asset') as kind
             FROM wallets w
             LEFT JOIN branches b ON w.branch_id=b.id
             LEFT JOIN wallet_categories c ON w.category_id=c.id
             WHERE w.is_active=1`;
    const p = [];
    // Dompet tanpa cabang (bank / e-wallet pusat) tetap terlihat oleh semua
    const bs = branchScopeSql(req.user, 'w.branch_id', null);
    if (bs.sql) { q += ' AND (w.branch_id IS NULL' + bs.sql.replace(' AND ', ' OR ') + ')'; bs.params.forEach((v) => p.push(v)); }
    q += ' ORDER BY (COALESCE(w.kind,c.kind,\'asset\')=\'liability\'), c.name, w.name';
    const wallets = db.prepare(q).all(...p);
    const totalAsset = wallets.filter(w=>w.kind!=='liability').reduce((s,w)=>s+w.current_balance,0);
    const totalLiability = wallets.filter(w=>w.kind==='liability').reduce((s,w)=>s+w.current_balance,0);
    res.json({
      wallets,
      total_balance: totalAsset,
      total_asset: totalAsset,
      total_liability: totalLiability,
      net_position: totalAsset - totalLiability,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== KATEGORI DOMPET (bisa dikelola sendiri) =====
router.get('/categories', (req, res) => {
  try {
    const cats = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM wallets w WHERE w.category_id=c.id AND w.is_active=1) as wallet_count
                             FROM wallet_categories c WHERE c.is_active=1 ORDER BY (c.kind='liability'), c.name`).all();
    res.json(cats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/categories', requirePerm('wallets.edit'), (req, res) => {
  const { name, kind, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama kategori wajib diisi' });
  const k = kind === 'liability' ? 'liability' : 'asset';
  try {
    const r = db.prepare('INSERT INTO wallet_categories (name,kind,icon) VALUES (?,?,?)').run(name, k, icon || (k==='liability'?'📕':'📦'));
    res.json({ id: r.lastInsertRowid, message: 'Kategori ditambahkan' });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.put('/categories/:id', requirePerm('wallets.edit'), (req, res) => {
  const { name, kind, icon } = req.body;
  const c = db.prepare('SELECT * FROM wallet_categories WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
  const k = kind === 'liability' ? 'liability' : (kind === 'asset' ? 'asset' : c.kind);
  db.prepare('UPDATE wallet_categories SET name=?, kind=?, icon=? WHERE id=?').run(name||c.name, k, icon||c.icon, req.params.id);
  // Sinkronkan kind ke dompet yang memakai kategori ini
  db.prepare('UPDATE wallets SET kind=? WHERE category_id=?').run(k, req.params.id);
  res.json({ message: 'Kategori diperbarui' });
});
router.delete('/categories/:id', requirePerm('wallets.edit'), (req, res) => {
  const c = db.prepare('SELECT * FROM wallet_categories WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
  const used = db.prepare('SELECT COUNT(*) c FROM wallets WHERE category_id=? AND is_active=1').get(req.params.id).c;
  if (used > 0) return res.status(400).json({ error: `Masih dipakai ${used} dompet. Pindahkan dompet dulu.` });
  db.prepare('UPDATE wallet_categories SET is_active=0 WHERE id=?').run(req.params.id);
  res.json({ message: 'Kategori dihapus' });
});

// GET all transactions across wallets (with filters)
router.get('/transactions/all', (req, res) => {
  try {
    const { start_date, end_date, wallet_id, type, limit=200 } = req.query;
    let q = `SELECT wt.*, w.name as wallet_name, w.type as wallet_type, u.full_name as operator_name
             FROM wallet_transactions wt
             LEFT JOIN wallets w ON wt.wallet_id=w.id
             LEFT JOIN users u ON wt.created_by=u.id
             WHERE 1=1`;
    const p = [];
    if (start_date) { q += " AND DATE(wt.created_at) >= ?"; p.push(start_date); }
    if (end_date)   { q += " AND DATE(wt.created_at) <= ?"; p.push(end_date); }
    if (wallet_id)  { q += ' AND wt.wallet_id = ?'; p.push(wallet_id); }
    if (type)       { q += ' AND wt.type = ?'; p.push(type); }
    const bs2 = branchScopeSql(req.user, 'w.branch_id', null);
    if (bs2.sql) { q += ' AND (w.branch_id IS NULL' + bs2.sql.replace(' AND ', ' OR ') + ')'; bs2.params.forEach((v) => p.push(v)); }
    q += ' ORDER BY wt.created_at DESC LIMIT ?'; p.push(parseInt(limit));
    const txs = db.prepare(q).all(...p);
    // Aggregates
    const totalIn = txs.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0);
    const totalOut = txs.filter(t=>t.amount<0).reduce((s,t)=>s+Math.abs(t.amount),0);
    res.json({ transactions: txs, summary: { total_in: totalIn, total_out: totalOut, count: txs.length } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET one wallet with recent transactions
/**
 * Dompet yang menempel ke sebuah cabang hanya boleh disentuh oleh orang yang
 * memang memegang cabang itu. Dompet tanpa cabang (bank / e-wallet pusat)
 * terbuka untuk semua pemegang izin dompet.
 */
function pastikanCabangDompet(req, w) {
  if (!w || !w.branch_id) return null;
  if (canUseBranch(req.user, w.branch_id)) return null;
  return 'Dompet ini milik cabang lain';
}

router.get('/:id', (req, res) => {
  try {
    const wallet = db.prepare(`SELECT w.*, b.name as branch_name FROM wallets w LEFT JOIN branches b ON w.branch_id=b.id WHERE w.id=?`).get(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Dompet tidak ditemukan' });
    const tolak = pastikanCabangDompet(req, wallet);
    if (tolak) return res.status(403).json({ error: tolak });
    const txs = db.prepare(`SELECT wt.*, u.full_name as operator_name FROM wallet_transactions wt LEFT JOIN users u ON wt.created_by=u.id WHERE wt.wallet_id=? ORDER BY wt.created_at DESC LIMIT 100`).all(req.params.id);
    res.json({ ...wallet, transactions: txs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create wallet
router.post('/', requirePerm('wallets.edit'), (req, res) => {
  const { name, type, branch_id, notes, opening_balance, category_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama dompet wajib diisi' });
  const catId = category_id ? parseInt(category_id) : null;
  let kind = 'asset', catName = type || 'petty_cash';
  if (catId) { const c = db.prepare('SELECT * FROM wallet_categories WHERE id=?').get(catId); if (c) { kind = c.kind; catName = c.name; } }
  const opening = parseFloat(opening_balance) || 0;
  try {
    const r = db.prepare('INSERT INTO wallets (name,type,branch_id,current_balance,notes,category_id,kind) VALUES (?,?,?,?,?,?,?)').run(name, catName, branch_id||null, opening, notes||null, catId, kind);
    if (opening !== 0) {
      db.prepare('INSERT INTO wallet_transactions (wallet_id,type,amount,balance_before,balance_after,description,created_by) VALUES (?,?,?,?,?,?,?)').run(r.lastInsertRowid, 'opening', opening, 0, opening, kind==='liability'?'Saldo awal hutang':'Saldo awal', req.user.id);
    }
    res.json({ id: r.lastInsertRowid, message: 'Dompet berhasil dibuat' });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// PUT edit wallet (metadata only)
router.put('/:id', requirePerm('wallets.edit'), (req, res) => {
  const { name, type, branch_id, notes, category_id } = req.body;
  const w = db.prepare('SELECT * FROM wallets WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Dompet tidak ditemukan' });
  let catId = category_id !== undefined ? (category_id ? parseInt(category_id) : null) : w.category_id;
  let kind = w.kind || 'asset', catName = type || w.type;
  if (catId) { const c = db.prepare('SELECT * FROM wallet_categories WHERE id=?').get(catId); if (c) { kind = c.kind; catName = c.name; } }
  try {
    db.prepare('UPDATE wallets SET name=?, type=?, branch_id=?, notes=?, category_id=?, kind=? WHERE id=?').run(
      name||w.name, catName, branch_id!==undefined?branch_id:w.branch_id, notes||null, catId, kind, req.params.id);
    res.json({ message: 'Dompet diperbarui' });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// DELETE wallet (soft)
router.delete('/:id', requirePerm('wallets.edit'), (req, res) => {
  const w = db.prepare('SELECT * FROM wallets WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Dompet tidak ditemukan' });
  const txCount = db.prepare('SELECT COUNT(*) as c FROM wallet_transactions WHERE wallet_id=?').get(req.params.id);
  if (txCount.c > 0) {
    db.prepare('UPDATE wallets SET is_active=0 WHERE id=?').run(req.params.id);
    res.json({ message: 'Dompet dinonaktifkan (ada riwayat transaksi)' });
  } else {
    db.prepare('DELETE FROM wallets WHERE id=?').run(req.params.id);
    res.json({ message: 'Dompet dihapus' });
  }
});

// POST topup (tambah saldo)
router.post('/:id/topup', requirePerm('wallets.edit'), (req, res) => {
  const { amount, description, reference } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Jumlah harus > 0' });
  const doTx = db.transaction(() => {
    const w = db.prepare('SELECT * FROM wallets WHERE id=? AND is_active=1').get(req.params.id);
    if (!w) throw new Error('Dompet tidak ditemukan');
    const _tolak = pastikanCabangDompet(req, w);
    if (_tolak) throw new Error(_tolak);
    const before = w.current_balance;
    const after = before + amt;
    db.prepare('UPDATE wallets SET current_balance=? WHERE id=?').run(after, req.params.id);
    db.prepare('INSERT INTO wallet_transactions (wallet_id,type,amount,balance_before,balance_after,description,reference,created_by) VALUES (?,?,?,?,?,?,?,?)').run(req.params.id,'topup',amt,before,after,description||'Tambah saldo',reference||null,req.user.id);
    return { before, after };
  });
  try {
    const r = doTx();
    const w = db.prepare('SELECT name FROM wallets WHERE id=?').get(req.params.id);
    logActivity({ user: req.user, module: 'wallets', action: 'topup', description: `Topup ${w?.name}: +Rp ${amt.toLocaleString('id-ID')} (${description||'-'})`, entity_type: 'wallet', entity_id: parseInt(req.params.id), metadata: r });
    res.json({ message:`Saldo ditambahkan Rp ${amt.toLocaleString('id-ID')}`, ...r });
  }
  catch(e) { res.status(400).json({ error: e.message }); }
});

// POST withdraw (kurangi saldo)
router.post('/:id/withdraw', requirePerm('wallets.edit'), (req, res) => {
  const { amount, description, reference } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Jumlah harus > 0' });
  const doTx = db.transaction(() => {
    const w = db.prepare('SELECT * FROM wallets WHERE id=? AND is_active=1').get(req.params.id);
    if (!w) throw new Error('Dompet tidak ditemukan');
    const _tolak = pastikanCabangDompet(req, w);
    if (_tolak) throw new Error(_tolak);
    const before = w.current_balance;
    const after = before - amt;
    if (after < 0) throw new Error(`Saldo tidak cukup (tersedia Rp ${before.toLocaleString('id-ID')})`);
    db.prepare('UPDATE wallets SET current_balance=? WHERE id=?').run(after, req.params.id);
    db.prepare('INSERT INTO wallet_transactions (wallet_id,type,amount,balance_before,balance_after,description,reference,created_by) VALUES (?,?,?,?,?,?,?,?)').run(req.params.id,'withdraw',-amt,before,after,description||'Tarik saldo',reference||null,req.user.id);
    return { before, after };
  });
  try {
    const r = doTx();
    const w = db.prepare('SELECT name FROM wallets WHERE id=?').get(req.params.id);
    logActivity({ user: req.user, module: 'wallets', action: 'withdraw', description: `Tarik ${w?.name}: -Rp ${amt.toLocaleString('id-ID')} (${description||'-'})`, entity_type: 'wallet', entity_id: parseInt(req.params.id), metadata: r });
    res.json({ message:`Saldo dikurangi Rp ${amt.toLocaleString('id-ID')}`, ...r });
  }
  catch(e) { res.status(400).json({ error: e.message }); }
});

// POST adjust (rekonsiliasi = set ke saldo aktual)
router.post('/:id/adjust', adminOnly, (req, res) => {
  const { new_balance, description } = req.body;
  const target = parseFloat(new_balance);
  if (isNaN(target) || target < 0) return res.status(400).json({ error: 'Saldo tidak valid' });
  const doTx = db.transaction(() => {
    const w = db.prepare('SELECT * FROM wallets WHERE id=? AND is_active=1').get(req.params.id);
    if (!w) throw new Error('Dompet tidak ditemukan');
    const _tolak = pastikanCabangDompet(req, w);
    if (_tolak) throw new Error(_tolak);
    const before = w.current_balance;
    const diff = target - before;
    db.prepare('UPDATE wallets SET current_balance=? WHERE id=?').run(target, req.params.id);
    db.prepare('INSERT INTO wallet_transactions (wallet_id,type,amount,balance_before,balance_after,description,created_by) VALUES (?,?,?,?,?,?,?)').run(req.params.id,'adjust',diff,before,target,description||'Rekonsiliasi manual',req.user.id);
    return { before, after: target, diff };
  });
  try {
    const r = doTx();
    const w = db.prepare('SELECT name FROM wallets WHERE id=?').get(req.params.id);
    logActivity({ user: req.user, module: 'wallets', action: 'adjust', description: `Rekonsiliasi ${w?.name}: Rp ${r.before.toLocaleString('id-ID')} → Rp ${r.after.toLocaleString('id-ID')}`, entity_type: 'wallet', entity_id: parseInt(req.params.id), metadata: r });
    res.json({ message:'Saldo direkonsiliasi', ...r });
  }
  catch(e) { res.status(400).json({ error: e.message }); }
});

// POST transfer antar dompet
router.post('/:id/transfer', requirePerm('wallets.edit'), (req, res) => {
  const { to_wallet_id, amount, description } = req.body;
  const amt = parseFloat(amount);
  const toId = parseInt(to_wallet_id);
  const fromId = parseInt(req.params.id);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Jumlah harus > 0' });
  if (!toId || toId === fromId) return res.status(400).json({ error: 'Pilih dompet tujuan yang berbeda' });
  const doTx = db.transaction(() => {
    const from = db.prepare('SELECT * FROM wallets WHERE id=? AND is_active=1').get(fromId);
    const to = db.prepare('SELECT * FROM wallets WHERE id=? AND is_active=1').get(toId);
    if (!from || !to) throw new Error('Dompet tidak ditemukan');
    const tolakDari = pastikanCabangDompet(req, from) || pastikanCabangDompet(req, to);
    if (tolakDari) throw new Error(tolakDari);
    const fromKind = from.kind || 'asset';
    const toKind = to.kind || 'asset';
    // Sumber: aset keluar uang (−); dompet hutang sebagai sumber = tambah hutang (+)
    const fromDelta = fromKind === 'liability' ? amt : -amt;
    // Tujuan: aset masuk uang (+); dompet hutang sebagai tujuan = bayar/kurangi hutang (−)
    const toDelta = toKind === 'liability' ? -amt : amt;
    if (fromKind !== 'liability' && from.current_balance < amt) throw new Error(`Saldo ${from.name} tidak cukup (tersedia Rp ${from.current_balance.toLocaleString('id-ID')})`);
    if (toKind === 'liability' && to.current_balance < amt) throw new Error(`Pembayaran melebihi sisa hutang (sisa Rp ${to.current_balance.toLocaleString('id-ID')})`);
    const payingDebt = toKind === 'liability';
    const fBefore = from.current_balance, fAfter = fBefore + fromDelta;
    const tBefore = to.current_balance, tAfter = tBefore + toDelta;
    db.prepare('UPDATE wallets SET current_balance=? WHERE id=?').run(fAfter, fromId);
    db.prepare('INSERT INTO wallet_transactions (wallet_id,type,amount,balance_before,balance_after,description,reference,created_by) VALUES (?,?,?,?,?,?,?,?)').run(fromId,'transfer_out',fromDelta,fBefore,fAfter,description||(payingDebt?`Bayar hutang: ${to.name}`:`Transfer ke ${to.name}`),`W#${toId}`,req.user.id);
    db.prepare('UPDATE wallets SET current_balance=? WHERE id=?').run(tAfter, toId);
    db.prepare('INSERT INTO wallet_transactions (wallet_id,type,amount,balance_before,balance_after,description,reference,created_by) VALUES (?,?,?,?,?,?,?,?)').run(toId,'transfer_in',toDelta,tBefore,tAfter,description||(payingDebt?`Pembayaran hutang dari ${from.name}`:`Transfer dari ${from.name}`),`W#${fromId}`,req.user.id);
    return { from: {before:fBefore, after:fAfter}, to: {before:tBefore, after:tAfter}, payingDebt };
  });
  try {
    const r = doTx();
    const from = db.prepare('SELECT name FROM wallets WHERE id=?').get(fromId);
    const to = db.prepare('SELECT name FROM wallets WHERE id=?').get(toId);
    logActivity({ user: req.user, module: 'wallets', action: 'transfer', description: `Transfer ${from?.name} → ${to?.name}: Rp ${amt.toLocaleString('id-ID')}`, entity_type: 'wallet_transfer', metadata: { from_id: fromId, to_id: toId, amount: amt } });
    res.json({ message: r.payingDebt ? 'Pembayaran hutang berhasil' : 'Transfer berhasil', ...r });
  }
  catch(e) { res.status(400).json({ error: e.message }); }
});

// DELETE transaction (revert)
router.delete('/transactions/:txId', adminOnly, (req, res) => {
  const doTx = db.transaction(() => {
    const tx = db.prepare('SELECT * FROM wallet_transactions WHERE id=?').get(req.params.txId);
    if (!tx) throw new Error('Transaksi tidak ditemukan');
    if (['transfer_in','transfer_out'].includes(tx.type)) throw new Error('Transaksi transfer tidak bisa dihapus manual');
    // Revert balance
    const w = db.prepare('SELECT * FROM wallets WHERE id=?').get(tx.wallet_id);
    if (!w) throw new Error('Dompet tidak ditemukan');
    const newBalance = w.current_balance - tx.amount;
    db.prepare('UPDATE wallets SET current_balance=? WHERE id=?').run(newBalance, tx.wallet_id);
    db.prepare('DELETE FROM wallet_transactions WHERE id=?').run(req.params.txId);
    return newBalance;
  });
  try { const b = doTx(); res.json({ message:'Transaksi dibatalkan, saldo direvert', new_balance: b }); }
  catch(e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
