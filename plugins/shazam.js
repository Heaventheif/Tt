// plugins/shazam.js — التعرف على الأغاني من ملفات صوت/فيديو مُرسلة مباشرة.
// يستخدم shazamio-core (توليد بصمة صوتية بلغة Rust/WASM) + بروتوكول Shazam
// غير الرسمي (نفس اللي تستخدمه مكتبة shazamio بايثون) لإرسال البصمة وجلب النتيجة.
// ⚠️ تنبيه: هذا endpoint غير رسمي وغير موثق من طرف Shazam، وقد يتوقف أو يتغير
// في أي وقت بدون إشعار مسبق. لا يحتاج أي مفتاح API — مجاني بالكامل.
// حذف هذا الملف يعطّل التعرف على الأغاني فوراً، بدون تعديل أي ملف آخر.
import { recognizeBytes } from "shazamio-core";
import { randomUUID } from "node:crypto";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.shazam");

export const DESCRIPTION = "التعرف على الأغاني من ملفات صوت/فيديو مُرسلة مباشرة — Shazam (shazamio-core)";

const MAX_ANALYZE_SIZE = 45 * 1024 * 1024; // 45MB

// نفس رابط الـ endpoint غير الرسمي المستخدم في shazamio (بايثون)
const SHAZAM_LANGUAGE = "ar-SA";
const SHAZAM_ENDPOINT_COUNTRY = "SA";

function shazamSearchUrl() {
  const uuid1 = randomUUID().toUpperCase();
  const uuid2 = randomUUID().toUpperCase();
  return (
    `https://amp.shazam.com/discovery/v5/${SHAZAM_LANGUAGE}/${SHAZAM_ENDPOINT_COUNTRY}` +
    `/iphone/-/tag/${uuid1}/${uuid2}` +
    `?sync=true&webv3=true&sampling=16000&track=true&video=true`
  );
}

function shazamHeaders() {
  return {
    "Content-Type": "application/json",
    "User-Agent":
      "Shazam/3685 CFNetwork/1240.0.4 Darwin/20.6.0",
    Accept: "*/*",
    "Accept-Language": "ar",
  };
}

function mediaAndSuffix(msg) {
  if (msg.voice) return [msg.voice, ".ogg"];
  if (msg.video_note) return [msg.video_note, ".mp4"];
  if (msg.video) return [msg.video, ".mp4"];
  if (msg.audio) {
    const fn = msg.audio.file_name || "";
    const ext = fn.includes(".") ? fn.slice(fn.lastIndexOf(".")) : ".mp3";
    return [msg.audio, ext];
  }
  return [null, null];
}

async function searchShazamBySignature(signature) {
  const timestamp = Date.now();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Riyadh";

  const body = {
    timezone,
    signature: {
      uri: signature.uri,
      samplems: Math.round(signature.samplems),
    },
    timestamp,
    context: {},
    geolocation: {},
  };

  const res = await fetch(shazamSearchUrl(), {
    method: "POST",
    headers: shazamHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`فشل الاتصال بخادم Shazam (HTTP ${res.status})`);
  }

  return res.json();
}

export async function identifyFromMessage(msg, bot) {
  const [media, suffix] = mediaAndSuffix(msg);
  if (!media) throw new Error("لا توجد وسائط صوت/فيديو قابلة للتعرف في هذه الرسالة");

  if (media.file_size && media.file_size > MAX_ANALYZE_SIZE) {
    throw new Error(
      `حجم الملف (${(media.file_size / 1024 / 1024).toFixed(1)}MB) كبير جداً للتحليل ` +
        `(الحد الأقصى ${(MAX_ANALYZE_SIZE / 1024 / 1024).toFixed(0)}MB).`
    );
  }

  const tempPath = `${Bun.env.TMPDIR || "/tmp"}/shazam_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`;
  try {
    await bot.downloadFile(media.file_id, tempPath);

    const fileBytes = new Uint8Array(await Bun.file(tempPath).arrayBuffer());

    // توليد البصمة الصوتية عبر shazamio-core (لا يحتاج مفتاح API)
    const signatures = recognizeBytes(fileBytes);
    if (!signatures.length) {
      throw new Error("تعذّر توليد بصمة صوتية من هذا الملف");
    }

    let data;
    try {
      // نجرب كل بصمة (مقطع) حتى نحصل على تطابق، لأن مقطعاً واحداً قد لا يكفي
      for (const sig of signatures) {
        try {
          const result = await searchShazamBySignature(sig);
          if (result?.track) {
            data = result;
            break;
          }
        } finally {
          sig.free();
        }
      }
    } finally {
      // تحرير أي بصمات متبقية لم يتم تحريرها بعد (في حال break مبكر)
      for (const sig of signatures) {
        try {
          sig.free();
        } catch {
          /* تم تحريرها مسبقاً */
        }
      }
    }

    if (!data?.track) {
      throw new Error("لم يُعثر على تطابق لهذه الأغنية");
    }

    const track = data.track;
    const subtitle = track.subtitle || "غير معروف"; // الفنان عادة في subtitle
    const title = track.title || "غير معروف";

    const appleMusicSection = track.hub?.providers?.find((p) =>
      p.actions?.some((a) => a.uri?.includes("music.apple.com"))
    );
    const spotifySection = track.hub?.providers?.find((p) =>
      p.actions?.some((a) => a.uri?.includes("open.spotify.com"))
    );
    const url =
      track.hub?.actions?.find((a) => a.type === "uri")?.uri ||
      appleMusicSection?.actions?.[0]?.uri ||
      spotifySection?.actions?.[0]?.uri ||
      "";

    const cover = track.images?.coverart || track.images?.coverarthq || "";

    return {
      title,
      artist: subtitle,
      url,
      cover,
    };
  } finally {
    try {
      await Bun.file(tempPath).delete?.();
    } catch (e) {
      logger.exception(`فشل حذف الملف المؤقت: ${tempPath}`, e);
    }
  }
}

export async function analyzeAudioShazam(msg, bot) {
  const chatId = msg.chat.id;
  const status = await bot.sendMessage(chatId, "⏳ جاري سحب البصمة الصوتية وتحليلها...");

  let track;
  try {
    track = await identifyFromMessage(msg, bot);
  } catch (e) {
    logger.exception(`فشل التحليل | chat=${chatId}`, e);
    await bot.editMessageText(chatId, status.message_id, `⚠️ ${e.message.slice(0, 300)}`);
    return;
  }

  let replyText = `🎵 تم التعرف على الأغنية بنجاح!\n\n📌 العنوان: ${track.title}\n🎤 الفنان: ${track.artist}`;
  if (track.url) replyText += `\n🔗 ${track.url}`;

  try {
    if (track.cover) {
      await bot.deleteMessage(chatId, status.message_id);
      await bot.sendPhoto(chatId, track.cover, replyText);
    } else {
      await bot.editMessageText(chatId, status.message_id, replyText);
    }
  } catch (e) {
    logger.exception("فشل إرسال صورة الغلاف — إرسال نص فقط", e);
    await bot.sendMessage(chatId, replyText);
  }
}

// لا تُسجَّل كـ handler مباشر — plugins/media_tools.js يستدعي analyzeAudioShazam()/
// identifyFromMessage() مباشرة عند اختيار المستخدم لذلك من القائمة.
export function registerPlugin() {
  return [];
}
