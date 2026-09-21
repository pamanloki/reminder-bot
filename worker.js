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

  // Kalau lagi menunggu input dari tombol.
  const mode = await getMode(env, uid);
  if (mode && mode.startsWith("add:")) {
    await clearMode(env, uid);
    return addReminder(env, chatId, uid, mode.slice(4), text);
  }
  if (mode && mode.startsWith("w_")) {
    await clearMode(env, uid);
    return wizardTyped(env, chatId, uid, mode.slice(2), text);
  }

  return sendMessage(env, chatId, "Belum kebaca. Tekan /menu untuk pakai tombol,\natau ketik cepat: 'paket 30 15-9 IM3'.", BACK_MENU);
}

async function handleCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const uid = cq.from && cq.from.id;
  const data = cq.data || "";
  await answerCallback(env, cq.id);
  if (!chatId) return;
  if (!isAllowed(env, uid, chatId)) return sendMessage(env, chatId, "Maaf, bot ini privat.");

  try {
    if (data === "menu") { await clearDraft(env, uid); return sendMenu(env, chatId); }
    if (data === "list") return sendList(env, chatId, uid);
    if (data === "help") return sendMessage(env, chatId, helpText(), BACK_MENU);
    if (data === "hari") return sendMessage(env, chatId, `📆 Sekarang: ${namaHariTanggal(Date.now())} (WIB)`, BACK_MENU);
    if (data[0] === "w") return handleWizard(env, chatId, uid, data);
    if (data.startsWith("done:")) return perpanjang(env, chatId, uid, Number(data.slice(5)));
    if (data.startsWith("del:")) return hapusReminder(env, chatId, uid, Number(data.slice(4)));
    if (data.startsWith("item:")) return sendItem(env, chatId, uid, Number(data.slice(5)));
  } catch (e) {
    return sendMessage(env, chatId, "Error: " + (e && e.message ? e.message : e));
  }
}

// ---------------------------------------------------------------------------
// WIZARD (tambah pengingat lewat tombol, minim ketik)
// ---------------------------------------------------------------------------

const OPERATORS = ["IM3", "Telkomsel", "XL", "Axis", "Tri", "Smartfren", "by.U"];
const DUR_PRESET = [7, 15, 28, 30, 60, 90];
const JAM_PRESET = [
  ["00:00", 0], ["08:00", 480], ["12:00", 720], ["17:00", 1020], ["23:59", 1439],
];
// Preset nominal per jenis (bisa "Lewati" / "Ketik" juga).
const NOM_PRESET = {
  listrik: ["20rb", "50rb", "100rb", "200rb", "500rb", "1jt"],
  pulsa: ["5rb", "10rb", "25rb", "50rb", "100rb"],
  paket: ["25rb", "50rb", "100rb", "150rb"],
  lainnya: ["50rb", "100rb", "200rb"],
};
function nomPreset(jenis) {
  return NOM_PRESET[jenis] || NOM_PRESET.lainnya;
}

function draftKey(uid) { return `draft:${uid}`; }
async function getDraft(env, uid) { const r = await env.REMINDERS.get(draftKey(uid)); return r ? JSON.parse(r) : null; }
async function saveDraft(env, uid, d) { await env.REMINDERS.put(draftKey(uid), JSON.stringify(d), { expirationTtl: 1800 }); }
async function clearDraft(env, uid) { await env.REMINDERS.delete(draftKey(uid)); }

// Operator custom (tersimpan, muncul lagi sebagai tombol).
async function getCustomOps(env, uid) {
  const r = await env.REMINDERS.get(`ops:${uid}`);
  return r ? JSON.parse(r) : [];
}
async function addCustomOp(env, uid, name) {
  name = name.trim().slice(0, 20);
  if (!name) return;
  const l = await getCustomOps(env, uid);
  if (OPERATORS.some((o) => o.toLowerCase() === name.toLowerCase())) return; // sudah ada di default
  if (l.some((o) => o.toLowerCase() === name.toLowerCase())) return;
  l.push(name);
  await env.REMINDERS.put(`ops:${uid}`, JSON.stringify(l.slice(0, 30)));
}

