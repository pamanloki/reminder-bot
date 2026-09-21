// Bot Telegram pengingat: token listrik, pulsa, masa aktif paket internet.
// Jalan di Cloudflare Worker.
//
// Cara pakai (kirim ke bot):
//   /tambah            -> pilih jenis lewat tombol, lalu ketik detailnya
//   Cepat via teks     : "paket 30 15-9 IM3"  (paket, masa aktif 30 hari, beli 15/9, nama IM3)
//                        "listrik 30 150rb"   (token listrik, ingatkan tiap 30 hari)
//                        "pulsa 45"           (pulsa, masa aktif 45 hari mulai hari ini)
//   /list              -> daftar pengingat + sisa hari
//   /menu, /help
//
// Notifikasi otomatis via Cron Trigger (mis. tiap hari 08:00 WIB = 01:00 UTC: "0 1 * * *").
//
// Siapkan di dashboard Worker:
//   Secrets : BOT_TOKEN (wajib), TELEGRAM_SECRET (disarankan), ALLOWED_IDS (privat)
//   Bindings: KV Namespace -> variable "REMINDERS"

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta (UTC+7)
const DAY = 86400000;

// Preset jenis: emoji, label, masa aktif default (hari), ingatkan H-berapa.
const JENIS = {
  listrik: { emoji: "⚡", label: "Token Listrik", durasi: 30, ingatkan: 3, kata: "isi ulang" },
  pulsa: { emoji: "📱", label: "Pulsa", durasi: 30, ingatkan: 5, kata: "masa aktif" },
  paket: { emoji: "🌐", label: "Paket Internet", durasi: 30, ingatkan: 3, kata: "masa aktif" },
  lainnya: { emoji: "🔔", label: "Lainnya", durasi: 30, ingatkan: 3, kata: "jatuh tempo" },
};

