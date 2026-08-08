// plugins/facebook.js — فيسبوك/ريلز عبر FBDL API (betadash-api-swordslush) كمزود أول،
// مع facebook-video-download-api (القديم) كاحتياط ثانٍ، و api.ferdev.my.id كاحتياط أخير.
// حذف هذا الملف يعطّل دعم فيسبوك فوراً، بدون تعديل أي ملف آخر.
import { config } from "../config.js";
import { QualityOption, ProbeResult, DownloadResult, streamToFile, hasAudioStream } from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.facebook");

export const DESCRIPTION = "فيسبوك/ريلز — FBDL API (جديد) + facebook-video-download-api (قديم) + ferdev كاحتياط أخير";
export const DOMAINS = ["facebook.com", "fb.watch", "fb.com"];
export const PRIORITY = 10;

const FDOWN = config.FB_DOWNLOAD_API;
const FDOWN_OLD = config.FB_DOWNLOAD_API_OLD;
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";

const PROBE_TIMEOUT_MS = 15000;

const OPTIONS = [
  QualityOption({ kind: "video", label: "🎥 جودة عادية", key: "v_sd" }),
  QualityOption({ kind: "video", label: "🎥 جودة HD", key: "v_hd" }),
  QualityOption({ kind: "audio", label: "🎵 256kbps", key: "a_256" }),
  QualityOption({ kind: "audio", label: "🎵 128kbps", key: "a_128" }),
];

export async function probe(url) {
  return ProbeResult({ title: "فيديو فيسبوك", options: OPTIONS, extra: { url } });
}

// 🔇 فحص وجود مسار صوت على رابط بعيد مباشرة عبر ffprobe (Range requests فقط)
async function hasAudioStreamUrl(url) {
  try {
    const proc = Bun.spawn(
      [
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=index", "-of", "csv=p=0",
        "-timeout", "10000000", "-user_agent", UA, url,
      ],
      { stdout: "pipe", stderr: "ignore" }
    );
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (exitCode !== 0) return true;
    return !!stdout.trim();
  } catch {
    return true;
  }
}

// 🆕 يستخدم FBDL API (betadash-api-swordslush): GET /fbdl?url=<encoded>
// ملاحظة مهمة: هذا الـ endpoint لا يرجع JSON، بل يرجع بايتات الفيديو مباشرة
// (content-type: video/mp4) — الرابط نفسه هو رابط التنزيل المباشر.
async function getCandidates(url, quality) {
  const dlUrl = `${FDOWN}/fbdl?${new URLSearchParams({ url })}`;
  // تحقق سريع (HEAD) إن الرابط فعلاً بيرجع فيديو، بدون تنزيل كامل
  try {
    const head = await fetch(dlUrl, {
      method: "GET",
      headers: { "User-Agent": UA, Range: "bytes=0-1" },
      signal: AbortSignal.timeout(15000),
    });
    if (!head.ok && head.status !== 206) {
      const text = await head.text().catch(() => "");
      throw new Error(`FBDL رجّع HTTP ${head.status}: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    throw new Error(`فشل التحقق من رابط FBDL: ${e.message}`);
  }
  return { urls: [dlUrl], title: "فيديو فيسبوك" };
}

// 🕰️ الـ API القديم (facebook-video-download-api) — احتياط ثانٍ قبل ferdev
async function getCandidatesOld(url, quality) {
  const res = await fetch(`${FDOWN_OLD}/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, quality }),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`API القديم رجّع HTTP ${res.status}: ${raw.slice(0, 200)}`);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`API القديم رجّع رد غير JSON: ${raw.slice(0, 200)}`);
  }
  logger.info(`[fb-old] رد الـ API (أول 500 حرف): ${raw.slice(0, 500)}`);
  if (!data || data.status === "error") throw new Error(data?.error || "فشل جلب روابط فيسبوك (القديم)");

  const urls = [];
  if (data.download_url) urls.push(data.download_url);
  for (const fmt of data.available_formats || []) {
    const u = fmt?.url;
    if (u && !urls.includes(u)) urls.push(u);
  }
  if (urls.length === 0) throw new Error(`تعذّر استخراج رابط الفيديو من رد API القديم: ${raw.slice(0, 300)}`);

  const title = data.video_info?.title || "فيديو فيسبوك";
  return { urls, title };
}

async function pickUrlForQuality(url, quality) {
  let urls, title;
  try {
    ({ urls, title } = await getCandidates(url, quality));
  } catch (e) {
    logger.warning(`[fb-api] فشل جلب روابط للجودة ${quality}: ${e.message}`);
    try {
      ({ urls, title } = await getCandidatesOld(url, quality));
      logger.info(`[fb-api] نجح المزود القديم كاحتياط للجودة ${quality}`);
    } catch (e2) {
      logger.warning(`[fb-api] فشل المزود القديم أيضاً للجودة ${quality}: ${e2.message}`);
      return null;
    }
  }
  let fallback = null;
  for (const cand of urls) {
    const hasAudio = await hasAudioStreamUrl(cand);
    if (hasAudio) return { url: cand, title, hasAudio: true };
    if (!fallback) fallback = { url: cand, title, hasAudio: false };
  }
  return fallback;
}

