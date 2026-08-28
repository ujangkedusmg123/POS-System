# Perbaikan Lanjutan — 4 Masalah Laporan Pengguna

---

## 1. Tombol "Buka Kasir" tidak bisa diklik  ← paling parah

### Petunjuk awal

Di screenshot, kolom saldo sudah terisi `100000`. Artinya tombol **100rb**
berfungsi. Jadi halamannya tidak beku — hanya sebagian tombol yang mati.

Bedanya:

```js
function setOpen(v){ ... }          // tombol 100rb  -> JALAN
async function openShift() { ... }  // tombol utama  -> MATI
```

### Akar masalah

Seluruh script halaman dibungkus seperti ini:

```js
if (initPage('shift', ...)) {
  ...seluruh isi halaman...
}
```

Di dalam sebuah blok, deklarasi `function` biasa **terangkat** ke scope global
lewat aturan warisan (Annex B), tetapi `async function` **tidak**. Dibuktikan
langsung:

```
function biasa   -> window.biasa    : function
async function   -> window.asinkron : undefined
const arrow      -> window.panah    : undefined
```

Akibatnya atribut `onclick="openShift()"` tidak menemukan fungsinya, klik
menghasilkan ReferenceError diam-diam, dan tombol terasa "mati".

### Dampak sebenarnya

Bukan satu tombol, tetapi **14 handler di 6 halaman** — praktis melumpuhkan
seluruh modul v2:

| Halaman | Handler yang mati |
|---|---|
| kasir-shift.html | openShift, closeShift, saveMovement, refresh |
| login-settings.html | save, uploadLogo, uploadBg |
| roles.html | openRole, saveRole |
| struk-custom.html | saveTemplate, testPrint |
| shift-reports.html | load, showDetail |
| payment-methods.html | savePm |

### Perbaikan

Pembungkus blok dibongkar. Isi script kembali berada di scope global, dan hanya
baris *bootstrap* di bagian bawah yang dijaga:

```js
const PAGE_OK = initPage('shift', ...);
... seluruh deklarasi di scope global ...
if (PAGE_OK) { refresh(); setInterval(...); }
```

Tiap berkas kini memuat komentar peringatan agar pola lama tidak terulang.

**Verifikasi:** seluruh halaman dimuat di DOM, tiap nama fungsi yang dirujuk
atribut `onclick`/`onchange` diuji keterjangkauannya dari scope yang sama —
**225 handler hidup, 0 mati**. Klik tombol Buka Kasir juga disimulasikan dan
benar-benar membuka sesi kasir dengan saldo awal yang sesuai.

---

## 2. POS masih bisa dipakai tanpa buka kasir

### Akar masalah

Modal gerbang sudah muncul, tetapi ada tombol **"Nanti"** yang menutupnya.
Setelah ditutup, keranjang tetap bisa diisi. Hanya tombol bayar yang nonaktif —
penguncian di lapisan yang salah.

### Perbaikan

- Tombol "Nanti" diganti **"← Keluar dari Kasir"** yang membawa pengguna keluar.
- Modal gerbang tidak bisa ditutup dengan klik di luar kotak.
- Fungsi `applyShiftLock()` mematikan **seluruh area transaksi**
  (`pointer-events:none` + diredupkan) selama kasir belum dibuka.
- `addToCart()` dijaga sebagai lapis kedua.
- Status shift disegarkan berkala; begitu kasir dibuka, kunci otomatis lepas.

Server tetap menjadi penjaga terakhir: `POST /api/sales` membalas `409` bila
tidak ada sesi terbuka. Penguncian UI hanya lapisan kenyamanan, bukan pengganti.

---

## 3. Printer Bluetooth belum bisa

Ada dua penyebab, dan **satu di antaranya tidak bisa diperbaiki dengan kode**.

### (a) Batasan yang memang tidak bisa dilewati

- **Web Bluetooth hanya hidup di HTTPS atau `http://localhost`.** Bila POS
  dibuka dari HP lewat alamat LAN (`http://192.168.x.x:3000`), API-nya tidak
  ada sama sekali.
- **Web Bluetooth hanya mendukung Bluetooth Low Energy (BLE).** Mayoritas
  printer thermal 58mm murah memakai **Bluetooth Classic (SPP)**, yang secara
  teknis tidak bisa diakses browser mana pun.

Untuk printer Classic, jalur yang benar memang **tombol "Cetak Struk" +
aplikasi RawBT** di Android — bukan tombol Bluetooth.

