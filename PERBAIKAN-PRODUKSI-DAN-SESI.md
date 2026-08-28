# Perbaikan: Preview, Tim Produksi, dan Keamanan Sesi Kasir

---

## 1. Preview struk dikembalikan ke tempat yang benar

Sebelumnya saya salah menghapus preview di **Pengaturan Struk**. Yang Anda
maksud adalah preview di halaman **Pengaturan** (umum) — dan memang itu yang
tidak perlu ada.

### Yang dikembalikan

**Pengaturan Struk** (`struk.html`) kini punya **preview ukuran asli 1:1**
lagi, memakai renderer yang sama persis dengan hasil cetak, dan langsung
berubah begitu form diubah.

Preview ini aman dari masalah tumpang tindih sebelumnya karena memakai
`srcdoc` — isinya digambar langsung dari data form, **bukan memuat URL halaman
lain**, jadi tidak mungkin berpindah halaman. (Bug lama terjadi karena preview
memuat `/login.html`, yang otomatis mengalihkan ke dashboard.)

### Yang dihapus

Halaman **Pengaturan** (`pengaturan.html`) ternyata memuat **form pengaturan
struk duplikat** — nama toko, tagline, alamat, telepon, sosmed, footer — persis
seperti di halaman Pengaturan Struk, lengkap dengan previewnya sendiri.

Ini bukan sekadar mubazir, tapi berbahaya: dua tempat mengatur data yang sama,
dan form duplikat itu memakai kunci berbeda (`store_name`, `store_tagline`)
sehingga bisa menimpa atau berbeda dari yang diatur di halaman utama.

Form duplikat beserta previewnya dihapus, diganti tautan ke halaman Pengaturan
Struk. Fitur **Ganti Password**, **Generate Data Dummy**, dan **Hapus Data**
tetap ada di sana.

---

## 2. Hak akses Tim Produksi

### Grup izin baru

Ditambahkan grup **🏭 Produksi** pada katalog hak akses:

| Izin | Keterangan |
|---|---|
| `production.view` | Melihat data produksi & surplus |
| `production.edit` | Mencatat hasil produksi |
| `production.delete` | Menghapus catatan produksi |
| `production.recipe` | Mengatur resep & HPP produksi |

Total izin granular kini **56**.

### Role bawaan baru: Tim Produksi

Role `production` dengan akses:

- **Boleh:** produksi (lihat, catat, atur resep), stok (lihat, ubah, transfer),
  bahan baku (lihat, kelola), produk (lihat).
- **Tidak boleh:** kasir/POS, buka-tutup kasir, laporan keuangan, dompet,
  beban, manajemen user, dan pengaturan sistem.

### Penegakan di server, bukan sekadar menyembunyikan menu

Route produksi dan sebagian route stok sebelumnya memakai `adminOnly`, artinya
Tim Produksi **tidak akan bisa bekerja sama sekali**. Sudah diganti izin
granular:

| Endpoint | Sebelum | Sesudah |
|---|---|---|
| `POST /api/production` | `adminOnly` | `production.edit` |
| `PUT /api/production/:id` | `adminOnly` | `production.edit` |
| `DELETE /api/production/:id` | `adminOnly` | `production.delete` |
| `PUT /api/production/config` | `adminOnly` | `production.recipe` |
| `POST /api/stock/koreksi` | `adminOnly` | `stock.edit` |
| `PUT /api/stock/min-stock` | `adminOnly` | `stock.edit` |
| `DELETE /api/stock/log/:id` | `adminOnly` | `stock.delete` |

---

## 3. Celah keamanan yang ditemukan saat pengujian

### (a) Seluruh laporan keuangan terbuka untuk semua akun

`routes/reports.js` hanya memakai `router.use(authMiddleware)` — artinya
**siapa pun yang berhasil login bisa membaca omzet, HPP, dan laba rugi**,
termasuk Tim Produksi yang seharusnya tidak menyentuh angka keuangan.

Ditemukan justru karena menguji akun Tim Produksi yang baru dibuat.

**Perbaikan:** seluruh route laporan kini wajib punya salah satu dari
`reports.view`, `dashboard.view`, atau `finance.view`.

### (b) Cabang transaksi bisa berbeda dari cabang shift

Saat membuat penjualan, cabang diambil dari kiriman klien:

```js
const branchId = req.user.role === 'admin'
  ? (parseInt(req.body.branch_id) || null)
  : req.user.branch_id;
```

Akibatnya penjualan bisa tercatat di **cabang A** sementara shift kasir yang
sedang berjalan ada di **cabang B**. Rekonsiliasi tutup kasir jadi tidak cocok
dan uang laci tidak bisa dipertanggungjawabkan.

**Perbaikan:** cabang transaksi **selalu mengikuti cabang sesi kasir** yang
sedang terbuka. Bila klien mengirim cabang berbeda, permintaan ditolak dengan
kode `BRANCH_MISMATCH`.

---

## 4. Buka kasir menyesuaikan akun

Sesi kasir memang sudah terikat ke akun yang login, dan itu sudah diuji ulang:

- Shift hanya bisa dilihat, ditutup, dan diisi mutasi kas oleh **pemiliknya**
  (atau pemegang izin `shift.view_all` seperti supervisor).
- Kasir lain tidak melihat shift orang lain sebagai miliknya.
- Setiap transaksi otomatis terikat ke `session_id` milik akun tersebut.
- Cabang mengikuti akun (kasir tidak bisa memilih cabang lain).

Yang ditambahkan: pada form **Buka Kasir** kini ditampilkan **atas nama siapa,
peran apa, dan cabang mana** shift akan dibuka, beserta keterangan bahwa kasir
lain tidak bisa memakai atau menutup shift tersebut. Data ini diambil dari
akun yang benar-benar login dan disegarkan dari server, bukan dari cache.

---

## Hasil pengujian

| Suite | Cakupan | Hasil |
|---|---|---|
| Tim Produksi & keamanan sesi | role, izin, penolakan lintas akun, cabang | **27/27 LULUS** |
| Preview & pengaturan | preview kembali, duplikat hilang, identitas akun | **15/15 LULUS** |
| Handler DOM | tiap `onclick` di seluruh halaman | **223 hidup, 0 mati** |
| Keamanan permission | wildcard, eskalasi hak akses | 23 LULUS |
| Buka/tutup kasir | gerbang shift, rumus paten, cash out | 35 LULUS |
| Role / termin / template | CRUD, isolasi struk default | 27 LULUS |
| Login & hak akses | branding publik, penegakan izin | 20 LULUS |
| A4 vs thermal, rename, wajib login | pemisahan format cetak | LULUS |
| API / izin / error | 401/403/404/413 | 13 LULUS |
| Regresi end-to-end | endpoint + transaksi + cetak ulang | 21 LULUS |

---

## Catatan pemasangan

```bash
npm install
npm start          # http://localhost:3000
```

Role **Tim Produksi** hanya ter-seed pada database baru. Kalau memakai database
lama, buat sendiri lewat menu **Role & Hak Akses** — grup izin Produksi sudah
tersedia di sana.

**Setelah memasang, tekan Ctrl+Shift+R sekali** agar browser tidak memakai
berkas lama.
