// plugins/generic.js — Fallback عام لأي رابط لم يُطالب به plugin آخر.
// يدعم حالياً:
//   • أي موقع يحتوي على روابط فيديو مباشرة (.m3u8 / .mp4 / .webm / .mkv) أو داخل iframes
//   • روابط فيديو مباشرة (Direct links)
//   • twitter.com / x.com عبر API خارجي: smfahim.xyz
import HlsDownloader from "hlsdownloader";
import path from "path";
import { config } from "../config.js";
import { QualityOption, ProbeResult, DownloadResult, streamToFile } from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.generic");

export const DESCRIPTION = "عام — استخراج الفيديو من أي موقع (M3U8/MP4/iFrames/Direct) + تويتر/X";
export const DOMAINS = ["*"];
export const PRIORITY = 99; // آخر خيار دائماً

const OPTIONS = [
  QualityOption({ kind: "video", label: "🎥 أفضل جودة متاحة", key: "v_best" }),
  QualityOption({ kind: "video", label: "🎥 أصغر حجم", key: "v_smallest" }),
];

// ─── أدوات مساعدة للاستخراج العام ───

const FETCH_OPTIONS = (referer) => ({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Referer": referer,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5"
  }
});

function extractVideoLinks(htmlText) {
  const patterns = [
    /https?:\/\/[^\s"'`<>#]+\.m3u8[^\s"'`<>#]*/gi,
    /https?:\/\/[^\s"'`<>#]+\.mp4[^\s"'`<>#]*/gi,
    /https?:\/\/[^\s"'`<>#]+\.webm[^\s"'`<>#]*/gi,
    /https?:\/\/[^\s"'`<>#]+\.mkv[^\s"'`<>#]*/gi,
    /https?:\/\/[^\s"'`<>#]+\.mov[^\s"'`<>#]*/gi,
    /https?:\/\/[^\s"'`<>#]+\.flv[^\s"'`<>#]*/gi,
  ];

  const allLinks = [];
  for (const regex of patterns) {
    const matches = htmlText.match(regex) || [];
    allLinks.push(...matches);
  }

  return [...new Set(allLinks.map(link => link.replace(/\\/g, "").replace(/["'`<>]/g, "")))];
}

function extractIframes(htmlText) {
  const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
  const matches = [];
  let match;
  while ((match = iframeRegex.exec(htmlText)) !== null) {
    if (match[1] && match[1].startsWith("http")) {
      matches.push(match[1]);
    }
  }
  return [...new Set(matches)];
}

function extractVideoTags(htmlText) {
  const sourceRegex = /<source[^>]+src=["']([^"']+)["']/gi;
  const videoRegex = /<video[^>]+src=["']([^"']+)["']/gi;
  const matches = [];
  let match;

  while ((match = sourceRegex.exec(htmlText)) !== null) {
    if (match[1]) matches.push(match[1]);
  }
  while ((match = videoRegex.exec(htmlText)) !== null) {
    if (match[1]) matches.push(match[1]);
  }

  return [...new Set(matches)].filter(u => u.startsWith("http"));
}

function extractJsonLd(htmlText) {
  try {
    const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = jsonLdRegex.exec(htmlText)) !== null) {
      const json = JSON.parse(match[1]);
      if (json.contentUrl) return json.contentUrl;
      if (json.video?.contentUrl) return json.video.contentUrl;
      if (json.embedUrl) return json.embedUrl;
    }
  } catch {
    // تجاهل أخطاء JSON
  }
  return null;
}

function extractOpenGraph(htmlText) {
  const ogVideoRegex = /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i;
  const ogVideoUrlRegex = /<meta[^>]+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i;
  const ogVideoSecureRegex = /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i;

  const m1 = htmlText.match(ogVideoRegex);
  const m2 = htmlText.match(ogVideoUrlRegex);
  const m3 = htmlText.match(ogVideoSecureRegex);

  return m3?.[1] || m2?.[1] || m1?.[1] || null;
}

function extractTitle(htmlText) {
  const m = htmlText.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (m && m[1].trim()) return m[1].trim();

  const ogTitle = htmlText.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogTitle) return ogTitle[1];

  return null;
}

function isVideoUrl(url) {
  const videoExts = [".m3u8", ".mp4", ".webm", ".mkv", ".mov", ".flv"];
  const lower = url.toLowerCase();
  return videoExts.some(ext => lower.includes(ext));
}

function normalizeUrl(url, baseUrl) {
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) {
    const base = new URL(baseUrl);
    return `${base.protocol}//${base.host}${url}`;
  }
  return new URL(url, baseUrl).href;
}

async function findGenericVideo(pageUrl) {
  const res = await Bun.fetch(pageUrl, FETCH_OPTIONS(pageUrl));
  if (!res.ok) throw new Error(`فشل الاتصال بالموقع، كود: ${res.status}`);
  const html = await res.text();

  let title = extractTitle(html) || "فيديو عام";

  let links = extractVideoLinks(html);
  if (links.length > 0) {
    return { url: links[0], title, method: "direct" };
  }

  const videoTagLinks = extractVideoTags(html);
  if (videoTagLinks.length > 0) {
    return { url: videoTagLinks[0], title, method: "video_tag" };
  }

  const jsonLdUrl = extractJsonLd(html);
  if (jsonLdUrl) {
    return { url: normalizeUrl(jsonLdUrl, pageUrl), title, method: "jsonld" };
  }

  const ogUrl = extractOpenGraph(html);
  if (ogUrl) {
    return { url: normalizeUrl(ogUrl, pageUrl), title, method: "og" };
  }

  const iframes = extractIframes(html);
  logger.info(`[findGenericVideo] تم العثور على ${iframes.length} iframe، جاري الفحص...`);

  for (const iframeUrl of iframes) {
    try {
      const iframeRes = await Bun.fetch(iframeUrl, FETCH_OPTIONS(pageUrl));
      if (!iframeRes.ok) continue;

      const iframeHtml = await iframeRes.text();

      const iframeLinks = extractVideoLinks(iframeHtml);
      if (iframeLinks.length > 0) {
        return { url: iframeLinks[0], title, method: "iframe_direct" };
      }

      const iframeVideoTags = extractVideoTags(iframeHtml);
      if (iframeVideoTags.length > 0) {
        return { url: iframeVideoTags[0], title, method: "iframe_video_tag" };
      }

      const iframeJsonLd = extractJsonLd(iframeHtml);
      if (iframeJsonLd) {
        return { url: normalizeUrl(iframeJsonLd, iframeUrl), title, method: "iframe_jsonld" };
      }

      const iframeOg = extractOpenGraph(iframeHtml);
      if (iframeOg) {
        return { url: normalizeUrl(iframeOg, iframeUrl), title, method: "iframe_og" };
      }

    } catch (err) {
      logger.debug(`[findGenericVideo] فشل فحص iframe ${iframeUrl}: ${err.message}`);
      continue;
    }
  }

  return null;
}

// ─── تويتر/X عبر API خارجي: smfahim.xyz (15 نسخة، fallback تتابعي) ───

const TWITTER_API_VERSIONS = 15;
const TWITTER_API_URL = (v) => `https://www.smfahim.xyz/download/all/v${v}`;

function extractCandidatesFromResponse(data) {
  const links = data?.links || {};
  const candidates = [
    { url: links.hd, quality: "hd" },
    { url: links.sd, quality: "sd" },
  ].filter(c => !!c.url);

  const seen = new Set();
  return candidates.filter(c => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

async function resolveTwitter(url) {
  const errors = [];

  for (let v = 1; v <= TWITTER_API_VERSIONS; v++) {
    const apiUrl = `${TWITTER_API_URL(v)}?url=${encodeURIComponent(url)}`;

    try {
      const res = await Bun.fetch(apiUrl, FETCH_OPTIONS(url));
      if (!res.ok) {
        errors.push(`v${v}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      if (!data || data.status !== true) {
        errors.push(`v${v}: status=false`);
        continue;
      }

      const sorted = extractCandidatesFromResponse(data);
      if (sorted.length === 0) {
        errors.push(`v${v}: بدون روابط فيديو`);
        continue;
      }

      logger.info(`[resolveTwitter] نجح الاستخراج عبر v${v}`);
      const title = data.title?.slice(0, 100) || "فيديو تويتر/X";
      return { sorted, title };

    } catch (err) {
      errors.push(`v${v}: ${err.message}`);
      continue;
    }
  }

  logger.warning(`[resolveTwitter] فشلت كل النسخ (1-${TWITTER_API_VERSIONS}): ${errors.join(" | ")}`);
  throw new Error("فشل استخراج بيانات المنشور من تويتر/X عبر جميع نسخ الـ API المتاحة");
}

function isTwitter(url) {
  try {
    const u = new URL(url);
    return u.hostname === "twitter.com" || u.hostname === "x.com" || u.hostname.endsWith(".twitter.com") || u.hostname.endsWith(".x.com");
  } catch {
    return false;
  }
}

function isDirectVideoUrl(url) {
  try {
    const u = new URL(url);
    return isVideoUrl(u.pathname);
  } catch {
    return false;
  }
}

// ─── واجهة الـ Plugin ───

export async function probe(url) {
  let title = "فيديو عام";

  if (isDirectVideoUrl(url)) {
    return ProbeResult({
      title: "رابط فيديو مباشر",
      options: OPTIONS,
      extra: { url, source: "direct_video" }
    });
  }

  if (isTwitter(url)) {
    let twitterResolved = null;
    try {
      twitterResolved = await resolveTwitter(url);
      title = twitterResolved.title;
    } catch (e) {
      logger.warning(`[probe] Twitter فشل: ${e.message}`);
    }
    return ProbeResult({ title, options: OPTIONS, extra: { url, source: "twitter", twitterResolved } });
  }

  try {
    const result = await findGenericVideo(url);
    if (result) title = result.title;
  } catch (e) {
    logger.warning(`[probe] عام فشل: ${e.message}`);
  }

  return ProbeResult({ title, options: OPTIONS, extra: { url, source: "generic" } });
}

export async function download(url, choice) {
  if (isDirectVideoUrl(url)) {
    const ext = path.extname(new URL(url).pathname) || ".mp4";
    const filePath = await streamToFile(url, ext, {
      timeoutTotal: 300,
      maxSize: config.UPLOAD_LIMIT,
    });
    return DownloadResult({ filePath, title: "فيديو مباشر", isAudio: false });
  }

  if (isTwitter(url)) {
    const { sorted, title } = choice?.extra?.twitterResolved || (await resolveTwitter(url));
    const pick = choice.key === "v_smallest" ? sorted[sorted.length - 1] : sorted[0];
    if (!pick?.url) throw new Error("تعذّر العثور على رابط تنزيل صالح لهذه الجودة");

    const filePath = await streamToFile(pick.url, ".mp4", {
      timeoutTotal: 90,
      maxSize: config.UPLOAD_LIMIT,
    });
    return DownloadResult({ filePath, title, isAudio: false });
  }

  const result = await findGenericVideo(url);
  if (!result || !result.url) {
    throw new Error("لم يتم العثور على أي روابط فيديو أو سيرفرات مشاهدة خارجية في هذا الموقع");
  }

  const { url: videoUrl, title, method } = result;
  logger.info(`[download] تم العثور على الفيديو عبر: ${method} → ${videoUrl}`);

  const isM3u8 = videoUrl.includes(".m3u8");
  const ext = path.extname(new URL(videoUrl).pathname) || ".mp4";

  if (isM3u8) {
    const outputFile = path.join(config.TEMP_DIR || import.meta.dir, `generic_hls_${Date.now()}.mp4`);
    const downloader = new HlsDownloader(videoUrl, outputFile, {
      concurrency: 8,
    });
    await downloader.start();
    return DownloadResult({ filePath: outputFile, title, isAudio: false });
  }

  const filePath = await streamToFile(videoUrl, ext, {
    timeoutTotal: 300,
    maxSize: config.UPLOAD_LIMIT,
  });
  return DownloadResult({ filePath, title, isAudio: false });
       }
