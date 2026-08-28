const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, requirePerm } = require('../middleware/auth');
const { branchScopeSql, accessibleBranches, canUseBranch } = require('../utils/branch-access');
const { todayWib, awalBulanWib, bulanLaluWib } = require('../utils/waktu');
const db = { prepare: (...a) => getDb().prepare(...a) };
router.use(authMiddleware);
// Seluruh laporan berisi data keuangan (omzet, HPP, laba). Dulu route ini
// hanya butuh "sudah login", sehingga peran non-keuangan seperti Tim Produksi
// pun bisa membacanya. Sekarang wajib punya izin melihat laporan.
router.use(requirePerm('reports.view', 'dashboard.view', 'finance.view'));

/**
 * Penyaring cabang untuk laporan. Non-admin dibatasi ke cabang yang benar-benar
 * diizinkan untuknya (bisa lebih dari satu), bukan lagi satu cabang tetap.
 * Nilai dirangkai sebagai angka hasil parse — tidak pernah string mentah dari
 * query — supaya tidak bisa disusupi lewat parameter URL.
 */
function bf(req, alias='') {
  const col = alias ? alias+'.branch_id' : 'branch_id';
  const scope = branchScopeSql(req.user, col, req.query.branch_id);
  if (!scope.sql) return '';
  const ids = scope.params.map((n) => parseInt(n) || 0);
  if (!ids.length) return ' AND 1=0';
  return ids.length === 1 ? ' AND '+col+'='+ids[0] : ' AND '+col+' IN ('+ids.join(',')+')';
}

/**
 * Penyaring beban. Beban tanpa cabang (mis. belanja bahan dapur pusat yang
 * menanggung semua outlet) tetap ikut terhitung — yang dibatasi hanyalah beban
 * yang jelas milik cabang lain.
 */
function bfExp(req, alias = 'e') {
  const col = alias + '.branch_id';
  const scope = branchScopeSql(req.user, col, req.query.branch_id);
  if (!scope.sql) return '';
  const ids = scope.params.map((n) => parseInt(n) || 0);
  if (!ids.length) return ' AND ' + col + ' IS NULL';
  return ' AND (' + col + ' IS NULL OR ' + col + ' IN (' + ids.join(',') + '))';
}

