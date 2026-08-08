// plugins/search_youtube.js — Search-plugin: بحث بالاسم عبر YouTube
// عبر مكتبة npm "yt-search" (scraping خفيف، بدون yt-dlp وبدون مفتاح API).
// حذف هذا الملف يعطّل خيار البحث عبر YouTube فوراً، بدون تعديل أي ملف آخر.
import yts from "yt-search";
import { SearchResult } from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.search_youtube");

export const DESCRIPTION = "بحث بالاسم عبر YouTube";
export const SEARCH_PRIORITY = 10; // يُعرض أولاً غالباً

function fmtDuration(secs) {
  if (!secs) return "";
  secs = Math.floor(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export async function search(query) {
  let result;
  try {
    result = await Promise.race([
      yts(query),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
    ]);
  } catch (e) {
    logger.warning(`[search] فشل بحث YouTube عن «${query}»: ${e.message}`);
    return [];
  }

  const videos = (result?.videos || []).slice(0, 10);
  return videos.map((v) =>
    SearchResult({
      title: v.title || "بدون عنوان",
      url: v.url,
      source: "YouTube",
      duration: v.timestamp || fmtDuration(v.seconds),
      uploader: v.author?.name || "",
    })
  );
}
