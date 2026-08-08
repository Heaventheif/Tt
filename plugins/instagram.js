// plugins/instagram.js — انستغرام (reel/p/tv) عبر API خارجي واحد فقط:
//   https://www.smfahim.xyz/download/instagram/v9?url=<link>
// تمت إزالة مكتبات npm (@mrnima/instagram-downloader و @xncn/instadownloader) بالكامل.
// ⚠️ تنبيه: هذا API خارجي مجاني تابع لطرف ثالث (smfahim.xyz)، غير موثق رسمياً،
// وقد يتوقف أو يتغير شكل استجابته في أي وقت بدون إشعار مسبق.
// حذف هذا الملف يعطّل دعم انستغرام فوراً، بدون تعديل أي ملف آخر.
import { config } from "../config.js";
import { QualityOption, ProbeResult, DownloadResult, streamToFile } from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.instagram");

export const DESCRIPTION = "انستغرام — smfahim.xyz API";
export const DOMAINS = ["instagram.com"];
export const PRIORITY = 10;

const OPTIONS = [QualityOption({ kind: "video", label: "🎥 تنزيل", key: "v_default" })];

const API_BASE = "https://www.smfahim.xyz/download/instagram/v1";

// يحاول استخراج رابط الوسائط والعنوان من أشكال استجابة مختلفة محتملة،
// لأن توثيق هذا الـ API غير منشور رسمياً.
function extractMediaUrl(json) {
  // الشكل الفعلي الحالي لـ smfahim: { status:true, title, links: { hd, sd } }
  if (json?.links && typeof json.links === "object") {
    const { hd, sd, url, video } = json.links;
    if (hd) return hd;
    if (sd) return sd;
    if (url) return url;
    if (video) return video;
  }

  // أشكال بديلة محتملة: { data: [...] } أو { data: {...} } أو { result: ... }
  const data = json?.data ?? json?.result ?? json;

  const candidates = [];

  if (Array.isArray(data)) {
    candidates.push(...data);
  } else if (data && typeof data === "object") {
    candidates.push(data);
  }

  for (const item of candidates) {
    if (item?.links && typeof item.links === "object") {
      const { hd, sd, url } = item.links;
      if (hd) return hd;
      if (sd) return sd;
      if (url) return url;
    }

    const url =
      item?.url ||
      item?.video_url ||
      item?.videoUrl ||
      item?.download_url ||
      item?.downloadUrl ||
      item?.media_url ||
      item?.hd ||
      item?.sd;
    if (url) return url;
  }

  return null;
}

function extractTitle(json) {
  const data = json?.data ?? json?.result ?? json;
  const item = Array.isArray(data) ? data[0] : data;
  return item?.title || item?.caption || item?.description || "فيديو انستغرام";
}

async function resolve(url) {
  const apiUrl = `${API_BASE}?url=${encodeURIComponent(url)}`;

  const res = await fetch(apiUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    throw new Error(`فشل الاتصال بخدمة التحميل (HTTP ${res.status})`);
  }

  const json = await res.json();

  if (json?.status === false || json?.success === false) {
    throw new Error(json?.message || "لم يتم العثور على وسائط — تأكد أن الرابط صحيح وأن المنشور عام (غير خاص)");
  }

  const mediaUrl = extractMediaUrl(json);
  if (!mediaUrl) {
    logger.warning(`[smfahim] شكل استجابة غير متوقع: ${JSON.stringify(json).slice(0, 500)}`);
    throw new Error("لم يتم العثور على وسائط — تأكد أن الرابط صحيح وأن المنشور عام (غير خاص)");
  }

  return { url: mediaUrl, title: extractTitle(json) };
}

export async function probe(url) {
  let title = "فيديو انستغرام";
  try {
    ({ title } = await resolve(url));
  } catch (e) {
    logger.warning(`[probe] فشل: ${e.message}`);
  }
  return ProbeResult({ title, options: OPTIONS, extra: { url } });
}

export async function download(url, choice) {
  const { url: dlUrl, title } = await resolve(url);
  const filePath = await streamToFile(dlUrl, ".mp4", { timeoutTotal: 90, maxSize: config.UPLOAD_LIMIT });
  return DownloadResult({ filePath, title, isAudio: false });
}
