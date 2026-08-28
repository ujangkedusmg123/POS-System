# Perbaikan Sistem Cetak Struk — Udang Kedu POS

Ringkasan perubahan pada revisi ini. Fokus utama: **logo yang tidak ikut tercetak**.

---

## 1. Kenapa logo tidak tercetak?

Ada **empat penyebab terpisah**, bukan satu. Backend sebenarnya sudah benar — logo
base64 sampai ~930KB tersimpan utuh di database (sudah diuji). Semua masalah ada di
sisi cetak.

### a. Balapan waktu (penyebab utama)

Kode lama menulis HTML ke iframe lalu memanggil `print()` setelah jeda **tetap 350 ms**:

```js
setTimeout(() => { ifr.contentWindow.print(); }, 350);
```

Kalau gambar logo belum selesai dimuat dalam 350 ms, yang tercetak adalah struk
**tanpa logo**. Untuk logo dari URL internet hampir selalu gagal. Untuk logo base64
besar di HP kentang juga sering gagal.

**Perbaikan:** proses cetak sekarang menunggu **semua gambar benar-benar selesai
`decode()`** sebelum `print()` dipanggil, lengkap dengan timeout pengaman 5 detik
supaya tidak pernah macet selamanya.

### b. Cache pengaturan tidak pernah kedaluwarsa

```js
const cached = localStorage.getItem('pos_receipt_settings');
if (cached) return JSON.parse(cached);   // selamanya!
```

Admin upload logo di perangkatnya sendiri, `clearReceiptCache()` hanya jalan di
browser itu. Perangkat kasir tetap memakai cache lama **selamanya** — jadi di preview
logonya muncul, tapi di struk asli tidak pernah.

**Perbaikan:** cache sekarang punya TTL 60 detik + auto-refresh. Kalau server tidak
bisa dihubungi, jatuh ke cache lama supaya kasir tetap bisa mencetak saat offline.

### c. Printer Bluetooth tidak pernah mengirim logo sama sekali

Fungsi `escposFromSale()` lama hanya mengirim teks. Tidak ada satu baris pun kode
gambar di dalamnya.

**Perbaikan:** logo dikonversi jadi raster monokrom (perintah ESC/POS `GS v 0`)
dengan dithering Floyd–Steinberg, dikirim per-band 96 baris agar aman di BLE.
Logo berwarna/abu-abu jadi tetap terbaca di printer thermal hitam-putih.

### d. Dokumen cetak tidak punya `<meta charset>`

Teks Indonesia dan emoji bisa berantakan di sebagian driver printer.

**Perbaikan:** ditambahkan `<meta charset="UTF-8">`.

---

## 2. Perbaikan lain pada alur cetak

| Masalah | Perbaikan |
|---|---|
| Iframe cetak berukuran `0×0` + `visibility:hidden` — sebagian browser tidak me-render (dan tidak mencetak) gambar di dalamnya | Iframe dipindah ke luar layar (`left:-10000px`) tapi tetap punya dimensi nyata |
| iOS/Safari tidak mendukung `print()` dari iframe (yang tercetak malah halaman induk) | iOS otomatis dialihkan ke jendela cetak terpisah |
| Logo dari URL bisa gagal karena CORS / hotlink protection / internet mati | Logo di-resolve jadi data URL dulu, di-cache di memori; URL bisa ditanam permanen lewat tombol **Muat** |
| Tidak ada `@page size` — printer thermal memakai ukuran A4 | `@page { size: 58mm auto }` sesuai pilihan kertas |
| Gambar bisa dibuang browser saat mencetak | Ditambah `print-color-adjust: exact` |
| Klik tombol cetak berkali-kali menumpuk jendela cetak | Ada penjaga `_printBusy` |
| Iframe cetak menumpuk di DOM dan tidak pernah dibersihkan | Dibersihkan lewat `onafterprint` + jaring pengaman |
| Preview di halaman Struk memakai renderer yang **berbeda** dari hasil cetak (dua implementasi terpisah) | Preview sekarang iframe 1:1 memakai `buildReceiptHTML()` yang sama persis — WYSIWYG betulan |
| Nama produk panjang terpotong di struk ESC/POS | Sekarang di-*wrap* rapi per lebar kertas |

---

## 3. Fitur baru di halaman Pengaturan Struk

- **Pilihan lebar kertas 58 mm / 80 mm** — ikut mengatur lebar halaman cetak,
  jumlah karakter per baris (32 / 48), dan resolusi logo Bluetooth (384 / 576 dot).