export default {
  async fetch(request, env) {
    if (request.method === "POST") return handleTelegram(request, env);
    return new Response("Bot pengingat aktif.", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function handleTelegram(request, env) {
  if (env.TELEGRAM_SECRET) {
    const got = request.headers.get("x-telegram-bot-api-secret-token");
    if (got !== env.TELEGRAM_SECRET) return new Response("forbidden", { status: 403 });
  }
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return new Response("ok");
  }

  const msg = update.message || update.edited_message;
  const chatId = msg && msg.chat && msg.chat.id;
  const fromId = msg && msg.from && msg.from.id;
  if (!chatId) return new Response("ok");
  if (!isAllowed(env, fromId, chatId)) {
    await sendMessage(env, chatId, "Maaf, bot ini privat.");
    return new Response("ok");
  }
  try {
    await routeMessage(env, chatId, msg);
  } catch (e) {
    await sendMessage(env, chatId, "Maaf, terjadi error: " + (e && e.message ? e.message : e));
  }
  return new Response("ok");
}

async function routeMessage(env, chatId, msg) {
  const uid = msg.from.id;
  const text = (msg.text || "").trim();
  if (!text) return sendMessage(env, chatId, "Ketik /menu untuk mulai.");

  const lower = text.toLowerCase();
  if (lower === "/start") {
    await sendMessage(env, chatId, helpText());
    return sendMenu(env, chatId);
  }
  if (lower === "/help") return sendMessage(env, chatId, helpText());
  if (lower.startsWith("/menu")) return sendMenu(env, chatId);
  if (lower.startsWith("/setup")) return setupMenuButton(env, chatId);
  if (lower.startsWith("/tambah") || lower.startsWith("/add")) return sendMenu(env, chatId);
  if (lower.startsWith("/list") || lower.startsWith("/daftar")) return sendList(env, chatId, uid);
  if (lower.startsWith("/hari") || lower.startsWith("/tanggal")) return sendMessage(env, chatId, `📆 Sekarang: ${namaHariTanggal(Date.now())} (WIB)`);

  // Jenis di awal teks -> tambah cepat.
  const firstWord = lower.split(/\s+/)[0];
  const alias = { listrik: "listrik", token: "listrik", pln: "listrik", pulsa: "pulsa", paket: "paket", kuota: "paket", internet: "paket", data: "paket", lainnya: "lainnya", lain: "lainnya" };
  if (alias[firstWord]) {
    return addReminder(env, chatId, uid, alias[firstWord], text.slice(firstWord.length).trim());
  }

  // Kalau lagi menunggu input dari tombol (mode add:<jenis>).
  const mode = await getMode(env, uid);
  if (mode && mode.startsWith("add:")) {
    await clearMode(env, uid);
    return addReminder(env, chatId, uid, mode.slice(4), text);
  }

  return sendMessage(env, chatId, "Belum kebaca. Contoh: 'paket 30 15-9 IM3'\nAtau tekan /menu.", BACK_MENU);
}

async function handleCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const uid = cq.from && cq.from.id;
  const data = cq.data || "";
  await answerCallback(env, cq.id);
  if (!chatId) return;
  if (!isAllowed(env, uid, chatId)) return sendMessage(env, chatId, "Maaf, bot ini privat.");

  try {
    if (data === "menu") return sendMenu(env, chatId);
    if (data === "list") return sendList(env, chatId, uid);
    if (data === "help") return sendMessage(env, chatId, helpText(), BACK_MENU);
    if (data.startsWith("add_")) {
      const jenis = data.slice(4);
      await setMode(env, uid, "add:" + jenis);
      return sendMessage(env, chatId, addPromptText(jenis), BACK_MENU);
    }
    if (data.startsWith("done:")) return perpanjang(env, chatId, uid, Number(data.slice(5)));
    if (data.startsWith("del:")) return hapusReminder(env, chatId, uid, Number(data.slice(4)));
    if (data.startsWith("item:")) return sendItem(env, chatId, uid, Number(data.slice(5)));
  } catch (e) {
    return sendMessage(env, chatId, "Error: " + (e && e.message ? e.message : e));
  }
}

// ---------------------------------------------------------------------------
// Tambah / kelola pengingat
// ---------------------------------------------------------------------------

async function addReminder(env, chatId, uid, jenis, argStr) {
  const j = JENIS[jenis] || JENIS.lainnya;
  const p = parseAdd(argStr, j);
  const item = {
    id: Date.now(),
    jenis,
    nama: p.nama,
    mulai: p.mulai,
    durasi: p.durasi,
    ingatkan: j.ingatkan,
  };
  const list = await getItems(env, uid);
  list.push(item);
  await saveItems(env, uid, list);

  const habis = item.mulai + item.durasi * DAY;
  const sisa = sisaHari(habis);
  return sendMessage(
    env,
    chatId,
    [
      `✅ Pengingat dibuat:`,
      `${j.emoji} ${j.label}${item.nama ? " — " + item.nama : ""}`,
      `📅 Mulai: ${namaHariTanggal(item.mulai)}`,
      `⏳ ${j.kata}: ${item.durasi} hari`,
      `🔔 ${j.kata === "isi ulang" ? "Ingat isi ulang" : "Habis"}: ${namaHariTanggal(habis)} (${labelSisa(sisa)})`,
      "",
      `Aku ingatkan otomatis mulai H-${item.ingatkan}.`,
    ].join("\n"),
    BACK_MENU,
  );
}

// Parse "30 15-9 IM3" -> { durasi, mulai(ts), nama }
function parseAdd(s, j) {
  s = (s || "").trim();
  let mulai = todayTs();
  // tanggal (dd-mm[-yyyy])
  const dm = s.match(/(\d{1,2})[-/ ](\d{1,2})(?:[-/ ](\d{2,4}))?/);
  if (dm) {
    const d = +dm[1], mo = +dm[2];
    let y = dm[3] ? +dm[3] : wibParts(Date.now()).y;
    if (y < 100) y += 2000;
    if (d <= 31 && mo <= 12) {
      mulai = Date.UTC(y, mo - 1, d, 12) - WIB_OFFSET_MS;
      s = (s.slice(0, dm.index) + s.slice(dm.index + dm[0].length)).replace(/\s+/g, " ").trim();
    }
  }
  // durasi = angka pertama tersisa
  let durasi = j.durasi;
  const dur = s.match(/\b(\d{1,3})\b/);
  if (dur) {
    durasi = +dur[1];
    s = (s.slice(0, dur.index) + s.slice(dur.index + dur[0].length)).replace(/\s+/g, " ").trim();
  }
  const nama = s.trim();
  return { durasi: durasi || j.durasi, mulai, nama };
}

async function sendList(env, chatId, uid) {
  const list = await getItems(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Belum ada pengingat. Tekan /menu untuk menambah.", BACK_MENU);
  // urutkan dari yang paling mepet
  const withSisa = list.map((it) => ({ it, sisa: sisaHari(it.mulai + it.durasi * DAY) })).sort((a, b) => a.sisa - b.sisa);
  const rows = [];
  const lines = ["📋 Daftar pengingat:", ""];
  for (const { it, sisa } of withSisa) {
    const j = JENIS[it.jenis] || JENIS.lainnya;
    lines.push(`${statusIcon(sisa, it.ingatkan)} ${j.emoji} ${j.label}${it.nama ? " — " + it.nama : ""} · ${labelSisa(sisa)}`);
    rows.push([{ text: `${j.emoji} ${it.nama || j.label} (${labelSisa(sisa)})`, callback_data: `item:${it.id}` }]);
  }
  rows.push([BACK_BTN]);
  return sendMessage(env, chatId, lines.join("\n"), { reply_markup: { inline_keyboard: rows } });
}

async function sendItem(env, chatId, uid, id) {
  const list = await getItems(env, uid);
  const it = list.find((x) => x.id === id);
  if (!it) return sendMessage(env, chatId, "Pengingat tidak ditemukan.", BACK_MENU);
  const j = JENIS[it.jenis] || JENIS.lainnya;
  const habis = it.mulai + it.durasi * DAY;
  const sisa = sisaHari(habis);
  const info = [
    `${j.emoji} ${j.label}${it.nama ? " — " + it.nama : ""}`,
    `📅 Mulai: ${namaHariTanggal(it.mulai)}`,
    `⏳ ${j.kata}: ${it.durasi} hari`,
    `🔔 ${j.kata === "isi ulang" ? "Isi ulang" : "Habis"}: ${namaHariTanggal(habis)} (${labelSisa(sisa)})`,
  ].join("\n");
  const rows = [
    [
      { text: "✅ Sudah beli / perpanjang", callback_data: `done:${it.id}` },
      { text: "🗑️ Hapus", callback_data: `del:${it.id}` },
    ],
    [{ text: "🔙 Daftar", callback_data: "list" }, BACK_BTN],
  ];
  return sendMessage(env, chatId, info, { reply_markup: { inline_keyboard: rows } });
}

// Perpanjang: mulai ulang dari hari ini.
async function perpanjang(env, chatId, uid, id) {
  const list = await getItems(env, uid);
  const it = list.find((x) => x.id === id);
  if (!it) return sendMessage(env, chatId, "Pengingat tidak ditemukan.", BACK_MENU);
  it.mulai = todayTs();
  await saveItems(env, uid, list);
  const j = JENIS[it.jenis] || JENIS.lainnya;
  const habis = it.mulai + it.durasi * DAY;
  return sendMessage(env, chatId, `✅ Diperbarui. ${j.emoji} ${j.label} berlaku sampai ${namaHariTanggal(habis)}.`, BACK_MENU);
}

async function hapusReminder(env, chatId, uid, id) {
  const list = await getItems(env, uid);
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return sendMessage(env, chatId, "Pengingat tidak ditemukan.", BACK_MENU);
  const it = list.splice(idx, 1)[0];
  await saveItems(env, uid, list);
  const j = JENIS[it.jenis] || JENIS.lainnya;
  return sendMessage(env, chatId, `🗑️ Dihapus: ${j.emoji} ${j.label}${it.nama ? " — " + it.nama : ""}`, BACK_MENU);
}

// ---------------------------------------------------------------------------
// Notifikasi terjadwal (Cron)
// ---------------------------------------------------------------------------

async function runScheduled(env) {
  if (!env.REMINDERS) return;
  let cursor;
  do {
    const res = await env.REMINDERS.list({ prefix: "rem:", cursor });
    for (const k of res.keys) {
      const uid = k.name.slice(4);
      try {
        const list = JSON.parse((await env.REMINDERS.get(k.name)) || "[]");
        const due = [];
        for (const it of list) {
          const sisa = sisaHari(it.mulai + it.durasi * DAY);
          if (sisa <= it.ingatkan) due.push({ it, sisa });
        }
        if (!due.length) continue;
        due.sort((a, b) => a.sisa - b.sisa);
        await sendMessage(env, uid, buildNotif(due));
      } catch {
        /* lanjut user berikutnya */
      }
    }
    cursor = res.cursor;
  } while (cursor);
}

function buildNotif(due) {
  const lines = ["🔔 PENGINGAT", ""];
  for (const { it, sisa } of due) {
    const j = JENIS[it.jenis] || JENIS.lainnya;
    const habis = it.mulai + it.durasi * DAY;
    lines.push(`${statusIcon(sisa, it.ingatkan)} ${j.emoji} ${j.label}${it.nama ? " — " + it.nama : ""}`);
    lines.push(`   ${j.kata === "isi ulang" ? "Waktunya isi ulang" : "Habis"}: ${namaHariTanggal(habis)} — ${labelSisa(sisa)}`);
    lines.push(`   👉 ${saran(j, sisa)}`);
    lines.push("");
  }
  lines.push("Sudah beli/perpanjang? Buka /list lalu tap item-nya.");
  return lines.join("\n");
}

function saran(j, sisa) {
  if (sisa < 0) return `Sudah lewat ${-sisa} hari — segera ${j.kata === "isi ulang" ? "isi ulang" : "perpanjang"}!`;
  if (sisa === 0) return `HARI INI — jangan sampai ${j.kata === "isi ulang" ? "listrik habis" : "putus"}.`;
  if (j.kata === "isi ulang") return `Siapkan dana buat isi ulang token.`;
  return `Segera perpanjang biar tidak terputus.`;
}

// ---------------------------------------------------------------------------
// Util waktu & status
// ---------------------------------------------------------------------------

function todayTs() {
  const p = wibParts(Date.now());
  return Date.UTC(p.y, p.m - 1, p.d, 12) - WIB_OFFSET_MS; // tengah hari WIB hari ini
}
function sisaHari(habisTs) {
  const h = wibParts(habisTs);
  const t = wibParts(Date.now());
  const hd = Date.UTC(h.y, h.m - 1, h.d);
  const td = Date.UTC(t.y, t.m - 1, t.d);
  return Math.round((hd - td) / DAY);
}
function labelSisa(sisa) {
  if (sisa < 0) return `telat ${-sisa} hari`;
  if (sisa === 0) return "HARI INI";
  if (sisa === 1) return "besok";
  return `${sisa} hari lagi`;
}
function statusIcon(sisa, ingatkan) {
  if (sisa < 0) return "🔴";
  if (sisa === 0) return "🔴";
  if (sisa <= (ingatkan || 3)) return "⚠️";
  return "🟢";
}

const NAMA_BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const NAMA_HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
function wibParts(ts) {
  const d = new Date(ts + WIB_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
}
function namaHariTanggal(ts) {
  const p = wibParts(ts);
  return `${NAMA_HARI[p.dow]}, ${p.d} ${NAMA_BULAN[p.m - 1]} ${p.y}`;
}

// ---------------------------------------------------------------------------
// Menu & util Telegram
// ---------------------------------------------------------------------------

const BACK_BTN = { text: "🔙 Menu", callback_data: "menu" };
const BACK_MENU = { reply_markup: { inline_keyboard: [[BACK_BTN]] } };
const MENU_MAIN = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "⚡ Token Listrik", callback_data: "add_listrik" },
        { text: "📱 Pulsa", callback_data: "add_pulsa" },
      ],
      [
        { text: "🌐 Paket Internet", callback_data: "add_paket" },
        { text: "🔔 Lainnya", callback_data: "add_lainnya" },
      ],
      [
        { text: "📋 Daftar pengingat", callback_data: "list" },
        { text: "❓ Bantuan", callback_data: "help" },
      ],
    ],
  },
};

