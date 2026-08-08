// plugins/tiktok.js — تيك توك عبر TikWM ثم TikMate (بديل عن yt-dlp)
// حذف هذا الملف يعطّل دعم تيك توك فوراً، بدون تعديل أي ملف آخر.
import { config } from "../config.js";
import { QualityOption, ProbeResult, DownloadResult, streamToFile } from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.tiktok");

export const DESCRIPTION = "تيك توك — TikWM + TikMate (بديل عن yt-dlp)";
export const DOMAINS = ["tiktok.com"];
export const PRIORITY = 10;

const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const RETRY_STATUS_CODES = [429, 502, 503, 504];
const INITIAL_BACKOFF_MS = 500;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PROVIDERS = [
  {
    name: "TikWM",
    buildUrl: (url) => `https://tikwm.com/api/?url=${encodeURIComponent(url)}`,
    extractor: (json) => json?.data?.play,
    titleExtractor: (json) => json?.data?.title,
  },
  {
    name: "TikMate",
    buildUrl: (url) => `https://www.tikmate.cc/api/url?url=${encodeURIComponent(url)}`,
    extractor: (json) => json?.url || json?.video_url,
    titleExtractor: (json) => json?.title,
  },
];

async function fetchWithTimeout(url, options = {}, retries = MAX_RETRIES, backoff = INITIAL_BACKOFF_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok && RETRY_STATUS_CODES.includes(res.status) && retries > 0) {
      await Bun.sleep(backoff);
      return fetchWithTimeout(url, options, retries - 1, Math.min(backoff * 2, 10000));
    }
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (retries > 0 && (e.name === "AbortError" || String(e.message).includes("timeout"))) {
      await Bun.sleep(backoff);
      return fetchWithTimeout(url, options, retries - 1, Math.min(backoff * 2, 10000));
    }
    throw e;
  }
}

function validateTikTokUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error("الرابط غير صالح (تأكد من صيغته)");
  }
  const validHosts = ["www.tiktok.com", "tiktok.com", "vm.tiktok.com", "vt.tiktok.com"];
  if (!validHosts.includes(url.hostname.toLowerCase())) {
    throw new Error("الرابط يجب أن يكون من TikTok");
  }
}

async function resolve(tiktokUrl) {
  validateTikTokUrl(tiktokUrl);
  let lastError = null;

  for (const provider of PROVIDERS) {
    try {
      const res = await fetchWithTimeout(provider.buildUrl(tiktokUrl), { headers: { "User-Agent": UA } });
      if (!res.ok) {
        lastError = new Error(`${provider.name}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const videoUrl = provider.extractor(json);
      if (videoUrl && typeof videoUrl === "string" && videoUrl.startsWith("http")) {
        const title = (provider.titleExtractor && provider.titleExtractor(json)) || "فيديو تيك توك";
        return { url: videoUrl, title };
      }
      lastError = new Error(`${provider.name}: لم يُعد رابطاً صالحاً`);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`تعذر استخراج رابط الفيديو من جميع المزودين. آخر خطأ: ${lastError?.message || "غير معروف"}`);
}

const OPTIONS = [
  QualityOption({ kind: "video", label: "🎥 فيديو", key: "v_hd" }),
  QualityOption({ kind: "audio", label: "🎵 256kbps", key: "a_256" }),
  QualityOption({ kind: "audio", label: "🎵 128kbps", key: "a_128" }),
];

export async function probe(url) {
  let title = "فيديو تيك توك";
  try {
    ({ title } = await resolve(url));
  } catch (e) {
    logger.warning(`[probe] فشل: ${e.message}`);
  }
  return ProbeResult({ title, options: OPTIONS, extra: { url } });
}

export async function download(url, choice) {
  const key = choice.key;
  const { url: dlUrl, title } = await resolve(url);
  const videoPath = await streamToFile(dlUrl, ".mp4", { timeoutTotal: 60, maxSize: config.UPLOAD_LIMIT });

  if (key.startsWith("a_")) {
    const quality = key.split("_")[1];
    let audioPath;
    try {
      audioPath = await extractAudio(videoPath, quality);
    } finally {
      try {
        await Bun.file(videoPath).delete?.();
      } catch {}
    }
    return DownloadResult({ filePath: audioPath, title, isAudio: true });
  }

  return DownloadResult({ filePath: videoPath, title, isAudio: false });
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