const CANCEL_ROW = [{ text: "✖️ Batal", callback_data: "menu" }];
function kb(rows) { return { reply_markup: { inline_keyboard: rows } }; }
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function handleWizard(env, chatId, uid, data) {
  const parts = data.split(":");
  const step = parts[1];
  const val = parts.slice(2).join(":");

  if (step === "jenis") {
    await saveDraft(env, uid, { jenis: val });
    if (val === "pulsa" || val === "paket") return wStepOperator(env, chatId, uid);
    return wStepSchedule(env, chatId);
  }

  const d = await getDraft(env, uid);
  if (!d) return sendMessage(env, chatId, "Sesi kadaluarsa. Mulai lagi dari /menu.", BACK_MENU);

  if (step === "op") {
    if (val === "type") { await setMode(env, uid, "w_op"); return sendMessage(env, chatId, "Ketik nama operator:", kb([CANCEL_ROW])); }
    d.nama = val; await saveDraft(env, uid, d); return wStepSchedule(env, chatId);
  }
  if (step === "sched") {
    return val === "tanggal" ? wStepTanggal(env, chatId) : wStepDurasi(env, chatId);
  }
  if (step === "dur") {
    if (val === "type") { await setMode(env, uid, "w_dur"); return sendMessage(env, chatId, "Ketik jumlah hari (mis. 28):", kb([CANCEL_ROW])); }
    d.schedType = "durasi"; d.durasi = +val; delete d.hariBulan; await saveDraft(env, uid, d); return wStepJam(env, chatId);
  }
  if (step === "tgl") {
    d.schedType = "tanggal"; d.hariBulan = +val; delete d.durasi; await saveDraft(env, uid, d); return wStepJam(env, chatId);
  }
  if (step === "jam") {
    if (val === "type") { await setMode(env, uid, "w_jam"); return sendMessage(env, chatId, "Ketik jam (HH:MM), mis. 14:30:", kb([CANCEL_ROW])); }
    d.jamMenit = val === "none" ? null : +val; await saveDraft(env, uid, d); return wStepNominal(env, chatId, d.jenis);
  }
  if (step === "nom") {
    if (val === "type") { await setMode(env, uid, "w_nom"); return sendMessage(env, chatId, "Ketik nominal (mis. 50rb):", kb([CANCEL_ROW])); }
    if (val !== "skip") d.nominal = val; await saveDraft(env, uid, d); return wStepConfirm(env, chatId, d);
  }
  if (step === "save") return wSave(env, chatId, uid);
}

async function wizardTyped(env, chatId, uid, field, text) {
  const d = await getDraft(env, uid);
  if (!d) return sendMessage(env, chatId, "Sesi kadaluarsa. Mulai lagi dari /menu.", BACK_MENU);
  if (field === "op") { const op = text.trim(); d.nama = op; await addCustomOp(env, uid, op); await saveDraft(env, uid, d); return wStepSchedule(env, chatId); }
  if (field === "dur") {
    const n = parseInt(text, 10);
    if (!n || n < 1) return sendMessage(env, chatId, "Angka tidak valid. Ketik jumlah hari (mis. 28):", kb([CANCEL_ROW]));
    d.schedType = "durasi"; d.durasi = n; delete d.hariBulan; await saveDraft(env, uid, d); return wStepJam(env, chatId);
  }
  if (field === "jam") {
    const m = text.match(/(\d{1,2})[:.](\d{2})/);
    if (!m || +m[1] > 23 || +m[2] > 59) return sendMessage(env, chatId, "Jam tidak valid. Contoh: 14:30", kb([CANCEL_ROW]));
    d.jamMenit = +m[1] * 60 + +m[2]; await saveDraft(env, uid, d); return wStepNominal(env, chatId, d.jenis);
  }
  if (field === "nom") { d.nominal = text.trim(); await saveDraft(env, uid, d); return wStepConfirm(env, chatId, d); }
}

