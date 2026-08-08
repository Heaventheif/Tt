// plugins/media_tools.js — Handler-plugin: قائمة أدوات للوسائط المُرسلة مباشرة
// (شازام، كلمات، تحويل لصوت، قص جزء بالزمن، ترجمة VTT عبر Groq Whisper).
// حذف هذا الملف يعطّل هذه القائمة فوراً، بدون تعديل أي ملف آخر.
import { isRecognizableMedia } from "../telegram-api.js";
import { shortHash } from "../cache.js";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.media_tools");

export const DESCRIPTION = "قائمة أدوات للوسائط المباشرة: شازام، كلمات، تحويل لصوت، قص جزء بالزمن، ترجمة VTT";

const TTL_MS = config.PENDING_TTL_MIN * 60 * 1000;
const GROQ_API_KEY = config.GROQ_API_KEY;

// token -> { msg, ts }
const MEDIA_PENDING = new Map();
// chatId -> { token, statusMessageId, ts }
const CLIP_AWAIT = new Map();

function cleanup() {
  const now = Date.now();
  for (const [k, v] of MEDIA_PENDING) if (now - v.ts > TTL_MS) MEDIA_PENDING.delete(k);
  for (const [k, v] of CLIP_AWAIT) if (now - v.ts > TTL_MS) CLIP_AWAIT.delete(k);
}

function mediaAndSuffix(msg) {
  if (msg.voice) return [msg.voice, ".ogg", "voice"];
  if (msg.video_note) return [msg.video_note, ".mp4", "video_note"];
  if (msg.video) return [msg.video, ".mp4", "video"];
  if (msg.audio) {
    const fn = msg.audio.file_name || "";
    const ext = fn.includes(".") ? fn.slice(fn.lastIndexOf(".")) : ".mp3";
    return [msg.audio, ext, "audio"];
  }
  return [null, null, null];
}

const isVideoKind = (kind) => kind === "video" || kind === "video_note";

async function cleanupFile(path) {
  if (!path) return;
  try {
    await Bun.file(path).delete?.();
  } catch (e) {
    logger.exception(`فشل حذف الملف المؤقت: ${path}`, e);
  }
}

// ══════════════════════════════════════════════
// 📋 عرض القائمة عند استقبال وسائط مباشرة
// ══════════════════════════════════════════════
async function showMediaMenu(msg, bot) {
  const chatId = msg.chat.id;
  const [media, , kind] = mediaAndSuffix(msg);
  if (!media) return;

  cleanup();
  const token = shortHash(`${chatId}|${msg.message_id}|${Date.now()}`, config.CACHE_HASH_LEN);
  MEDIA_PENDING.set(token, { msg, ts: Date.now() });

  const rows = [
    [{ text: "🎵 اكتشاف الأغنية (Shazam)", callback_data: `mtool|${token}|shazam` }],
    [{ text: "📝 عرض الكلمات (Lyrics)", callback_data: `mtool|${token}|lyrics` }],
    [{ text: "📝 إنشاء ترجمة (VTT)", callback_data: `mtool|${token}|vtt` }],
  ];
  if (isVideoKind(kind)) {
    rows.push([{ text: "🔄 تحويل الفيديو إلى صوت", callback_data: `mtool|${token}|to_audio` }]);
    rows.push([{ text: "✂️ قص جزء محدد بالزمن", callback_data: `mtool|${token}|cut` }]);
  }

  await bot.sendMessage(chatId, "📎 استلمت الوسائط! ماذا تريد أن تفعل بها؟", {
    replyMarkup: { inline_keyboard: rows },
  });
}

async function downloadOriginal(bot, msg) {
  const [media, suffix, kind] = mediaAndSuffix(msg);
  if (!media) throw new Error("لا توجد وسائط في هذه الرسالة");
  const path = `${Bun.env.TMPDIR || "/tmp"}/mtool_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`;
  await bot.downloadFile(media.file_id, path);
  return [path, kind];
}

