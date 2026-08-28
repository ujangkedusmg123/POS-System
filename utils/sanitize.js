/**
 * PEMBERSIH INPUT — pertahanan terhadap XSS tersimpan
 * ---------------------------------------------------------------------------
 * Halaman-halaman aplikasi ini menyusun tampilan dengan `innerHTML`, dan teks
 * yang ditampilkan berasal dari database: nama pelanggan, keterangan beban,
 * catatan pesanan, nama produk, dan seterusnya. Kalau seorang kasir menyimpan
 * nama pelanggan berisi tag HTML, tag itu akan ikut dieksekusi di browser orang
 * lain — termasuk browser pemilik yang sedang login sebagai admin. Itu jalan
 * pintas dari "kasir" menjadi "admin".
 *
 * Menambal ratusan titik render satu per satu rawan terlewat. Karena itu
 * penjagaannya diletakkan di satu pintu masuk: tidak ada tag HTML yang boleh
 * tersimpan ke database sejak awal.
 *
 * Yang TIDAK dibersihkan (memang butuh karakter khusus / bukan teks tampilan):
 *   - password           : tidak pernah ditampilkan, dan tidak boleh diubah isinya
 *   - logo / gambar / url: berisi data URI panjang
 *   - config / permissions: struktur JSON, bukan teks bebas
 */

// Kunci yang isinya bukan teks tampilan — dibiarkan apa adanya.
const LEWATI = /^(.*password.*|.*logo.*|.*image.*|.*_url|url|config|permissions|token|barcode)$/i;

const MAKS_PANJANG = 5000; // batas wajar untuk satu kolom teks

/** Buang tag HTML dan sisa kurung siku dari sebuah teks. */
function bersihkanTeks(v) {
  let s = String(v);
  if (s.length > MAKS_PANJANG) s = s.slice(0, MAKS_PANJANG);
  // Buang tag utuh dulu (<script>...), lalu kurung siku yang tersisa.
  const hasil = s.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
  return hasil;
}

/** Telusuri objek/array dan bersihkan setiap nilai teks di dalamnya. */
function bersihkan(nilai, kunci, kedalaman) {
  const level = kedalaman || 0;
  if (level > 6) return nilai; // jaga-jaga dari struktur yang terlalu dalam
  // Kunci yang dikecualikan dilewati beserta seluruh isinya, bukan hanya
  // lapisan terluarnya — mis. `config` template struk yang berupa objek.
  if (kunci && LEWATI.test(kunci)) return nilai;
  if (typeof nilai === 'string') return bersihkanTeks(nilai);
  if (Array.isArray(nilai)) return nilai.map((v) => bersihkan(v, kunci, level + 1));
  if (nilai && typeof nilai === 'object') {
    const keluar = {};
    Object.keys(nilai).forEach((k) => { keluar[k] = bersihkan(nilai[k], k, level + 1); });
    return keluar;
  }
  return nilai;
}

/** Middleware Express: bersihkan body pada permintaan yang menulis data. */
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object' && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
    try { req.body = bersihkan(req.body); } catch (e) { /* biarkan apa adanya kalau gagal */ }
  }
  next();
}

module.exports = { sanitizeBody, bersihkanTeks };