async function wStepOperator(env, chatId, uid) {
  const custom = await getCustomOps(env, uid);
  const all = [...OPERATORS, ...custom.filter((o) => !OPERATORS.includes(o))];
  const rows = chunk(all.map((o) => ({ text: o, callback_data: "w:op:" + o })), 2);
  rows.push([{ text: "✏️ Operator lain (ketik)", callback_data: "w:op:type" }]);
  rows.push(CANCEL_ROW);
  return sendMessage(env, chatId, "📱 Pilih operator:", kb(rows));
}
function wStepSchedule(env, chatId) {
  const rows = [
    [{ text: "⏳ Masa aktif (hari)", callback_data: "w:sched:durasi" }],
    [{ text: "🔁 Tiap tanggal (bulanan)", callback_data: "w:sched:tanggal" }],
    CANCEL_ROW,
  ];
  return sendMessage(env, chatId, "Pilih cara pengingat:", kb(rows));
}
function wStepDurasi(env, chatId) {
  const rows = chunk(DUR_PRESET.map((n) => ({ text: n + " hari", callback_data: "w:dur:" + n })), 3);
  rows.push([{ text: "✏️ Lainnya (ketik)", callback_data: "w:dur:type" }]);
  rows.push(CANCEL_ROW);
  return sendMessage(env, chatId, "⏳ Masa aktif berapa hari?", kb(rows));
}
function wStepTanggal(env, chatId) {
  const days = [];
  for (let i = 1; i <= 31; i++) days.push({ text: String(i), callback_data: "w:tgl:" + i });
  const rows = chunk(days, 7);
  rows.push(CANCEL_ROW);
  return sendMessage(env, chatId, "🔁 Tiap tanggal berapa?", kb(rows));
}
function wStepJam(env, chatId) {
  const rows = chunk(JAM_PRESET.map(([lbl, m]) => ({ text: "🕐 " + lbl, callback_data: "w:jam:" + m })), 3);
  rows.push([
    { text: "Tanpa jam", callback_data: "w:jam:none" },
    { text: "✏️ Ketik jam", callback_data: "w:jam:type" },
  ]);
  rows.push(CANCEL_ROW);
  return sendMessage(env, chatId, "🕐 Jam habis? (opsional)", kb(rows));
}
function wStepNominal(env, chatId, jenis) {
  const rows = chunk(nomPreset(jenis).map((n) => ({ text: "Rp" + n, callback_data: "w:nom:" + n })), 3);
  rows.push([
    { text: "Lewati", callback_data: "w:nom:skip" },
    { text: "✏️ Ketik", callback_data: "w:nom:type" },
  ]);
  rows.push(CANCEL_ROW);
  return sendMessage(env, chatId, "💰 Nominal? (opsional)", kb(rows));
}
function wStepConfirm(env, chatId, d) {
  const item = draftToItem(d);
  const j = JENIS[d.jenis] || JENIS.lainnya;
  const due = dueTs(item);
  const jadwal = item.hariBulan ? `🔁 Tiap tanggal ${item.hariBulan}` : `⏳ ${item.durasi} hari (mulai hari ini)`;
  const info = [
    "Cek dulu ya:",
    "",
    `${j.emoji} ${j.label}${item.nama ? " — " + item.nama : ""}`,
    jadwal,
    `🔔 Berikutnya: ${namaHariTanggal(due)}${jamStr(item)}`,
  ].join("\n");
  return sendMessage(env, chatId, info, kb([
    [{ text: "✅ Simpan", callback_data: "w:save" }],
    CANCEL_ROW,
  ]));
}

function draftToItem(d) {
  const j = JENIS[d.jenis] || JENIS.lainnya;
  let nama = d.nama || "";
  if (d.nominal) nama = nama ? nama + " · " + d.nominal : d.nominal;
  const item = { id: Date.now(), jenis: d.jenis, nama, ingatkan: j.ingatkan };
  if (d.schedType === "tanggal") item.hariBulan = d.hariBulan;
  else { item.mulai = todayTs(); item.durasi = d.durasi || j.durasi; }
  if (d.jamMenit != null) item.jamMenit = d.jamMenit;
  return item;
}

