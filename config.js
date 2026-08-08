// config.js — مصدر واحد للحقيقة لكل متغيرات البيئة (بديل config.py)
// يُستخدم من كل مكان في المشروع: import { config } from "../config.js"

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function int(name, def) {
  const v = process.env[name];
  return v === undefined ? def : parseInt(v, 10);
}

function float(name, def) {
  const v = process.env[name];
  return v === undefined ? def : parseFloat(v);
}

const CACHE_TTL_DAYS = int("CACHE_TTL_DAYS", 30);

export const config = {
  // 🤖 Telegram / Webhook
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || "",
  SERVER_URL: (process.env.SERVER_URL || "").replace(/\/+$/, ""),
  PORT: int("PORT", 10000),
  WEBHOOK_PATH: process.env.WEBHOOK_PATH || "/webhook",

  // ⚙️ حدود التشغيل العامة
  MAX_CONCURRENT_DOWNLOADS: int("MAX_CONCURRENT_DOWNLOADS", 2),
  UPLOAD_LIMIT_MB: int("UPLOAD_LIMIT_MB", 50),
  get UPLOAD_LIMIT() {
    return this.UPLOAD_LIMIT_MB * 1024 * 1024;
  },

  PENDING_TTL_MIN: int("PENDING_TTL_MIN", 30),
  SEARCH_PENDING_TTL_MIN: int("SEARCH_PENDING_TTL_MIN", 15),

  // 🚦 حد أدنى بالثواني بين كل رسالة/أمر من نفس chat_id
  RATE_LIMIT_SECONDS: float("RATE_LIMIT_SECONDS", 3),

  // ✂️ حد أقصى لمدة "تنزيل جزء محدد بالوقت" (بالثواني)
  MAX_CLIP_DURATION_SECONDS: int("MAX_CLIP_DURATION_SECONDS", 600),

  // 🔐 chat_id المخوَّلة لأوامر الإدارة، مفصولة بفواصل
  ADMIN_CHAT_IDS: (process.env.ADMIN_CHAT_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x))
    .map((x) => parseInt(x, 10)),

  // 🗄️ طبقة الكاش (media_cache) — bun:sqlite افتراضياً، Redis اختياري
  CACHE_DB_PATH: process.env.CACHE_DB_PATH || "media_cache.sqlite",
  REDIS_URL: (process.env.REDIS_URL || "").trim() || null,
  CACHE_TTL_DAYS,
  CACHE_TTL: CACHE_TTL_DAYS > 0 ? CACHE_TTL_DAYS * 86400 : null,
  CACHE_HASH_LEN: int("CACHE_HASH_LEN", 8),
  CACHE_ENABLED: bool("CACHE_ENABLED", true),

  // 🔌 مفاتيح/روابط الـ APIs الخارجية المستخدمة من الـ plugins
  YT_API_1: process.env.YT_API_1 || "https://ccproject.serv00.net/ytdl2.php",
  YT_API_2: process.env.YT_API_2 || "https://yt-dlp-stream.onrender.com/api",
  FB_DOWNLOAD_API:
    process.env.FB_DOWNLOAD_API ||
    "https://betadash-api-swordslush-production.up.railway.app",
  FB_DOWNLOAD_API_OLD:
    process.env.FB_DOWNLOAD_API_OLD ||
    "https://facebook-video-download-api.onrender.com",
  FERDEV_API_KEY: (process.env.FERDEV_API_KEY || "").trim(),

  LYRICS_API: process.env.LYRICS_API || "https://api.lyrics.ovh/v1",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  // 🎵 التعرف على الأغاني (بديل shazamio) — AudD.io، مفتاح مجاني عبر audd.io
  AUDD_API_KEY: (process.env.AUDD_API_KEY || "").trim(),

  // 📝 تسجيل الأحداث
  LOG_LEVEL: (process.env.LOG_LEVEL || "INFO").toUpperCase(),

  /** يتحقق من وجود المتغيرات الإلزامية عند الإقلاع */
  validate() {
    const missing = ["TELEGRAM_TOKEN", "SERVER_URL"].filter((n) => !this[n]);
    if (missing.length) {
      console.error(`❌ متغيرات بيئة إلزامية ناقصة: ${missing.join(", ")} — راجع .env.example`);
      process.exit(1);
    }
    if (this.MAX_CONCURRENT_DOWNLOADS < 1) {
      console.warn("⚠️ MAX_CONCURRENT_DOWNLOADS < 1 — سيُستخدم 1 كحد أدنى آمن");
      this.MAX_CONCURRENT_DOWNLOADS = 1;
    }
  },
};
