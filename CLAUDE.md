# CLAUDE.md

Panduan singkat untuk mengembangkan repo ini.

## Apa ini

Bot Telegram **pengingat** (token listrik, pulsa, masa aktif paket internet),
berjalan sebagai **Cloudflare Worker**. Seluruh logika di satu file `worker.js`
(tanpa framework/dependency).

## Deploy

Lewat **dashboard Cloudflare** (bukan Wrangler): Worker → Edit code → tempel
`worker.js` → Deploy. Detail di `README.md`. Validasi cepat sebelum commit:

```bash
node --check worker.js
```

## Konfigurasi runtime

- Secrets: `BOT_TOKEN` (wajib), `TELEGRAM_SECRET`, `ALLOWED_IDS`.
- Binding: KV Namespace → variable **`REMINDERS`**.
- Cron Trigger `0 1 * * *` (08:00 WIB) → memicu `scheduled` untuk notifikasi.

## Arsitektur `worker.js`

Dua entry point di `export default`:
- `fetch(request, env)` — webhook Telegram (POST) & halaman status (GET).
- `scheduled(event, env, ctx)` — dipanggil Cron → `runScheduled()` kirim notifikasi.

Alur pesan: `handleTelegram` → `routeMessage` (teks/perintah) atau
`handleCallback` (tombol). Tambah pengingat lewat mode `add:<jenis>` (KV, TTL 15 mnt)
atau teks cepat (`paket 30 15-9 IM3`).

## Model data (KV)

- `rem:<uid>` → array pengingat:
  `{ id, jenis, nama, ingatkan, [mulai+durasi | hariBulan], [jamMenit], [skipUntil], [snoozeUntil] }`
  - `jenis`: listrik | pulsa | paket | lainnya (lihat konstanta `JENIS`)
  - durasi: habis = `mulai + durasi*DAY`; bulanan: `nextMonthlyTs(hariBulan, skipUntil)`
  - jatuh tempo via `dueTs(it)`; sisa hari via `sisaHari(dueTs(it))`
  - `snoozeUntil` (ts): di-snooze sampai tanggal itu (tombol 😴 Besok)
- `mode:<uid>` → string sementara: `w_*` (wizard), `buy:<id>`, `edit:<id>:<field>`, `restore` (TTL 15 mnt).
- `ops:<uid>` → operator custom; `labels:<uid>` → label "atas nama" custom.
- `hist:<uid>` → riwayat isi ulang `{ jenis, label, nama, ts }` (maks 60).

## Cron & notifikasi

- Ringkasan harian dikirim saat jam 08:00 WIB (`isDigest`). Kalau Cron diset
  `0 * * * *` (tiap jam), item ber-`jamMenit` yang jatuh tempo hari-H juga dapat
  "⏰ ALARM" tepat di jamnya. Notif per item + tombol (✅ Sudah beli / 😴 Besok).

`uid` = id user Telegram = chat_id (private chat), dipakai langsung untuk notifikasi.

## Konvensi

- Zona waktu **WIB (UTC+7)** — pakai `wibParts(ts)`, jangan getHours lokal.
- Preset jenis (emoji, durasi default, H-berapa) ada di `JENIS`.
- Tambah jenis baru → tambah entri di `JENIS` + tombol di `MENU_MAIN` + alias di
  `routeMessage`.
- Status/urgensi dihitung dari `sisaHari` (🟢 aman / ⚠️ ≤ingatkan / 🔴 habis-telat).
- Komentar & teks bot dalam Bahasa Indonesia.
