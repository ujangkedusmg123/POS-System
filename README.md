# 🏪 POS System - Sistem Manajemen Toko

Sistem POS (Point of Sale) lengkap dengan fitur penjualan, monitoring stok, pencatatan beban, dan laporan keuangan.

## 🛠️ Tech Stack

| Komponen | Teknologi | Alasan Dipilih |
|----------|-----------|----------------|
| **Database** | SQLite (better-sqlite3) | Tidak perlu instalasi server, file tunggal, cepat |
| **Backend** | Node.js + Express.js | Ringan, ekosistem npm lengkap |
| **Frontend** | HTML + CSS + Vanilla JS | Sederhana, tidak perlu build process |
| **Charts** | Chart.js | Library grafik yang powerful dan mudah |
| **Auth** | JWT + bcryptjs | Standar industri untuk autentikasi |

## 📋 Fitur Utama

### 🛒 Kasir / POS
- Interface kasir yang cepat dan intuitif
- Pencarian produk dan filter kategori
- Keranjang belanja dengan kalkulasi otomatis
- Diskon dan pajak per transaksi
- Metode pembayaran: Tunai, Transfer, QRIS
- Cetak struk transaksi
- Quick pay (5rb, 10rb, 20rb, 50rb, 100rb)

### 📦 Produk & Inventori
- CRUD produk dengan kode & barcode
- Kategori produk
- Harga beli dan jual dengan kalkulasi margin
- Alert stok minimum

### 📥 Monitoring Stok
- Penerimaan stok dari pemasok
- Penyesuaian stok (tambah/kurangi/koreksi)
- Riwayat pergerakan stok
- Status stok: Aman / Menipis / Habis

### 💸 Beban & Pengeluaran
- Pencatatan semua pengeluaran operasional
- Kategorisasi beban (Sewa, Listrik, Gaji, dll.)
- Filter periode dan kategori
- Grafik distribusi beban

### 📈 Laporan Keuangan
- **Laporan Laba Rugi** (P&L Statement)
  - Pendapatan, HPP (COGS), Laba Kotor, Beban, Laba Bersih
  - Margin analysis
  - Tren harian
- **Laporan Penjualan**
  - Per produk, kategori, dan kasir
  - Tren harian
- **Laporan Stok**
  - Nilai inventori
  - Status stok
- **Laporan Beban**
  - Per kategori dengan pie chart

### 📊 Dashboard
- KPI real-time (hari ini & bulan ini)
- Grafik penjualan 7 hari
- Penjualan per jam
- Produk terlaris
- Metode pembayaran
- Ringkasan Laba Rugi

## 🚀 Cara Setup & Menjalankan