- **Slider lebar logo 15–100%** dengan tampilan perkiraan ukuran dalam dot & mm.
- **Toggle "Cetak logo di struk"** — matikan logo tanpa menghapusnya.
- **Kompresi otomatis** — logo yang diupload diperkecil ke lebar 384 px dan
  dikonversi ke PNG, jadi database dan localStorage tetap ringan.
- **Tombol "Muat" untuk URL** — mengunduh gambar dan menanamkannya, supaya tetap
  tercetak walau perangkat kasir sedang offline.
- **Tes cetak Bluetooth memakai pengaturan yang sedang diedit**, jadi bisa dicoba
  sebelum disimpan.

---

## 4. Bug lain yang ikut diperbaiki

1. **Kasir tertendang keluar saat menyentuh fitur admin.**
   `API.request()` memanggil `Auth.logout()` pada status **403**, padahal 403 berarti
   "login valid tapi tidak berhak", bukan "sesi habis". Sekarang hanya **401** yang
   memaksa logout; 403 menampilkan pesan errornya.

2. **Request menggantung selamanya untuk endpoint API tak dikenal.**
   ```js
   app.get('*', (req, res) => {
     if (!req.path.startsWith('/api')) res.sendFile(...);  // /api/* tidak dibalas!
   });
   ```
   Sekarang membalas `404` JSON. (Berkat ini, salah ketik endpoint langsung ketahuan
   alih-alih membuat halaman menggantung.)

3. **Payload kelewat besar membalas halaman HTML error Express.**
   Sekarang membalas `413` JSON berbahasa Indonesia: "Data terlalu besar. Perkecil
   ukuran logo (maks ~1MB)." Ditambah handler error global.

4. **Teks pengaturan & nama produk disisipkan mentah ke HTML struk** — bisa merusak
   layout atau jadi celah XSS. Semua sudah di-escape lewat `escHtml()`.

5. **`API.request` gagal total kalau server membalas non-JSON** — parsing JSON kini
   dibungkus try/catch, dan pesan error menyertakan kode status.

6. **Definisi tabel `channels` terduplikat** di `database/db.js` — dibersihkan.

---

## 5. Hasil pengujian

Empat suite otomatis dijalankan terhadap server yang benar-benar berjalan.
**Semua lulus, 0 gagal.**

| Suite | Cek | Hasil |
|---|---|---|
| HTML struk (charset, escaping, `@page`, ukuran logo, toggle) | 12 | LULUS |
| ESC/POS + raster logo (verifikasi bit-level: piksel hitam → bit 1, header `GS v 0`, wrapping 32/48 kolom, potong kertas) | 19 | LULUS |
| Alur cetak & cache (menunggu gambar, gambar gagal, timeout, TTL, fallback offline) | 13 | LULUS |
| API / izin / error (izin admin vs kasir, 401/403/404/413, roundtrip logo 930KB) | 13 | LULUS |
| Regresi end-to-end (13 endpoint utama + buat transaksi + ambil detail untuk cetak ulang) | 21 | LULUS |

Selain itu: seluruh file JS dan setiap blok `<script>` inline di 24 halaman HTML lolos
pemeriksaan sintaks, dan **79 pemanggilan API dari frontend sudah dicocokkan satu per
satu dengan 102 route yang terdaftar** — semuanya valid.

---

## 6. Catatan pemakaian

**Untuk hasil logo paling tajam di printer thermal:** pakai PNG **hitam-putih dengan
kontras tinggi**, bukan foto. Printer thermal hanya mengenal hitam dan putih — foto
akan diproses lewat dithering dan hasilnya cenderung berbintik.

**Printer Bluetooth Classic (mayoritas printer 58 mm murah):** tombol Bluetooth di
aplikasi hanya untuk printer **BLE**. Untuk Bluetooth Classic, pakai tombol **Cetak
Struk** biasa + aplikasi **RawBT** di Android sebagai print service — jalur ini
sekarang sudah mencetak logo dengan benar.

**Setelah mengubah pengaturan struk**, perangkat kasir akan mengambil pengaturan baru
dalam waktu maksimal 60 detik (atau langsung saat halaman dimuat ulang).

---

## 7. File yang diubah

```
public/js/app.js       modul struk & cetak ditulis ulang (~470 baris)
public/struk.html      ditulis ulang: preview WYSIWYG + kontrol kertas/logo
server.js              404 JSON untuk API, handler error global
database/db.js         seed pengaturan baru, hapus tabel duplikat
```

Menjalankan: `npm install` lalu `npm start` → http://localhost:3000