async function sendMenu(env, chatId) {
  return sendMessage(env, chatId, "🔔 Menu Pengingat\nTambah pengingat baru atau lihat daftar:", MENU_MAIN);
}

// Instruksi input per jenis (dipakai setelah tekan tombol).
function addPromptText(jenis) {
  const j = JENIS[jenis] || JENIS.lainnya;
  const contoh = {
    listrik: "30 150rb            → ingat isi ulang tiap 30 hari\n30 20-9            → mulai dari tanggal 20-9",
    pulsa: "45                 → masa aktif 45 hari, mulai hari ini\n30 20-9 XL         → beli 20-9, nama XL",
    paket: "30 20-9 IM3        → paket 30 hari, beli 20-9, nama IM3\n28                 → 28 hari mulai hari ini",
    lainnya: "30 20-9 nama       → jatuh tempo 30 hari sejak 20-9",
  };
  return [
    `${j.emoji} ${j.label}`,
    "",
    "Ketik: masa_aktif_hari [tgl] [nama]",
    "",
    "Contoh:",
    contoh[jenis] || contoh.lainnya,
    "",
    `(tanpa tanggal = mulai hari ini · default ${j.durasi} hari · ingat H-${j.ingatkan})`,
  ].join("\n");
}

function helpText() {
  return [
    "🔔 BOT PENGINGAT",
    "Ingatkan token listrik, pulsa, & masa aktif paket internet.",
    "",
    "━ CARA TAMBAH ━",
    "Paling gampang: /menu → tap jenisnya → ikuti contohnya.",
    "",
    "Atau ketik langsung:",
    "  <jenis> <masa_aktif_hari> [tgl] [nama]",
    "",
    "jenis: listrik / pulsa / paket / lainnya",
    "  (alias: token, pln, kuota, internet, data)",
    "",
    "Contoh:",
    "• paket 30 15-9 IM3   → paket 30 hari, beli 15/9, nama IM3",
    "• pulsa 45            → masa aktif 45 hari, mulai hari ini",
    "• listrik 30          → ingat isi ulang token tiap 30 hari",
    "",
    "Tanggal opsional (DD-MM / DD-MM-YYYY). Tanpa tanggal = mulai hari ini.",
    "",
    "━ NOTIFIKASI ━",
    "Aku kirim pengingat otomatis menjelang habis:",
    "🟢 aman   ⚠️ mepet (≤ H-3)   🔴 habis / telat",
    "",
    "━ PERINTAH ━",
    "/menu — tombol tambah & daftar",
    "/list — lihat semua pengingat + status",
    "/hari — tanggal sekarang",
    "",
    "Di /list: tap item → ✅ Sudah beli/perpanjang, atau 🗑️ Hapus.",
  ].join("\n");
}

