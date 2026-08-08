// main.js — نقطة الدخول (بديل main.py) — Bun.serve بدل Sanic، بدون Docker.
// كل ميزة جديدة تُضاف بملف واحد في plugins/ — حذفه يعطّلها فوراً بدون تعديل هذا الملف.
import { config } from "./config.js";
import * as cache from "./cache.js";
import {
  loadAllPlugins, runPendingSetups, findPlugin, getRegistry, getPlugins,
  getDownloadSemaphore, getSearchProviders, getExtraHandlers, splitMedia,
} from "./plugin-loader.js";
import { Bot, isCommand, isPlainText, commandName, commandArgs } from "./telegram-api.js";
import { getLogger } from "./lib/logger.js";
import { startKeepAlive } from "./lib/keep-alive.js";

const logger = getLogger("main");

config.validate();

const UPLOAD_LIMIT = config.UPLOAD_LIMIT;
const URL_RE = /https?:\/\/\S+/;

const bot = new Bot(config.TELEGRAM_TOKEN);

// ══════════════════════════════════════════════
// 🗄️ حالات مؤقتة في الذاكرة (Map بدل dict بايثون)
// ══════════════════════════════════════════════
const PENDING = new Map(); // token -> { url, plugin, title, options: Map, extra, ts, clip? }
const PENDING_TTL_MS = config.PENDING_TTL_MIN * 60 * 1000;

const SEARCH_PENDING = new Map(); // token -> { results, query, ts }
const SEARCH_PENDING_TTL_MS = config.SEARCH_PENDING_TTL_MIN * 60 * 1000;

const URL_MODE_PENDING = new Map(); // token -> { url, ts }
const URL_MODE_PENDING_TTL_MS = config.PENDING_TTL_MIN * 60 * 1000;

const URL_CLIP_AWAIT = new Map(); // chatId -> { url, statusMessageId, ts }
const DOWNLOAD_TASKS = new Map(); // token -> AbortController-like { cancelled, promise }

const lastActionTs = new Map(); // chatId -> ts (rate limiting)

function cleanupMap(map, ttlMs) {
  const now = Date.now();
  for (const [k, v] of map) if (now - v.ts > ttlMs) map.delete(k);
}

function isRateLimited(chatId) {
  const now = Date.now();
  const last = lastActionTs.get(chatId) || 0;
  if (now - last < config.RATE_LIMIT_SECONDS * 1000) return true;
  lastActionTs.set(chatId, now);
  return false;
}

function shortHash(text, len) {
  return cache.shortHash(text, len);
}

// ══════════════════════════════════════════════
// ⌨️ بناء لوحة الأزرار من قائمة QualityOption
// ══════════════════════════════════════════════
function buildKeyboard(token, options) {
  const videos = options.filter((o) => o.kind === "video");
  const audios = options.filter((o) => o.kind === "audio");
  const rows = [];
  const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };
  for (const c of chunk(videos, 3)) rows.push(c.map((o) => ({ text: o.label, callback_data: `dl|${token}|${o.key}` })));
  for (const c of chunk(audios, 3)) rows.push(c.map((o) => ({ text: o.label, callback_data: `dl|${token}|${o.key}` })));
  return { inline_keyboard: rows };
}