async function wSave(env, chatId, uid) {
  const d = await getDraft(env, uid);
  if (!d) return sendMessage(env, chatId, "Sesi kadaluarsa. Mulai lagi dari /menu.", BACK_MENU);
  const item = draftToItem(d);
  const list = await getItems(env, uid);
  list.push(item);
  await saveItems(env, uid, list);
  await clearDraft(env, uid);
  const j = JENIS[d.jenis] || JENIS.lainnya;
  const due = dueTs(item);
  return sendMessage(
    env,
    chatId,
    `✅ Pengingat dibuat:\n${j.emoji} ${j.label}${item.nama ? " — " + item.nama : ""}\n🔔 Berikutnya: ${namaHariTanggal(due)}${jamStr(item)} (${labelSisa(sisaHari(due))})`,
    BACK_MENU,
  );
}

// ---------------------------------------------------------------------------
// Tambah / kelola pengingat (teks cepat)
// ---------------------------------------------------------------------------

async function addReminder(env, chatId, uid, jenis, argStr) {
  const j = JENIS[jenis] || JENIS.lainnya;
  const p = parseAdd(argStr, j);
  const item = {
    id: Date.now(),
    jenis,
    nama: p.nama,
    ingatkan: j.ingatkan,
  };
  if (p.hariBulan) {
    item.hariBulan = p.hariBulan; // pengingat bulanan tanggal tetap
  } else {
    item.mulai = p.mulai;
    item.durasi = p.durasi;
  }
  if (p.jamMenit != null) item.jamMenit = p.jamMenit; // jam habis (opsional)
  const list = await getItems(env, uid);
  list.push(item);
  await saveItems(env, uid, list);

  const due = dueTs(item);
  const sisa = sisaHari(due);
  const barisJadwal = item.hariBulan
    ? `🔁 Tiap tanggal ${item.hariBulan} tiap bulan`
    : `📅 Mulai: ${namaHariTanggal(item.mulai)}\n⏳ ${j.kata}: ${item.durasi} hari`;
  return sendMessage(
    env,
    chatId,
    [
      `✅ Pengingat dibuat:`,
      `${j.emoji} ${j.label}${item.nama ? " — " + item.nama : ""}`,
      barisJadwal,
      `🔔 Berikutnya: ${namaHariTanggal(due)}${jamStr(item)} (${labelSisa(sisa)})`,
      "",
      `Aku ingatkan otomatis mulai H-${item.ingatkan}.`,
    ].join("\n"),
    BACK_MENU,
  );
}

// Jatuh tempo/hari-H sebuah pengingat (dukung bulanan tetap, durasi, & jam).
function dueTs(it) {
  const base = it.hariBulan ? nextMonthlyTs(it.hariBulan, it.skipUntil) : it.mulai + it.durasi * DAY;
  if (it.jamMenit == null) return base;
  const p = wibParts(base);
  return Date.UTC(p.y, p.m - 1, p.d, Math.floor(it.jamMenit / 60), it.jamMenit % 60) - WIB_OFFSET_MS;
}
function pad(n) {
  return String(n).padStart(2, "0");
}
// " jam 14:30" bila item punya jam, kalau tidak string kosong.
function jamStr(it) {
  if (it == null || it.jamMenit == null) return "";
  return ` jam ${pad(Math.floor(it.jamMenit / 60))}:${pad(it.jamMenit % 60)}`;
}

