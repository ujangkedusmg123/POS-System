# Perbaikan Putaran Ini

Menanggapi laporan: preview struk di Pengaturan, bug konfigurasi tampilan
halaman awal, konfigurasi terasa tidak tersimpan, akses tanpa login, dan
tampilan yang tumpang tindih.

---

## 1. Preview struk dihilangkan dari halaman Pengaturan

Sesuai permintaan, panel preview struk dihapus dari:

- **Pengaturan Struk** (`struk.html`) — panel kanan kini berisi tombol
  **Cetak Struk Contoh** dan kontrol Printer Bluetooth.
- **Struk Custom** (`struk-custom.html`) — diganti tombol **Cetak Contoh
  Template** plus ringkasan teks bidang mana saja yang ditimpa.

**Tidak ada satu pun `<iframe>` tersisa di seluruh halaman aplikasi.** Ini
sekaligus menghapus sumber utama tampilan tumpang tindih.

---

## 2. Bug konfigurasi tampilan halaman awal

### Akar masalah — preview memuat dashboard, bukan halaman login

Preview di **Tampilan Login** memuat `/login.html` ke dalam sebuah `<iframe>`.
Masalahnya, `login.html` punya logika "sudah login? langsung masuk" yang
otomatis mengalihkan ke dashboard. Karena admin yang sedang mengatur memang
sudah login, isi iframe **langsung berpindah ke dashboard** — lengkap dengan
sidebar posisi `fixed` yang menimpa kotak preview. Inilah tampilan "tumpuk"
yang terlihat.

**Perbaikan:** preview tidak lagi memakai iframe. Diganti *mock* yang digambar
langsung di halaman (elemen biasa), sehingga tidak mungkin mengalihkan halaman
dan tidak mungkin menimpa apa pun. Mock ikut berubah realtime mengikuti judul,
subjudul, sambutan, emoji/logo, warna gradasi, gambar latar, dan footer.

Sebagai lapis kedua, `login.html` kini mengenali mode `?preview=1` dan
mematikan pengalihan otomatis sepenuhnya.

### Akar masalah — unggah gambar latar selalu gagal

Gambar latar dikecilkan lalu **dipaksa menjadi PNG** pada lebar 1400px:

```js
bgData = await normalizeLogoDataUrl(raw, 1400);   // selalu PNG
if (bgData.length > 2.2*1024*1024) { ...ditolak... }
```

Foto (bukan grafis) yang dikonversi ke PNG membengkak jadi 3–5 MB, sehingga
selalu melewati batas dan **ditolak tanpa penjelasan yang jelas**.

**Perbaikan:** foto latar kini dikompres sebagai **JPEG secara bertahap**
(1600 → 1400 → 1200 → 1000 → 800 → 640 px, mutu 0.82 → 0.55) sampai berada di
bawah 900 KB. Pesan sukses menyebutkan ukuran akhirnya, mis.
*"Gambar latar dimuat (312 KB)"*. Logo tetap memakai PNG karena butuh tepi
tajam dan latar transparan.

---

## 3. "Semua konfigurasi kayanya belum bisa kesimpan"

Penyimpanan diuji berlapis dan **semuanya berhasil**:

- Lewat API langsung (termasuk nilai kosong, angka, boolean, dan `null`).
- Lewat DOM sungguhan: isi form → klik Simpan → muat ulang halaman baru →
  nilai kembali muncul.
- **Bertahan setelah server di-restart.**
- Untuk seluruh modul: Tampilan Login, Pengaturan Struk, Struk Custom, Role,
  Termin Pembayaran, Cabang, dan Channel.

### Penyebab yang paling mungkin: cache browser

Server tidak pernah mengirim header cache untuk berkas statis, sehingga browser
bebas menyimpan `app.js` versi lama. Akibatnya perbaikan yang sudah dikirim
tidak ikut terpakai — termasuk perbaikan tombol `async` sebelumnya — sehingga
tombol Simpan terasa tidak bekerja.

**Perbaikan:** berkas `.html`, `.js`, dan `.css` kini dikirim dengan
`Cache-Control: no-cache, must-revalidate`.