### Prasyarat
- Node.js v16 atau lebih baru ([download](https://nodejs.org))
- npm (sudah termasuk dengan Node.js)

### Langkah Instalasi

```bash
# 1. Clone atau ekstrak folder pos-system
cd pos-system

# 2. Install dependencies
npm install

# 3. Jalankan server
npm start

# Atau dengan auto-reload (development)
npm run dev
```

### Akses Aplikasi
Buka browser dan akses: **http://localhost:3000**

### Akun Default
| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `admin123` |
| Kasir | `kasir1` | `kasir123` |

## 📁 Struktur Project

```
pos-system/
├── server.js              # Entry point Express server
├── package.json           # Dependencies
├── database/
│   └── db.js              # SQLite setup, schema & seed data
├── routes/
│   ├── auth.js            # Autentikasi & user management
│   ├── products.js        # Produk & kategori
│   ├── sales.js           # Penjualan & transaksi
│   ├── stock.js           # Stok & pemasok
│   ├── expenses.js        # Beban & pengeluaran
│   └── reports.js         # Laporan & dashboard
├── middleware/
│   └── auth.js            # JWT middleware
└── public/               # Frontend files
    ├── index.html         # Dashboard
    ├── login.html         # Login
    ├── pos.html           # Kasir
    ├── products.html      # Produk
    ├── stock.html         # Stok
    ├── expenses.html      # Beban
    ├── reports.html       # Laporan
    ├── sales.html         # Riwayat penjualan
    ├── css/style.css      # Stylesheet
    └── js/app.js          # Shared utilities
```

## 🗃️ Database Schema (SQLite)

Database disimpan otomatis di `database/pos.db`

**Tabel Utama:**
- `users` - Pengguna sistem
- `categories` - Kategori produk
- `products` - Produk & inventori
- `suppliers` - Pemasok / supplier
- `customers` - Data pelanggan
- `sales` - Transaksi penjualan
- `sale_items` - Detail item transaksi
- `stock_in` - Penerimaan stok
- `stock_in_items` - Detail penerimaan stok
- `stock_adjustments` - Penyesuaian stok manual
- `expense_categories` - Kategori beban
- `expenses` - Pencatatan beban

## 🔌 API Endpoints

### Auth
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Info user
- `PUT /api/auth/change-password` - Ubah password

### Products
- `GET /api/products` - Daftar produk
- `POST /api/products` - Tambah produk
- `PUT /api/products/:id` - Update produk
- `GET /api/products/meta/categories` - Kategori

### Sales
- `GET /api/sales` - Riwayat penjualan
- `POST /api/sales` - Buat transaksi
- `GET /api/sales/:id` - Detail transaksi

### Stock
- `GET /api/stock/in` - Riwayat penerimaan
- `POST /api/stock/in` - Terima stok
- `POST /api/stock/adjustments` - Penyesuaian stok

### Expenses
- `GET /api/expenses` - Daftar beban
- `POST /api/expenses` - Tambah beban
- `PUT /api/expenses/:id` - Update beban

### Reports
- `GET /api/reports/dashboard` - Data dashboard
- `GET /api/reports/profit-loss` - Laporan L/R
- `GET /api/reports/sales` - Laporan penjualan
- `GET /api/reports/stock` - Laporan stok
- `GET /api/reports/expenses` - Laporan beban

## 🚀 Menjalankan di Hosting

Aplikasi ini satu proses Node.js dengan database berupa satu berkas
(`database/pos.db`). Tidak perlu server database terpisah.

```bash
npm install --omit=dev
JWT_SECRET="<acak minimal 32 karakter>" ALLOWED_ORIGINS="https://pos.domainanda.com" PORT=3000 node server.js
```

### Variabel lingkungan

| Variabel | Wajib | Keterangan |
|---|---|---|
| `JWT_SECRET` | **ya** | Kunci penandatangan token. Kalau kosong, sistem membuat kunci acak di `database/.jwt-secret` dan menampilkan peringatan. Isi sendiri untuk produksi. |
| `ALLOWED_ORIGINS` | disarankan | Daftar domain yang boleh memanggil API, dipisah koma. Kosong = semua domain (hanya cocok untuk pemakaian lokal). |
| `PORT` | tidak | Default `3000`. |
| `TZ` | tidak | Default `Asia/Jakarta`. Seluruh tanggal & jam aplikasi memakai **WIB**. |
| `TRUST_PROXY` | tidak | Default `1`. Jumlah lapisan reverse proxy di depan aplikasi. |
| `LOGIN_MAX_ATTEMPTS` | tidak | Default `8` percobaan gagal sebelum akun dikunci sementara. |
| `LOGIN_LOCK_MINUTES` | tidak | Default `10` menit lama penguncian. |
| `SEED_DUMMY` | tidak | Isi `true` **hanya** kalau ingin database diisi data contoh 45 hari. Default: tidak diisi apa pun. |

### Sebelum dibuka ke pengguna

1. **Ganti semua password bawaan** lewat Manajemen User. Server menampilkan
   peringatan di log selama masih ada akun yang memakai password bawaan.
2. Pasang **HTTPS** (Nginx/Caddy/Cloudflare). Token dikirim di header
   `Authorization`, jadi tanpa HTTPS bisa disadap di jaringan.
3. Isi **alamat & telepon cabang** di menu Cabang, dan atur data struk di
   Pengaturan.
4. **Backup `database/pos.db`** secara terjadwal — seluruh data ada di berkas itu.
   Salin juga `database/.jwt-secret` kalau tidak memakai variabel `JWT_SECRET`
   (kalau hilang, semua sesi login terputus).
5. Jalankan lewat process manager (`pm2`, `systemd`) supaya otomatis hidup lagi
   setelah server restart.

### Zona waktu

Seluruh sistem memakai **WIB (UTC+7)**, tidak mengikuti zona waktu server
maupun perangkat pengguna: nomor invoice, kode shift, batas "hari ini" di
laporan, jam di struk, dan isi file Excel semuanya WIB.

## 🔒 Keamanan

### Model hak akses
Setiap endpoint dijaga dua lapis:

1. **Izin (permission)** — apa yang boleh dilakukan. Diatur per role di menu
   *Role & Hak Akses*. Tidak ada lagi pemeriksaan "harus admin" yang menutup
   role sah lain.
2. **Cabang** — di mana boleh dilakukan. Dibaca dari tabel `user_branches`
   **setiap permintaan**, bukan dari token, supaya pencabutan akses langsung
   berlaku tanpa menunggu user login ulang.

Keduanya berlaku untuk operasi baca **dan** tulis. Membatalkan transaksi,
mengoreksi stok, memindah saldo dompet, atau mengubah beban milik cabang lain
ditolak walaupun nomor id-nya ditebak dengan benar.

### Perlindungan lain
- **XSS tersimpan** — tidak ada tag HTML yang boleh masuk ke database
  (`utils/sanitize.js`). Ini menutup jalur "kasir menyimpan skrip di nama
  pelanggan, lalu skrip itu berjalan di browser pemilik".
- **Injeksi SQL** — seluruh nilai dari pengguna dikirim sebagai parameter;
  satu-satunya bagian SQL yang dirangkai adalah daftar id cabang, dan itu pun
  hasil `parseInt`.
- **Brute force login** — 8 percobaan gagal per akun/IP lalu terkunci 10 menit.
- **Token** — kunci penandatangan tidak ada di dalam kode.

### Sebelum go-live
- Set `JWT_SECRET` lewat variabel lingkungan (jangan tulis di kode)
- Ganti password default setelah instalasi
- Batasi `ALLOWED_ORIGINS` ke domain Anda sendiri
- Pasang HTTPS
- Backup file `database/pos.db` secara rutin

## 📱 Kompatibilitas
- Modern browsers (Chrome, Firefox, Edge, Safari)
- Responsive untuk tablet
- Optimal di layar 1280px ke atas
