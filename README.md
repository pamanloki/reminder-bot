# reminder-bot

Bot Telegram **pengingat** token listrik, pulsa, dan masa aktif paket internet.
Jalan di **Cloudflare Worker** (satu file `worker.js`, tanpa dependency).

## Fitur

- ⚡ **Token listrik**, 📱 **pulsa**, 🌐 **paket internet**, 🔔 **lainnya**
- Set **tanggal beli/mulai** + **masa aktif (hari)** → otomatis hitung tanggal habis
- 🔔 **Notifikasi otomatis** menjelang habis (H-3, H-1, hari-H, dan telat) via Cron — dengan pesan informatif (tanggal habis, sisa hari, saran)
- 📋 `/list` daftar semua + status: 🟢 aman · ⚠️ mepet · 🔴 habis/telat
- Tap item → ✅ **Sudah beli / perpanjang** (reset masa aktif) atau 🗑️ **Hapus**
- Menu tombol + privat via `ALLOWED_IDS`

## Cara pakai (di bot)

Paling gampang: `/menu` → tap jenis → ikuti contoh. Atau ketik langsung:

```
<jenis> <masa_aktif_hari> [tgl] [nama]
```

- `paket 30 15-9 IM3` → paket 30 hari, beli 15/9, nama IM3
- `pulsa 45` → masa aktif 45 hari, mulai hari ini
- `listrik 30` → ingat isi ulang token tiap 30 hari

Alias jenis: `token/pln` → listrik, `kuota/internet/data` → paket.

## Setup (via dashboard Cloudflare, tanpa Wrangler)

1. **Buat Worker** → **Edit code** → tempel isi `worker.js` → **Deploy**.
2. **Secrets** (Settings → Variables and Secrets, tipe **Secret**):
   | Name | Value |
   |------|-------|
   | `BOT_TOKEN` | token dari @BotFather (wajib) |
   | `TELEGRAM_SECRET` | string acak bebas (disarankan) |
   | `ALLOWED_IDS` | ID Telegram-mu, dipisah koma (untuk privat) |
3. **Bindings** (Settings → Bindings): **KV Namespace** → variable **`REMINDERS`**.
4. **Cron Trigger** (Settings → Triggers → Cron): `0 1 * * *` (tiap hari 08:00 WIB) → **Deploy**.
5. **Daftarkan webhook** (buka di browser):
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<TELEGRAM_SECRET>
   ```
6. Kirim `/start`, lalu `/setup` sekali agar tombol menu Telegram aktif.

## Catatan

- Data disimpan di **Cloudflare KV**, per user Telegram.
- Zona waktu **WIB (UTC+7)**.
- Notifikasi dikirim sekali per hari (saat Cron jalan) untuk item yang ≤ H-3 sampai lewat jatuh tempo.