> **Setelah memasang versi ini, tekan Ctrl+Shift+R satu kali** untuk membuang
> berkas lama yang masih tersimpan di browser.

### Satu celah nyata yang ditemukan

`receipt_margin` tidak terdaftar sebagai kunci konfigurasi yang diizinkan pada
**Struk Custom**, sehingga margin yang diatur di sana **dibuang diam-diam saat
disimpan** — API tetap menjawab "berhasil". Kunci sudah ditambahkan di server
dan kolom isiannya ditambahkan di form.

---

## 4. Membuka localhost:3000 langsung masuk sistem

### Akar masalah

Penjagaan hanya memeriksa *keberadaan* token di `localStorage`:

```js
if (!localStorage.getItem('pos_token')) window.location.replace('/login.html');
```

Token JWT kedaluwarsa setelah 12 jam. Token basi tetap dianggap "sudah login",
jadi pengguna langsung dilempar ke dalam sistem dan hanya menemui halaman yang
gagal memuat data. `login.html` pun ikut mengalihkan otomatis berdasarkan
token yang belum tentu sah.

### Perbaikan

- `login.html` memvalidasi token ke `/api/auth/me` **sebelum** mengalihkan.
  Token tidak sah otomatis dibersihkan dan pengguna tetap di halaman login.
- Setiap halaman memanggil `Auth.validateSession()` yang memverifikasi sesi ke
  server dan menendang keluar bila token ditolak; data pengguna sekaligus
  disegarkan agar perubahan hak akses langsung terbawa.
- URL yang tidak dikenal kini **dialihkan ke `/login.html`**, bukan menyajikan
  `index.html` (dulu kerangka dashboard sempat tampil sebelum penjaga jalan).
- `production.html` ternyata sama sekali **tidak punya penjaga login** —
  sudah ditambahkan.

---

## 5. Tampilan tumpang tindih

- Seluruh `<iframe>` dihapus (sumber utama tumpang tindih).
- Panel samping pada halaman pengaturan tidak lagi memakai `position:sticky`
  di `struk.html`; yang masih sticky punya media query yang mengembalikannya ke
  aliran normal di layar < 1000px.
- Audit otomatis: seluruh tag HTML seimbang di semua halaman, seluruh halaman
  punya `meta viewport`, dan setiap tabel terbungkus wadah scroll.

---

## Hasil pengujian

Semua suite dijalankan terhadap server sungguhan.

| Suite | Cakupan | Hasil |
|---|---|---|
| Penyimpanan pengaturan | API, DOM, dan bertahan setelah restart | LULUS |
| DOM halaman pengaturan | tanpa iframe, mock preview, simpan + reload | LULUS (17) |
| Template struk custom | config tersimpan utuh, margin, isolasi struk default | LULUS (8) |
| Gerbang login | validasi token, URL tak dikenal, no-cache, preview | LULUS (17) |
| Handler DOM | tiap `onclick` di seluruh halaman terjangkau | LULUS (225) |
| Keamanan permission | wildcard, eskalasi hak akses, admin tetap utuh | LULUS (23) |
| Role / termin / template | CRUD, proteksi role sistem | LULUS (27) |
| Buka/tutup kasir | gerbang shift, rumus paten, cash out | LULUS (35) |
| API / izin / error | 401/403/404/413 | LULUS (13) |
| Regresi end-to-end | endpoint + transaksi + detail cetak ulang | LULUS (21) |
| Struk & ESC/POS | charset, escaping, margin, raster logo | LULUS (44) |

Pemeriksaan statis: seluruh berkas JS dan tiap blok `<script>` inline lolos
pemeriksaan sintaks; seluruh tag HTML seimbang; tidak ada `<iframe>` tersisa.

---

## Catatan pemasangan

```bash
npm install
npm start          # http://localhost:3000
```

Database tidak disertakan — dibuat otomatis lengkap dengan data awal saat
pertama dijalankan. Untuk mengulang dari nol, hapus `database/pos.db`.

**Penting:** setelah memasang versi ini, buka browser lalu tekan
**Ctrl+Shift+R** sekali agar berkas lama yang tersimpan di browser dibuang.