// DASHBOARD
router.get('/dashboard', (req, res) => {
  try {
    // Semua tanggal mengikuti WIB, bukan zona waktu server tempat aplikasi dipasang.
    const today = todayWib();
    const lastMonth = bulanLaluWib();
    const start = req.query.start_date || awalBulanWib();
    const end   = req.query.end_date   || today;
    const branch = bf(req);       // no alias — for simple FROM sales WHERE...
    const branchS = bf(req, 's'); // with alias s — for JOIN queries using 's' alias

    // Today stats
    const todaySales = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(total),0) as revenue FROM sales WHERE DATE(created_at)=? AND status='completed'${branch}`).get(today);
    const todayExp   = db.prepare(`SELECT COALESCE(SUM(e.amount),0) as total FROM expenses e WHERE e.expense_date=?${bfExp(req)}`).get(today); // today is local date // expense_date is local date input // expense_date is already local date

    // Period stats
    const periodSales = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(total),0) as revenue FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND status='completed'${branch}`).get(start, end);

    // HPP = bahan baku + kemasan (is_hpp=1)
    const periodHPP = db.prepare(`SELECT COALESCE(SUM(e.amount),0) as total FROM expenses e JOIN expense_categories ec ON e.category_id=ec.id WHERE ec.is_hpp=1 AND e.expense_date BETWEEN ? AND ?${bfExp(req)}`).get(start, end);
    // Beban Operasional = expenses where is_hpp=0
    const periodBeban = db.prepare(`SELECT COALESCE(SUM(e.amount),0) as total FROM expenses e JOIN expense_categories ec ON e.category_id=ec.id WHERE ec.is_hpp=0 AND e.expense_date BETWEEN ? AND ?${bfExp(req)}`).get(start, end);
    const periodTotalExp = db.prepare(`SELECT COALESCE(SUM(e.amount),0) as total FROM expenses e WHERE e.expense_date BETWEEN ? AND ?${bfExp(req)}`).get(start, end);

    const labaKotor = periodSales.revenue - (periodHPP?.total||0);
    const labaBersih = labaKotor - (periodBeban?.total||0);

    // Last month growth
    const lastRev = db.prepare(`SELECT COALESCE(SUM(total),0) as revenue FROM sales WHERE strftime('%Y-%m',created_at)=? AND status='completed'${branch}`).get(lastMonth);
    const growth = lastRev.revenue > 0 ? ((periodSales.revenue - lastRev.revenue) / lastRev.revenue * 100).toFixed(1) : 0;

    // Expenses breakdown for period
    const expBreakdown = db.prepare(`SELECT ec.name as category, ec.is_hpp, COALESCE(SUM(e.amount),0) as total FROM expense_categories ec LEFT JOIN expenses e ON ec.id=e.category_id AND e.expense_date BETWEEN ? AND ? GROUP BY ec.id ORDER BY ec.is_hpp DESC, total DESC`).all(start, end);

    // Stok produk per cabang (agregat produk track_stock)
    const mochiStocks = db.prepare(`SELECT b.id as branch_id, b.name as branch_name, COALESCE(SUM(ps.current_stock),0) as current_stock FROM branches b LEFT JOIN product_stock ps ON b.id=ps.branch_id LEFT JOIN products p ON ps.product_id=p.id AND p.track_stock=1 AND p.is_active=1 WHERE b.is_active=1 GROUP BY b.id ORDER BY b.id`).all();

    // Channel breakdown
    const channels = db.prepare(`SELECT channel, COUNT(*) as count, SUM(total) as revenue FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND status='completed'${branch} GROUP BY channel ORDER BY revenue DESC`).all(start, end);

    // Recent sales
    const recentSales = db.prepare(`SELECT s.invoice_number,s.total,s.payment_method,s.channel,s.created_at,u.full_name as cashier,c.name as customer,b.name as branch FROM sales s LEFT JOIN users u ON s.cashier_id=u.id LEFT JOIN customers c ON s.customer_id=c.id LEFT JOIN branches b ON s.branch_id=b.id WHERE s.status='completed'${branchS} ORDER BY s.created_at DESC LIMIT 10`).all();

    // Best products
    const bestProducts = db.prepare(`SELECT p.name,p.code,p.unit,SUM(si.quantity) as total_qty,SUM(si.subtotal) as total_revenue FROM sale_items si JOIN sales s ON si.sale_id=s.id JOIN products p ON si.product_id=p.id WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.status='completed'${branchS} GROUP BY si.product_id ORDER BY total_qty DESC LIMIT 5`).all(start, end);

    // Charts
    const salesChart = db.prepare(`SELECT DATE(created_at) as date, COALESCE(SUM(total),0) as revenue, COUNT(*) as transactions FROM sales WHERE DATE(created_at)>=DATE(datetime('now','+7 hours'),'-6 days') AND status='completed'${branch} GROUP BY DATE(created_at) ORDER BY date`).all();
    const payBreakdown = db.prepare(`SELECT payment_method, COUNT(*) as count, SUM(total) as total FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND status='completed'${branch} GROUP BY payment_method`).all(start, end);
    const hourlySales = db.prepare(`SELECT strftime('%H',created_at) as hour, COUNT(*) as count, SUM(total) as total FROM sales WHERE DATE(created_at)=? AND status='completed'${branch} GROUP BY strftime('%H',created_at) ORDER BY hour`).all(today);

    res.json({
      period: { start, end },
      summary: {
        today: { count: todaySales.count, revenue: todaySales.revenue, expenses: todayExp.total },
        period: {
          count: periodSales.count, revenue: periodSales.revenue,
          hpp: periodHPP?.total||0, beban: periodBeban?.total||0,
          total_expenses: periodTotalExp?.total||0,
          laba_kotor: labaKotor, laba_bersih: labaBersih,
          growth: parseFloat(growth),
          expenses_breakdown: expBreakdown,
        }
      },
      mochi_stock: { stocks: mochiStocks, total: mochiStocks.reduce((s,x)=>s+x.current_stock,0) },
      channel_breakdown: channels,
      recent_sales: recentSales,
      best_products: bestProducts,
      sales_chart: salesChart,
      payment_breakdown: payBreakdown,
      hourly_sales: hourlySales,
    });
  } catch(e) { console.error('Dashboard error:', e); res.status(500).json({ error: e.message }); }
});

