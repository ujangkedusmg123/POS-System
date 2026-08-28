const API_BASE = '/api';

const Auth = {
  getToken: () => sessionStorage.getItem('pos_token'),
  getUser: () => JSON.parse(sessionStorage.getItem('pos_user') || 'null'),
  isLoggedIn: () => !!sessionStorage.getItem('pos_token'),
  logout() { sessionStorage.removeItem('pos_token'); sessionStorage.removeItem('pos_user'); window.location.replace('/login.html'); },
  requireAuth() { if (!this.isLoggedIn()) window.location.replace('/login.html'); },

  /**
   * Pastikan sesi benar-benar sah menurut SERVER, bukan sekadar "ada token di
   * localStorage". Token JWT kedaluwarsa setelah 12 jam; tanpa pemeriksaan ini
   * pengguna dengan token basi tetap masuk ke sistem dan melihat halaman kosong
   * yang gagal memuat data, bukan diarahkan ke halaman login.
   * Hasilnya di-cache singkat agar tidak menambah request di tiap pindah halaman.
   */
  async validateSession() {
    if (!this.isLoggedIn()) { window.location.replace('/login.html'); return false; }
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { Authorization: `Bearer ${this.getToken()}` },
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) { this.logout(); return false; }
      if (!res.ok) return true; // server bermasalah — jangan tendang pengguna keluar
      const me = await res.json();
      // Segarkan data pengguna (hak akses bisa berubah dari sisi admin)
      const cur = this.getUser() || {};
      sessionStorage.setItem('pos_user', JSON.stringify(Object.assign({}, cur, me)));
      return true;
    } catch (e) {
      return true; // offline — biarkan tetap bekerja dengan data lokal
    }
  },
};

const API = {
  async request(method, endpoint, data=null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = Auth.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (data && method !== 'GET') opts.body = JSON.stringify(data);
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, opts);
      // 401 = token hilang/kadaluarsa -> harus login ulang.
      // 403 = login valid tapi tidak punya hak akses -> JANGAN logout,
      //       cukup tampilkan pesannya (dulu kasir ikut tertendang keluar).
      if (res.status === 401) { Auth.logout(); throw new Error('Sesi berakhir, silakan login ulang'); }
      let json = null;
      try { json = await res.json(); } catch(e) { json = null; }
      if (!res.ok) throw new Error((json && json.error) || `Terjadi kesalahan (${res.status})`);
      return json;
    } catch(e) {
      if (e.name === 'TypeError') throw new Error('Tidak dapat terhubung ke server');
      throw e;
    }
  },
  get: (ep) => API.request('GET', ep),
  post: (ep, d) => API.request('POST', ep, d),
  put: (ep, d) => API.request('PUT', ep, d),
  patch: (ep, d) => API.request('PATCH', ep, d),
  delete: (ep) => API.request('DELETE', ep),
};

/* Zona waktu tunggal untuk seluruh aplikasi. Server menyimpan tanggal & jam
   dalam WIB; tampilannya juga dipaksa WIB supaya perangkat yang zona waktunya
   berbeda (laptop pribadi, tablet yang jamnya salah setelan) tetap menunjukkan
   jam yang sama dengan struk dan laporan. */