Dulu tombol Bluetooth langsung **disembunyikan** saat tidak didukung, sehingga
pengguna hanya melihat tombol yang hilang tanpa tahu alasannya. Sekarang tombol
tetap tampil namun nonaktif, dengan alasan yang bisa dibaca (`title` + indikator
status), misalnya: *"Cetak Bluetooth langsung hanya bisa lewat HTTPS atau
http://localhost…"*

### (b) Bug nyata yang diperbaiki

**Ukuran potongan data terlalu besar.** Versi lama selalu mengirim potongan
180 byte:

```js
const CHUNK = 180;
```

Banyak printer BLE memakai MTU 23 byte (maksimal 20 byte per operasi tulis),
sehingga pengiriman **gagal total**. Sekarang ukurannya adaptif — dicoba
180 → 100 → 40 → 20 sampai ada yang diterima, lalu ukuran yang berhasil
diingat untuk cetakan berikutnya.

**Pencarian jalur tulis dibuat berlapis.** Bila `getPrimaryServices()` gagal
atau tidak menemukan characteristic yang bisa ditulis, tiap UUID yang dikenal
dicoba satu per satu. Daftar UUID diperluas (`0xFFF0`, `0xAE30`, dan lainnya),
dan `writeWithoutResponse` diutamakan karena jauh lebih cepat untuk data raster
logo.

**Pesan error dibedakan** per jenis kegagalan: `SecurityError` (bukan HTTPS),
`NetworkError` (printer mati/di luar jangkauan/dipakai perangkat lain), dan
kasus "tersambung tapi tidak ada jalur tulis" yang kini menjelaskan bahwa itu
kemungkinan besar printer Bluetooth Classic.

---

## 4. Margin struk terlalu rapat

### Akar masalah

Padding horizontal struk memang **nol**:

```css
body { padding: 2mm 0; }          /* pratinjau */
@media print { body { padding: 1mm 0 4mm } }   /* cetak */
```

Teks menempel ke tepi kertas. Ini bukan hanya soal estetika: area cetak
sebenarnya selalu sedikit lebih sempit dari lebar kertas, sehingga karakter di
sisi kanan bisa terpotong.

### Perbaikan

Margin kiri/kanan kini bisa diatur lewat **Pengaturan Struk → Margin kiri &
kanan** (slider 0–8 mm, **default 3 mm**). Lebar logo ikut menyesuaikan area
dalam yang tersisa, jadi logo tidak pernah melewati margin.

---

## Hasil pengujian

Seluruh suite dijalankan terhadap server sungguhan. **Semua lulus, 0 gagal.**

| Suite | Cakupan |
|---|---|
| Verifikasi 4 keluhan (21 cek) | klik tombol benar-benar membuka kasir; POS terkunci/terbuka sesuai status shift; Bluetooth beralasan; margin ≠ 0 |
| Handler DOM (225 cek) | tiap `onclick` di seluruh halaman terjangkau |
| Keamanan permission (23) | wildcard, eskalasi hak akses, admin tetap utuh |
| Role/termin/template (27) | CRUD, proteksi role sistem, isolasi struk default |
| Buka/tutup kasir (35) | gerbang shift, rumus paten, cash out, riwayat |
| Login & hak akses (20) | branding publik, kebocoran data, penegakan izin |
| API/izin/error (13) | 401/403/404/413, roundtrip logo besar |
| Regresi end-to-end (21) | 13 endpoint + transaksi + detail cetak ulang |
| HTML struk (12) | charset, escaping, `@page`, ukuran logo, margin |
| ESC/POS + raster logo (19) | verifikasi bit-level, wrapping, potong kertas |
| Alur cetak & cache (13) | tunggu gambar, timeout, TTL, fallback offline |

Pemeriksaan statis: seluruh berkas JS dan tiap blok `<script>` inline lolos
pemeriksaan sintaks; seluruh tag HTML seimbang; tidak ada lagi halaman yang
script-nya dibungkus blok.

---

## Catatan pemakaian

- **Printer thermal 58mm Bluetooth Classic:** gunakan tombol **Cetak Struk** +
  aplikasi **RawBT** di Android. Tombol Bluetooth di aplikasi khusus BLE.
- **Agar tombol Bluetooth aktif:** buka POS lewat HTTPS atau
  `http://localhost`. Lewat alamat LAN biasa, browser memblokir Bluetooth.
- **Kalau hasil cetak masih terlihat mepet** atau ada karakter terpotong di sisi
  kanan, naikkan slider margin di Pengaturan Struk.
- Setelah hak akses sebuah role diubah, pengguna terkait perlu **login ulang**.