// P&L REPORT
router.get('/profit-loss', (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const start = start_date || awalBulanWib();
    const end   = end_date   || todayWib();
    const branch = bf(req);
    const branchS = bf(req, 's');

    const revenue = db.prepare(`SELECT COALESCE(SUM(total),0) as total, COUNT(*) as count FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND status='completed'${branch}`).get(start, end);
    const hpp = db.prepare(`SELECT COALESCE(SUM(e.amount),0) as total FROM expenses e JOIN expense_categories ec ON e.category_id=ec.id WHERE ec.is_hpp=1 AND e.expense_date BETWEEN ? AND ?${bfExp(req)}`).get(start, end);
    const beban = db.prepare(`SELECT COALESCE(SUM(e.amount),0) as total FROM expenses e JOIN expense_categories ec ON e.category_id=ec.id WHERE ec.is_hpp=0 AND e.expense_date BETWEEN ? AND ?${bfExp(req)}`).get(start, end);
    const expBycat = db.prepare(`SELECT ec.name as category, ec.is_hpp, COALESCE(SUM(e.amount),0) as total FROM expense_categories ec LEFT JOIN expenses e ON ec.id=e.category_id AND e.expense_date BETWEEN ? AND ? GROUP BY ec.id ORDER BY ec.is_hpp DESC, total DESC`).all(start, end);
    const labaKotor = revenue.total - (hpp?.total||0);
    const labaBersih = labaKotor - (beban?.total||0);

    const dailySales = db.prepare(`SELECT DATE(created_at) as date, SUM(total) as revenue FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND status='completed'${branch} GROUP BY DATE(created_at) ORDER BY date`).all(start, end);
    const dailyExp = db.prepare(`SELECT e.expense_date as date, SUM(e.amount) as expenses FROM expenses e WHERE e.expense_date BETWEEN ? AND ?${bfExp(req)} GROUP BY e.expense_date ORDER BY e.expense_date`).all(start, end);

    res.json({
      period: { start, end },
      revenue: { total: revenue.total, transactions: revenue.count },
      hpp: hpp?.total||0, beban: beban?.total||0,
      laba_kotor: labaKotor, laba_bersih: labaBersih,
      gross_margin: revenue.total>0?(labaKotor/revenue.total*100).toFixed(1):0,
      net_margin: revenue.total>0?(labaBersih/revenue.total*100).toFixed(1):0,
      expenses: { total: (hpp?.total||0)+(beban?.total||0), by_category: expBycat },
      daily: { sales: dailySales, expenses: dailyExp },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// SALES REPORT
router.get('/sales', (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const start = start_date || awalBulanWib();
    const end   = end_date   || todayWib();
    const branch = bf(req);
    const branchS = bf(req, 's');
    const summary = db.prepare(`SELECT DATE(created_at) as period, COUNT(*) as transactions, SUM(total) as revenue, AVG(total) as avg_transaction FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND status='completed'${branch} GROUP BY period ORDER BY period`).all(start, end);
    const byProduct = db.prepare(`SELECT p.name,p.code,SUM(si.quantity) as qty,SUM(si.subtotal) as revenue FROM sale_items si JOIN sales s ON si.sale_id=s.id JOIN products p ON si.product_id=p.id WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.status='completed'${branchS} GROUP BY si.product_id ORDER BY qty DESC LIMIT 15`).all(start, end);
    const byCategory = db.prepare(`SELECT c.name as category,SUM(si.quantity) as qty,SUM(si.subtotal) as revenue FROM sale_items si JOIN sales s ON si.sale_id=s.id JOIN products p ON si.product_id=p.id JOIN categories c ON p.category_id=c.id WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.status='completed'${branchS} GROUP BY c.id ORDER BY revenue DESC`).all(start, end);
    const byCashier = db.prepare(`SELECT u.full_name,COUNT(*) as transactions,SUM(s.total) as revenue FROM sales s JOIN users u ON s.cashier_id=u.id WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.status='completed'${branchS} GROUP BY s.cashier_id ORDER BY revenue DESC`).all(start, end);
    const byChannel = db.prepare(`SELECT channel,COUNT(*) as count,SUM(total) as revenue FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND status='completed'${branch} GROUP BY channel ORDER BY revenue DESC`).all(start, end);
    res.json({ period:{start,end}, summary, by_product:byProduct, by_category:byCategory, by_cashier:byCashier, by_channel:byChannel });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// STOCK REPORT — pakai product_stock baru
router.get('/stock', (req, res) => {
  try {
    const stocks = db.prepare(`
      SELECT b.id as branch_id, b.name as branch_name,
        COALESCE(SUM(ps.current_stock),0) as current_stock
      FROM branches b
      LEFT JOIN product_stock ps ON b.id=ps.branch_id
      LEFT JOIN products p ON ps.product_id=p.id AND p.is_active=1 AND p.track_stock=1
      WHERE b.is_active=1
      GROUP BY b.id
    `).all();
    const products = db.prepare(`SELECT p.*,c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.is_active=1 ORDER BY p.name`).all();
    const totalStock = stocks.reduce((s,x)=>s+(x.current_stock||0),0);
    res.json({ mochi_stocks: stocks, stocks, total_stock: totalStock, products, summary:{ total_products: products.length } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// EXPENSE REPORT
router.get('/expenses', (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const start = start_date || awalBulanWib();
    const end   = end_date   || todayWib();
    const byCategory = db.prepare(`SELECT ec.name as category, ec.is_hpp, COUNT(e.id) as count, COALESCE(SUM(e.amount),0) as total FROM expense_categories ec LEFT JOIN expenses e ON ec.id=e.category_id AND e.expense_date BETWEEN ? AND ?${bfExp(req)} GROUP BY ec.id ORDER BY ec.is_hpp DESC, total DESC`).all(start, end);
    const detail = db.prepare(`SELECT e.*,ec.name as category_name,ec.is_hpp,u.full_name as created_by_name,b.name as branch_name FROM expenses e LEFT JOIN expense_categories ec ON e.category_id=ec.id LEFT JOIN users u ON e.created_by=u.id LEFT JOIN branches b ON e.branch_id=b.id WHERE e.expense_date BETWEEN ? AND ?${bfExp(req)} ORDER BY e.expense_date DESC`).all(start, end);
    res.json({ period:{start,end}, by_category:byCategory, detail, total:detail.reduce((s,e)=>s+e.amount,0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
