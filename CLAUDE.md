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
  `{ id, jenis, nama, mulai(ts), durasi(hari), ingatkan(hari) }`
  - `jenis`: listrik | pulsa | paket | lainnya (lihat konstanta `JENIS`)
  - habis = `mulai + durasi*DAY`; sisa hari via `sisaHari(habisTs)`
- `mode:<uid>` → string sementara `add:<jenis>` (TTL 15 mnt).

`uid` = id user Telegram = chat_id (private chat), dipakai langsung untuk notifikasi.

## Konvensi

- Zona waktu **WIB (UTC+7)** — pakai `wibParts(ts)`, jangan getHours lokal.
- Preset jenis (emoji, durasi default, H-berapa) ada di `JENIS`.
- Tambah jenis baru → tambah entri di `JENIS` + tombol di `MENU_MAIN` + alias di
  `routeMessage`.
- Status/urgensi dihitung dari `sisaHari` (🟢 aman / ⚠️ ≤ingatkan / 🔴 habis-telat).
- Komentar & teks bot dalam Bahasa Indonesia.