// ══════════════════════════════════════════════
// 🔍 فحص رابط وعرض خيارات الجودة
// ══════════════════════════════════════════════
async function probeAndPresent(url, chatId, messageId) {
  const plugin = findPlugin(url);
  if (!plugin) {
    await bot.editMessageText(
      chatId, messageId,
      "❌ هذا الموقع غير مدعوم حالياً.\nأرسل رابطاً من يوتيوب، تيك توك، انستغرام، فيسبوك، تويتر/X، ساوندكلاود..."
    );
    return;
  }

  await bot.editMessageText(chatId, messageId, `🔍 جاري فحص الرابط عبر [${plugin.name}]...`);

  let result;
  try {
    result = await Promise.race([
      plugin.probe(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 20000)),
    ]);
  } catch (e) {
    if (e.message === "timeout") {
      logger.warning(`[${plugin.name}] probe تجاوز المهلة الزمنية | url=${url} | chat=${chatId}`);
      await bot.editMessageText(chatId, messageId, "❌ استغرق فحص الرابط وقتاً طويلاً جداً. حاول مجدداً لاحقاً.");
    } else {
      logger.exception(`[${plugin.name}] probe فشل | url=${url} | chat=${chatId}`, e);
      await bot.editMessageText(chatId, messageId, `❌ تعذّر فحص الرابط:\n${String(e.message).slice(0, 300)}`);
    }
    return;
  }

  if (!result || !result.options || !result.options.length) {
    await bot.editMessageText(chatId, messageId, "❌ لم تُوجد جودات متاحة لهذا الرابط.");
    return;
  }

  cleanupMap(PENDING, PENDING_TTL_MS);
  const token = shortHash(url, config.CACHE_HASH_LEN);
  const optionsMap = new Map(result.options.map((o) => [o.key, o]));
  PENDING.set(token, {
    url, plugin: plugin.name, title: result.title, options: optionsMap, extra: result.extra, ts: Date.now(),
  });

  const kb = buildKeyboard(token, result.options);
  await bot.editMessageText(
    chatId, messageId,
    `🎬 *${result.title}*\n\nاختر جودة الفيديو 🎥 أو صيغة الصوت 🎵:`,
    { replyMarkup: kb, parseMode: "Markdown" }
  );
}

// ══════════════════════════════════════════════
// 🔎 بحث نصي متعدد المنصات
// ══════════════════════════════════════════════
const SOURCE_EMOJI = { YouTube: "▶️", SoundCloud: "🟠" };

async function handleSearchQuery(queryText, chatId) {
  const providers = getSearchProviders();
  if (!providers.length) return;

  const status = await bot.sendMessage(chatId, `🔍 جاري البحث عن «${queryText}»...`);

  let allResults = [];
  for (const p of providers) {
    try {
      const res = await p.search(queryText);
      allResults = allResults.concat(res || []);
    } catch (e) {
      logger.exception(`[${p.name}] search فشل | query=${queryText}`, e);
    }
  }

  if (!allResults.length) {
    await bot.editMessageText(chatId, status.message_id, "❌ لم أجد نتائج مطابقة. جرّب صياغة مختلفة، أو أرسل رابطاً مباشرة.");
    return;
  }

  const results = allResults.slice(0, 10);
  cleanupMap(SEARCH_PENDING, SEARCH_PENDING_TTL_MS);
  const token = shortHash(`${queryText}|${Date.now()}`, config.CACHE_HASH_LEN);
  SEARCH_PENDING.set(token, { results, query: queryText, ts: Date.now() });

  const rows = results.map((r, i) => {
    const emoji = SOURCE_EMOJI[r.source] || "🎵";
    const dur = r.duration ? ` · ${r.duration}` : "";
    let label = `${i + 1}. ${emoji} ${r.title}${dur}`;
    if (label.length > 60) label = label.slice(0, 57) + "...";
    return [{ text: label, callback_data: `srch|${token}|${i}` }];
  });

  await bot.editMessageText(chatId, status.message_id, `🔍 نتائج البحث عن «${queryText}»:`, {
    replyMarkup: { inline_keyboard: rows },
  });
}

async function handleSearchChoice(cq) {
  const msg = cq.message;
  const chatId = msg.chat.id;
  const data = cq.data || "";
  const parts = data.split("|");
  if (parts.length !== 3) {
    await bot.answerCallbackQuery(cq.id, "⚠️ طلب غير صالح.", true);
    return;
  }
  const [, token, idxS] = parts;
  const idx = parseInt(idxS, 10);

  cleanupMap(SEARCH_PENDING, SEARCH_PENDING_TTL_MS);
  const task = SEARCH_PENDING.get(token);
  if (!task) {
    await bot.answerCallbackQuery(cq.id, "⌛ انتهت صلاحية نتائج البحث، أعد البحث.", true);
    return;
  }
  const results = task.results;
  if (Number.isNaN(idx) || idx < 0 || idx >= results.length) {
    await bot.answerCallbackQuery(cq.id, "⚠️ خيار غير موجود.", true);
    return;
  }

  await bot.answerCallbackQuery(cq.id);
  const chosen = results[idx];
  SEARCH_PENDING.delete(token);

  await bot.editMessageText(chatId, msg.message_id, `🔍 جاري فحص: ${chosen.title} (${chosen.source})...`);
  await probeAndPresent(chosen.url, chatId, msg.message_id);
}

