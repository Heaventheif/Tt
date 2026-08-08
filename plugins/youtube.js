// plugins/youtube.js — يوتيوب: @vreden/youtube_scraper (أول خيار، مكتبة npm
// مباشرة داخل نفس عملية Bun) ثم ccproject API ثم yt2 API — بدون yt-dlp إطلاقاً.
// حذف هذا الملف يعطّل دعم يوتيوب فوراً، بدون تعديل أي ملف آخر.
import { config } from "../config.js";
import {
  QualityOption, ProbeResult, DownloadResult,
  streamToFile, hasVideoStream, isBlackVideo,
} from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.youtube");

export const DESCRIPTION = "يوتيوب — @vreden/youtube_scraper + ccproject + yt2 (بدون yt-dlp)";
export const DOMAINS = ["youtube.com", "youtu.be"];
export const PRIORITY = 10;

const CCPROJECT = config.YT_API_1;
const YT2_BASE = config.YT_API_2;

const AUDIO_QUALITIES = [92, 128, 256, 320];
function nearestAudioQuality(q) {
  q = Number(q);
  if (!Number.isFinite(q)) return 128;
  return AUDIO_QUALITIES.reduce((best, cur) => (Math.abs(cur - q) < Math.abs(best - q) ? cur : best));
}

const VIDEO_OPTIONS = [
  QualityOption({ kind: "video", label: "🎥 1080p", key: "v_1080" }),
  QualityOption({ kind: "video", label: "🎥 720p", key: "v_720" }),
  QualityOption({ kind: "video", label: "🎥 480p", key: "v_480" }),
  QualityOption({ kind: "video", label: "🎥 360p", key: "v_360" }),
];
const AUDIO_OPTIONS = [
  QualityOption({ kind: "audio", label: "🎵 256kbps", key: "a_256" }),
  QualityOption({ kind: "audio", label: "🎵 128kbps", key: "a_128" }),
  QualityOption({ kind: "audio", label: "🎵 64kbps", key: "a_64" }),
];

let _ytLib = null;
async function ytLib() {
  if (!_ytLib) {
    _ytLib = await import("@vreden/youtube_scraper");
  }
  return _ytLib;
}

export async function probe(url) {
  let title = null;

  try {
    const yt = await ytLib();
    const info = await yt.metadata(url);
    if (info && info.status !== false) title = info.title;
  } catch (e) {
    logger.warning(`[probe][vreden] فشل: ${e.message}`);
  }

  if (!title) {
    try {
      const res = await fetch(`${YT2_BASE}/v2/q?=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(15000) });
      let data = await res.json();
      if (Array.isArray(data)) data = data[0] || {};
      title = data?.title;
    } catch (e) {
      logger.warning(`[probe][yt2] فشل جلب العنوان: ${e.message}`);
    }
  }

  return ProbeResult({
    title: title || "فيديو يوتيوب",
    options: [...VIDEO_OPTIONS, ...AUDIO_OPTIONS],
    extra: { url },
  });
}

export async function download(url, choice) {
  const key = choice.key;
  const isAudio = key.startsWith("a_");
  const val = key.split("_")[1];

  const errors = [];
  for (const provider of [viaVreden, viaCcproject, viaYt2]) {
    try {
      const { url: dlUrl, title } = await provider(url, !isAudio, val);
      const suffix = isAudio ? ".mp3" : ".mp4";
      const fpath = await streamToFile(dlUrl, suffix, { timeoutTotal: 120, maxSize: config.UPLOAD_LIMIT });

      if (!isAudio && !(await hasVideoStream(fpath))) {
        logger.warning(`[download] ${provider.name} أعاد ملفاً بدون فيديو حقيقي — تجربة مزود آخر`);
        try { await Bun.file(fpath).delete?.(); } catch {}
        errors.push(`${provider.name}: الملف المُرجَع بدون مسار فيديو (صوت فقط)`);
        continue;
      }
      if (!isAudio && (await isBlackVideo(fpath))) {
        logger.warning(`[download] ${provider.name} أعاد فيديو أسود بالكامل — تجربة مزود آخر`);
        try { await Bun.file(fpath).delete?.(); } catch {}
        errors.push(`${provider.name}: الفيديو المُرجَع صورة سوداء ثابتة`);
        continue;
      }
      return DownloadResult({ filePath: fpath, title, isAudio });
    } catch (e) {
      logger.warning(`[download] المزود ${provider.name} فشل: ${e.message}`);
      errors.push(`${provider.name}: ${e.message}`);
    }
  }

  logger.error(`[download] فشل كل المزودين | url=${url} | ${errors.join(" | ")}`);
  throw new Error("فشل كل المزودين الخارجيين:\n" + errors.join("\n"));
}

async function viaVreden(url, wantMp4, val) {
  const yt = await ytLib();
  const q = wantMp4 ? Number(val) : nearestAudioQuality(val);
  const res = wantMp4 ? await yt.ytmp4(url, q) : await yt.ytmp3(url, q);
  if (!res || res.status === false) throw new Error((res && res.error) || "vreden: فشل التحويل");
  const dl = res.download || {};
  if (!dl.status || !dl.url) throw new Error("vreden: لا يوجد رابط تحميل في الاستجابة");
  return { url: dl.url, title: (res.metadata && res.metadata.title) || "يوتيوب" };
}
// ملاحظة: Function.prototype.name غير قابل للكتابة (writable:false) رغم أنه
// قابل لإعادة التعريف (configurable:true) — والوحدات (ESM) تعمل دائماً بوضع
// strict mode، فالتعيين المباشر (viaVreden.name = "...") يرمي:
// "TypeError: Attempted to assign to readonly property" ويُسقط الملف بالكامل
// عند التحميل. Object.defineProperty هو الطريقة الصحيحة لتغييره فعلياً.
Object.defineProperty(viaVreden, "name", { value: "vreden", configurable: true });

async function viaCcproject(url, wantMp4, val) {
  const kind = wantMp4 ? "mp4" : "mp3";
  const qs = new URLSearchParams({ url, type: kind });
  const res = await fetch(`${CCPROJECT}?${qs}`, { signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (!data || !data.download) throw new Error(data?.error || "no download URL");
  return { url: data.download, title: data.title || "يوتيوب" };
}
Object.defineProperty(viaCcproject, "name", { value: "ccproject", configurable: true });

async function viaYt2(url, wantMp4, val) {
  const res = await fetch(`${YT2_BASE}/v2/q?=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(30000) });
  let data = await res.json();
  if (Array.isArray(data)) data = data[0] || {};
  const media = data?.media || {};
  const pick = (v) => (typeof v === "string" ? v : v?.url);
  const dlUrl = pick(wantMp4 ? media.mp4 : media.mp3);
  if (!dlUrl) throw new Error("yt2: لا يوجد رابط تحميل");
  return { url: dlUrl, title: data?.title || "يوتيوب" };
}
Object.defineProperty(viaYt2, "name", { value: "yt2", configurable: true });
