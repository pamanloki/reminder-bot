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
  // File masuk (untuk /restore).
  if (msg.document) return handleIncomingDoc(env, chatId, uid, msg);
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
  if (lower.startsWith("/dashboard") || lower.startsWith("/dash")) return sendDashboard(env, chatId, uid);
  if (lower.startsWith("/list") || lower.startsWith("/daftar")) return sendList(env, chatId, uid);
  if (lower.startsWith("/hari") || lower.startsWith("/tanggal")) return sendMessage(env, chatId, `📆 Sekarang: ${namaHariTanggal(Date.now())} (WIB)`);
  if (lower.startsWith("/riwayat") || lower.startsWith("/history")) return sendRiwayat(env, chatId, uid);
  if (lower.startsWith("/backup") || lower.startsWith("/export")) return sendBackup(env, chatId, uid);
  if (lower.startsWith("/restore") || lower.startsWith("/import")) {
    await setMode(env, uid, "restore");
    return sendMessage(env, chatId, "♻️ Kirim file backup (.json) yang dulu kamu simpan, atau paste isi JSON-nya.\nData sekarang akan diganti.", kb([[BACK_BTN]]));
  }

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
  if (mode && mode.startsWith("buy:")) {
    await clearMode(env, uid);
    return beliTanggalTyped(env, chatId, uid, Number(mode.slice(4)), text);
  }
  if (mode && mode.startsWith("edit:")) {
    await clearMode(env, uid);
    const [, id, field] = mode.split(":");
    return applyEdit(env, chatId, uid, Number(id), field, text);
  }
  if (mode === "restore") {
    await clearMode(env, uid);
    return doRestore(env, chatId, uid, text);
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
    if (data === "dash") return sendDashboard(env, chatId, uid);
    if (data === "list") return sendList(env, chatId, uid);
    if (data === "help") return sendMessage(env, chatId, helpText(), BACK_MENU);
    if (data === "hari") return sendMessage(env, chatId, `📆 Sekarang: ${namaHariTanggal(Date.now())} (WIB)`, BACK_MENU);
    if (data[0] === "w") return handleWizard(env, chatId, uid, data);
    if (data.startsWith("done:")) return sudahBeli(env, chatId, uid, Number(data.slice(5)));
    if (data.startsWith("bt:")) { const [, id, when] = data.split(":"); return beliTanggal(env, chatId, uid, Number(id), when); }
    if (data.startsWith("edit:")) return sendEditMenu(env, chatId, uid, Number(data.slice(5)));
    if (data.startsWith("ed:")) { const [, id, field] = data.split(":"); return editField(env, chatId, uid, Number(id), field); }
    if (data.startsWith("ej:")) { const [, id, jenis] = data.split(":"); return editJenis(env, chatId, uid, Number(id), jenis); }
    if (data.startsWith("snz:")) return snoozeItem(env, chatId, uid, Number(data.slice(4)));
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

// Label "atas nama siapa" (tersimpan, muncul lagi sebagai tombol).
async function getCustomLabels(env, uid) {
  const r = await env.REMINDERS.get(`labels:${uid}`);
  return r ? JSON.parse(r) : [];
}
async function addCustomLabel(env, uid, name) {
  name = name.trim().slice(0, 20);
  if (!name) return;
  const l = await getCustomLabels(env, uid);
  if (l.some((o) => o.toLowerCase() === name.toLowerCase())) return;
  l.push(name);
  await env.REMINDERS.put(`labels:${uid}`, JSON.stringify(l.slice(0, 30)));
}
// Gabungkan operator + pemilik → satu label tampilan.
function joinNama(op, owner) {
  if (op && owner) return `${op} · ${owner}`;
  return op || owner || "";
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
    // Token listrik tak punya "masa aktif" — habisnya karena kepakai. Tanya pemilik dulu (rumah/kontrakan).
    if (val === "listrik") return wStepPemilik(env, chatId, uid);
    return wStepSchedule(env, chatId);
  }

  const d = await getDraft(env, uid);
  if (!d) return sendMessage(env, chatId, "Sesi kadaluarsa. Mulai lagi dari /menu.", BACK_MENU);

  if (step === "op") {
    if (val === "type") { await setMode(env, uid, "w_op"); return sendMessage(env, chatId, "Ketik nama operator:", kb([CANCEL_ROW])); }
    d.op = val; await saveDraft(env, uid, d); return wStepPemilik(env, chatId, uid);
  }
  if (step === "own") {
    if (val === "type") { await setMode(env, uid, "w_own"); return sendMessage(env, chatId, "Ketik atas nama siapa (mis. Nomerku, Pacarku):", kb([CANCEL_ROW])); }
    return wSetPemilik(env, chatId, uid, d, val === "skip" ? "" : val);
  }
  if (step === "sched") {
    return val === "tanggal" ? wStepTanggal(env, chatId) : wStepDurasi(env, chatId);
  }
  if (step === "dur") {
    if (val === "type") { await setMode(env, uid, "w_dur"); return sendMessage(env, chatId, "Ketik jumlah hari (mis. 28):", kb([CANCEL_ROW])); }
    d.schedType = "durasi"; d.durasi = +val; delete d.hariBulan; delete d.mulai; await saveDraft(env, uid, d); return wStepMulai(env, chatId, d.jenis);
  }
  if (step === "when") {
    if (val === "beli") { await setMode(env, uid, "w_beli"); return sendMessage(env, chatId, "Ketik tanggal beli/isi (mis. 10-9):", kb([CANCEL_ROW])); }
    if (val === "habis") { await setMode(env, uid, "w_habis"); return sendMessage(env, chatId, "Ketik tanggal habis masa aktif (mis. 8-10):", kb([CANCEL_ROW])); }
    delete d.mulai; await saveDraft(env, uid, d); return afterMulai(env, chatId, d); // "today"
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
  if (field === "op") { const op = text.trim(); d.op = op; await addCustomOp(env, uid, op); await saveDraft(env, uid, d); return wStepPemilik(env, chatId, uid); }
  if (field === "own") { return wSetPemilik(env, chatId, uid, d, text.trim()); }
  if (field === "dur") {
    const n = parseInt(text, 10);
    if (!n || n < 1) return sendMessage(env, chatId, "Angka tidak valid. Ketik jumlah hari (mis. 28):", kb([CANCEL_ROW]));
    d.schedType = "durasi"; d.durasi = n; delete d.hariBulan; delete d.mulai; await saveDraft(env, uid, d); return wStepMulai(env, chatId, d.jenis);
  }
  if (field === "beli") {
    const ts = parseTanggal(text);
    if (ts == null) return sendMessage(env, chatId, "Tanggal tidak valid. Contoh: 10-9 (10 September).", kb([CANCEL_ROW]));
    d.mulai = ts; await saveDraft(env, uid, d); return afterMulai(env, chatId, d);
  }
  if (field === "habis") {
    const ts = parseTanggal(text);
    if (ts == null) return sendMessage(env, chatId, "Tanggal tidak valid. Contoh: 8-10 (8 Oktober).", kb([CANCEL_ROW]));
    d.mulai = ts - (d.durasi || 30) * DAY; await saveDraft(env, uid, d); return afterMulai(env, chatId, d);
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
// Langkah "atas nama siapa" (opsional). Untuk listrik: rumah/kontrakan; lainnya: pemilik nomor.
async function wStepPemilik(env, chatId, uid) {
  const custom = await getCustomLabels(env, uid);
  const rows = custom.length ? chunk(custom.map((o) => ({ text: "👤 " + o, callback_data: "w:own:" + o })), 2) : [];
  rows.push([{ text: "✏️ Ketik nama", callback_data: "w:own:type" }, { text: "Lewati", callback_data: "w:own:skip" }]);
  rows.push(CANCEL_ROW);
  return sendMessage(env, chatId, "🏷️ Atas nama siapa? (opsional)\nBiar bisa bedain, mis. Telkomsel Nomerku vs Telkomsel Pacarku.", kb(rows));
}
async function wSetPemilik(env, chatId, uid, d, owner) {
  owner = (owner || "").trim();
  if (owner) await addCustomLabel(env, uid, owner);
  d.owner = owner;
  d.nama = joinNama(d.op, owner);
  // Listrik: model berbasis tanggal beli (+ siklus ±30 hari), langsung tanya kapan beli.
  if (d.jenis === "listrik") {
    d.schedType = "durasi";
    d.durasi = (JENIS.listrik && JENIS.listrik.durasi) || 30;
    delete d.hariBulan;
    await saveDraft(env, uid, d);
    return wStepMulai(env, chatId, d.jenis);
  }
  await saveDraft(env, uid, d);
  return wStepSchedule(env, chatId);
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
// Kapan mulainya: baru beli hari ini, atau yang sudah jalan (set tgl beli/habis).
function wStepMulai(env, chatId, jenis) {
  const rows = [[{ text: "🆕 Baru isi hari ini", callback_data: "w:when:today" }]];
  // Token listrik habis karena kepakai (bukan tanggal pasti) -> tak ada "set tgl habis".
  if (jenis !== "listrik") rows.push([{ text: "⏰ Set tgl habis", callback_data: "w:when:habis" }]);
  rows.push([{ text: "📅 Set tgl beli", callback_data: "w:when:beli" }]);
  rows.push(CANCEL_ROW);
  const msg = jenis === "listrik"
    ? "📆 Beli tokennya kapan?\nAku ingatkan lagi sekitar sebulan setelahnya."
    : "📆 Kapan mulainya?\nKalau paket lama yang sudah jalan, set tanggal habisnya biar pas.";
  return sendMessage(env, chatId, msg, kb(rows));
}
// Setelah tanggal mulai diset: listrik langsung ke nominal (tanpa jam), lainnya tanya jam.
function afterMulai(env, chatId, d) {
  return d.jenis === "listrik" ? wStepNominal(env, chatId, d.jenis) : wStepJam(env, chatId);
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
  const jadwal = item.hariBulan
    ? `🔁 Tiap tanggal ${item.hariBulan}`
    : `⏳ ${item.durasi} hari (mulai ${sisaHari(item.mulai) === 0 ? "hari ini" : namaHariTanggal(item.mulai)})`;
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
  else { item.mulai = d.mulai != null ? d.mulai : todayTs(); item.durasi = d.durasi || j.durasi; }
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

// Parse "dd-mm[-yyyy]" atau "dd/mm" -> ts tengah hari WIB, atau null.
function parseTanggal(text) {
  const dm = String(text || "").match(/\b(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?\b/);
  if (!dm) return null;
  const d = +dm[1], mo = +dm[2];
  let y = dm[3] ? +dm[3] : wibParts(Date.now()).y;
  if (y < 100) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return Date.UTC(y, mo - 1, d, 12) - WIB_OFFSET_MS;
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

// Dashboard: ringkasan sekilas — apa yang perlu aksi, mepet, dan aman.
async function sendDashboard(env, chatId, uid) {
  const list = await getItems(env, uid);
  if (!list.length) {
    return sendMessage(env, chatId, "📊 Dashboard kosong.\nBelum ada pengingat — tap jenis di /menu untuk menambah.", MENU_MAIN);
  }
  const rows = list
    .map((it) => ({ it, sisa: sisaHari(dueTs(it)), snz: snoozed(it) }))
    .sort((a, b) => a.sisa - b.sisa);
  const perlu = rows.filter((r) => r.sisa <= 0);
  const mepet = rows.filter((r) => r.sisa > 0 && r.sisa <= (r.it.ingatkan || 3));
  const aman = rows.filter((r) => r.sisa > (r.it.ingatkan || 3));
  const snzCount = rows.filter((r) => r.snz).length;

  const nm = (it) => {
    const j = JENIS[it.jenis] || JENIS.lainnya;
    return `${j.emoji} ${j.label}${it.nama ? " · " + it.nama : ""}`;
  };
  const line = (r) => `• ${nm(r.it)} — ${labelSisa(r.sisa)}${jamStr(r.it)}${r.snz ? " 😴" : ""}`;

  const out = ["📊 DASHBOARD PENGINGAT", `📆 ${namaHariTanggal(Date.now())}`, ""];
  out.push(`🔴 Perlu aksi — ${perlu.length}`);
  perlu.length ? perlu.forEach((r) => out.push(line(r))) : out.push("• 👍 tidak ada yang telat/jatuh tempo");
  if (mepet.length) {
    out.push("", `⚠️ Mepet — ${mepet.length}`);
    mepet.forEach((r) => out.push(line(r)));
  }
  out.push("", `🟢 Aman — ${aman.length}`);
  if (aman.length) out.push(`• terdekat: ${nm(aman[0].it)} — ${labelSisa(aman[0].sisa)}`);
  out.push("", `Σ Total ${rows.length} pengingat${snzCount ? ` · 😴 ${snzCount} di-snooze` : ""}`);

  // Tombol aksi cepat untuk yang perlu perhatian (maks 6).
  const btns = [...perlu, ...mepet].slice(0, 6).map((r) => [{
    text: `${(JENIS[r.it.jenis] || JENIS.lainnya).emoji} ${r.it.nama || (JENIS[r.it.jenis] || JENIS.lainnya).label} — ${labelSisa(r.sisa)}`,
    callback_data: `item:${r.it.id}`,
  }]);
  btns.push([{ text: "📋 Daftar lengkap", callback_data: "list" }, { text: "🔄 Refresh", callback_data: "dash" }]);
  btns.push([BACK_BTN]);
  return sendMessage(env, chatId, out.join("\n"), kb(btns));
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
        { text: "✅ Sudah beli / isi ulang", callback_data: `done:${it.id}` },
        { text: "🗑️ Hapus", callback_data: `del:${it.id}` },
      ];
  const rows = [
    btnBaris,
    [{ text: "✏️ Edit", callback_data: `edit:${it.id}` }],
    [{ text: "🔙 Daftar", callback_data: "list" }, BACK_BTN],
  ];
  return sendMessage(env, chatId, info, { reply_markup: { inline_keyboard: rows } });
}

// Menu edit: pilih bagian yang mau diubah.
async function sendEditMenu(env, chatId, uid, id) {
  const list = await getItems(env, uid);
  const it = list.find((x) => x.id === id);
  if (!it) return sendMessage(env, chatId, "Pengingat tidak ditemukan.", BACK_MENU);
  const j = JENIS[it.jenis] || JENIS.lainnya;
  const rows = [[{ text: "🏷️ Nama / nominal", callback_data: `ed:${it.id}:nama` }]];
  if (it.hariBulan) {
    rows.push([{ text: "🔁 Tanggal bulanan", callback_data: `ed:${it.id}:tgl` }]);
  } else {
    rows.push([{ text: "⏳ Masa aktif (hari)", callback_data: `ed:${it.id}:durasi` }]);
    rows.push([{ text: "📅 Tanggal beli/mulai", callback_data: `ed:${it.id}:mulai` }]);
  }
  rows.push([{ text: "🕐 Jam", callback_data: `ed:${it.id}:jam` }]);
  rows.push([{ text: "🔔 Ingatkan H-berapa", callback_data: `ed:${it.id}:ingatkan` }]);
  rows.push([{ text: "🔀 Ganti jenis", callback_data: `ed:${it.id}:jenis` }]);
  rows.push([{ text: "🔙 Kembali", callback_data: `item:${it.id}` }]);
  return sendMessage(env, chatId, `✏️ Edit ${j.emoji} ${j.label}${it.nama ? " — " + it.nama : ""}\nPilih yang mau diubah:`, kb(rows));
}

// Tekan salah satu field edit -> minta input teks (atau tombol untuk jenis).
async function editField(env, chatId, uid, id, field) {
  if (field === "jenis") {
    const rows = chunk(Object.keys(JENIS).map((jk) => ({ text: `${JENIS[jk].emoji} ${JENIS[jk].label}`, callback_data: `ej:${id}:${jk}` })), 2);
    rows.push([{ text: "🔙 Batal", callback_data: `item:${id}` }]);
    return sendMessage(env, chatId, "🔀 Ganti jenis jadi:", kb(rows));
  }
  const prompts = {
    nama: "Ketik nama/label baru (mis. Telkomsel · Nomerku · 50rb):",
    durasi: "Ketik masa aktif baru (jumlah hari, mis. 30):",
    tgl: "Ketik tanggal bulanan baru (1-31):",
    mulai: "Ketik tanggal beli/mulai (mis. 20-9):",
    jam: "Ketik jam (HH:MM, mis. 14:30) — atau ketik 'hapus' untuk tanpa jam:",
    ingatkan: "Ingatkan berapa hari sebelumnya? (mis. 3):",
  };
  const msg = prompts[field];
  if (!msg) return sendMessage(env, chatId, "Field tidak dikenal.", BACK_MENU);
  await setMode(env, uid, `edit:${id}:${field}`);
  return sendMessage(env, chatId, msg, kb([[{ text: "🔙 Batal", callback_data: `item:${id}` }]]));
}

// Terapkan hasil edit lalu tampilkan lagi detail item.
async function applyEdit(env, chatId, uid, id, field, text) {
  const list = await getItems(env, uid);
  const it = list.find((x) => x.id === id);
  if (!it) return sendMessage(env, chatId, "Pengingat tidak ditemukan.", BACK_MENU);
  const t = (text || "").trim();
  const reprompt = (m) => setMode(env, uid, `edit:${id}:${field}`).then(() =>
    sendMessage(env, chatId, m, kb([[{ text: "🔙 Batal", callback_data: `item:${id}` }]])));
  if (field === "nama") {
    it.nama = t;
  } else if (field === "durasi") {
    const n = parseInt(t, 10);
    if (!n || n < 1) return reprompt("Angka tidak valid. Ketik jumlah hari (mis. 30):");
    it.durasi = n; delete it.hariBulan; delete it.skipUntil;
    if (it.mulai == null) it.mulai = todayTs();
  } else if (field === "tgl") {
    const n = parseInt(t, 10);
    if (!n || n < 1 || n > 31) return reprompt("Tanggal tidak valid (1-31). Ketik lagi:");
    it.hariBulan = n; delete it.durasi; delete it.mulai; delete it.skipUntil;
  } else if (field === "mulai") {
    const ts = parseTanggal(t);
    if (ts == null) return reprompt("Tanggal tidak valid. Contoh: 20-9 (20 September).");
    it.mulai = ts; delete it.skipUntil;
  } else if (field === "jam") {
    if (/^(hapus|tanpa|none|-)$/i.test(t)) { delete it.jamMenit; }
    else {
      const m = t.match(/(\d{1,2})[:.](\d{2})/);
      if (!m || +m[1] > 23 || +m[2] > 59) return reprompt("Jam tidak valid. Contoh: 14:30 (atau 'hapus').");
      it.jamMenit = +m[1] * 60 + +m[2];
    }
  } else if (field === "ingatkan") {
    const n = parseInt(t, 10);
    if (isNaN(n) || n < 0 || n > 60) return reprompt("Angka tidak valid (0-60). Ketik lagi:");
    it.ingatkan = n;
  } else {
    return sendMessage(env, chatId, "Field tidak dikenal.", BACK_MENU);
  }
  await saveItems(env, uid, list);
  await sendMessage(env, chatId, "✅ Tersimpan.");
  return sendItem(env, chatId, uid, id);
}

// Ganti jenis item lewat tombol.
async function editJenis(env, chatId, uid, id, jenis) {
  if (!JENIS[jenis]) return sendMessage(env, chatId, "Jenis tidak dikenal.", BACK_MENU);
  const list = await getItems(env, uid);
  const it = list.find((x) => x.id === id);
  if (!it) return sendMessage(env, chatId, "Pengingat tidak ditemukan.", BACK_MENU);
  it.jenis = jenis;
  await saveItems(env, uid, list);
  await sendMessage(env, chatId, "✅ Jenis diganti.");
  return sendItem(env, chatId, uid, id);
}

// Snooze: ingatkan lagi besok.
async function snoozeItem(env, chatId, uid, id) {
  const list = await getItems(env, uid);
  const it = list.find((x) => x.id === id);
  if (!it) return sendMessage(env, chatId, "Pengingat tidak ditemukan.", BACK_MENU);
  it.snoozeUntil = todayTs() + DAY; // besok
  await saveItems(env, uid, list);
  const j = JENIS[it.jenis] || JENIS.lainnya;
  return sendMessage(env, chatId, `😴 Oke, ${j.emoji} ${j.label}${it.nama ? " — " + it.nama : ""} aku ingatkan lagi besok.`, BACK_MENU);
}

// ---------------------------------------------------------------------------
// Riwayat isi ulang
// ---------------------------------------------------------------------------

async function logRiwayat(env, uid, it, ts) {
  try {
    const raw = await env.REMINDERS.get(`hist:${uid}`);
    const arr = raw ? JSON.parse(raw) : [];
    const j = JENIS[it.jenis] || JENIS.lainnya;
    arr.unshift({ jenis: it.jenis, label: j.label, nama: it.nama || "", ts: ts || Date.now() });
    await env.REMINDERS.put(`hist:${uid}`, JSON.stringify(arr.slice(0, 60)));
  } catch { /* abaikan */ }
}

async function sendRiwayat(env, chatId, uid) {
  const raw = await env.REMINDERS.get(`hist:${uid}`);
  const arr = raw ? JSON.parse(raw) : [];
  if (!arr.length) return sendMessage(env, chatId, "📜 Belum ada riwayat. Tekan ✅ Sudah beli saat mengisi ulang, nanti tercatat di sini.", BACK_MENU);
  const now = wibParts(Date.now());
  const bulanIni = arr.filter((r) => { const p = wibParts(r.ts); return p.y === now.y && p.m === now.m; });
  const lines = [`📜 Riwayat isi ulang (${bulanIni.length}x bulan ini)`, ""];
  for (const r of arr.slice(0, 20)) {
    const j = JENIS[r.jenis] || JENIS.lainnya;
    lines.push(`${j.emoji} ${r.label}${r.nama ? " — " + r.nama : ""}\n   ${namaHariTanggal(r.ts)}`);
  }
  return sendMessage(env, chatId, lines.join("\n"), BACK_MENU);
}

// ---------------------------------------------------------------------------
// Backup & restore
// ---------------------------------------------------------------------------

async function sendBackup(env, chatId, uid) {
  const items = await getItems(env, uid);
  const ops = JSON.parse((await env.REMINDERS.get(`ops:${uid}`)) || "[]");
  const labels = JSON.parse((await env.REMINDERS.get(`labels:${uid}`)) || "[]");
  const hist = JSON.parse((await env.REMINDERS.get(`hist:${uid}`)) || "[]");
  const data = { v: 1, exportedAt: Date.now(), items, ops, labels, hist };
  const p = wibParts(Date.now());
  const fname = `reminder-backup-${p.y}${pad(p.m)}${pad(p.d)}.json`;
  await sendDocument(env, chatId, fname, JSON.stringify(data, null, 2));
  return sendMessage(env, chatId, `💾 Backup ${items.length} pengingat. Simpan filenya baik-baik.\nUntuk memulihkan: /restore lalu kirim file ini.`);
}

async function handleIncomingDoc(env, chatId, uid, msg) {
  const mode = await getMode(env, uid);
  if (mode !== "restore") {
    return sendMessage(env, chatId, "Kalau mau memulihkan data, ketik /restore dulu, baru kirim filenya.", BACK_MENU);
  }
  await clearMode(env, uid);
  try {
    const fileId = msg.document.file_id;
    const gf = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`).then((r) => r.json());
    if (!gf.ok) throw new Error("gagal ambil file");
    const path = gf.result.file_path;
    const content = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`).then((r) => r.text());
    return doRestore(env, chatId, uid, content);
  } catch (e) {
    return sendMessage(env, chatId, "Gagal baca file: " + (e && e.message ? e.message : e), BACK_MENU);
  }
}

async function doRestore(env, chatId, uid, content) {
  let data;
  try { data = JSON.parse(content); } catch { return sendMessage(env, chatId, "❌ Isi bukan JSON yang valid.", BACK_MENU); }
  const items = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(items)) return sendMessage(env, chatId, "❌ Format backup tidak dikenal.", BACK_MENU);
  await saveItems(env, uid, items);
  if (Array.isArray(data.ops)) await env.REMINDERS.put(`ops:${uid}`, JSON.stringify(data.ops.slice(0, 30)));
  if (Array.isArray(data.labels)) await env.REMINDERS.put(`labels:${uid}`, JSON.stringify(data.labels.slice(0, 30)));
  if (Array.isArray(data.hist)) await env.REMINDERS.put(`hist:${uid}`, JSON.stringify(data.hist.slice(0, 60)));
  return sendMessage(env, chatId, `✅ Dipulihkan: ${items.length} pengingat. Buka /list untuk cek.`, BACK_MENU);
}

// Tombol "Sudah beli". Bulanan tanggal tetap -> lompat sebulan.
// Berbasis durasi (pulsa/paket/listrik) -> tanya tanggal belinya biar akurat.
async function sudahBeli(env, chatId, uid, id) {
  const list = await getItems(env, uid);
  const it = list.find((x) => x.id === id);
  if (!it) return sendMessage(env, chatId, "Pengingat tidak ditemukan.", BACK_MENU);
  const j = JENIS[it.jenis] || JENIS.lainnya;
  if (it.hariBulan) {
    // Lewati tanggal terdekat -> pengingat lompat ke bulan berikutnya.
    it.skipUntil = dueTs(it);
    delete it.snoozeUntil;
    await saveItems(env, uid, list);
    await logRiwayat(env, uid, it, Date.now());
    const next = dueTs(it);
    return sendMessage(
      env,
      chatId,
      `👍 Oke, tanggal ${it.hariBulan} bulan ini aku lewati.\n🔔 Pengingat berikutnya: ${namaHariTanggal(next)}${jamStr(it)}.`,
      BACK_MENU,
    );
  }
  const rows = [
    [{ text: "🆕 Hari ini", callback_data: `bt:${it.id}:today` }],
    [{ text: "✏️ Ketik tgl beli", callback_data: `bt:${it.id}:type` }],
    [{ text: "🔙 Batal", callback_data: `item:${it.id}` }],
  ];
  return sendMessage(env, chatId, `✅ ${j.emoji} ${j.label}${it.nama ? " — " + it.nama : ""}\nKapan belinya?`, kb(rows));
}

// Terapkan tanggal beli -> reset masa aktif dari tanggal itu.
async function terapkanBeli(env, chatId, uid, id, mulaiTs) {
  const list = await getItems(env, uid);
  const it = list.find((x) => x.id === id);
  if (!it) return sendMessage(env, chatId, "Pengingat tidak ditemukan.", BACK_MENU);
  const j = JENIS[it.jenis] || JENIS.lainnya;
  it.mulai = mulaiTs;
  delete it.skipUntil;
  delete it.snoozeUntil;
  await saveItems(env, uid, list);
  await logRiwayat(env, uid, it, mulaiTs);
  const due = dueTs(it);
  return sendMessage(
    env,
    chatId,
    `✅ Diperbarui. ${j.emoji} ${j.label} beli ${namaHariTanggal(mulaiTs)}.\n🔔 Habis/isi lagi: ${namaHariTanggal(due)}${jamStr(it)} (${labelSisa(sisaHari(due))}).`,
    BACK_MENU,
  );
}
function beliTanggal(env, chatId, uid, id, when) {
  if (when === "type") {
    return setMode(env, uid, `buy:${id}`).then(() =>
      sendMessage(env, chatId, "Ketik tanggal beli (mis. 20-9):", kb([[{ text: "🔙 Batal", callback_data: `item:${id}` }]])),
    );
  }
  return terapkanBeli(env, chatId, uid, id, todayTs()); // "today"
}
async function beliTanggalTyped(env, chatId, uid, id, text) {
  const ts = parseTanggal(text);
  if (ts == null) {
    await setMode(env, uid, `buy:${id}`); // minta ulang
    return sendMessage(env, chatId, "Tanggal tidak valid. Contoh: 20-9 (20 September).", kb([[{ text: "🔙 Batal", callback_data: `item:${id}` }]]));
  }
  return terapkanBeli(env, chatId, uid, id, ts);
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

// Item lagi di-snooze? (ingatkan lagi besok -> jangan kirim hari ini)
function snoozed(it) {
  return it.snoozeUntil != null && sisaHari(it.snoozeUntil) > 0;
}

async function runScheduled(env) {
  if (!env.REMINDERS) return;
  const hourNow = wibParts(Date.now()).h;
  const isDigest = hourNow === 8; // ringkasan harian pagi (cron 08:00 WIB)
  let cursor;
  do {
    const res = await env.REMINDERS.list({ prefix: "rem:", cursor });
    for (const k of res.keys) {
      const uid = k.name.slice(4);
      try {
        const list = JSON.parse((await env.REMINDERS.get(k.name)) || "[]");
        for (const it of list) {
          if (snoozed(it)) continue;
          const sisa = sisaHari(dueTs(it));
          const jamHour = it.jamMenit != null ? Math.floor(it.jamMenit / 60) : null;
          const digestHit = isDigest && sisa <= (it.ingatkan || 3);
          const jamHit = jamHour === hourNow && sisa === 0; // alarm tepat jam (butuh cron tiap jam)
          if (digestHit || jamHit) await sendNotifItem(env, uid, it, sisa, jamHit && !isDigest);
        }
      } catch {
        /* lanjut user berikutnya */
      }
    }
    cursor = res.cursor;
  } while (cursor);
}

// Kirim satu notifikasi per item + tombol (Sudah beli / Snooze).
async function sendNotifItem(env, uid, it, sisa, precise) {
  const j = JENIS[it.jenis] || JENIS.lainnya;
  const habis = dueTs(it);
  const head = precise ? "⏰ ALARM" : "🔔 PENGINGAT";
  const text = [
    `${head}  ${statusIcon(sisa, it.ingatkan)} ${j.emoji} ${j.label}${it.nama ? " — " + it.nama : ""}`,
    `${j.kata === "isi ulang" ? "Waktunya isi ulang" : "Habis"}: ${namaHariTanggal(habis)}${jamStr(it)} — ${labelSisa(sisa)}`,
    `👉 ${saran(j, sisa)}`,
  ].join("\n");
  const rows = [[
    { text: "✅ Sudah beli", callback_data: `done:${it.id}` },
    { text: "😴 Besok", callback_data: `snz:${it.id}` },
  ]];
  return sendMessage(env, uid, text, kb(rows));
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
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() };
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
      [
        { text: "📊 Dashboard", callback_data: "dash" },
        { text: "📋 Daftar", callback_data: "list" },
      ],
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
    "  ⚡ Listrik : jenis → atas nama → tgl beli → nominal",
    "  📱🌐 Pulsa/Paket : jenis → operator → atas nama →",
    "     masa aktif → kapan mulai → jam → nominal",
    "Kamu cuma tap; ketik hanya kalau isi manual.",
    "",
    "🏷️ ATAS NAMA (opsional): biar bisa bedain nomor,",
    "   mis. Telkomsel · Nomerku vs Telkomsel · Pacarku.",
    "   Sekali ketik, tersimpan jadi tombol.",
    "",
    "📆 KAPAN MULAI (buat yang sudah jalan):",
    "   • 🆕 Baru isi hari ini",
    "   • ⏰ Set tgl habis  → mis. 8-10 (dihitung mundur)",
    "   • 📅 Set tgl beli   → mis. 10-9",
    "",
    "⚡ Listrik pakai model tgl beli: diingatkan ~30 hari",
    "   setelah beli. Tap 'Sudah beli' → set tgl beli baru.",
    "",
    "━ CARA TAMBAH CEPAT (ketik) ━",
    "1) Bulanan tanggal tetap:",
    "   <jenis> tiap <tgl> [nama]  • paket tiap 1",
    "2) Masa aktif (N hari):",
    "   <jenis> <hari> [tgl] [nama]",
    "   • paket 30 15-9 IM3  → 30 hari, beli 15/9, nama IM3",
    "   • pulsa 45           → 45 hari, mulai hari ini",
    "",
    "jenis: listrik / pulsa / paket / lainnya",
    "  (alias: token, pln, kuota, internet, data)",
    "Opsional jam habis: tambah 'jam HH:MM' (mis. paket 30 jam 23:59)",
    "",
    "━ KALAU SUDAH BELI / ISI ULANG ━",
    "/list → tap item → ✅ Sudah beli:",
    "  • Pulsa/paket/listrik: pilih 'Hari ini' atau ketik tgl beli",
    "    → masa aktif dihitung dari tanggal itu.",
    "  • Bulanan tanggal tetap: otomatis lewati ke bulan depan.",
    "",
    "✏️ EDIT: /list → tap item → ✏️ Edit → pilih bagian",
    "   (nama/nominal, masa aktif/tanggal, tgl beli, jam,",
    "    H-ingatkan, 🔀 ganti jenis).",
    "",
    "━ NOTIFIKASI ━",
    "Pengingat otomatis menjelang habis (per item + tombol):",
    "🟢 aman   ⚠️ mepet (≤ H-3)   🔴 habis / telat",
    "Di notif: ✅ Sudah beli  •  😴 Besok (snooze 1 hari).",
    "⏰ Alarm tepat jam: set Cron '0 * * * *' (tiap jam) di",
    "   dashboard — item yg punya jam diingatkan pas jamnya.",
    "",
    "━ PERINTAH ━",
    "/menu — tombol tambah & daftar",
    "/dashboard — ringkasan sekilas (perlu aksi / mepet / aman)",
    "/list — lihat semua pengingat + status",
    "/riwayat — riwayat isi ulang (+ hitungan bulan ini)",
    "/backup — simpan semua data ke file .json",
    "/restore — pulihkan data dari file backup",
    "/hari — tanggal sekarang",
  ].join("\n");
}

async function setupMenuButton(env, chatId) {
  const commands = [
    { command: "menu", description: "Tambah pengingat / lihat daftar" },
    { command: "dashboard", description: "Ringkasan sekilas semua pengingat" },
    { command: "list", description: "Daftar pengingat" },
    { command: "tambah", description: "Tambah pengingat" },
    { command: "riwayat", description: "Riwayat isi ulang" },
    { command: "backup", description: "Backup data ke file" },
    { command: "restore", description: "Pulihkan data dari file" },
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

async function sendDocument(env, chatId, filename, content) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([content], { type: "application/json" }), filename);
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
}