// ══════════════════════════════════════════════
// 📨 استقبال الرسائل النصية
// ══════════════════════════════════════════════
async function handleMessage(msg) {
  const text = (msg.text || "").trim();
  if (!text) return;
  const chatId = msg.chat.id;

  const pendingClip = URL_CLIP_AWAIT.get(chatId);
  if (pendingClip && !URL_RE.test(text)) {
    URL_CLIP_AWAIT.delete(chatId);
    await handleUrlClipTime(chatId, text, pendingClip);
    return;
  }
  if (pendingClip) URL_CLIP_AWAIT.delete(chatId);

  const m = URL_RE.exec(text);
  if (m) {
    const url = m[0];
    cleanupMap(URL_MODE_PENDING, URL_MODE_PENDING_TTL_MS);
    const token = shortHash(url, config.CACHE_HASH_LEN);
    URL_MODE_PENDING.set(token, { url, ts: Date.now() });
    const kb = {
      inline_keyboard: [[
        { text: "📥 تنزيل كامل", callback_data: `mode|${token}|full` },
        { text: "✂️ تنزيل جزء محدد", callback_data: `mode|${token}|part` },
      ]],
    };
    await bot.sendMessage(chatId, "📥 كيف تريد تنزيل هذا الرابط؟", { replyMarkup: kb });
    return;
  }

  if (text.length >= 2 && text.length <= 100) {
    await handleSearchQuery(text, chatId);
  }
}

async function handleUrlModeChoice(cq) {
  const msgContainer = cq.message;
  const chatId = msgContainer.chat.id;
  const statusId = msgContainer.message_id;
  const data = cq.data || "";
  const parts = data.split("|");
  if (parts.length !== 3) {
    await bot.answerCallbackQuery(cq.id, "⚠️ طلب غير صالح.", true);
    return;
  }
  const [, token, mode] = parts;

  cleanupMap(URL_MODE_PENDING, URL_MODE_PENDING_TTL_MS);
  const entry = URL_MODE_PENDING.get(token);
  if (!entry) {
    await bot.answerCallbackQuery(cq.id, "⌛ انتهت الصلاحية، أعد إرسال الرابط.", true);
    return;
  }

  await bot.answerCallbackQuery(cq.id);
  const url = entry.url;
  URL_MODE_PENDING.delete(token);

  if (mode === "full") {
    await bot.editMessageText(chatId, statusId, "🔍 جاري التحقق من الرابط...");
    await probeAndPresent(url, chatId, statusId);
    return;
  }

  if (mode === "part") {
    await bot.editMessageText(
      chatId, statusId,
      "⏱️ أرسل وقت الجزء المطلوب بصيغة (البداية-النهاية) mm:ss\nمثال: `0:30-1:15`",
      { parseMode: "Markdown" }
    );
    URL_CLIP_AWAIT.set(chatId, { url, statusMessageId: statusId, ts: Date.now() });
    return;
  }

  await bot.answerCallbackQuery(cq.id, "⚠️ خيار غير معروف.", true);
}

async function handleUrlClipTime(chatId, text, pending) {
  const mtool = await import("./plugins/media_tools.js");
  const statusId = pending.statusMessageId;
  const url = pending.url;

  let start, end;
  try {
    [start, end] = mtool.parseTimeRange(text);
  } catch (e) {
    await bot.sendMessage(chatId, `❌ ${e.message}`);
    URL_CLIP_AWAIT.set(chatId, pending);
    return;
  }

  await bot.editMessageText(chatId, statusId, "🔍 جاري التحقق من الرابط...");
  await probeAndPresent(url, chatId, statusId);

  const token = shortHash(url, config.CACHE_HASH_LEN);
  if (PENDING.has(token)) {
    PENDING.get(token).clip = { start, end };
  }
}

