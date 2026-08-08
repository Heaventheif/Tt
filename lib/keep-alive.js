// lib/keep-alive.js — يُبقي APIs الخارجية (Render/Heroku) مستيقظة
// بإرسال ping دوري كل 10 دقائق لمنعها من الدخول في وضع السكون.
import { getLogger } from "./logger.js";

const logger = getLogger("keep-alive");

const PING_INTERVAL_MS = 10 * 60 * 1000; // كل 10 دقائق

/**
 * يرسل ping لقائمة URLs ويسجّل النتيجة.
 * @param {string[]} urls - قائمة بعناوين الـ APIs
 */
export function startKeepAlive(urls) {
  if (!urls || urls.length === 0) return;

  const validUrls = urls.filter(Boolean);
  if (!validUrls.length) return;

  logger.info(`[keep-alive] 🏃 بدء إبقاء ${validUrls.length} API مستيقظة`);

  async function pingAll() {
    for (const url of validUrls) {
      try {
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(10000),
        });
        logger.debug(`[keep-alive] ✅ ping ناجح: ${url} (${res.status})`);
      } catch (e) {
        // فشل الـ ping لا يوقف البوت — فقط تسجيل تحذير
        logger.warning(`[keep-alive] ⚠️ ping فشل: ${url} — ${e.message}`);
      }
    }
  }

  // ping فوري عند الإقلاع لإيقاظ الخوادم قبل أول استخدام
  pingAll();

  // ثم ping دوري
  setInterval(pingAll, PING_INTERVAL_MS);
}