// Parse input:
//   "tiap 25 100rb"   -> bulanan tanggal 25, nama 100rb
//   "30 15-9 IM3"     -> durasi 30, mulai 15-9, nama IM3
function parseAdd(s, j) {
  s = (s || "").trim();

  // Jam (HH:MM) — dibaca duluan supaya tidak tertukar durasi. Contoh: "jam 14:30".
  let jamMenit = null;
  const jm = s.match(/(?:jam\s*)?\b(\d{1,2})[:.](\d{2})\b/);
  if (jm) {
    const hh = +jm[1], mm = +jm[2];
    if (hh < 24 && mm < 60) {
      jamMenit = hh * 60 + mm;
      s = (s.slice(0, jm.index) + s.slice(jm.index + jm[0].length)).replace(/\s+/g, " ").trim();
    }
  }

  // Bulanan tanggal tetap: "tiap 25" / "setiap tgl 25" / "tiap tanggal 25"
  const bl = s.match(/\b(?:tiap|setiap)\s*(?:tgl|tanggal)?\s*(\d{1,2})\b/i);
  if (bl) {
    const d = +bl[1];
    if (d >= 1 && d <= 31) {
      const nama = (s.slice(0, bl.index) + s.slice(bl.index + bl[0].length)).replace(/\s+/g, " ").trim();
      return { hariBulan: d, nama, jamMenit };
    }
  }

  // tanggal mulai (dd-mm[-yyyy]) — pakai '-' atau '/' (bukan spasi, biar tak tertukar durasi)
  let mulai = todayTs();
  const dm = s.match(/\b(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?\b/);
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
  return { durasi: durasi || j.durasi, mulai, nama: s.trim(), jamMenit };
}

async function sendList(env, chatId, uid) {
  const list = await getItems(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Belum ada pengingat. Tekan /menu untuk menambah.", BACK_MENU);
  // urutkan dari yang paling mepet
  const withSisa = list.map((it) => ({ it, sisa: sisaHari(dueTs(it)) })).sort((a, b) => a.sisa - b.sisa);
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
  const due = dueTs(it);
  const sisa = sisaHari(due);
  const jadwal = it.hariBulan
    ? `🔁 Tiap tanggal ${it.hariBulan} tiap bulan`
    : `📅 Mulai: ${namaHariTanggal(it.mulai)}\n⏳ ${j.kata}: ${it.durasi} hari`;
  const info = [
    `${j.emoji} ${j.label}${it.nama ? " — " + it.nama : ""}`,
    jadwal,
    `🔔 Berikutnya: ${namaHariTanggal(due)}${jamStr(it)} (${labelSisa(sisa)})`,
  ].join("\n");
  const btnBaris = it.hariBulan
    ? [
        { text: "✅ Sudah beli bulan ini", callback_data: `done:${it.id}` },
        { text: "🗑️ Hapus", callback_data: `del:${it.id}` },
      ]
    : [
        { text: "✅ Sudah beli / perpanjang", callback_data: `done:${it.id}` },
        { text: "🗑️ Hapus", callback_data: `del:${it.id}` },
      ];
  const rows = [btnBaris, [{ text: "🔙 Daftar", callback_data: "list" }, BACK_BTN]];
  return sendMessage(env, chatId, info, { reply_markup: { inline_keyboard: rows } });
}

// Perpanjang: mulai ulang dari hari ini.
async function perpanjang(env, chatId, uid, id) {
  const list = await getItems(env, uid);
  const it = list.find((x) => x.id === id);
  if (!it) return sendMessage(env, chatId, "Pengingat tidak ditemukan.", BACK_MENU);
  const j = JENIS[it.jenis] || JENIS.lainnya;
  if (it.hariBulan) {
    // Lewati tanggal terdekat -> pengingat lompat ke bulan berikutnya.
    it.skipUntil = dueTs(it);
    await saveItems(env, uid, list);
    const next = dueTs(it);
    return sendMessage(
      env,
      chatId,
      `👍 Oke, tanggal ${it.hariBulan} bulan ini aku lewati.\n🔔 Pengingat berikutnya: ${namaHariTanggal(next)}${jamStr(it)}.`,
      BACK_MENU,
    );
  }
  it.mulai = todayTs();
  await saveItems(env, uid, list);
  const due = dueTs(it);
  return sendMessage(env, chatId, `✅ Diperbarui. ${j.emoji} ${j.label} berlaku sampai ${namaHariTanggal(due)}.`, BACK_MENU);
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
          const sisa = sisaHari(dueTs(it));
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
    const habis = dueTs(it);
    lines.push(`${statusIcon(sisa, it.ingatkan)} ${j.emoji} ${j.label}${it.nama ? " — " + it.nama : ""}`);
    lines.push(`   ${j.kata === "isi ulang" ? "Waktunya isi ulang" : "Habis"}: ${namaHariTanggal(habis)}${jamStr(it)} — ${labelSisa(sisa)}`);
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
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12
}
// Tanggal berikutnya dengan hari-bulan = d, pada/sesudah hari ini (WIB).
// `after` (opsional): lewati semua tanggal sampai dengan hari itu — dipakai saat
// user menekan "sudah beli bulan ini" agar pengingat lompat ke bulan berikutnya.
function nextMonthlyTs(d, after) {
  const t = wibParts(Date.now());
  // Titik acuan minimal = hari ini; kalau `after` lebih jauh, mulai dari sehari sesudahnya.
  let refUTC = Date.UTC(t.y, t.m - 1, t.d);
  if (after) {
    const a = wibParts(after);
    const aNext = Date.UTC(a.y, a.m - 1, a.d) + DAY;
    if (aNext > refUTC) refUTC = aNext;
  }
  const ref = wibParts(refUTC);
  let y = ref.y, m = ref.m;
  const dayThis = Math.min(d, daysInMonth(y, m));
  if (Date.UTC(y, m - 1, dayThis) >= refUTC) {
    return Date.UTC(y, m - 1, dayThis, 12) - WIB_OFFSET_MS;
  }
  m++; if (m > 12) { m = 1; y++; }
  const dayNext = Math.min(d, daysInMonth(y, m));
  return Date.UTC(y, m - 1, dayNext, 12) - WIB_OFFSET_MS;
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
        { text: "⚡ Token Listrik", callback_data: "w:jenis:listrik" },
        { text: "📱 Pulsa", callback_data: "w:jenis:pulsa" },
      ],
      [
        { text: "🌐 Paket Internet", callback_data: "w:jenis:paket" },
        { text: "🔔 Lainnya", callback_data: "w:jenis:lainnya" },
      ],
      [{ text: "📋 Daftar pengingat", callback_data: "list" }],
      [
        { text: "📆 Hari ini", callback_data: "hari" },
        { text: "❓ Bantuan", callback_data: "help" },
      ],
    ],
  },
};