// ══════════════════════════════════════════════
// ⚡ إرسال فوري من الكاش
// ══════════════════════════════════════════════
async function sendCached(chatId, cached, statusMessageId) {
  if (cached.mediaType === "video") {
    await bot.sendCachedVideo(chatId, cached.fileId, null);
  } else if (cached.mediaType === "audio") {
    await bot.sendCachedAudio(chatId, cached.fileId, null, cached.title);
  } else {
    await bot.sendCachedDocument(chatId, cached.fileId, null);
  }
  await bot.deleteMessage(chatId, statusMessageId);
}

// ══════════════════════════════════════════════
// ⬇️ اختيار المستخدم → تحميل، تقسيم إذا لزم، وإرسال
// ══════════════════════════════════════════════
function cleanupFile(path) {
  try {
    if (path) {
      Bun.file(path).delete?.();
      logger.info(`[cleanup] 🧹 تم حذف الملف المؤقت: ${path}`);
    }
  } catch (e) {
    logger.exception(`فشل حذف الملف المؤقت: ${path}`, e);
  }
}

async function sendResult(chatId, dl, statusMessageId, task, cacheKey) {
  const fsize = Bun.file(dl.filePath).size;
  let parts = [dl.filePath];

  if (fsize > UPLOAD_LIMIT) {
    if (dl.isDocument) {
      cleanupFile(dl.filePath);
      await bot.editMessageText(chatId, statusMessageId, `❌ حجم الملف (${(fsize / 1024 / 1024).toFixed(1)}MB) يتجاوز حد تيليجرام (50MB).`);
      return;
    }
    try {
      parts = await splitMedia(dl.filePath, { maxSize: UPLOAD_LIMIT, isAudio: dl.isAudio });
    } catch (e) {
      logger.exception(`[split] فشل تقسيم الملف | ${dl.filePath}`, e);
      cleanupFile(dl.filePath);
      await bot.editMessageText(chatId, statusMessageId, `❌ فشل تقسيم الملف الكبير:\n${e.message.slice(0, 200)}`);
      return;
    }
    if (!parts.includes(dl.filePath)) cleanupFile(dl.filePath);
  }

  const total = parts.length;
  try {
    let sent = null;
    for (const partPath of parts) {
      if (dl.isDocument) {
        const fname = dl.title.toLowerCase().endsWith(".zip") ? dl.title : partPath.split("/").pop();
        sent = await bot.sendDocument(chatId, partPath, { filename: fname });
      } else if (dl.isAudio) {
        sent = await bot.sendAudio(chatId, partPath, { title: dl.title });
      } else {
        sent = await bot.sendVideo(chatId, partPath);
      }
    }
    await bot.deleteMessage(chatId, statusMessageId);

    if (cacheKey && total === 1 && sent) {
      const [urlHash, qualityKey] = cacheKey;
      const mediaType = dl.isDocument ? "document" : dl.isAudio ? "audio" : "video";
      const fileId = sent[mediaType]?.file_id;
      if (fileId) await cache.setCached(urlHash, qualityKey, fileId, mediaType, dl.title);
    }
  } catch (e) {
    logger.exception(`[send] فشل رفع الملف | plugin=${task.plugin} | chat=${chatId}`, e);
    try {
      await bot.editMessageText(chatId, statusMessageId, `❌ فشل رفع الملف إلى تيليجرام:\n${e.message.slice(0, 200)}`);
    } catch (e2) {
      logger.exception("فشل حتى تعديل رسالة الخطأ", e2);
    }
  } finally {
    for (const p of parts) cleanupFile(p);
  }
}

// ══════════════════════════════════════════════
// ⏱️ تحديث دوري لرسالة الحالة + زر إلغاء
// ══════════════════════════════════════════════
function cancelKeyboard(token) {
  return { inline_keyboard: [[{ text: "❌ إلغاء التحميل", callback_data: `cancel|${token}` }]] };
}

function startProgressTicker() {
  // ⛔ تم تعطيل رسائل التقدم الدورية بناءً على طلب المستخدم — لا إشعارات "جاري تحميل".
  return () => {};
}

async function handleCancelDownload(cq) {
  const data = cq.data || "";
  const parts = data.split("|");
  if (parts.length !== 2) {
    await bot.answerCallbackQuery(cq.id, "⚠️ طلب غير صالح.", true);
    return;
  }
  const token = parts[1];
  const task = DOWNLOAD_TASKS.get(token);
  if (!task || task.done) {
    await bot.answerCallbackQuery(cq.id, "⌛ لا يوجد تحميل نشط لإلغائه.", true);
    return;
  }
  task.cancelled = true;
  await bot.answerCallbackQuery(cq.id, "🚫 جاري إلغاء التحميل...");
}

