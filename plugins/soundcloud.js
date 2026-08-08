// plugins/soundcloud.js — ساوندكلاود عبر API مباشر (streaming)
// حذف هذا الملف يعطّل دعم ساوندكلاود فوراً، بدون تعديل أي ملف آخر.
import { config } from "../config.js";
import { QualityOption, ProbeResult, DownloadResult, streamToFile, getSoundcloudClientId } from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.soundcloud");

export const DESCRIPTION = "ساوندكلاود — streaming مباشر";
export const DOMAINS = ["soundcloud.com"];
export const PRIORITY = 10;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" };

export async function probe(url) {
  let title = "مقطع SoundCloud";
  try {
    const cid = await getSoundcloudClientId(H);
    const qs = new URLSearchParams({ url, client_id: cid });
    const res = await fetch(`https://api-v2.soundcloud.com/resolve?${qs}`, {
      headers: H,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    title = data?.title || title;
  } catch (e) {
    logger.warning(`[probe] فشل جلب العنوان: ${e.message}`);
  }

  return ProbeResult({
    title,
    options: [
      QualityOption({ kind: "audio", label: "🎵 تحميل MP3 (كامل)", key: "a_full" }),
      QualityOption({ kind: "audio", label: "🎵 معاينة 30 ثانية", key: "a_snip" }),
    ],
    extra: { url },
  });
}

export async function download(url, choice) {
  const wantSnip = choice.key === "a_snip";
  const cid = await getSoundcloudClientId(H);

  const qs = new URLSearchParams({ url, client_id: cid });
  const resolveRes = await fetch(`https://api-v2.soundcloud.com/resolve?${qs}`, {
    headers: H,
    signal: AbortSignal.timeout(10000),
  });
  const track = await resolveRes.json();

  const title = track?.title || "بدون عنوان";
  const transcodings = track?.media?.transcodings || [];
  if (!transcodings.length) throw new Error("لا يوجد بث متاح لهذا المقطع");

  const protPref = "progressive";
  let candidates = transcodings.filter((t) => wantSnip === !!t.snipped && t?.format?.protocol === protPref);
  if (!candidates.length) candidates = transcodings.filter((t) => wantSnip === !!t.snipped);
  if (!candidates.length) candidates = transcodings.filter((t) => t?.format?.protocol === protPref);
  const chosen = (candidates.length ? candidates : transcodings)[0];

  const streamQs = new URLSearchParams({
    client_id: cid,
    track_authorization: track.track_authorization || "",
  });
  const streamRes = await fetch(`${chosen.url}?${streamQs}`, { headers: H, signal: AbortSignal.timeout(15000) });
  const streamData = await streamRes.json();

  const streamUrl = streamData?.url;
  if (!streamUrl) throw new Error("فشل استخراج رابط البث");

  const filePath = await streamToFile(streamUrl, ".mp3", { headers: H, timeoutTotal: 60, maxSize: config.UPLOAD_LIMIT });
  return DownloadResult({ filePath, title, isAudio: true });
}
