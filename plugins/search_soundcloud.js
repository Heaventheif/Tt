// plugins/search_soundcloud.js — Search-plugin: بحث بالاسم عبر SoundCloud API
// حذف هذا الملف يعطّل خيار البحث عبر SoundCloud فوراً، بدون تعديل أي ملف آخر.
import { SearchResult, getSoundcloudClientId } from "../plugin-loader.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("plugin.search_soundcloud");

export const DESCRIPTION = "بحث بالاسم عبر SoundCloud";
export const SEARCH_PRIORITY = 20; // يُعرض بعد YouTube

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" };

function fmtDuration(ms) {
  if (!ms) return "";
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export async function search(query) {
  let data;
  try {
    const cid = await getSoundcloudClientId(H);
    const qs = new URLSearchParams({ q: query, client_id: cid, limit: "10" });
    const res = await fetch(`https://api-v2.soundcloud.com/search/tracks?${qs}`, {
      headers: H,
      signal: AbortSignal.timeout(12000),
    });
    data = await res.json();
  } catch (e) {
    logger.warning(`[search] فشل بحث SoundCloud عن «${query}»: ${e.message}`);
    return [];
  }

  const items = data?.collection || [];
  return items.slice(0, 10).flatMap((t) => {
    if (!t.permalink_url) return [];
    return [
      SearchResult({
        title: t.title || "بدون عنوان",
        url: t.permalink_url,
        source: "SoundCloud",
        duration: fmtDuration(t.duration),
        uploader: t.user?.username || "",
      }),
    ];
  });
}