async function handleChoice(cq) {
  const msg = cq.message;
  const chatId = msg.chat.id;
  const data = cq.data || "";
  const parts = data.split("|");
  if (parts.length !== 3) {
    await bot.answerCallbackQuery(cq.id, "⚠️ طلب غير صالح.", true);
    return;
  }
  const [, token, key] = parts;

  cleanupMap(PENDING, PENDING_TTL_MS);
  const task = PENDING.get(token);
  if (!task) {
    await bot.answerCallbackQuery(cq.id, "⌛ انتهت صلاحية الطلب، أعد إرسال الرابط.", true);
    return;
  }
  const option = task.options.get(key);
  if (!option) {
    await bot.answerCallbackQuery(cq.id, "⚠️ خيار غير موجود.", true);
    return;
  }

  await bot.answerCallbackQuery(cq.id);

  const cached = await cache.getCached(token, key);
  if (cached) {
    try {
      await sendCached(chatId, cached, msg.message_id);
      PENDING.delete(token);
      return;
    } catch {
      logger.warning(`[cache] file_id مخزَّن لم يعد صالحاً (token=${token}, key=${key}) — تحميل عادي بدلاً منه`);
    }
  }

  const kbCancel = cancelKeyboard(token);
  await bot.editMessageText(chatId, msg.message_id, "🎬", { replyMarkup: kbCancel });

  const pluginEntry = getPlugins().find((p) => p.name === task.plugin);
  if (!pluginEntry) {
    await bot.editMessageText(chatId, msg.message_id, "❌ الـ plugin الأصلي لم يُعثر عليه، أعد إرسال الرابط.");
    return;
  }

  const tDlStart = Date.now();
  const downloadTask = { cancelled: false, done: false };
  DOWNLOAD_TASKS.set(token, downloadTask);
  const stopTicker = startProgressTicker(chatId, msg.message_id, task.title, option.label, tDlStart, token);

  let dl;
  try {
    const dlPromise = pluginEntry.download(task.url, { key, option, extra: task.extra });
    const cancelPromise = new Promise((_, reject) => {
      const check = setInterval(() => {
        if (downloadTask.cancelled) {
          clearInterval(check);
          reject(new Error("__CANCELLED__"));
        }
      }, 300);
      dlPromise.finally(() => clearInterval(check)).catch(() => {});
    });
    dl = await Promise.race([dlPromise, cancelPromise]);
  } catch (e) {
    downloadTask.done = true;
    stopTicker();
    DOWNLOAD_TASKS.delete(token);
    if (e.message === "__CANCELLED__") {
      await bot.editMessageText(chatId, msg.message_id, "🚫 تم إلغاء التحميل بناءً على طلبك.");
      PENDING.delete(token);
      return;
    }
    logger.exception(`[${task.plugin}] download فشل | url=${task.url} | chat=${chatId}`, e);
    await bot.editMessageText(chatId, msg.message_id, `❌ فشل التحميل:\n${String(e.message).slice(0, 300)}`);
    return;
  }
  downloadTask.done = true;
  stopTicker();
  DOWNLOAD_TASKS.delete(token);

  logger.info(`[${task.plugin}] ⬇️ تحميل مكتمل في ${((Date.now() - tDlStart) / 1000).toFixed(1)}s | ${dl.filePath}`);

  let cacheKey = [token, key];
  const clip = task.clip;
  if (clip && !dl.isDocument) {
    const mtool = await import("./plugins/media_tools.js");
    try {
      const trimmedPath = await mtool.trimMediaByTime(dl.filePath, clip.start, clip.end, dl.isAudio);
      cleanupFile(dl.filePath);
      dl.filePath = trimmedPath;
      cacheKey = null;
    } catch (e) {
      logger.exception(`[clip] فشل قص الجزء المطلوب | url=${task.url} | chat=${chatId}`, e);
      await bot.editMessageText(chatId, msg.message_id, `⚠️ تعذّر قص الجزء المطلوب، سيُرسل الملف كاملاً:\n${e.message.slice(0, 150)}`);
    }
  }

  await sendResult(chatId, dl, msg.message_id, task, cacheKey);
  PENDING.delete(token);
}

