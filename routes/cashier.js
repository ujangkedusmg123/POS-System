const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, requirePerm, can } = require('../middleware/auth');
const { logActivity } = require('../utils/activity-log');
const { branchScopeSql, accessibleBranches, canUseBranch } = require('../utils/branch-access');
const { todayWib } = require('../utils/waktu');
const db = { prepare: (...a) => getDb().prepare(...a), transaction: (...a) => getDb().transaction(...a) };

router.use(authMiddleware);

/* ==========================================================================
   BUKA / TUTUP KASIR
   --------------------------------------------------------------------------
   Prinsip penting: seluruh angka "seharusnya" (expected) dihitung DI SERVER
   dari data transaksi mentah. Klien hanya boleh mengirim `counted_cash`
   (hasil hitung fisik uang di laci). Nilai expected, selisih, dan rekap per
   metode pembayaran TIDAK PERNAH diambil dari body request, sehingga tidak
   bisa dimanipulasi dari sisi kasir.
   ========================================================================== */

function genSessionCode(branchId) {
  const tgl = todayWib().replace(/-/g, '');   // kode shift mengikuti tanggal WIB
  const p = `SH${String(branchId || 0).padStart(2, '0')}${tgl}`;
  const last = db.prepare('SELECT session_code FROM cash_sessions WHERE session_code LIKE ? ORDER BY id DESC LIMIT 1').get(p + '%');
  const seq = last ? parseInt(last.session_code.slice(-3)) + 1 : 1;
  return p + String(seq).padStart(3, '0');
}

/**
 * Inti perhitungan shift. Semua diturunkan dari tabel sales / cash_movements.
 * @returns rekap lengkap sebuah sesi
 */
function computeSession(sessionId) {
  const s = db.prepare(`SELECT cs.*, u.full_name as cashier_name, b.name as branch_name, cb.full_name as closed_by_name
    FROM cash_sessions cs
    LEFT JOIN users u ON cs.user_id=u.id
    LEFT JOIN branches b ON cs.branch_id=b.id
    LEFT JOIN users cb ON cs.closed_by=cb.id
    WHERE cs.id=?`).get(sessionId);
  if (!s) return null;

  const methods = db.prepare('SELECT * FROM payment_methods').all();
  const methodBy = {};
  methods.forEach((m) => { methodBy[m.code] = m; });

  // --- Penjualan selama shift ---
  const sales = db.prepare(`SELECT payment_method, COUNT(*) as trx, SUM(total) as total
    FROM sales WHERE session_id=? AND status='completed' GROUP BY payment_method`).all(sessionId);

  const byMethod = sales.map((row) => {
    const m = methodBy[row.payment_method];
    return {
      code: row.payment_method,
      name: m ? m.name : row.payment_method,
      icon: m ? m.icon : '💳',
      kind: m ? m.kind : 'cashless',
      counted_in_drawer: m ? !!m.counted_in_drawer : (row.payment_method === 'cash'),
      transactions: row.trx || 0,
      amount: row.total || 0,
    };
  }).sort((a, b) => b.amount - a.amount);

  const salesTotal = byMethod.reduce((a, r) => a + r.amount, 0);
  const trxCount = byMethod.reduce((a, r) => a + r.transactions, 0);
  // Hanya metode yang menambah uang fisik di laci yang masuk hitungan tunai
  const drawerSales = byMethod.filter((r) => r.counted_in_drawer).reduce((a, r) => a + r.amount, 0);

  // --- Kembalian yang sudah dikeluarkan (mengurangi isi laci) ---
  const changeRow = db.prepare(`SELECT COALESCE(SUM(change_amount),0) as c FROM sales
    WHERE session_id=? AND status='completed'`).get(sessionId);
  const totalChange = changeRow ? changeRow.c : 0;

  // --- Transaksi yang dibatalkan (informasi untuk supervisor) ---
  const voidRow = db.prepare(`SELECT COUNT(*) as c, COALESCE(SUM(total),0) as t FROM sales
    WHERE session_id=? AND status='cancelled'`).get(sessionId);

  // --- Kas masuk / keluar manual ---
  const moves = db.prepare(`SELECT cm.*, u.full_name as created_by_name FROM cash_movements cm
    LEFT JOIN users u ON cm.created_by=u.id WHERE cm.session_id=? ORDER BY cm.id`).all(sessionId);
  const cashIn = moves.filter((m) => m.type === 'in').reduce((a, m) => a + (m.amount || 0), 0);
  const cashOut = moves.filter((m) => m.type === 'out').reduce((a, m) => a + (m.amount || 0), 0);

  // --- SALDO SEHARUSNYA (paten, dihitung sistem) ---
  // saldo awal + penjualan tunai + kas masuk − kas keluar
  // Catatan: change_amount tidak dikurangi lagi karena `total` sudah nilai bersih
  // yang diterima (payment_amount − change_amount = total).
  const expectedCash = (s.opening_balance || 0) + drawerSales + cashIn - cashOut;

  // --- Rekap produk / porsi terjual ---
  const items = db.prepare(`SELECT si.product_name, si.product_code,
      SUM(si.quantity) as qty, SUM(si.subtotal) as subtotal,
      COALESCE(p.unit,'porsi') as unit
    FROM sale_items si
    JOIN sales s ON si.sale_id=s.id
    LEFT JOIN products p ON si.product_id=p.id
    WHERE s.session_id=? AND s.status='completed'
    GROUP BY si.product_name, si.product_code, p.unit
    ORDER BY qty DESC`).all(sessionId);
  const totalPorsi = items.reduce((a, i) => a + (i.qty || 0), 0);

  const counted = s.counted_cash;
  const difference = (s.status === 'closed' && counted != null) ? (counted - expectedCash) : null;

  return {
    ...s,
    is_open: s.status === 'open',
    summary: {
      transactions: trxCount,
      sales_total: salesTotal,
      drawer_sales: drawerSales,
      non_drawer_sales: salesTotal - drawerSales,
      total_change: totalChange,
      cash_in: cashIn,
      cash_out: cashOut,
      opening_balance: s.opening_balance || 0,
      expected_cash: expectedCash,      // <- dihitung sistem, bukan dari klien
      counted_cash: counted,
      difference,
      cancelled_count: voidRow ? voidRow.c : 0,
      cancelled_total: voidRow ? voidRow.t : 0,
      total_porsi: totalPorsi,
      product_count: items.length,
    },
    by_method: byMethod,
    items,
    movements: moves,
  };
}