async function sendMenu(env, chatId) {
  return sendMessage(env, chatId, "🔔 Menu Pengingat\nTambah pengingat baru atau lihat daftar:", MENU_MAIN);
}

function helpText() {
  return [
    "🔔 BOT PENGINGAT",
    "Ingatkan token listrik, pulsa, & masa aktif paket internet.",
    "",
    "━ CARA TAMBAH (paling gampang) ━",
    "/menu → tap jenis → ikuti langkahnya (semua tombol):",
    "  jenis → operator → durasi/tanggal → jam → nominal → simpan.",
    "Kamu cuma tap; ketik hanya kalau mau isi manual.",
    "",
    "━ CARA TAMBAH CEPAT (ketik) ━",
    "Atau ketik langsung. Dua cara:",
    "",
    "1) Bulanan tanggal tetap:",
    "   <jenis> tiap <tgl> [nama]",
    "   • listrik tiap 25 100rb → tiap tanggal 25, tiap bulan",
    "   • paket tiap 1          → tiap tanggal 1",
    "",
    "2) Masa aktif (N hari):",
    "   <jenis> <hari> [tgl] [nama]",
    "   • paket 30 15-9 IM3     → 30 hari, beli 15/9, nama IM3",
    "   • pulsa 45              → 45 hari, mulai hari ini",
    "",
    "jenis: listrik / pulsa / paket / lainnya",
    "  (alias: token, pln, kuota, internet, data)",
    "",
    "Opsional jam habis (bagus buat paket): tambah 'jam HH:MM'",
    "  • paket 30 20-9 jam 23:59",
    "  • paket tiap 25 jam 14:30",
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