export async function download(url, choice) {
  const key = choice.key;
  if (key.startsWith("a_")) return downloadAudio(url, key);

  const quality = key === "v_hd" ? "720p" : "worst";
  const LADDER = ["worst", "360p", "720p", "1080p", "best"];
  const start = LADDER.includes(quality) ? LADDER.indexOf(quality) : 0;

  let picked = null;
  let silentFallback = null;
  for (const q of LADDER.slice(start)) {
    const result = await pickUrlForQuality(url, q);
    if (!result) continue;
    if (result.hasAudio) {
      picked = result;
      break;
    }
    if (!silentFallback) silentFallback = result;
  }
  if (!picked) picked = silentFallback;

  if (picked) {
    try {
      const filePath = await streamToFile(picked.url, ".mp4", { timeoutTotal: 120, maxSize: config.UPLOAD_LIMIT });
      return DownloadResult({ filePath, title: picked.title, isAudio: false });
    } catch (e) {
      logger.warning(`[fb-api] فشل تنزيل الرابط المختار: ${e.message}`);
    }
  }

  logger.warning("[facebook] المزود الأول (API) فشل بالكامل — تجربة ferdev كمزود احتياطي");
  try {
    return await downloadViaFerdev(url, key);
  } catch (e2) {
    logger.error(`[facebook] فشل المزود الاحتياطي (ferdev) أيضاً: ${e2.message}`);
    throw new Error(`فشل المزود الأساسي (API) والمزود الاحتياطي (ferdev): ${e2.message}`);
  }
}

async function downloadViaFerdev(url, key) {
  if (!config.FERDEV_API_KEY) {
    throw new Error("FERDEV_API_KEY غير مضبوط — لا يوجد مزود احتياطي متاح");
  }
  const qs = new URLSearchParams({ link: url, apikey: config.FERDEV_API_KEY });
  const res = await fetch(`https://api.ferdev.my.id/downloader/facebook?${qs}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ferdev رجّع HTTP ${res.status}: ${raw.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`ferdev رجّع رد غير JSON: ${raw.slice(0, 200)}`);
  }
  const dlUrl =
    json?.result?.url || json?.result?.hd || json?.result?.sd || json?.result?.video || json?.data?.url || json?.url;
  if (!dlUrl) throw new Error(`تعذّر استخراج رابط الفيديو من رد ferdev: ${raw.slice(0, 300)}`);
  const title = json?.result?.title || "فيديو فيسبوك";

  if (key.startsWith("a_")) {
    const quality = key.split("_")[1];
    const videoPath = await streamToFile(dlUrl, ".mp4", { timeoutTotal: 120, maxSize: config.UPLOAD_LIMIT });
    try {
      const audioPath = await extractAudio(videoPath, quality);
      return DownloadResult({ filePath: audioPath, title, isAudio: true });
    } finally {
      try { await Bun.file(videoPath).delete?.(); } catch {}
    }
  }

  const filePath = await streamToFile(dlUrl, ".mp4", { timeoutTotal: 120, maxSize: config.UPLOAD_LIMIT });
  if (!(await hasAudioStream(filePath))) {
    try { await Bun.file(filePath).delete?.(); } catch {}
    throw new Error("الفيديو الناتج بدون صوت");
  }
  return DownloadResult({ filePath, title, isAudio: false });
}

// 🎧 استخراج صوت فقط — لا يوجد مزود خارجي للصوت مباشرة، فنُنزّل الفيديو
// الكامل (أفضل جودة متاحة) ثم نستخرج الصوت محلياً عبر ffmpeg -vn، بدل
// الاعتماد على yt-dlp كما كان سابقاً.
async function downloadAudio(url, key) {
  const quality = key.split("_")[1]; // "256" أو "128"
  const picked = (await pickUrlForQuality(url, "best")) || (await pickUrlForQuality(url, "worst"));
  if (!picked) throw new Error("تعذّر جلب رابط فيديو لاستخراج الصوت منه");

  const videoPath = await streamToFile(picked.url, ".mp4", { timeoutTotal: 120, maxSize: config.UPLOAD_LIMIT });
  try {
    const audioPath = await extractAudio(videoPath, quality);
    return DownloadResult({ filePath: audioPath, title: picked.title, isAudio: true });
  } finally {
    try { await Bun.file(videoPath).delete?.(); } catch {}
  }
}

async function extractAudio(videoPath, quality) {
  const outPath = `${videoPath}.audio.mp3`;
  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-i", videoPath, "-vn", "-acodec", "libmp3lame", "-b:a", `${quality}k`, outPath],
    { stdout: "ignore", stderr: "pipe" }
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0 || Bun.file(outPath).size === 0) {
    throw new Error(`فشل استخراج الصوت عبر ffmpeg: ${stderr.slice(0, 300)}`);
  }
  return outPath;
}