/** Sesi yang sedang terbuka untuk seorang user. */
function openSessionFor(userId) {
  return db.prepare("SELECT * FROM cash_sessions WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(userId);
}

/* ------------------------------------------------------------------ ROUTES */

/** Shift aktif milik user yang sedang login (dipakai POS untuk memutuskan gerbang). */
router.get('/current', (req, res) => {
  try {
    const open = openSessionFor(req.user.id);
    if (!open) return res.json({ session: null, is_open: false });
    res.json({ session: computeSession(open.id), is_open: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** BUKA KASIR — input saldo awal. */
router.post('/open', requirePerm('pos.session_open'), (req, res) => {
  try {
    const existing = openSessionFor(req.user.id);
    if (existing) return res.status(400).json({ error: 'Anda masih punya shift yang terbuka. Tutup dulu sebelum membuka yang baru.' });

    const opening = parseFloat(req.body.opening_balance);
    if (isNaN(opening) || opening < 0) return res.status(400).json({ error: 'Saldo awal harus berupa angka dan tidak boleh negatif' });

    // Cabang shift WAJIB salah satu cabang yang diizinkan untuk user ini.
    // Ini gerbang utamanya: semua penjualan mengikuti cabang sesi kasir, jadi
    // membatasi di sini sekaligus membatasi di mana user boleh berjualan.
    const outlets = accessibleBranches(req.user, { onlyOutlet: true });
    if (!outlets.length) {
      return res.status(403).json({ error: 'Akun Anda belum diberi akses ke cabang mana pun. Hubungi admin.', code: 'NO_BRANCH_ACCESS' });
    }
    let branchId = parseInt(req.body.branch_id) || null;
    if (!branchId) {
      if (outlets.length === 1) branchId = outlets[0].id;
      else return res.status(400).json({ error: 'Pilih cabang tempat Anda membuka kasir', code: 'BRANCH_REQUIRED', branches: outlets });
    }
    if (!outlets.some((o) => o.id === branchId)) {
      return res.status(403).json({ error: 'Anda tidak punya akses membuka kasir di cabang tersebut', code: 'BRANCH_FORBIDDEN' });
    }

    const code = genSessionCode(branchId);
    const r = db.prepare(`INSERT INTO cash_sessions (session_code,branch_id,user_id,opening_balance,opening_notes,status)
      VALUES (?,?,?,?,?,'open')`).run(code, branchId, req.user.id, opening, req.body.notes || null);

    logActivity({ user: req.user, module: 'cashier', action: 'session_open',
      description: `Buka kasir ${code} — saldo awal Rp ${opening.toLocaleString('id-ID')}`,
      entity_type: 'cash_session', entity_id: r.lastInsertRowid });

    res.json({ id: r.lastInsertRowid, session_code: code, message: 'Kasir berhasil dibuka' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * Cabang yang boleh dipakai user ini untuk membuka kasir.
 * Dipakai layar Buka Kasir untuk mengisi pilihan cabang — daftarnya dihitung
 * di server, jadi klien tidak bisa menawarkan cabang yang tidak berhak.
 */
router.get('/branches', (req, res) => {
  try { res.json(accessibleBranches(req.user, { onlyOutlet: true })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** Pratinjau rekonsiliasi sebelum benar-benar menutup. */
router.get('/:id/preview', (req, res) => {
  try {
    const s = computeSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Shift tidak ditemukan' });
    if (s.user_id !== req.user.id && !can(req.user, 'shift.view_all')) {
      return res.status(403).json({ error: 'Anda hanya bisa melihat shift sendiri' });
    }
    // Izin "lihat semua shift" tetap dibatasi cabang yang jadi hak user ini.
    if (s.user_id !== req.user.id && s.branch_id && !canUseBranch(req.user, s.branch_id)) {
      return res.status(403).json({ error: 'Shift ini milik cabang lain' });
    }
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** TUTUP KASIR — klien hanya mengirim hasil hitung fisik. */
router.post('/:id/close', requirePerm('pos.session_close'), (req, res) => {
  try {
    const sess = db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(req.params.id);
    if (!sess) return res.status(404).json({ error: 'Shift tidak ditemukan' });
    if (sess.status !== 'open') return res.status(400).json({ error: 'Shift ini sudah ditutup' });
    if (sess.user_id !== req.user.id && !can(req.user, 'shift.view_all')) {
      return res.status(403).json({ error: 'Anda hanya bisa menutup shift sendiri' });
    }

    const counted = parseFloat(req.body.counted_cash);
    if (isNaN(counted) || counted < 0) return res.status(400).json({ error: 'Jumlah uang fisik harus diisi dengan angka yang valid' });

    // Hitung ulang di server. Angka expected dari body request diabaikan total.
    const computed = computeSession(sess.id);
    const expected = computed.summary.expected_cash;
    const diff = counted - expected;

    db.prepare(`UPDATE cash_sessions SET closed_at=(datetime('now','+7 hours')), closed_by=?,
      counted_cash=?, expected_cash=?, difference=?, closing_notes=?, snapshot=?, status='closed' WHERE id=?`)
      .run(req.user.id, counted, expected, diff, req.body.notes || null,
        JSON.stringify({
          summary: computed.summary, by_method: computed.by_method,
          items: computed.items, movements: computed.movements,
        }), sess.id);

    const label = diff === 0 ? 'pas' : (diff > 0 ? `lebih Rp ${diff.toLocaleString('id-ID')}` : `kurang Rp ${Math.abs(diff).toLocaleString('id-ID')}`);
    logActivity({ user: req.user, module: 'cashier', action: 'session_close',
      description: `Tutup kasir ${sess.session_code} — fisik Rp ${counted.toLocaleString('id-ID')} vs sistem Rp ${expected.toLocaleString('id-ID')} (${label})`,
      entity_type: 'cash_session', entity_id: sess.id });

    res.json({ message: 'Kasir berhasil ditutup', session: computeSession(sess.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Catat kas masuk / keluar selama shift. */
router.post('/:id/movement', requirePerm('pos.cash_out'), (req, res) => {
  try {
    const sess = db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(req.params.id);
    if (!sess) return res.status(404).json({ error: 'Shift tidak ditemukan' });
    if (sess.status !== 'open') return res.status(400).json({ error: 'Shift sudah ditutup, tidak bisa menambah catatan kas' });
    if (sess.user_id !== req.user.id && !can(req.user, 'shift.view_all')) {
      return res.status(403).json({ error: 'Bukan shift Anda' });
    }
    const type = req.body.type === 'in' ? 'in' : 'out';
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Nominal harus lebih dari nol' });
    if (!req.body.reason || !String(req.body.reason).trim()) return res.status(400).json({ error: 'Keterangan wajib diisi' });

    const r = db.prepare(`INSERT INTO cash_movements (session_id,type,amount,category,reason,reference,created_by)
      VALUES (?,?,?,?,?,?,?)`).run(sess.id, type, amount, req.body.category || null,
      String(req.body.reason).trim(), req.body.reference || null, req.user.id);

    logActivity({ user: req.user, module: 'cashier', action: type === 'out' ? 'cash_out' : 'cash_in',
      description: `${type === 'out' ? 'Kas keluar' : 'Kas masuk'} Rp ${amount.toLocaleString('id-ID')} — ${req.body.reason}`,
      entity_type: 'cash_session', entity_id: sess.id });

    res.json({ id: r.lastInsertRowid, message: type === 'out' ? 'Kas keluar dicatat' : 'Kas masuk dicatat' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/movement/:mid', requirePerm('pos.cash_out'), (req, res) => {
  try {
    const sess = db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(req.params.id);
    if (!sess) return res.status(404).json({ error: 'Shift tidak ditemukan' });
    if (sess.status !== 'open') return res.status(400).json({ error: 'Shift sudah ditutup, catatan kas terkunci' });
    const mv = db.prepare('SELECT * FROM cash_movements WHERE id=? AND session_id=?').get(req.params.mid, sess.id);
    if (!mv) return res.status(404).json({ error: 'Catatan kas tidak ditemukan' });
    db.prepare('DELETE FROM cash_movements WHERE id=?').run(req.params.mid);
    logActivity({ user: req.user, module: 'cashier', action: 'cash_delete',
      description: `Hapus catatan kas Rp ${(mv.amount||0).toLocaleString('id-ID')} — ${mv.reason||''}`,
      entity_type: 'cash_session', entity_id: sess.id });
    res.json({ message: 'Catatan kas dihapus' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Riwayat shift untuk supervisor / owner. */
router.get('/sessions', requirePerm('shift.view_own', 'shift.view_all', 'shift.report'), (req, res) => {
  try {
    const { start_date, end_date, user_id, branch_id, status, limit = 100 } = req.query;
    let q = `SELECT cs.*, u.full_name as cashier_name, b.name as branch_name, cb.full_name as closed_by_name,
      (SELECT COUNT(*) FROM sales s WHERE s.session_id=cs.id AND s.status='completed') as trx_count,
      (SELECT COALESCE(SUM(s.total),0) FROM sales s WHERE s.session_id=cs.id AND s.status='completed') as sales_total,
      (SELECT COALESCE(SUM(cm.amount),0) FROM cash_movements cm WHERE cm.session_id=cs.id AND cm.type='out') as cash_out
      FROM cash_sessions cs
      LEFT JOIN users u ON cs.user_id=u.id
      LEFT JOIN branches b ON cs.branch_id=b.id
      LEFT JOIN users cb ON cs.closed_by=cb.id WHERE 1=1`;
    const p = [];
    // Tanpa hak lihat-semua, user hanya melihat shift sendiri
    if (!can(req.user, 'shift.view_all')) { q += ' AND cs.user_id=?'; p.push(req.user.id); }
    else if (user_id) { q += ' AND cs.user_id=?'; p.push(user_id); }
    const bs = branchScopeSql(req.user, 'cs.branch_id', branch_id);
    q += bs.sql; bs.params.forEach((v) => p.push(v));
    if (start_date) { q += ' AND DATE(cs.opened_at)>=?'; p.push(start_date); }
    if (end_date) { q += ' AND DATE(cs.opened_at)<=?'; p.push(end_date); }
    if (status) { q += ' AND cs.status=?'; p.push(status); }
    q += ' ORDER BY cs.id DESC LIMIT ?';
    p.push(parseInt(limit) || 100);
    res.json(db.prepare(q).all(...p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Detail satu shift (rekap dihitung ulang untuk yang masih terbuka). */
router.get('/sessions/:id', (req, res) => {
  try {
    const s = computeSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Shift tidak ditemukan' });
    if (s.user_id !== req.user.id && !can(req.user, 'shift.view_all')) {
      return res.status(403).json({ error: 'Anda hanya bisa melihat shift sendiri' });
    }
    // Izin "lihat semua shift" tetap dibatasi cabang yang jadi hak user ini.
    if (s.user_id !== req.user.id && s.branch_id && !canUseBranch(req.user, s.branch_id)) {
      return res.status(403).json({ error: 'Shift ini milik cabang lain' });
    }
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, openSessionFor, computeSession };
module.exports.default = router;
