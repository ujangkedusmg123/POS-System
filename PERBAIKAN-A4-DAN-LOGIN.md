# Perbaikan: Cetak A4, Ganti Nama, dan Wajib Login

---

## 1. Pemisahan format cetak: A4 vs thermal

### Masalah

Semua jalur cetak memakai format struk thermal. Akibatnya **Laporan Tutup
Kasir** dicetak dengan lebar 72mm, font Courier, dan `@page size:80mm` —
hasilnya tidak terbaca ketika dicetak ke kertas A4. Sementara di halaman
**Laporan Keuangan**, tombol Cetak memanggil `window.print()` mentah sehingga
yang tercetak adalah **seluruh halaman aplikasi** — sidebar, tombol, dan tab
ikut terbawa.

### Perbaikan

Dibuat modul dokumen A4 yang **terpisah total** dari struk thermal:

| Jalur cetak | Format | Keterangan |
|---|---|---|
| Struk pelanggan di POS | **Thermal saja** (58/80mm) | via printer Bluetooth |
| Cetak ulang struk (Riwayat Penjualan) | **Thermal saja** | via printer Bluetooth |
| Tes cetak di Pengaturan Struk / Struk Custom | **Thermal** | memang menguji struk |
| Laporan Tutup Kasir | **A4** | cetak / unduh |
| Laporan Keuangan | **A4** | cetak / unduh |

Dokumen A4 memakai `@page size:A4 portrait`, lebar 210mm, font proporsional
(bukan Courier), kop toko dengan logo, tabel bergaris rapi, blok tanda tangan,
serta kaki halaman berisi waktu cetak. Baris tabel diberi `break-inside:avoid`
dan header tabel diulang di tiap halaman.

Setiap laporan kini punya **dua tombol**:

- **🖨️ Cetak A4 / PDF** — membuka dialog cetak; bisa dipilih printer A4 atau
  "Simpan sebagai PDF".
- **⬇️ Unduh (A4)** — mengunduh berkas dokumennya, bisa dibuka dan dicetak
  kapan saja tanpa membuka aplikasi.

Struk pelanggan sengaja **tidak** diberi opsi A4, sesuai permintaan: struk
pelanggan hanya thermal.

---

## 2. Ganti nama: Udang Kedu → Ujang Kedu

Diganti di **87 kemunculan pada 31 berkas**: seluruh halaman HTML, `app.js`,
`style.css`, `server.js`, dan data awal di `database/db.js` (nama toko pada
struk, judul halaman login, footer struk, dan teks sidebar).

Diverifikasi otomatis: tidak ada lagi string `Udang Kedu` maupun `udangkedu`
yang tersisa di seluruh kode.

> Catatan: nama toko yang **sudah tersimpan** di database lama tidak ikut
> berubah, karena itu data milik Anda. Kalau memakai database lama, ubah lewat
> **Pengaturan Struk** dan **Tampilan Login**. Database baru langsung memakai
> "Ujang Kedu".

---

## 3. Wajib login — penyebab sebenarnya

### Masalah

Sesi disimpan di `localStorage`, yang **bertahan selamanya** meski browser
ditutup dan dibuka lagi berhari-hari kemudian. Jadi membuka `localhost:3000`
selalu langsung masuk ke dashboard, karena token lama masih ada di sana.
Pemeriksaan keabsahan token ke server memang sudah ditambahkan sebelumnya,
tetapi token yang masih berlaku tetap meloloskan pengguna tanpa login.

### Perbaikan

Sesi dipindahkan dari `localStorage` ke **`sessionStorage`**. Bedanya:
`sessionStorage` otomatis terhapus saat tab/browser ditutup.

Hasilnya: **setiap kali aplikasi dibuka kembali, halaman login selalu muncul.**
Menyegarkan halaman atau berpindah menu tetap tidak meminta login ulang, jadi
tidak mengganggu kasir yang sedang bekerja.

Perubahan diterapkan pada **28 berkas** — `app.js`, `login.html`, dan penjaga
di setiap halaman. Cache pengaturan struk tetap di `localStorage` karena bukan
data sesi.

Lapisan pengaman yang tetap berlaku:

- Token divalidasi ke server (`/api/auth/me`); token kedaluwarsa dibersihkan.
- URL yang tidak dikenal dialihkan ke `/login.html`.
- Seluruh endpoint API menolak permintaan tanpa token (401).

---

## Hasil pengujian

Dijalankan pada instance bersih berdatabase baru.

| Suite | Cakupan | Hasil |
|---|---|---|
| Verifikasi 4 permintaan | A4 vs thermal, rename, wajib login | **27/27 LULUS** |
| Handler DOM | tiap `onclick` di seluruh halaman | **226 hidup, 0 mati** |
| Tombol Cetak POS | satu tombol, jalur Bluetooth, cetak otomatis aman | 11 LULUS |
| Keamanan permission | wildcard, eskalasi hak akses | 23 LULUS |
| Buka/tutup kasir | gerbang shift, rumus paten, cash out | 35 LULUS |
| Role / termin / template | CRUD, isolasi struk default | 27 LULUS |
| Login & hak akses | branding publik, penegakan izin | 20 LULUS |
| API / izin / error | 401/403/404/413 | 13 LULUS |
| Regresi end-to-end | endpoint + transaksi + detail cetak ulang | 21 LULUS |
| Struk & ESC/POS | charset, escaping, margin, raster logo | 44 LULUS |

Pemeriksaan spesifik format cetak yang lulus:

- struk POS memakai `@page size:58mm` dan font monospace — **bukan** A4;
- dokumen A4 memakai `@page size:A4 portrait`, lebar 210mm, dan **tidak**
  mengandung lebar thermal (58/72/80mm) maupun font Courier;
- `shift-reports.html` tidak lagi memuat `size:80mm auto`;
- `reports.html` tidak lagi memuat `onclick="window.print()"`.

---

## Cara menjalankan

```bash
npm install
npm start          # http://localhost:3000
```

Database dibuat otomatis saat pertama dijalankan. Untuk mengulang dari nol,
hapus `database/pos.db`.

**Setelah memasang versi ini, tekan Ctrl+Shift+R sekali** agar browser tidak
memakai berkas lama.