const TZ = 'Asia/Jakarta';
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const fmt = {
  currency: (n) => 'Rp ' + (n||0).toLocaleString('id-ID'),
  number: (n) => (n||0).toLocaleString('id-ID'),
  percent: (n) => (n||0).toFixed(1) + '%',
  /**
   * Ubah nilai dari server jadi Date.
   *
   * Ada dua bentuk yang beredar dan artinya BERBEDA:
   *   1. "YYYY-MM-DD HH:MM:SS" (dari database)  -> angka jamnya sudah WIB
   *   2. "....T....Z" / "+07:00" (ISO-8601)     -> sudah menyebut zona waktunya
   *
   * Bentuk pertama harus dibaca sebagai WIB. Bentuk kedua TIDAK boleh diperlakukan
   * begitu — kalau ISO UTC ikut dianggap WIB, jam di struk meleset 7 jam
   * (14.46 UTC tampil sebagai 14.46, padahal seharusnya 21.46 WIB).
   */
  _parse: (d) => {
    if (!d) return null;
    if (d instanceof Date) return d;
    const s = String(d).trim();
    const punyaZona = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
    const m = punyaZona ? null : s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - WIB_OFFSET_MS);
    }
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt;
  },
  /** 'YYYY-MM-DD HH:MM:SS' waktu WIB — sama bentuknya dengan yang disimpan server. */
  nowWibSql: () => {
    const w = new Date(Date.now() + WIB_OFFSET_MS);
    return w.toISOString().slice(0, 19).replace('T', ' ');
  },
  date: (d) => { const dt = fmt._parse(d); return dt ? dt.toLocaleDateString('id-ID', {timeZone:TZ,day:'2-digit',month:'short',year:'numeric'}) : '-'; },
  dateTime: (d) => { const dt = fmt._parse(d); return dt ? dt.toLocaleString('id-ID', {timeZone:TZ,day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '-'; },
  time: (d) => { const dt = fmt._parse(d); return dt ? dt.toLocaleTimeString('id-ID', {timeZone:TZ,hour:'2-digit',minute:'2-digit'}) : '-'; },
};

/** Download tabular data sebagai CSV (langsung dibuka di Excel). rows[0] = header. */
function downloadCsv(rows, filename='export.csv') {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n;]/.test(s) ? `"${s}"` : s;
  };
  const csv = '\ufeff' + rows.map(r => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

/* ==========================================================================
   UNDUH EXCEL
   Semua laporan memakai satu jalur yang sama: data yang sedang tampil dikirim
   ke server, server merapikannya jadi .xlsx (judul, format Rupiah, header beku,
   filter, baris TOTAL), lalu berkasnya diunduh. Dengan begitu format tiap
   laporan konsisten dan tidak perlu diulang di tiap halaman.
   ========================================================================== */

/**
 * @param {object} spec { filename, sheets:[{ name, title, meta, columns, rows, totals }] }
 *   columns: [{ header, key, width, type }]  type: text|number|money|decimal|percent|date|datetime
 *   rows:    array of object (pakai key) ATAU array of array (urut kolom)
 *   totals:  object/array opsional -> jadi baris TOTAL tebal di bawah
 */
async function downloadExcel(spec, btn) {
  const label = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '\u23f3 Menyiapkan...'; }
  try {
    const res = await fetch(`${API_BASE}/export/xlsx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Auth.getToken()}` },
      body: JSON.stringify(spec),
    });
    if (!res.ok) {
      let pesan = `Gagal membuat file (${res.status})`;
      try { const j = await res.json(); if (j && j.error) pesan = j.error; } catch (e) {}
      throw new Error(pesan);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (spec.filename || 'laporan').replace(/\.xlsx$/i, '') + '.xlsx';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('File Excel berhasil diunduh', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}

/** Keterangan periode & cabang yang lazim dipakai di kepala laporan. */
function excelMeta(extra) {
  const u = Auth.getUser() || {};
  const rows = [['Dicetak', new Date().toLocaleString('id-ID', { timeZone: TZ, dateStyle: 'long', timeStyle: 'short' }) + ' WIB'], ['Oleh', u.full_name || '-']];
  return (extra || []).concat(rows);
}

/**
 * Bikin tabel bisa di-sort dengan klik header.
 * Tiap <th> boleh punya data-nosort="true" agar tidak sortable.
 * Tiap <td> boleh punya data-sort-value="..." untuk sort key numerik/tanggal.
 */
function makeSortable(tableEl) {
  if (!tableEl || tableEl.dataset._sortable === '1') return;
  tableEl.dataset._sortable = '1';
  const ths = tableEl.querySelectorAll('thead th');
  ths.forEach((th, idx) => {
    if (th.dataset.nosort === 'true') return;
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    if (!th.querySelector('.sort-arrow')) {
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.style.cssText = 'margin-left:4px;opacity:0.35;font-size:10px';
      arrow.textContent = '⇅';
      th.appendChild(arrow);
    }
    th.addEventListener('click', () => sortTableByCol(tableEl, idx));
  });
}

function sortTableByCol(tableEl, colIdx) {
  const tbody = tableEl.querySelector('tbody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  if (!rows.length) return;
  // Toggle direction
  const currentDir = tableEl.dataset._sortCol == colIdx ? (tableEl.dataset._sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
  tableEl.dataset._sortCol = colIdx;
  tableEl.dataset._sortDir = currentDir;

  const getVal = (row) => {
    const cell = row.children[colIdx];
    if (!cell) return '';
    const v = cell.dataset.sortValue !== undefined ? cell.dataset.sortValue : cell.textContent.trim();
    const n = parseFloat(v);
    return !isNaN(n) && String(n) === String(v).replace(/[,.]/g,'') ? n : v.toLowerCase();
  };
  rows.sort((a,b) => {
    const va = getVal(a), vb = getVal(b);
    if (va < vb) return currentDir === 'asc' ? -1 : 1;
    if (va > vb) return currentDir === 'asc' ? 1 : -1;
    return 0;
  });
  rows.forEach(r => tbody.appendChild(r));
  // Update arrows
  tableEl.querySelectorAll('.sort-arrow').forEach((a,i) => {
    a.textContent = i === colIdx ? (currentDir === 'asc' ? '▲' : '▼') : '⇅';
    a.style.opacity = i === colIdx ? '1' : '0.35';
  });
}

function showToast(message, type='info', duration=3500) {
  let c = document.getElementById('toast-container');
  if (!c) { c = document.createElement('div'); c.id='toast-container'; c.className='toast-container'; document.body.appendChild(c); }
  const icons = {success:'✅',error:'❌',warning:'⚠️',info:'ℹ️'};
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ️'}</span><span style="flex:1">${message}</span><span class="toast-close" onclick="this.parentElement.remove()">✕</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(20px)'; t.style.transition='all 0.3s'; setTimeout(()=>t.remove(),300); }, duration);
}

function openModal(id) { document.getElementById(id)?.classList.add('show'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('show'); }

function confirmDialog(message, onConfirm, title='Konfirmasi') {
  let m = document.getElementById('confirm-modal');
  if (!m) {
    m = document.createElement('div'); m.id='confirm-modal'; m.className='modal-overlay';
    document.body.appendChild(m);
  }
  m.innerHTML = `<div class="modal-box" style="max-width:400px">
    <div class="modal-header"><span class="modal-title">${title}</span></div>
    <div class="modal-body"><p style="font-size:14px;color:var(--text-secondary)">${message}</p></div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal('confirm-modal')">Batal</button>
      <button class="btn btn-danger" id="confirm-ok-btn">Ya, Lanjutkan</button>
    </div>
  </div>`;
  m.addEventListener('click', (e) => { if(e.target===m) closeModal('confirm-modal'); });
  setTimeout(() => m.classList.add('show'), 10);
  document.getElementById('confirm-ok-btn').onclick = () => { closeModal('confirm-modal'); onConfirm(); };
}

/* ==========================================================================
   HAK AKSES (PERMISSION) — sisi klien
   Catatan: ini hanya untuk kenyamanan UI (menyembunyikan menu/tombol yang
   tidak relevan). Penegakan sebenarnya tetap ada di server; setiap endpoint
   dijaga requirePerm(), jadi menyembunyikan tombol bukan satu-satunya lapisan.
   ========================================================================== */
const Perms = {
  list() {
    const u = Auth.getUser();
    if (!u) return [];
    if (u.role === 'admin') return ['*'];
    return Array.isArray(u.permissions) ? u.permissions : [];
  },
  /** Punya izin tertentu? Mendukung '*' dan 'modul.*'. */
  can(key) {
    const p = this.list();
    if (p.includes('*')) return true;
    if (p.includes(key)) return true;
    return p.includes(String(key).split('.')[0] + '.*');
  },
  /** Punya salah satu dari beberapa izin? */
  any(...keys) { return keys.some((k) => this.can(k)); },
  /** Punya semua izin? */
  all(...keys) { return keys.every((k) => this.can(k)); },
};

/**
 * Sembunyikan elemen yang tidak boleh diakses.
 * Pakai atribut: <button data-perm="products.create">
 * atau data-perm-any="a.b,c.d" (cukup salah satu).
 */
function applyPermissionsToDom(root) {
  (root || document).querySelectorAll('[data-perm]').forEach((el) => {
    if (!Perms.can(el.dataset.perm)) el.style.display = 'none';
  });
  (root || document).querySelectorAll('[data-perm-any]').forEach((el) => {
    const keys = el.dataset.permAny.split(',').map((s) => s.trim()).filter(Boolean);
    if (!Perms.any(...keys)) el.style.display = 'none';
  });
}

/* --------------------------------------------------------------- NAVIGASI */

/** Satu sumber kebenaran menu: tiap item menyebut izin yang dibutuhkan. */
const NAV_MENU = [
  { section: 'UTAMA' },
  { icon: '📊', label: 'Dashboard', href: '/', key: 'dashboard', perm: 'dashboard.view' },
  { icon: '🛒', label: 'Kasir / POS', href: '/pos.html', key: 'pos', perm: 'pos.view' },
  { icon: '🔐', label: 'Buka / Tutup Kasir', href: '/kasir-shift.html', key: 'shift', perm: 'pos.session_open' },
  { icon: '👨‍🍳', label: 'Dapur / Antrian Masak', href: '/kitchen.html', key: 'kitchen', perm: 'kitchen.view' },

  { section: 'PRODUK & STOK' },
  { icon: '🦐', label: 'Produk', href: '/products.html', key: 'products', perm: 'products.view' },
  { icon: '🧮', label: 'Monitoring Stok', href: '/stock.html', key: 'stock', perm: 'stock.view' },
  { icon: '↔️', label: 'Transfer Stok', href: '/stock-transfer.html', key: 'transfer', perm: 'stock.transfer' },
  { icon: '🥣', label: 'Bahan Baku', href: '/bahan.html', key: 'bahan', perm: 'bahan.view' },

  { section: 'TRANSAKSI' },
  { icon: '💰', label: 'Riwayat Penjualan', href: '/sales.html', key: 'sales', perm: 'sales.view' },
  { icon: '📋', label: 'Laporan Kasir', href: '/shift-reports.html', key: 'shift-reports', perm: 'shift.report,shift.view_all,shift.view_own' },
  { icon: '👥', label: 'Pelanggan', href: '/customers.html', key: 'customers', perm: 'customers.view' },

  { section: 'KEUANGAN' },
  { icon: '📈', label: 'Dashboard Keuangan', href: '/finance.html', key: 'finance', perm: 'finance.view' },
  { icon: '🏭', label: 'Produksi & Surplus', href: '/production.html', key: 'production', perm: 'production.view' },
  { icon: '💳', label: 'Dompet & Kas Kecil', href: '/wallets.html', key: 'wallets', perm: 'wallets.view' },
  { icon: '📋', label: 'Beban & Pengeluaran', href: '/expenses.html', key: 'expenses', perm: 'expenses.view' },
  { icon: '📈', label: 'Laporan Keuangan', href: '/reports.html', key: 'reports', perm: 'reports.view' },

  { section: 'MANAJEMEN' },
  { icon: '🏪', label: 'Cabang', href: '/branches.html', key: 'branches', perm: 'branches.view' },
  { icon: '📡', label: 'Channel Penjualan', href: '/channels.html', key: 'channels', perm: 'channels.view' },
  { icon: '👤', label: 'Manajemen User', href: '/users.html', key: 'users', perm: 'users.view' },
  { icon: '🛡️', label: 'Role & Hak Akses', href: '/roles.html', key: 'roles', perm: 'roles.view' },
  { icon: '📜', label: 'Log Aktivitas', href: '/activity.html', key: 'activity', perm: 'activity.view' },

  { section: 'PENGATURAN' },
  { icon: '🖨️', label: 'Struk Default', href: '/struk.html', key: 'struk', perm: 'settings.receipt' },
  { icon: '🧾', label: 'Struk Custom', href: '/struk-custom.html', key: 'struk-custom', perm: 'settings.receipt_custom' },
  { icon: '💳', label: 'Termin Pembayaran', href: '/payment-methods.html', key: 'payment-methods', perm: 'settings.payment' },
  { icon: '🎨', label: 'Tampilan Login', href: '/login-settings.html', key: 'login-settings', perm: 'settings.login' },
  { icon: '⚙️', label: 'Pengaturan', href: '/pengaturan.html', key: 'pengaturan', perm: 'settings.view' },
];

/** Item pertama yang boleh diakses user — dipakai untuk redirect. */
function firstAllowedPage() {
  const item = NAV_MENU.find((i) => !i.section && navItemAllowed(i));
  return item ? item.href : '/pos.html';
}

function navItemAllowed(item) {
  if (!item.perm) return true;
  return Perms.any(...String(item.perm).split(',').map((s) => s.trim()));
}

function setupSidebar(activePage) {
  const user = Auth.getUser();
  if (!user) return;
  const nav = document.getElementById('sidebar-nav');
  if (!nav) return;

  // Saring menu sesuai izin, lalu buang judul section yang jadi kosong
  const visible = NAV_MENU.filter((i) => i.section || navItemAllowed(i));
  const cleaned = visible.filter((item, idx) => {
    if (!item.section) return true;
    const next = visible.slice(idx + 1).find((x) => true);
    return !!(next && !next.section); // ada isinya tepat setelah judul
  });

  nav.innerHTML = cleaned.map((item) => {
    if (item.section) return `<div class="nav-section-title">${item.section}</div>`;
    return `<a href="${item.href}" class="nav-item ${activePage === item.key ? 'active' : ''}">
      <span class="nav-icon">${item.icon}</span><span class="nav-label">${item.label}</span></a>`;
  }).join('');

  const isAdmin = user.role === 'admin';
  const avatar = document.getElementById('user-avatar');
  if (avatar) avatar.textContent = (user.full_name || '?').charAt(0).toUpperCase();
  const nameEl = document.getElementById('user-name');
  if (nameEl) nameEl.textContent = user.full_name || '-';
  const roleEl = document.getElementById('user-role');
  if (roleEl) {
    const roleLabel = user.role_name || (isAdmin ? 'Administrator' : 'Kasir');
    roleEl.innerHTML = (isAdmin ? '👑 ' : '💼 ') + roleLabel +
      (user.branch_name ? `<br><span style='font-size:11px;opacity:0.8'>🏪 ${user.branch_name}</span>` : '');
  }
}

/**
 * Inisialisasi halaman: cek login, tegakkan hak akses, gambar sidebar.
 * Gerbang akses sekarang berbasis permission (bukan lagi daftar admin-only),
 * jadi role buatan sendiri ikut dihormati.
 */
function initPage(pageKey, pageTitle, pageSubtitle) {
  Auth.requireAuth();
  // Validasi sesi ke server (token bisa saja sudah kedaluwarsa)
  Auth.validateSession();
  const user = Auth.getUser();
  if (!user) return;

  const item = NAV_MENU.find((i) => i.key === pageKey);
  if (item && !navItemAllowed(item)) {
    const target = firstAllowedPage();
    showToast('Anda tidak punya hak akses ke halaman tersebut', 'warning');
    setTimeout(() => { window.location.href = target; }, 800);
    return false;
  }

  document.title = `${pageTitle} — Ujang Kedu`;
  setupSidebar(pageKey);
  setupMobileMenu();
  const t = document.getElementById('page-title');
  if (t) t.textContent = pageTitle;
  const st = document.getElementById('page-subtitle');
  if (st) st.textContent = pageSubtitle || '';
  applyPermissionsToDom();
  return true;
}

function setupMobileMenu() {
  // Cegah double-inject
  if (document.getElementById('mobile-menu-toggle')) return;
  const btn = document.createElement('button');
  btn.id = 'mobile-menu-toggle';
  btn.innerHTML = '☰';
  btn.setAttribute('aria-label','Menu');
  document.body.appendChild(btn);
  const bd = document.createElement('div');
  bd.id = 'sidebar-backdrop';
  document.body.appendChild(bd);
  const sidebar = document.getElementById('sidebar');
  btn.onclick = () => { sidebar?.classList.add('open'); bd.classList.add('open'); };
  bd.onclick = () => { sidebar?.classList.remove('open'); bd.classList.remove('open'); };
  // Auto-close saat klik nav item
  sidebar?.querySelectorAll('a').forEach(a => a.addEventListener('click', ()=>{ sidebar.classList.remove('open'); bd.classList.remove('open'); }));
}

/** Date yang komponennya (getFullYear, getHours, ...) sudah bernilai WIB. */
function wibNow(base) {
  const d = base ? new Date(base) : new Date();
  return new Date(d.getTime() + (7 * 60 + d.getTimezoneOffset()) * 60000);
}
function ymdWib(d) {
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
/** 'YYYY-MM-DD' hari ini menurut WIB — dipakai semua filter tanggal. */
function getToday() { return ymdWib(wibNow()); }
function getMonthStart() { return getToday().substring(0, 7) + '-01'; }
/** Tanggal N hari yang lalu menurut WIB. */
function daysAgoLocal(n) {
  const d = wibNow();
  d.setDate(d.getDate() - n);
  return ymdWib(d);
}
const todayLocal = getToday;

/* ==========================================================================
   MODUL STRUK & CETAK  (v2)
   Perbaikan utama:
   1. Logo TIDAK ikut tercetak  -> sekarang logo di-resolve jadi data URL,
      lalu proses cetak MENUNGGU gambar benar-benar selesai dimuat/decode
      sebelum window.print() dipanggil.
   2. Cache pengaturan struk permanen -> sekarang pakai TTL + auto-refresh,
      jadi logo yang baru disimpan admin langsung terpakai di device kasir.
   3. Dokumen struk tidak punya <meta charset> -> teks/emoji berantakan.
   4. Printer Bluetooth (ESC/POS) tidak pernah mengirim logo sama sekali
      -> sekarang logo dikonversi jadi raster bitmap (GS v 0) + dithering.
   5. Teks dari pengaturan/nama produk di-escape (anti rusak layout & XSS).
   ========================================================================== */

/** Escape teks agar aman & tidak merusak layout saat disisipkan ke HTML struk. */
function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Profil kertas: lebar cetak, jumlah karakter/baris, dan lebar dot printer. */
const PAPER_PROFILES = {
  '58': { pageMm: 58, contentMm: 48, chars: 32, dots: 384 },
  '80': { pageMm: 80, contentMm: 72, chars: 48, dots: 576 },
};
function getPaperProfile(s) {
  return PAPER_PROFILES[String((s && s.receipt_paper) || '58')] || PAPER_PROFILES['58'];
}
/** Lebar logo dalam persen dari lebar area cetak (default 55%). */
function getLogoWidthPct(s) {
  const n = parseInt((s && s.receipt_logo_width) || '55', 10);
  if (isNaN(n)) return 55;
  return Math.min(100, Math.max(15, n));
}
function isLogoEnabled(s) {
  return (s && s.receipt_show_logo) !== '0';
}
/**
 * Margin dalam struk (mm) di kiri-kanan. Dulu nilainya 0, sehingga teks
 * menempel ke tepi kertas dan sebagian karakter terpotong di banyak printer
 * thermal (area cetak sebenarnya selalu sedikit lebih sempit dari kertas).
 * Default 3mm; bisa diatur 0-8mm lewat Pengaturan Struk.
 */
function getReceiptMargin(s) {
  const n = parseFloat((s && s.receipt_margin) != null && s.receipt_margin !== '' ? s.receipt_margin : '3');
  if (isNaN(n)) return 3;
  return Math.min(8, Math.max(0, n));
}

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ---------------------------------------------------------------- SETTINGS */

const RECEIPT_CACHE_KEY = 'pos_receipt_settings';
const RECEIPT_CACHE_TTL = 60 * 1000; // 60 detik

function _readReceiptCache() {
  try {
    const raw = localStorage.getItem(RECEIPT_CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  } catch (e) { return null; }
}

/**
 * Ambil pengaturan struk. Cache hanya berlaku RECEIPT_CACHE_TTL supaya
 * perubahan logo dari admin cepat menyebar ke semua device.
 * Kalau server tidak bisa dihubungi, jatuh ke cache lama (tetap bisa cetak).
 */
async function getReceiptSettings(force) {
  const cached = _readReceiptCache();
  const fresh = cached && cached._ts && (Date.now() - cached._ts) < RECEIPT_CACHE_TTL;
  if (!force && fresh) return cached;
  try {
    const data = await API.get('/settings');
    if (data && typeof data === 'object') {
      data._ts = Date.now();
      try { localStorage.setItem(RECEIPT_CACHE_KEY, JSON.stringify(data)); }
      catch (e) { /* kuota localStorage penuh — abaikan, cetak tetap jalan */ }
      return data;
    }
  } catch (e) { /* offline / server mati */ }
  return cached || {};
}

/** Hapus cache pengaturan (dipanggil setelah admin menyimpan pengaturan struk). */
function clearReceiptCache() {
  try { localStorage.removeItem(RECEIPT_CACHE_KEY); } catch (e) {}
  _logoDataUrlCache.clear();
  _logoRasterCache.clear();
}

/* -------------------------------------------------------------------- LOGO */

const _logoDataUrlCache = new Map();
const _logoRasterCache = new Map();

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gambar logo gagal dimuat'));
    img.src = src;
  });
}

/**
 * Pastikan logo berbentuk data URL.
 * Ini KUNCI perbaikan: data URL selalu ter-render di jendela cetak / iframe,
 * tidak terpengaruh CORS, hotlink protection, atau koneksi lambat.
 */
async function resolveLogoDataUrl(src) {
  if (!src) return '';
  if (/^data:image\//i.test(src)) return src;
  if (_logoDataUrlCache.has(src)) return _logoDataUrlCache.get(src);
  try {
    const res = await fetch(src, { mode: 'cors', cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!/^image\//.test(blob.type || '')) throw new Error('Bukan gambar');
    const url = await new Promise((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = () => no(new Error('Gagal membaca gambar'));
      r.readAsDataURL(blob);
    });
    _logoDataUrlCache.set(src, url);
    return url;
  } catch (e) {
    // CORS / offline: pakai URL asli, browser mungkin masih bisa memuatnya
    _logoDataUrlCache.set(src, src);
    return src;
  }
}

/**
 * Perkecil + kompres logo di sisi klien sebelum disimpan.
 * Hasil: PNG data URL, lebar maksimum `maxWidth` dot (default 384 = 58mm).
 * Tujuan: logo ringan, tidak memenuhi DB/localStorage, dan tajam di printer.
 */
async function normalizeLogoDataUrl(src, maxWidth) {
  return normalizeImageDataUrl(src, maxWidth, 'image/png');
}

/**
 * Perkecil + kompres gambar di sisi klien.
 *
 * Untuk LOGO pakai PNG (tepi tajam, latar transparan).
 * Untuk FOTO LATAR wajib pakai JPEG: foto 1400px yang dikonversi ke PNG bisa
 * membengkak jadi 3-5MB, lalu ditolak oleh batas ukuran — inilah sebabnya
 * unggah gambar latar dulu sering "gagal tanpa alasan".
 *
 * @param {string} src      data URL sumber
 * @param {number} maxWidth lebar maksimum (px)
 * @param {string} mime     'image/png' atau 'image/jpeg'
 * @param {number} quality  0..1, hanya untuk JPEG
 */
async function normalizeImageDataUrl(src, maxWidth, mime, quality) {
  maxWidth = maxWidth || 384;
  mime = mime || 'image/png';
  const img = await loadImageEl(src);
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (!nw || !nh) throw new Error('Ukuran gambar tidak valid');
  const scale = Math.min(1, maxWidth / nw);
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return cv.toDataURL(mime, mime === 'image/jpeg' ? (quality == null ? 0.82 : quality) : undefined);
}

/**
 * Kompres foto latar sampai muat di bawah batas ukuran, dengan menurunkan
 * mutu lalu dimensinya secara bertahap. Mengembalikan null bila tetap gagal,
 * supaya pemanggil bisa memberi pesan yang jelas.
 */
async function compressBackgroundImage(src, maxBytes) {
  maxBytes = maxBytes || 900 * 1024;
  const attempts = [[1600, 0.82], [1400, 0.75], [1200, 0.7], [1000, 0.65], [800, 0.6], [640, 0.55]];
  for (const [w, q] of attempts) {
    try {
      const out = await normalizeImageDataUrl(src, w, 'image/jpeg', q);
      if (out.length <= maxBytes) return out;
    } catch (e) { return null; }
  }
  return null;
}

/* ------------------------------------------------------- HTML STRUK (CETAK) */

/**
 * Bangun dokumen HTML struk yang siap dicetak.
 * @param {object} sale   data transaksi
 * @param {object} s      pengaturan struk
 * @param {object|string} opts  { logo, autoPrint } — string = logo (kompatibel versi lama)
 */
function buildReceiptHTML(sale, s, opts) {
  s = s || {};
  sale = sale || {};
  if (typeof opts === 'string') opts = { logo: opts };
  opts = opts || {};

  const paper = getPaperProfile(s);
  const storeName = s.receipt_store_name || 'Ujang Kedu';
  const tagline   = s.receipt_tagline    || '';
  const address   = s.receipt_address    || '';
  const phone     = s.receipt_phone      || '';
  const instagram = s.receipt_instagram  || '';
  const footer    = s.receipt_footer     || 'Terima kasih sudah membeli!';
  const logo      = isLogoEnabled(s) ? (opts.logo != null ? opts.logo : (s.receipt_logo || '')) : '';
  const logoPct   = getLogoWidthPct(s);
  const marginMm  = getReceiptMargin(s);
  // Lebar teks = area cetak dikurangi margin kiri+kanan
  const innerMm   = Math.max(20, paper.contentMm - marginMm * 2);
  const logoMm    = (innerMm * logoPct / 100).toFixed(1);

  const showCashier  = s.receipt_show_cashier  !== '0';
  const showDatetime = s.receipt_show_datetime !== '0';
  const showInvoice  = s.receipt_show_invoice  !== '0';

  const pmLabel = { cash: 'Tunai', transfer: 'Transfer', qris: 'QRIS' };
  const items = sale.items || [];
  const fmtRp = (n) => 'Rp ' + (parseInt(n, 10) || 0).toLocaleString('id-ID');

  let dtStr = '';
  if (showDatetime && sale.created_at) {
    const d = (typeof fmt !== 'undefined' && fmt._parse) ? fmt._parse(sale.created_at) : new Date(sale.created_at);
    if (d && !isNaN(d.getTime())) {
      dtStr = d.toLocaleString('id-ID', {
        timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    }
  }

  const autoPrintScript = opts.autoPrint
    ? '<' + 'script>window.addEventListener("load",function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},450);});<' + '/script>'
    : '';

  return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Struk ${escHtml(sale.invoice_number || '')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff}
  body{
    font-family:'Courier New',Courier,monospace;
    font-size:12px;line-height:1.35;color:#000;
    width:${paper.contentMm}mm;max-width:100%;
    margin:0 auto;padding:${marginMm}mm ${marginMm}mm ${marginMm + 2}mm;
    -webkit-font-smoothing:none;
  }
  .center{text-align:center}
  .between{display:flex;justify-content:space-between;gap:6px;margin:1px 0}
  .between span:last-child{text-align:right;white-space:nowrap}
  .logo-wrap{text-align:center;margin:0 0 2mm}
  .logo-img{
    width:${logoMm}mm;max-width:100%;height:auto;display:block;margin:0 auto;
    /* Wajib: sebagian browser membuang gambar saat cetak tanpa ini */
    -webkit-print-color-adjust:exact;print-color-adjust:exact;
    image-rendering:-webkit-optimize-contrast;
  }
  .store-name{font-size:16px;font-weight:900;text-align:center;margin:1mm 0;letter-spacing:.3px}
  .store-sub{font-size:11px;text-align:center;margin:0.3mm 0}
  hr{border:none;border-top:1px dashed #000;margin:1.6mm 0}
  .item-name{font-weight:bold;margin-top:1.2mm;word-break:break-word}
  .total-row{display:flex;justify-content:space-between;font-weight:900;font-size:13px;
             border-top:1px solid #000;padding-top:1.2mm;margin-top:1.2mm}
  .footer{text-align:center;font-size:11px;margin-top:2mm;white-space:pre-line;word-break:break-word}
  @media print{
    @page{size:${paper.pageMm}mm auto;margin:0}
    html,body{width:${paper.contentMm}mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    body{padding:${marginMm}mm ${marginMm}mm ${marginMm + 4}mm}
  }
</style></head>
<body>
${logo ? `<div class="logo-wrap"><img src="${escHtml(logo)}" alt="" class="logo-img"></div>` : ''}
<div class="store-name">${escHtml(storeName)}</div>
${tagline   ? `<div class="store-sub">${escHtml(tagline)}</div>`   : ''}
${address   ? `<div class="store-sub">${escHtml(address)}</div>`   : ''}
${phone     ? `<div class="store-sub">${escHtml(phone)}</div>`     : ''}
${instagram ? `<div class="store-sub">${escHtml(instagram)}</div>` : ''}
<hr>
${showInvoice && sale.invoice_number ? `<div class="between"><span>Invoice</span><span>${escHtml(sale.invoice_number)}</span></div>` : ''}
${dtStr ? `<div class="between"><span>Waktu</span><span>${escHtml(dtStr)}</span></div>` : ''}
${showCashier && sale.cashier_name ? `<div class="between"><span>Kasir</span><span>${escHtml(sale.cashier_name)}</span></div>` : ''}
${sale.customer_name && sale.customer_name !== 'Pelanggan Umum' ? `<div class="between"><span>Pelanggan</span><span>${escHtml(sale.customer_name)}</span></div>` : ''}
<hr>
${items.map(i => `<div class="item-name">${escHtml(i.product_name)}</div>
<div class="between"><span>${escHtml(i.quantity)} x ${fmtRp(i.sell_price)}</span><span>${fmtRp(i.subtotal)}</span></div>`).join('')}
<hr>
${(sale.discount_amount || 0) > 0 ? `<div class="between"><span>Diskon</span><span>-${fmtRp(sale.discount_amount)}</span></div>` : ''}
<div class="total-row"><span>TOTAL</span><span>${fmtRp(sale.total)}</span></div>
<div class="between" style="margin-top:1mm"><span>Bayar (${escHtml(pmLabel[sale.payment_method] || sale.payment_method || '')})</span><span>${fmtRp(sale.payment_amount)}</span></div>
${(sale.change_amount || 0) > 0 ? `<div class="between"><span>Kembalian</span><span>${fmtRp(sale.change_amount)}</span></div>` : ''}
<hr>
<div class="footer">${escHtml(footer)}</div>
${autoPrintScript}
</body></html>`;
}

/* ------------------------------------------------------------ PROSES CETAK */

/** Tunggu SEMUA gambar di dalam dokumen selesai dimuat (inti perbaikan logo). */
function waitForImages(win, timeout) {
  timeout = timeout || 5000;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, timeout);
    let imgs;
    try { imgs = Array.from(win.document.images || []); } catch (e) { return finish(); }
    if (!imgs.length) return finish();
    let pending = imgs.length;
    const one = () => { if (--pending <= 0) finish(); };
    imgs.forEach((img) => {
      if (img.complete) {
        // sudah selesai (berhasil atau gagal)
        if (img.naturalWidth === 0) img.style.display = 'none';
        return one();
      }
      const ok = () => {
        if (img.decode) { img.decode().then(one, one); } else { one(); }
      };
      img.addEventListener('load', ok, { once: true });
      img.addEventListener('error', () => { img.style.display = 'none'; one(); }, { once: true });
    });
  });
}

function nextPaint() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));
}

/** Cetak dokumen HTML lewat iframe tersembunyi (anti popup-blocker). */
async function printHtmlDocument(html) {
  // iOS/Safari tidak mendukung print() dari iframe -> pakai jendela baru
  if (IS_IOS) return openPrintWindow(html);

  document.getElementById('__print_frame')?.remove();
  const ifr = document.createElement('iframe');
  ifr.id = '__print_frame';
  ifr.setAttribute('aria-hidden', 'true');
  ifr.title = 'Struk';
  // PENTING: jangan width/height 0 atau visibility:hidden — sebagian browser
  // tidak me-render (dan tidak mencetak) gambar di dalamnya. Sembunyikan
  // dengan memindahkannya ke luar layar tapi tetap punya dimensi nyata.
  ifr.style.cssText = 'position:fixed;left:-10000px;top:0;width:80mm;height:600px;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(ifr);

  const win = ifr.contentWindow;
  if (!win) { ifr.remove(); return openPrintWindow(html); }

  try {
    const doc = win.document;
    doc.open(); doc.write(html); doc.close();

    await new Promise((r) => {
      if (doc.readyState === 'complete') return r();
      let settled = false;
      const done = () => { if (!settled) { settled = true; r(); } };
      win.addEventListener('load', done, { once: true });
      setTimeout(done, 2000);
    });

    await waitForImages(win);   // <- logo dijamin sudah ada sebelum cetak
    await nextPaint();

    let cleaned = false;
    const cleanup = () => { if (!cleaned) { cleaned = true; setTimeout(() => ifr.remove(), 500); } };
    win.onafterprint = cleanup;
    window.addEventListener('focus', cleanup, { once: true });
    setTimeout(cleanup, 60000); // jaring pengaman

    win.focus();
    win.print();
  } catch (e) {
    ifr.remove();
    openPrintWindow(html);
  }
}

/** Cadangan: cetak lewat jendela baru (auto-print setelah gambar siap). */
function openPrintWindow(html) {
  const doc = html.indexOf('window.print()') !== -1
    ? html
    : html.replace('</body>', '<' + 'script>window.addEventListener("load",function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},450);});<' + '/script></body>');
  const w = window.open('', '_blank');
  if (!w) {
    showToast('Cetak gagal: pop-up diblokir. Izinkan pop-up untuk situs ini, atau gunakan tombol Cetak Bluetooth.', 'warning', 6000);
    return;
  }
  w.document.open(); w.document.write(doc); w.document.close();
}

let _printBusy = false;

/** Cetak struk via printer sistem / RawBT. */
async function printReceipt(sale) {
  if (_printBusy) return;
  if (!sale) { showToast('Data transaksi tidak ditemukan', 'error'); return; }
  _printBusy = true;
  try {
    const s = await getReceiptSettings();
    const logo = (isLogoEnabled(s) && s.receipt_logo) ? await resolveLogoDataUrl(s.receipt_logo) : '';
    const html = buildReceiptHTML(sale, s, { logo });
    await printHtmlDocument(html);
  } catch (e) {
    showToast('Gagal mencetak: ' + (e.message || e), 'error');
  } finally {
    setTimeout(() => { _printBusy = false; }, 800);
  }
}

/** Dipertahankan untuk kompatibilitas kode lama. */
function fallbackPrintWindow(html) { openPrintWindow(html); }

/* ==========================================================================
   DOKUMEN A4 (LAPORAN) — TERPISAH DARI STRUK THERMAL

   Struk pelanggan di POS SELALU memakai format thermal (58/80mm) dan hanya
   dikirim ke printer thermal. Sebaliknya, laporan/dokumen administrasi tidak
   boleh memakai format thermal: dulu Laporan Tutup Kasir ikut dicetak dengan
   lebar 72mm dan font Courier, sehingga tidak terbaca di kertas A4.

   Modul di bawah membangun dokumen A4 yang rapi, bisa dicetak ke printer A4
   maupun disimpan sebagai PDF lewat dialog cetak browser, dan bisa diunduh
   sebagai berkas.
   ========================================================================== */

/** CSS bersama untuk semua dokumen A4. */
const A4_STYLE = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;color:#111}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    font-size:11pt;line-height:1.5;
    width:210mm;min-height:297mm;margin:0 auto;padding:16mm 15mm;
  }
  .doc-head{display:flex;align-items:flex-start;gap:14px;border-bottom:2.5px solid #111;padding-bottom:10px;margin-bottom:6px}
  .doc-logo{max-width:26mm;max-height:18mm;object-fit:contain;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .doc-store{flex:1;min-width:0}
  .doc-store h1{font-size:16pt;font-weight:800;letter-spacing:-.2px}
  .doc-store p{font-size:9pt;color:#444;margin-top:1px}
  .doc-title{text-align:right}
  .doc-title h2{font-size:13pt;font-weight:800;text-transform:uppercase;letter-spacing:.5px}
  .doc-title p{font-size:9pt;color:#444;margin-top:2px}
  .doc-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(46mm,1fr));gap:5px 16px;
            margin:12px 0 16px;font-size:9.5pt}
  .doc-meta div{display:flex;gap:6px}
  .doc-meta span:first-child{color:#555;min-width:26mm}
  .doc-meta span:last-child{font-weight:600}
  h3.sec{font-size:10.5pt;font-weight:800;text-transform:uppercase;letter-spacing:.4px;
         margin:14px 0 6px;padding-bottom:3px;border-bottom:1px solid #bbb}
  table{width:100%;border-collapse:collapse;font-size:10pt;margin-bottom:6px}
  th{text-align:left;font-size:8.5pt;text-transform:uppercase;letter-spacing:.3px;color:#333;
     background:#f1f1f1;padding:6px 8px;border-bottom:1.5px solid #999;
     -webkit-print-color-adjust:exact;print-color-adjust:exact}
  td{padding:5px 8px;border-bottom:1px solid #e3e3e3;vertical-align:top}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  tr.total td{font-weight:800;border-top:2px solid #111;border-bottom:none;font-size:10.5pt}
  tr.sub td{font-weight:700;background:#fafafa}
  .kv{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px dotted #ddd;font-size:10pt}
  .kv.total{border-bottom:none;border-top:2px solid #111;margin-top:5px;padding-top:7px;font-weight:800;font-size:11.5pt}
  .kv .v{font-variant-numeric:tabular-nums;white-space:nowrap}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .note{font-size:9.5pt;color:#444;margin-top:4px;white-space:pre-line}
  .sign-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(55mm,1fr));gap:20px;margin-top:20mm}
  .sign{text-align:center;font-size:10pt}
  .sign .line{margin-top:20mm;border-top:1px solid #111;padding-top:4px}
  .doc-foot{margin-top:14px;padding-top:8px;border-top:1px solid #ddd;
            font-size:8.5pt;color:#666;display:flex;justify-content:space-between;gap:10px}
  @media print{
    @page{size:A4 portrait;margin:12mm}
    body{width:auto;min-height:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .no-print{display:none !important}
    tr,.kv,.sign{break-inside:avoid}
    thead{display:table-header-group}
  }
`;

/**
 * Bangun dokumen A4 lengkap.
 * @param {object} o
 *   title     judul dokumen (mis. "Laporan Tutup Kasir")
 *   subtitle  keterangan di bawah judul
 *   meta      array [label, nilai] untuk blok informasi
 *   body      HTML isi dokumen
 *   store     pengaturan toko (untuk kop) — opsional
 *   logo      data URL logo — opsional
 *   footer    teks kaki halaman — opsional
 */
function buildA4Document(o) {
  o = o || {};
  const s = o.store || {};
  const storeName = s.receipt_store_name || 'Ujang Kedu';
  const bits = [s.receipt_address, s.receipt_phone, s.receipt_instagram].filter(Boolean);
  const cetakPada = new Date().toLocaleString('id-ID', {
    timeZone: TZ, day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const meta = (o.meta || []).filter(Boolean).map(
    ([k, v]) => `<div><span>${escHtml(k)}</span><span>${v == null ? '-' : escHtml(v)}</span></div>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(o.title || 'Laporan')}</title>
<style>${A4_STYLE}</style>
</head><body>
  <div class="doc-head">
    ${o.logo ? `<img src="${escHtml(o.logo)}" alt="" class="doc-logo">` : ''}
    <div class="doc-store">
      <h1>${escHtml(storeName)}</h1>
      ${bits.length ? `<p>${escHtml(bits.join(' · '))}</p>` : ''}
    </div>
    <div class="doc-title">
      <h2>${escHtml(o.title || 'Laporan')}</h2>
      ${o.subtitle ? `<p>${escHtml(o.subtitle)}</p>` : ''}
    </div>
  </div>
  ${meta ? `<div class="doc-meta">${meta}</div>` : ''}
  ${o.body || ''}
  <div class="doc-foot">
    <span>${escHtml(o.footer || 'Dokumen ini dibuat otomatis oleh sistem.')}</span>
    <span>Dicetak: ${escHtml(cetakPada)}</span>
  </div>
</body></html>`;
}

/** Ambil kop toko (nama, alamat, telepon) + logo untuk dokumen A4. */
async function getDocumentHeader() {
  try {
    const s = await getReceiptSettings();
    const logo = s.receipt_logo ? await resolveLogoDataUrl(s.receipt_logo) : '';
    return { store: s, logo };
  } catch (e) { return { store: {}, logo: '' }; }
}

/** Cetak dokumen A4 (dialog cetak browser -> printer A4 atau Simpan sebagai PDF). */
async function printA4Document(opts) {
  const head = await getDocumentHeader();
  const html = buildA4Document(Object.assign({}, head, opts));
  await printHtmlDocument(html);
}

/** Unduh dokumen A4 sebagai berkas .html (bisa dibuka & dicetak kapan saja). */
async function downloadA4Document(opts, filename) {
  const head = await getDocumentHeader();
  const html = buildA4Document(Object.assign({}, head, opts));
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || ((opts.title || 'laporan').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.html');
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast('Dokumen diunduh. Buka berkasnya lalu cetak ke kertas A4 atau simpan sebagai PDF.', 'success', 6000);
}


/* ================= PRINTER BLUETOOTH (Web Bluetooth / ESC-POS) ============= */

/* --------------------------------------------------------------------------
   PRINTER BLUETOOTH (Web Bluetooth / ESC-POS)

   Dua hal yang sering bikin "Bluetooth tidak jalan", dan keduanya BUKAN bug
   aplikasi — tapi dulu tidak pernah dijelaskan ke pengguna:

   1. Web Bluetooth hanya hidup di HTTPS atau http://localhost. Kalau POS
      dibuka dari HP lewat alamat LAN (mis. http://192.168.1.5:3000), API-nya
      tidak ada sama sekali. Dulu tombolnya langsung DISEMBUNYIKAN, jadi
      pengguna hanya melihat "tidak ada tombol Bluetooth" tanpa alasan.

   2. Web Bluetooth hanya mendukung Bluetooth Low Energy (BLE). Mayoritas
      printer thermal 58mm murah memakai Bluetooth CLASSIC (SPP), yang secara
      teknis TIDAK BISA diakses browser mana pun. Untuk printer jenis ini
      jalur yang benar adalah tombol "Cetak Struk" + aplikasi RawBT.

   Sekarang tombol tetap ditampilkan namun nonaktif disertai alasannya, dan
   proses koneksi jauh lebih tahan banting.
   -------------------------------------------------------------------------- */

const btPrinter = { device: null, characteristic: null, chunkSize: 0 };

/** Kenapa Bluetooth tidak tersedia? Dipakai untuk pesan yang jelas ke pengguna. */
function getBluetoothStatus() {
  if (!window.isSecureContext) {
    return { supported: false, reason: 'butuh HTTPS',
      detail: 'Cetak Bluetooth langsung hanya bisa lewat HTTPS atau http://localhost. ' +
              'Halaman ini dibuka lewat koneksi biasa, jadi browser memblokir akses Bluetooth. ' +
              'Gunakan tombol Cetak Struk + aplikasi RawBT.' };
  }
  if (!navigator.bluetooth) {
    return { supported: false, reason: 'browser tidak mendukung',
      detail: 'Browser ini tidak punya Web Bluetooth. Yang mendukung: Chrome/Edge di Android, ' +
              'Windows, macOS, dan Linux. Safari dan Chrome iOS tidak mendukung.' };
  }
  return { supported: true, reason: '', detail:
    'Hanya untuk printer Bluetooth LE. Printer thermal 58mm umumnya Bluetooth Classic — ' +
    'untuk itu pakai tombol Cetak Struk + aplikasi RawBT.' };
}

const BT_SUPPORTED = getBluetoothStatus().supported;

/** UUID service yang umum dipakai printer thermal BLE. */
const BT_SERVICES = [
  0x18F0, 0xFF00, 0xFFE0, 0xFEE7, 0xFFF0, 0xAE30,
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];

/** Cari characteristic yang bisa ditulis, dengan beberapa lapis cadangan. */
async function findWritableCharacteristic(server) {
  const pick = (chars) => {
    // Utamakan writeWithoutResponse: jauh lebih cepat untuk data raster logo
    return chars.find((c) => c.properties.writeWithoutResponse)
        || chars.find((c) => c.properties.write)
        || null;
  };
  // Lapis 1: minta seluruh service sekaligus
  try {
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      try {
        const found = pick(await svc.getCharacteristics());
        if (found) return found;
      } catch (e) { /* service ini tidak bisa dibaca, lanjut */ }
    }
  } catch (e) { /* sebagian browser menolak, coba satu per satu */ }

  // Lapis 2: coba tiap UUID yang dikenal satu per satu
  for (const uuid of BT_SERVICES) {
    try {
      const svc = await server.getPrimaryService(uuid);
      const found = pick(await svc.getCharacteristics());
      if (found) return found;
    } catch (e) { /* printer ini tidak punya service tsb */ }
  }
  return null;
}

async function connectBluetoothPrinter(silent) {
  const st = getBluetoothStatus();
  if (!st.supported) {
    if (!silent) showToast(st.detail, 'warning', 9000);
    return false;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: BT_SERVICES,
    });
    const server = await device.gatt.connect();
    const ch = await findWritableCharacteristic(server);
    if (!ch) {
      showToast('Perangkat tersambung tapi tidak ditemukan jalur tulis. ' +
        'Kemungkinan besar ini printer Bluetooth Classic yang tidak bisa diakses browser — ' +
        'gunakan tombol Cetak Struk + aplikasi RawBT.', 'error', 10000);
      try { server.disconnect(); } catch (e) {}
      return false;
    }
    btPrinter.device = device;
    btPrinter.characteristic = ch;
    btPrinter.chunkSize = 0; // ditentukan adaptif saat menulis
    device.addEventListener('gattserverdisconnected', () => {
      btPrinter.characteristic = null;
      updateBtIndicator();
      showToast('Printer Bluetooth terputus', 'warning');
    });
    updateBtIndicator();
    showToast('Printer Bluetooth terhubung: ' + (device.name || 'Printer'), 'success');
    return true;
  } catch (e) {
    const name = e && e.name;
    if (name === 'NotFoundError') {
      if (!silent) showToast('Tidak ada printer yang dipilih.', 'warning');
    } else if (name === 'SecurityError') {
      showToast('Akses Bluetooth diblokir browser. Pastikan halaman dibuka lewat HTTPS.', 'error', 8000);
    } else if (name === 'NetworkError') {
      showToast('Gagal menyambung ke printer. Pastikan printer menyala, dalam jangkauan, ' +
        'dan belum terhubung ke perangkat lain.', 'error', 8000);
    } else {
      showToast('Gagal konek Bluetooth: ' + ((e && e.message) || e), 'error', 8000);
    }
    return false;
  }
}

/**
 * Kirim byte ke printer.
 * Ukuran potongan dibuat ADAPTIF: banyak printer BLE memakai MTU kecil (23 byte,
 * artinya maksimal 20 byte per tulis). Potongan tetap 180 byte seperti versi
 * sebelumnya akan gagal total di printer tersebut. Di sini ukuran diturunkan
 * bertahap sampai ada yang diterima.
 */
async function btWrite(bytes) {
  const ch = btPrinter.characteristic;
  if (!ch) throw new Error('Printer belum terhubung');
  const useNoResponse = !!ch.properties.writeWithoutResponse;
  const send = (slice) => (useNoResponse && ch.writeValueWithoutResponse)
    ? ch.writeValueWithoutResponse(slice)
    : ch.writeValue(slice);

  const candidates = btPrinter.chunkSize ? [btPrinter.chunkSize] : [180, 100, 40, 20];
  let lastErr = null;

  for (const size of candidates) {
    try {
      for (let i = 0; i < bytes.length; i += size) {
        await send(bytes.slice(i, i + size));
        await new Promise((r) => setTimeout(r, size > 60 ? 20 : 12));
      }
      btPrinter.chunkSize = size; // ingat ukuran yang berhasil
      return;
    } catch (e) {
      lastErr = e;
      // Ukuran terlalu besar untuk MTU printer ini — coba yang lebih kecil.
      // Jeda sejenak agar antrean GATT bersih sebelum mencoba lagi.
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr || new Error('Gagal mengirim data ke printer');
}

async function printReceiptBluetooth(sale) {
  if (!sale) { showToast('Data transaksi tidak ditemukan', 'error'); return; }
  if (!btPrinter.characteristic) {
    const ok = await connectBluetoothPrinter(false);
    if (!ok) return;
  }
  try {
    const s = await getReceiptSettings();
    const bytes = await escposFromSale(sale, s);
    await btWrite(bytes);
    showToast('Struk dikirim ke printer 🖨️', 'success');
  } catch (e) {
    showToast('Gagal cetak Bluetooth: ' + (e.message || e) + '. Coba hubungkan ulang.', 'error');
    btPrinter.characteristic = null;
    updateBtIndicator();
  }
}

/**
 * Konversi logo -> raster monokrom untuk perintah ESC/POS `GS v 0`.
 * Pakai dithering Floyd–Steinberg supaya logo berwarna/abu-abu tetap terbaca
 * di printer thermal yang hanya mengenal hitam/putih.
 */
async function logoToEscposRaster(dataUrl, widthDots, maxHeightDots) {
  maxHeightDots = maxHeightDots || 240;
  const key = dataUrl.length + '|' + dataUrl.slice(-48) + '|' + widthDots;
  if (_logoRasterCache.has(key)) return _logoRasterCache.get(key);

  const img = await loadImageEl(dataUrl);
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (!nw || !nh) throw new Error('Ukuran logo tidak valid');

  let w = Math.min(widthDots, nw > widthDots ? widthDots : Math.max(nw, 8));
  w = Math.floor(w / 8) * 8;
  if (w < 8) w = 8;
  let h = Math.max(1, Math.round((nh / nw) * w));
  if (h > maxHeightDots) { h = maxHeightDots; }

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  let px;
  try { px = ctx.getImageData(0, 0, w, h).data; }
  catch (e) { throw new Error('Logo diblokir CORS, tidak bisa dikirim ke printer'); }

  // Grayscale + komposit di atas putih (agar PNG transparan tidak jadi hitam)
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = px[i * 4 + 3] / 255;
    const v = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    gray[i] = v * a + 255 * (1 - a);
  }
  // Floyd–Steinberg dithering
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const oldv = gray[i];
      const newv = oldv < 128 ? 0 : 255;
      gray[i] = newv;
      const err = oldv - newv;
      if (x + 1 < w) gray[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) gray[i + w - 1] += err * 3 / 16;
        gray[i + w] += err * 5 / 16;
        if (x + 1 < w) gray[i + w + 1] += err * 1 / 16;
      }
    }
  }

  const bytesPerRow = w / 8;
  const bitmap = new Uint8Array(bytesPerRow * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] < 128) bitmap[y * bytesPerRow + (x >> 3)] |= (0x80 >> (x & 7));
    }
  }
  const out = { bitmap, bytesPerRow, width: w, height: h };
  _logoRasterCache.set(key, out);
  return out;
}

/** Bungkus raster jadi perintah GS v 0, dipecah per-band agar aman di BLE. */
function escposRasterCommands(raster) {
  const bytes = [];
  const BAND = 96; // baris per band
  for (let y0 = 0; y0 < raster.height; y0 += BAND) {
    const rows = Math.min(BAND, raster.height - y0);
    bytes.push(0x1D, 0x76, 0x30, 0x00,
      raster.bytesPerRow & 0xff, (raster.bytesPerRow >> 8) & 0xff,
      rows & 0xff, (rows >> 8) & 0xff);
    const start = y0 * raster.bytesPerRow;
    const end = start + rows * raster.bytesPerRow;
    for (let i = start; i < end; i++) bytes.push(raster.bitmap[i]);
  }
  return bytes;
}

/** Bangun perintah ESC/POS lengkap (termasuk LOGO) dari data transaksi. */
async function escposFromSale(sale, s) {
  s = s || {};
  sale = sale || {};
  const paper = getPaperProfile(s);
  const W = paper.chars;

  const bytes = [];
  const push = (...a) => a.forEach((x) => (Array.isArray(x) ? bytes.push(...x) : bytes.push(x)));
  // Buang karakter non-ASCII (printer thermal murah tidak punya font-nya)
  const enc = (str) => {
    const clean = String(str == null ? '' : str).replace(/[^\x20-\x7E\n]/g, '');
    const out = [];
    for (let i = 0; i < clean.length; i++) out.push(clean.charCodeAt(i) & 0xff);
    return out;
  };
  const text = (t) => push(...enc(t));
  const nl = () => push(0x0A);
  const ESC = 0x1B, GS = 0x1D;
  const alignC = () => push(ESC, 0x61, 1);
  const alignL = () => push(ESC, 0x61, 0);
  const boldOn = () => push(ESC, 0x45, 1);
  const boldOff = () => push(ESC, 0x45, 0);
  const big = () => push(GS, 0x21, 0x11);
  const normal = () => push(GS, 0x21, 0x00);
  const line = (l, r) => {
    l = String(l || ''); r = String(r || '');
    if (l.length + r.length + 1 > W) l = l.substring(0, Math.max(1, W - r.length - 1));
    return l + ' '.repeat(Math.max(1, W - l.length - r.length)) + r;
  };
  const wrap = (t) => {
    const words = String(t || '').split(/\s+/).filter(Boolean);
    const lines = []; let cur = '';
    words.forEach((word) => {
      while (word.length > W) { if (cur) { lines.push(cur); cur = ''; } lines.push(word.slice(0, W)); word = word.slice(W); }
      if (!cur) cur = word;
      else if (cur.length + 1 + word.length <= W) cur += ' ' + word;
      else { lines.push(cur); cur = word; }
    });
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };
  const dash = () => '-'.repeat(W);
  const fmtRp = (n) => 'Rp' + (parseInt(n, 10) || 0).toLocaleString('id-ID');
  const pm = { cash: 'Tunai', transfer: 'Transfer', qris: 'QRIS' };

  push(ESC, 0x40); // init

  // ---- LOGO (sebelumnya tidak pernah dikirim sama sekali) ----
  if (isLogoEnabled(s) && s.receipt_logo) {
    try {
      const dataUrl = await resolveLogoDataUrl(s.receipt_logo);
      const targetW = Math.round(paper.dots * getLogoWidthPct(s) / 100);
      const raster = await logoToEscposRaster(dataUrl, targetW);
      alignC();
      push(...escposRasterCommands(raster));
      nl();
    } catch (e) {
      // Logo gagal dirender -> tetap cetak struk tanpa logo
      console.warn('Logo ESC/POS dilewati:', e.message || e);
    }
  }

  alignC(); boldOn(); big();
  text(s.receipt_store_name || 'Ujang Kedu'); nl();
  normal(); boldOff();
  if (s.receipt_tagline)   { wrap(s.receipt_tagline).forEach((l) => { text(l); nl(); }); }
  if (s.receipt_address)   { wrap(s.receipt_address).forEach((l) => { text(l); nl(); }); }
  if (s.receipt_phone)     { text(s.receipt_phone); nl(); }
  if (s.receipt_instagram) { text(s.receipt_instagram); nl(); }

  alignL(); text(dash()); nl();
  if (s.receipt_show_invoice !== '0' && sale.invoice_number) { text(line('Invoice', sale.invoice_number)); nl(); }
  if (s.receipt_show_datetime !== '0' && sale.created_at) {
    const d = (typeof fmt !== 'undefined' && fmt._parse) ? fmt._parse(sale.created_at) : new Date(sale.created_at);
    if (d && !isNaN(d.getTime())) {
      text(line('Waktu', d.toLocaleString('id-ID', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })));
      nl();
    }
  }
  if (s.receipt_show_cashier !== '0' && sale.cashier_name) { text(line('Kasir', sale.cashier_name)); nl(); }
  if (sale.customer_name && sale.customer_name !== 'Pelanggan Umum') { text(line('Plgn', sale.customer_name)); nl(); }
  text(dash()); nl();

  (sale.items || []).forEach((i) => {
    wrap(i.product_name).forEach((l) => { text(l); nl(); });
    text(line(`${i.quantity} x ${fmtRp(i.sell_price)}`, fmtRp(i.subtotal))); nl();
  });

  text(dash()); nl();
  if ((sale.discount_amount || 0) > 0) { text(line('Diskon', '-' + fmtRp(sale.discount_amount))); nl(); }
  boldOn(); text(line('TOTAL', fmtRp(sale.total))); nl(); boldOff();
  text(line('Bayar (' + (pm[sale.payment_method] || sale.payment_method || '') + ')', fmtRp(sale.payment_amount))); nl();
  if ((sale.change_amount || 0) > 0) { text(line('Kembali', fmtRp(sale.change_amount))); nl(); }
  text(dash()); nl();

  alignC();
  String(s.receipt_footer || 'Terima kasih!').split('\n').forEach((l) => {
    wrap(l).forEach((ln) => { text(ln); nl(); });
  });
  nl(); nl(); nl();
  push(GS, 0x56, 0x42, 0x00); // potong kertas (diabaikan bila tidak didukung)

  return new Uint8Array(bytes);
}

function updateBtIndicator() {
  const st = getBluetoothStatus();
  document.querySelectorAll('.bt-status').forEach((el) => {
    if (!st.supported) {
      el.textContent = '⚠️ Bluetooth langsung tidak tersedia (' + st.reason + ')';
      el.style.color = 'var(--warning, #b45309)';
      el.title = st.detail;
      return;
    }
    const on = !!btPrinter.characteristic;
    el.textContent = on ? ('🟢 ' + ((btPrinter.device && btPrinter.device.name) || 'Printer terhubung')) : '⚪ Belum terhubung';
    el.style.color = on ? 'var(--success)' : 'var(--text-muted)';
    el.title = '';
  });
}

/**
 * Siapkan UI cetak.
 * Dulu tombol Bluetooth langsung disembunyikan bila tidak didukung, sehingga
 * pengguna tidak pernah tahu KENAPA. Sekarang tombol tetap terlihat tapi
 * nonaktif, dengan alasan yang bisa dibaca.
 */
function initPrintUI() {
  const st = getBluetoothStatus();
  document.querySelectorAll('.btn-bt-print').forEach((b) => {
    b.style.display = '';
    if (st.supported) {
      b.disabled = false;
      b.title = '';
      b.style.opacity = '';
      b.style.cursor = '';
    } else {
      b.disabled = true;
      b.title = st.detail;
      b.style.opacity = '0.5';
      b.style.cursor = 'not-allowed';
    }
  });
  document.querySelectorAll('.bt-status').forEach((el) => { el.style.display = ''; });
  updateBtIndicator();
}

// Pra-muat pengaturan struk + logo begitu halaman siap, supaya klik "Cetak"
// langsung jalan tanpa menunggu jaringan (penyebab logo sering terlewat).
(function warmUpReceipt() {
  if (!Auth.isLoggedIn()) return;
  const run = () => {
    getReceiptSettings(true)
      .then((s) => (s && s.receipt_logo ? resolveLogoDataUrl(s.receipt_logo) : null))
      .catch(() => {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(run, 600));
  else setTimeout(run, 600);
})();

/* ==========================================================================
   NOTIFIKASI SUARA TRANSAKSI
   Memakai Web Audio API — tidak butuh file audio eksternal sama sekali,
   jadi tetap berbunyi walau perangkat sedang offline.
   ========================================================================== */
let _audioCtx = null;
function getAudioCtx() {
  if (_audioCtx) return _audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try { _audioCtx = new Ctx(); } catch (e) { return null; }
  return _audioCtx;
}

// Browser memblokir audio sebelum ada interaksi user; "bangunkan" saat sentuhan pertama.
(function unlockAudioOnce() {
  const wake = () => {
    const ctx = getAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    document.removeEventListener('pointerdown', wake);
    document.removeEventListener('keydown', wake);
  };
  document.addEventListener('pointerdown', wake, { once: true });
  document.addEventListener('keydown', wake, { once: true });
})();

const SOUND_PATTERNS = {
  // [frekuensi Hz, mulai detik, durasi detik]
  chime:   [[880, 0, 0.11], [1318.5, 0.10, 0.19]],
  success: [[659.3, 0, 0.09], [880, 0.09, 0.09], [1318.5, 0.18, 0.22]],
  beep:    [[1046.5, 0, 0.13]],
  cash:    [[1568, 0, 0.06], [2093, 0.07, 0.06], [1568, 0.15, 0.13]],
  error:   [[311.1, 0, 0.16], [233.1, 0.16, 0.26]],
};

/**
 * Bunyikan nada pendek.
 * @param {string} type kunci SOUND_PATTERNS
 * @param {number} volume 0..1
 */
function playTone(type, volume) {
  const ctx = getAudioCtx();
  if (!ctx) return false;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const pattern = SOUND_PATTERNS[type] || SOUND_PATTERNS.chime;
  const vol = Math.max(0, Math.min(1, volume == null ? 0.22 : volume));
  const t0 = ctx.currentTime;
  pattern.forEach(([freq, at, dur]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0 + at);
    // amplop lembut supaya tidak "klik"
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t0 + at); osc.stop(t0 + at + dur + 0.02);
  });
  return true;
}

/** Bunyi "transaksi berhasil" sesuai pengaturan. */
async function playSuccessSound() {
  try {
    const s = await getReceiptSettings();
    if (s.pos_sound_enabled === '0') return;
    playTone(s.pos_sound_type || 'chime', parseFloat(s.pos_sound_volume || '0.22'));
  } catch (e) { playTone('chime', 0.22); }
}

function playErrorSound() {
  getReceiptSettings().then((s) => {
    if (s.pos_sound_enabled === '0') return;
    playTone('error', 0.18);
  }).catch(() => {});
}

/* ==========================================================================
   STRUK: DUKUNGAN TEMPLATE CUSTOM
   Template custom hanya menimpa field di atas salinan pengaturan default —
   pengaturan default itu sendiri tidak pernah diubah.
   ========================================================================== */
let _templateCache = { data: null, ts: 0 };

async function getReceiptTemplates(force) {
  if (!force && _templateCache.data && (Date.now() - _templateCache.ts) < 60000) return _templateCache.data;
  try {
    const list = await API.get('/receipt-templates');
    _templateCache = { data: Array.isArray(list) ? list : [], ts: Date.now() };
    return _templateCache.data;
  } catch (e) { return _templateCache.data || []; }
}
function clearTemplateCache() { _templateCache = { data: null, ts: 0 }; }

/**
 * Gabungkan pengaturan default dengan config template.
 * Mengembalikan OBJEK BARU — `base` tidak pernah dimutasi.
 */
function mergeReceiptSettings(base, templateConfig) {
  const merged = Object.assign({}, base || {});
  if (templateConfig && typeof templateConfig === 'object') {
    Object.keys(templateConfig).forEach((k) => {
      const v = templateConfig[k];
      if (v !== undefined && v !== null && v !== '') merged[k] = v;
    });
  }
  return merged;
}

/**
 * Cetak struk dengan opsi template.
 * @param {object} sale
 * @param {object} opts { templateId, direct }
 */
async function printReceiptWithTemplate(sale, opts) {
  opts = opts || {};
  const base = await getReceiptSettings();
  let settings = base;
  if (opts.templateId) {
    const tpls = await getReceiptTemplates();
    const tpl = tpls.find((t) => String(t.id) === String(opts.templateId));
    if (tpl) settings = mergeReceiptSettings(base, tpl.config);
  }
  const logo = (isLogoEnabled(settings) && settings.receipt_logo)
    ? await resolveLogoDataUrl(settings.receipt_logo) : '';
  const html = buildReceiptHTML(sale, settings, { logo });
  await printHtmlDocument(html);
}
