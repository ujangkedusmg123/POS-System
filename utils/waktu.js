/**
 * WAKTU — seluruh sistem memakai WIB (UTC+7)
 * ---------------------------------------------------------------------------
 * Kenapa dipusatkan di sini: aplikasi ini dipasang di server yang zona waktunya
 * belum tentu Asia/Jakarta. Kalau sebagian kode memakai jam server dan sebagian
 * lagi memakai `CURRENT_TIMESTAMP` bawaan SQLite (yang selalu UTC), laporan
 * "hari ini" bisa meleset satu hari — transaksi jam 00:30 WIB akan terhitung
 * sebagai hari kemarin. Semua tanggal & jam di aplikasi ini WIB, titik.
 *
 * Pemakaian:
 *   - Di SQL   : pakai konstanta NOW_SQL, mis. `... created_at=${NOW_SQL}`
 *   - Di JS    : pakai nowWib() / todayWib() / bulanIniWib()
 */

const OFFSET_MENIT = 7 * 60; // WIB = UTC+7

/** Ekspresi SQLite untuk "sekarang" dalam WIB. Pakai ini, jangan CURRENT_TIMESTAMP. */
const NOW_SQL = "datetime('now','+7 hours')";

/** Ekspresi SQLite untuk "tanggal hari ini" dalam WIB. */
const TODAY_SQL = "date('now','+7 hours')";

/** Objek Date yang komponennya (getFullYear, getHours, ...) sudah bernilai WIB. */
function wibDate(d) {
  const base = d ? new Date(d) : new Date();
  return new Date(base.getTime() + (OFFSET_MENIT + base.getTimezoneOffset()) * 60000);
}

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD HH:MM:SS' waktu WIB — format yang dipakai kolom datetime di DB. */
function nowWib() {
  const w = wibDate();
  return `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())} ${pad(w.getHours())}:${pad(w.getMinutes())}:${pad(w.getSeconds())}`;
}

/** 'YYYY-MM-DD' hari ini menurut WIB. */
function todayWib() {
  const w = wibDate();
  return `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}`;
}

/** 'YYYY-MM' bulan berjalan menurut WIB. */
function bulanIniWib() {
  const w = wibDate();
  return `${w.getFullYear()}-${pad(w.getMonth() + 1)}`;
}

/** 'YYYY-MM-01' — awal bulan berjalan menurut WIB. */
function awalBulanWib() {
  return bulanIniWib() + '-01';
}

/** 'YYYY-MM' bulan lalu menurut WIB. */
function bulanLaluWib() {
  const w = wibDate();
  w.setDate(1);
  w.setMonth(w.getMonth() - 1);
  return `${w.getFullYear()}-${pad(w.getMonth() + 1)}`;
}

/** 'YYYY-MM-DD' n hari yang lalu menurut WIB. */
function hariLaluWib(n) {
  const w = wibDate();
  w.setDate(w.getDate() - (parseInt(n) || 0));
  return `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}`;
}

module.exports = {
  NOW_SQL, TODAY_SQL, OFFSET_MENIT,
  wibDate, nowWib, todayWib, bulanIniWib, awalBulanWib, bulanLaluWib, hariLaluWib,
};