async function setupMenuButton(env, chatId) {
  const commands = [
    { command: "menu", description: "Tambah pengingat / lihat daftar" },
    { command: "list", description: "Daftar pengingat" },
    { command: "tambah", description: "Tambah pengingat" },
    { command: "hari", description: "Tanggal sekarang" },
    { command: "help", description: "Bantuan" },
  ];
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    return sendMessage(env, chatId, "✅ Tombol Menu Telegram sudah diatur.");
  } catch (e) {
    return sendMessage(env, chatId, "Gagal atur menu: " + (e && e.message ? e.message : e));
  }
}

async function answerCallback(env, id) {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: id }),
    });
  } catch {
    /* abaikan */
  }
}

// ---------------------------------------------------------------------------
// Penyimpanan (KV) & mode
// ---------------------------------------------------------------------------

function itemsKey(uid) {
  return `rem:${uid}`;
}
async function getItems(env, uid) {
  if (!env.REMINDERS) throw new Error("KV 'REMINDERS' belum di-bind");
  const raw = await env.REMINDERS.get(itemsKey(uid));
  return raw ? JSON.parse(raw) : [];
}
async function saveItems(env, uid, list) {
  await env.REMINDERS.put(itemsKey(uid), JSON.stringify(list));
}
function modeKey(uid) {
  return `mode:${uid}`;
}
async function setMode(env, uid, val) {
  await env.REMINDERS.put(modeKey(uid), val, { expirationTtl: 900 });
}
async function getMode(env, uid) {
  return (await env.REMINDERS.get(modeKey(uid))) || "";
}
async function clearMode(env, uid) {
  await env.REMINDERS.delete(modeKey(uid));
}

function isAllowed(env, fromId, chatId) {
  const raw = (env.ALLOWED_IDS || "").trim();
  if (!raw) return true;
  const allow = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return allow.includes(String(fromId)) || allow.includes(String(chatId));
}

async function sendMessage(env, chatId, text, extra) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN belum diset");
  const payload = { chat_id: chatId, text, disable_web_page_preview: true, ...(extra || {}) };
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
