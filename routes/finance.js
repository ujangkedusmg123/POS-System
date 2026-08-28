const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authMiddleware, adminOnly, requirePerm } = require('../middleware/auth');
const db = { prepare: (...a) => getDb().prepare(...a) };

router.use(authMiddleware);
router.use(requirePerm('finance.view'));

const CONST_KEYS = {
  hpp_resep: 'prod_hpp_resep', harga_jual: 'prod_harga_jual', hpp_packaging: 'prod_hpp_packaging',
  opex_harian: 'prod_opex_harian', pcs_per_porsi: 'prod_pcs_per_porsi', pcs_per_resep: 'prod_pcs_per_resep',
};
const DEFAULTS = { hpp_resep: 65040, harga_jual: 14000, hpp_packaging: 1100, opex_harian: 650000, pcs_per_porsi: 4, pcs_per_resep: 37 };

function getConfig() {
  const cfg = { ...DEFAULTS };
  Object.entries(CONST_KEYS).forEach(([k, sk]) => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(sk);
    if (row && row.value !== null && row.value !== '') cfg[k] = parseFloat(row.value);
  });
  if (!cfg.pcs_per_porsi || cfg.pcs_per_porsi <= 0) cfg.pcs_per_porsi = 4;
  if (!cfg.pcs_per_resep || cfg.pcs_per_resep <= 0) cfg.pcs_per_resep = 37;
  // HPP per porsi TERGENERATE dari resep: bahan + packaging
  const porsiPerResep = cfg.pcs_per_resep / cfg.pcs_per_porsi;             // mis. 37/4 = 9,25 porsi/resep
  cfg.hpp_bahan_per_porsi = porsiPerResep > 0 ? cfg.hpp_resep / porsiPerResep : 0; // mis. 65.040/9,25
  cfg.hpp_per_porsi = cfg.hpp_bahan_per_porsi + cfg.hpp_packaging;         // total HPP per porsi
  cfg.porsi_per_resep = porsiPerResep;
  return cfg;
}

// GET /daily — P&L harian dari penjualan nyata, HPP tergenerate per porsi
router.get('/daily', (req, res) => {
  try {
    const { start, end, branch_id } = req.query;
    const cfg = getConfig();

    let q = `SELECT date(created_at) AS d, COUNT(*) AS orders,
                    SUM(total) AS revenue, SUM(discount_amount) AS discount
             FROM sales WHERE status='completed'`;
    const p = [];
    if (start) { q += ' AND date(created_at) >= ?'; p.push(start); }
    if (end)   { q += ' AND date(created_at) <= ?'; p.push(end); }
    if (branch_id) { q += ' AND branch_id = ?'; p.push(branch_id); }
    q += ' GROUP BY date(created_at) ORDER BY d ASC';
    const raw = db.prepare(q).all(...p);

    const hargaJual = cfg.harga_jual || 1;
    const costRatio = cfg.hpp_per_porsi / hargaJual; // proporsi HPP terhadap harga per porsi

    const rows = raw.map(r => {
      const revenue = r.revenue || 0;
      const porsi = hargaJual > 0 ? revenue / hargaJual : 0;   // estimasi porsi dari omzet
      const hppBahan = porsi * cfg.hpp_bahan_per_porsi;
      const packaging = porsi * cfg.hpp_packaging;
      const hpp = hppBahan + packaging;                         // HPP tergenerate by porsi
      const grossMargin = revenue - hpp;
      const grossMarginPct = revenue > 0 ? grossMargin / revenue : 0;
      const opex = cfg.opex_harian;                            // opex per hari aktif
      const surplus = grossMargin - opex;
      const surplusPct = revenue > 0 ? surplus / revenue : 0;
      return {
        date: r.d, orders: r.orders, discount: r.discount || 0,
        revenue, porsi, hpp_bahan: hppBahan, packaging, hpp,
        gross_margin: grossMargin, gross_margin_pct: grossMarginPct,
        opex, surplus, surplus_pct: surplusPct,
      };
    });

    const sum = (f) => rows.reduce((s, r) => s + r[f], 0);
    const totRev = sum('revenue');
    const summary = {
      days: rows.length,
      total_orders: sum('orders'),
      total_revenue: totRev,
      total_porsi: sum('porsi'),
      total_hpp: sum('hpp'),
      total_packaging: sum('packaging'),
      total_gross_margin: sum('gross_margin'),
      total_opex: sum('opex'),
      total_surplus: sum('surplus'),
      avg_gross_margin_pct: totRev > 0 ? sum('gross_margin') / totRev : 0,
      avg_surplus_pct: totRev > 0 ? sum('surplus') / totRev : 0,
      avg_revenue_per_day: rows.length ? totRev / rows.length : 0,
    };
    res.json({ config: cfg, rows, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.getConfig = getConfig;