// ══════════════════════════════════════════════
// 🔄 تحويل فيديو → صوت (mp3) عبر ffmpeg
// ══════════════════════════════════════════════
export async function videoToAudio(srcPath) {
  const outPath = `${srcPath}.audio.mp3`;
  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-i", srcPath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", outPath],
    { stdout: "ignore", stderr: "pipe" }
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0 || Bun.file(outPath).size === 0) {
    await cleanupFile(outPath);
    throw new Error(`فشل التحويل عبر ffmpeg: ${stderr.slice(0, 300)}`);
  }
  return outPath;
}

// ══════════════════════════════════════════════
// ⏱️ تحليل صيغة "البداية-النهاية" — mm:ss فقط
// ══════════════════════════════════════════════
const SEP_RE = /\s*(?:-|–|—|إلى|الى|to)\s*/i;
const MMSS_RE = /^(\d{1,3}):([0-5]?\d)$/;

function toSeconds(t) {
  t = t.trim();
  const m = MMSS_RE.exec(t);
  if (!m) throw new Error(`صيغة وقت غير صالحة: «${t}» — استخدم mm:ss فقط، مثال: 0:30`);
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function formatSeconds(s) {
  const sInt = Math.max(0, Math.round(s));
  const m = Math.floor(sInt / 60);
  const sec = sInt % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function parseTimeRange(text) {
  const parts = (text || "").trim().split(SEP_RE).filter((p) => p !== "");
  if (parts.length !== 2) throw new Error("استخدم صيغة: البداية-النهاية بصيغة mm:ss، مثال: 0:30-1:15");
  const start = toSeconds(parts[0]);
  const end = toSeconds(parts[1]);
  if (start < 0 || end <= start) throw new Error("يجب أن تكون نهاية المقطع بعد بدايته");
  const maxDur = config.MAX_CLIP_DURATION_SECONDS;
  if (maxDur && end - start > maxDur) {
    throw new Error(
      `الجزء المطلوب طويل جداً (${formatSeconds(end - start)}) — الحد الأقصى المسموح ${formatSeconds(maxDur)}`
    );
  }
  return [start, end];
}

// ══════════════════════════════════════════════
// ✂️ قص جزء من ملف صوت/فيديو بالزمن عبر ffmpeg
// ══════════════════════════════════════════════
export async function trimMediaByTime(srcPath, start, end, isAudio = false) {
  const duration = end - start;
  const suffix = srcPath.includes(".") ? srcPath.slice(srcPath.lastIndexOf(".")) : isAudio ? ".mp3" : ".mp4";
  const outPath = `${srcPath}.cut${suffix}`;

  async function run(...codecArgs) {
    const proc = Bun.spawn(
      ["ffmpeg", "-y", "-ss", String(start), "-t", String(duration), "-i", srcPath, ...codecArgs, outPath],
      { stdout: "ignore", stderr: "pipe" }
    );
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    const ok = code === 0 && Bun.file(outPath).size > 0;
    return [ok, stderr];
  }

  let [ok, stderr] = await run("-c", "copy");
  if (!ok) {
    const codecArgs = isAudio ? ["-c:a", "libmp3lame", "-q:a", "2"] : ["-c:v", "libx264", "-c:a", "aac"];
    [ok, stderr] = await run(...codecArgs);
  }
  if (!ok) {
    await cleanupFile(outPath);
    throw new Error(`فشل قص المقطع عبر ffmpeg: ${stderr.slice(0, 300)}`);
  }
  return outPath;
}

// ══════════════════════════════════════════════
// 📝 تفريغ نصي (VTT) عبر Groq Whisper (groq-sdk مباشرة، بدون subprocess)
// ══════════════════════════════════════════════
function secondsToVttTs(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function segmentsToVtt(segments) {
  const lines = ["WEBVTT", ""];
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (!text) continue;
    lines.push(`${secondsToVttTs(seg.start || 0)} --> ${secondsToVttTs(seg.end || 0)}`);
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n");
}

export async function transcribeToVtt(srcPath) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY غير مضبوط في متغيرات البيئة");

  const { default: Groq } = await import("groq-sdk");
  const groq = new Groq({ apiKey: GROQ_API_KEY });

  const transcription = await groq.audio.transcriptions.create({
    file: Bun.file(srcPath),
    model: "whisper-large-v3",
    response_format: "verbose_json",
  });

  const segments = (transcription.segments || [])
    .map((s) => ({ text: (s.text || "").trim(), start: s.start, end: s.end }))
    .filter((s) => s.text);
  if (!segments.length) throw new Error("لم يُرجع Groq أي مقاطع نصية");

  const vttText = segmentsToVtt(segments);
  const vttPath = `${srcPath}.vtt`;
  await Bun.write(vttPath, vttText);
  return vttPath;
}

// ══════════════════════════════════════════════
// 🎛️ معالج ضغط أزرار القائمة (callback_query بادئتها mtool|)
// ══════════════════════════════════════════════
function isMtoolCallback(obj) {
  return "data" in obj && (obj.data || "").startsWith("mtool|");
}

async function handleMtoolCallback(cq, bot) {
  const msgContainer = cq.message;
  const chatId = msgContainer.chat.id;
  const statusId = msgContainer.message_id;
  const data = cq.data || "";

  const parts = data.split("|");
  if (parts.length !== 3) {
    await bot.answerCallbackQuery(cq.id, "⚠️ طلب غير صالح.", true);
    return;
  }
  const [, token, action] = parts;

  cleanup();
  const entry = MEDIA_PENDING.get(token);
  if (!entry) {
    await bot.answerCallbackQuery(cq.id, "⌛ انتهت صلاحية الطلب، أعد إرسال الوسائط.", true);
    return;
  }

  await bot.answerCallbackQuery(cq.id);
  const originalMsg = entry.msg;
  const [, , kind] = mediaAndSuffix(originalMsg);

  if (action === "shazam") {
    const shazam = await import("./shazam.js");
    await bot.deleteMessage(chatId, statusId);
    await shazam.analyzeAudioShazam(originalMsg, bot);
    MEDIA_PENDING.delete(token);
    return;
  }

  if (action === "lyrics") {
    const shazam = await import("./shazam.js");
    const lyricsMod = await import("./lyrics.js");
    await bot.editMessageText(chatId, statusId, "⏳ جاري التعرف على المقطع...");
    let track;
    try {
      track = await shazam.identifyFromMessage(originalMsg, bot);
    } catch (e) {
      await bot.editMessageText(chatId, statusId, `❌ تعذّر التعرف على المقطع:\n${e.message.slice(0, 200)}`);
      return;
    }
    await bot.editMessageText(chatId, statusId, "🔍 جاري البحث عن الكلمات...");
    await lyricsMod.replyWithLyrics(bot, chatId, statusId, track.artist, track.title);
    MEDIA_PENDING.delete(token);
    return;
  }

  if (action === "to_audio") {
    if (!isVideoKind(kind)) {
      await bot.editMessageText(chatId, statusId, "❌ هذا الخيار متاح فقط للفيديو.");
      return;
    }
    await bot.editMessageText(chatId, statusId, "⏳ جاري تحميل الفيديو وتحويله إلى صوت...");
    let src, out;
    try {
      [src] = await downloadOriginal(bot, originalMsg);
      out = await videoToAudio(src);
      await bot.editMessageText(chatId, statusId, "📤 جاري رفع الملف الصوتي...");
      await bot.sendAudio(chatId, out, { title: "مقطع صوتي" });
      await bot.deleteMessage(chatId, statusId);
    } catch (e) {
      logger.exception("فشل التحويل إلى صوت", e);
      await bot.editMessageText(chatId, statusId, `❌ فشل التحويل:\n${e.message.slice(0, 200)}`);
    } finally {
      await cleanupFile(src);
      await cleanupFile(out);
    }
    MEDIA_PENDING.delete(token);
    return;
  }

  if (action === "vtt") {
    await bot.editMessageText(chatId, statusId, "⏳ جاري تحميل الوسائط...");
    let src, vttPath;
    try {
      [src] = await downloadOriginal(bot, originalMsg);
      await bot.editMessageText(chatId, statusId, "🧠 جاري تفريغ النص عبر Groq Whisper...");
      vttPath = await transcribeToVtt(src);
      await bot.editMessageText(chatId, statusId, "📤 جاري رفع ملف الترجمة...");
      await bot.sendDocument(chatId, vttPath, { filename: "captions.vtt" });
      await bot.deleteMessage(chatId, statusId);
    } catch (e) {
      logger.exception("فشل إنشاء الترجمة", e);
      await bot.editMessageText(chatId, statusId, `❌ فشل إنشاء الترجمة:\n${e.message.slice(0, 200)}`);
    } finally {
      await cleanupFile(src);
      await cleanupFile(vttPath);
    }
    MEDIA_PENDING.delete(token);
    return;
  }

  if (action === "cut") {
    if (!isVideoKind(kind)) {
      await bot.editMessageText(chatId, statusId, "❌ هذا الخيار متاح فقط للفيديو.");
      return;
    }
    await bot.editMessageText(
      chatId, statusId,
      "⏱️ أرسل وقت الجزء المطلوب بصيغة (البداية-النهاية) mm:ss\nمثال: `0:30-1:15`",
      { parseMode: "Markdown" }
    );
    CLIP_AWAIT.set(chatId, { token, statusMessageId: statusId, ts: Date.now() });
    return;
  }

  await bot.answerCallbackQuery(cq.id, "⚠️ خيار غير معروف.", true);
}

// ══════════════════════════════════════════════
// ⌨️ استقبال رد نصي بالوقت لتنفيذ قص وسائط مُرسلة مباشرة
// ══════════════════════════════════════════════
function isAwaitingClipReply(msg) {
  if ("data" in msg) return false;
  if (!("text" in msg) || (msg.text || "").startsWith("/")) return false;
  const chatId = msg.chat?.id;
  return CLIP_AWAIT.has(chatId);
}

async function handleClipTimeReply(msg, bot) {
  const chatId = msg.chat.id;
  const pending = CLIP_AWAIT.get(chatId);
  CLIP_AWAIT.delete(chatId);
  if (!pending) return;

  const entry = MEDIA_PENDING.get(pending.token);
  if (!entry) {
    await bot.sendMessage(chatId, "⌛ انتهت صلاحية الطلب، أعد إرسال الفيديو.");
    return;
  }

  let start, end;
  try {
    [start, end] = parseTimeRange(msg.text || "");
  } catch (e) {
    await bot.sendMessage(chatId, `❌ ${e.message}`);
    CLIP_AWAIT.set(chatId, pending);
    return;
  }

  const statusId = pending.statusMessageId;
  await bot.editMessageText(chatId, statusId, "⏳ جاري تنزيل الوسائط كاملة...");

  let src, out;
  try {
    [src] = await downloadOriginal(bot, entry.msg);
    await bot.editMessageText(chatId, statusId, `✂️ جاري قص الجزء المطلوب (${formatSeconds(start)} → ${formatSeconds(end)})...`);
    out = await trimMediaByTime(src, start, end, false);
    await bot.editMessageText(chatId, statusId, "📤 جاري رفع المقطع المقصوص...");
    await bot.sendVideo(chatId, out);
    await bot.deleteMessage(chatId, statusId);
  } catch (e) {
    logger.exception("فشل قص المقطع", e);
    await bot.editMessageText(chatId, statusId, `❌ فشل قص المقطع:\n${e.message.slice(0, 200)}`);
  } finally {
    await cleanupFile(src);
    await cleanupFile(out);
    MEDIA_PENDING.delete(pending.token);
  }
}

export function registerPlugin() {
  return [
    { filter: isRecognizableMedia, callback: showMediaMenu },
    { filter: isMtoolCallback, callback: handleMtoolCallback },
    { filter: isAwaitingClipReply, callback: handleClipTimeReply },
  ];
}