// ══════════════════════════════════════════════
// /start و /plugins (أوامر أساسية مدمجة)
// ══════════════════════════════════════════════
const MD_SPECIAL_RE = /([_*`[])/g;
function mdEscape(text) {
  return (text || "").replace(MD_SPECIAL_RE, "\\$1");
}

async function cmdStart(msg) {
  const chatId = msg.chat.id;
  const text =
    "🎬 *أهلاً بك!*\n" +
    "أرسل رابط فيديو، اسم أغنية، أو مقطع صوتي/فيديو — وسأتولى الباقي.\n\n" +
    "🔌 /plugins — لعرض المنصات المدعومة\n" +
    "📝 /lyrics `<اسم أغنية>` — لعرض الكلمات";
  await bot.sendMessage(chatId, text, { parseMode: "Markdown" });
}

// أسماء عرض بسيطة للمنصات المدعومة (بدون أي تفاصيل تقنية)
const PLATFORM_LABELS = {
  facebook: "📘 فيسبوك / ريلز",
  instagram: "📸 إنستغرام",
  tiktok: "🎵 تيك توك",
  youtube: "▶️ يوتيوب",
  soundcloud: "☁️ ساوندكلاود",
};

async function cmdPlugins(msg) {
  const chatId = msg.chat.id;
  const reg = getRegistry();
  const lines = Object.entries(reg)
    .filter(([name, info]) => info.status === "loaded" && Array.isArray(info.domains) && info.domains.length > 0 && !info.domains.includes("*"))
    .map(([name]) => PLATFORM_LABELS[name] || `✅ ${name}`);
  // 🌐 دعم عام لأي موقع فيديو آخر (بدون تفاصيل تقنية)
  if (reg.generic?.status === "loaded") lines.push("🌐 مواقع أخرى (رابط فيديو مباشر)");
  await bot.sendMessage(chatId, "🔌 *المنصات المدعومة:*\n\n" + lines.join("\n"), { parseMode: "Markdown" });
}

async function cmdClearCache(msg) {
  const chatId = msg.chat.id;
  if (!config.ADMIN_CHAT_IDS.includes(chatId)) {
    await bot.sendMessage(chatId, "⛔ هذا الأمر مخصص للإدارة فقط.");
    return;
  }
  let count;
  try {
    count = await cache.clearAllCache();
  } catch (e) {
    await bot.sendMessage(chatId, `❌ فشل مسح الكاش:\n${e.message.slice(0, 200)}`);
    return;
  }
  if (count === -1) {
    await bot.sendMessage(chatId, "⏸️ الكاش مُعطَّل أصلاً (CACHE_ENABLED=false) — لا شيء لمسحه.");
  } else {
    await bot.sendMessage(chatId, `🧹 تم مسح الكاش بنجاح — ${count} مدخل محذوف.`);
  }
}

const BUILTIN_COMMANDS = { start: cmdStart, plugins: cmdPlugins, clear_cache: cmdClearCache };

// ══════════════════════════════════════════════
// 🧭 توجيه التحديثات الخام
// ══════════════════════════════════════════════
async function dispatchUpdate(update) {
  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data || "";
      if (data.startsWith("dl|")) return void (await handleChoice(cq));
      if (data.startsWith("srch|")) return void (await handleSearchChoice(cq));
      if (data.startsWith("mode|")) return void (await handleUrlModeChoice(cq));
      if (data.startsWith("cancel|")) return void (await handleCancelDownload(cq));

      for (const h of getExtraHandlers()) {
        try {
          if (h.filter(cq)) {
            await h.callback(cq, bot);
            break;
          }
        } catch (e) {
          logger.exception("[handler-plugin] فشل فحص/تنفيذ handler لـ callback_query", e);
        }
      }
      return;
    }

    if (!update.message) return;
    const msg = update.message;

    const chatIdRl = msg.chat?.id;
    if (chatIdRl !== undefined && isRateLimited(chatIdRl)) return;

    if (isCommand(msg)) {
      const name = commandName(msg);
      if (BUILTIN_COMMANDS[name]) return void (await BUILTIN_COMMANDS[name](msg));
      for (const h of getExtraHandlers()) {
        try {
          if (h.filter(msg)) {
            await h.callback(msg, bot);
            return;
          }
        } catch (e) {
          logger.exception(`[handler-plugin] فشل فحص/تنفيذ handler لأمر: ${name}`, e);
        }
      }
      return;
    }

    if (isPlainText(msg)) {
      for (const h of getExtraHandlers()) {
        try {
          if (h.filter(msg)) {
            await h.callback(msg, bot);
            return;
          }
        } catch (e) {
          logger.exception("[handler-plugin] فشل فحص/تنفيذ handler لرسالة نصية", e);
        }
      }
      await handleMessage(msg);
      return;
    }

    for (const h of getExtraHandlers()) {
      try {
        if (h.filter(msg)) {
          await h.callback(msg, bot);
          return;
        }
      } catch (e) {
        logger.exception("[handler-plugin] فشل فحص/تنفيذ handler لرسالة وسائط", e);
      }
    }
  } catch (e) {
    logger.exception(`⚠️ خطأ غير متوقع أثناء معالجة update=${JSON.stringify(update).slice(0, 300)}`, e);
  }
}

// ══════════════════════════════════════════════
// 🧹 تنظيف دوري
// ══════════════════════════════════════════════
function startPeriodicCleanup() {
  setInterval(() => {
    try {
      cleanupMap(PENDING, PENDING_TTL_MS);
      cleanupMap(SEARCH_PENDING, SEARCH_PENDING_TTL_MS);
      cleanupMap(URL_MODE_PENDING, URL_MODE_PENDING_TTL_MS);
      const now = Date.now();
      const staleMs = Math.max(config.RATE_LIMIT_SECONDS, 1) * 20 * 1000;
      for (const [k, ts] of lastActionTs) if (now - ts > staleMs) lastActionTs.delete(k);
    } catch (e) {
      logger.exception("[cleanup] فشل التنظيف الدوري", e);
    }
  }, 5 * 60 * 1000);
}

// ══════════════════════════════════════════════
// 🚀 الإقلاع
// ══════════════════════════════════════════════
async function bootstrap() {
  await loadAllPlugins();
  await runPendingSetups();
  await cache.initCache(config);
  if (getExtraHandlers().length) {
    logger.info(`✅ تم تسجيل ${getExtraHandlers().length} handler إضافي من الـ plugins`);
  }
  await bot.setWebhook(`${config.SERVER_URL}${config.WEBHOOK_PATH}`);
  startPeriodicCleanup();

  // 🔔 إبقاء APIs الخارجية (Render/Heroku) مستيقظة — يمنع البطء بعد الخمول
  startKeepAlive([
    config.YT_API_2,          // yt-dlp-stream.onrender.com
    config.FB_DOWNLOAD_API_OLD, // facebook-video-download-api.onrender.com
    config.FB_DOWNLOAD_API,   // betadash API
  ]);

  logger.info("✅ البوت يعمل!");
}

try {
  await bootstrap();
} catch (e) {
  logger.error(`❌ فشل إقلاع البوت — سيتم الإيقاف: ${e.message}`);
  process.exit(1);
}

// ══════════════════════════════════════════════
// 🌐 خادم HTTP — Bun.serve بدل Sanic (بدون Docker)
// ══════════════════════════════════════════════
const server = Bun.serve({
  port: config.PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === config.WEBHOOK_PATH) {
      try {
        const upd = await req.json();
        if (upd) dispatchUpdate(upd); // لا ننتظره — نرد فوراً على تيليجرام
      } catch (e) {
        logger.exception("webhook: خطأ أثناء معالجة التحديث", e);
      }
      return Response.json({ ok: true });
    }

    if (req.method === "GET" && url.pathname === "/") {
      return Response.json({ status: "online", plugins: getRegistry() });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "healthy", ts: Date.now() / 1000 });
    }

    return new Response("Not Found", { status: 404 });
  },
});

logger.info(`🌐 الخادم يعمل على المنفذ ${server.port}`);

process.on("SIGTERM", async () => {
  await cache.closeCache();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await cache.closeCache();
  process.exit(0);
});
