// cache.js — طبقة كاش الوسائط: هاش قصير للرابط ↔ Telegram file_id (بديل cache.py)
// SQLite (bun:sqlite المدمجة في Bun) افتراضياً، Redis اختياري عبر REDIS_URL.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getLogger } from "./lib/logger.js";

const logger = getLogger("cache");

export function shortHash(text, length = 8) {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, length);
}

// ══════════════════════════════════════════════
// 🗄️ SQLite backend — الافتراضي
// ══════════════════════════════════════════════
class SQLiteCache {
  constructor(path, ttlSeconds) {
    this.ttlSeconds = ttlSeconds;
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS media_cache (
      key        TEXT PRIMARY KEY,
      file_id    TEXT NOT NULL,
      media_type TEXT NOT NULL,
      title      TEXT,
      created_at REAL NOT NULL
    )`);
  }

  async get(key) {
    const row = this.db
      .query("SELECT file_id, media_type, title, created_at FROM media_cache WHERE key = ?")
      .get(key);
    if (!row) return null;
    if (this.ttlSeconds && Date.now() / 1000 - row.created_at > this.ttlSeconds) {
      this.db.query("DELETE FROM media_cache WHERE key = ?").run(key);
      return null;
    }
    return {
      fileId: row.file_id,
      mediaType: row.media_type,
      title: row.title || "",
      createdAt: row.created_at,
    };
  }

  async set(key, media) {
    this.db
      .query(
        `INSERT INTO media_cache (key, file_id, media_type, title, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           file_id=excluded.file_id, media_type=excluded.media_type,
           title=excluded.title, created_at=excluded.created_at`
      )
      .run(key, media.fileId, media.mediaType, media.title, media.createdAt);
  }

  async close() {
    this.db.close();
  }

  async clearAll() {
    const row = this.db.query("SELECT COUNT(*) as c FROM media_cache").get();
    const count = row ? row.c : 0;
    this.db.exec("DELETE FROM media_cache");
    return count;
  }
}

// ══════════════════════════════════════════════
// 🚀 Redis backend — اختياري (ioredis، متوافقة مع Bun)
// ══════════════════════════════════════════════
class RedisCache {
  constructor(url, ttlSeconds) {
    this.url = url;
    this.ttlSeconds = ttlSeconds;
    this.r = null;
  }

  async init() {
    const { default: Redis } = await import("ioredis");
    this.r = new Redis(this.url, { lazyConnect: true });
    await this.r.connect();
    await this.r.ping();
  }

  async get(key) {
    const raw = await this.r.get(`mediacache:${key}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async set(key, media) {
    const payload = JSON.stringify(media);
    if (this.ttlSeconds) {
      await this.r.set(`mediacache:${key}`, payload, "EX", this.ttlSeconds);
    } else {
      await this.r.set(`mediacache:${key}`, payload);
    }
  }

  async close() {
    if (this.r) await this.r.quit();
  }

  async clearAll() {
    let count = 0;
    let cursor = "0";
    do {
      const [next, keys] = await this.r.scan(cursor, "MATCH", "mediacache:*", "COUNT", 100);
      cursor = next;
      if (keys.length) {
        await this.r.del(...keys);
        count += keys.length;
      }
    } while (cursor !== "0");
    return count;
  }
}

// ══════════════════════════════════════════════
// 🎛️ نقطة دخول واحدة يستخدمها main.js
// ══════════════════════════════════════════════
let backend = null;
let enabled = true;

export async function initCache(cfg) {
  enabled = !!cfg.CACHE_ENABLED;
  if (!enabled) {
    logger.info("⏸️ الكاش مُعطَّل عبر CACHE_ENABLED=false");
    return;
  }

  if (cfg.REDIS_URL) {
    try {
      const b = new RedisCache(cfg.REDIS_URL, cfg.CACHE_TTL);
      await b.init();
      backend = b;
      logger.info("✅ Redis backend نشط — مناسب للتشغيل متعدد النسخ");
      return;
    } catch (e) {
      logger.warning(`⚠️ تعذّر الاتصال بـ Redis (${e.message}) — التراجع إلى SQLite`);
    }
  }

  backend = new SQLiteCache(cfg.CACHE_DB_PATH, cfg.CACHE_TTL);
  logger.info(`✅ SQLite backend نشط — ${cfg.CACHE_DB_PATH}`);
}

export async function getCached(urlHash, qualityKey) {
  if (!enabled || !backend) return null;
  try {
    return await backend.get(`${urlHash}:${qualityKey}`);
  } catch (e) {
    logger.exception("فشل قراءة الكاش — سيُتابَع التحميل العادي", e);
    return null;
  }
}

export async function setCached(urlHash, qualityKey, fileId, mediaType, title) {
  if (!enabled || !backend) return;
  try {
    await backend.set(`${urlHash}:${qualityKey}`, {
      fileId,
      mediaType,
      title,
      createdAt: Date.now() / 1000,
    });
  } catch (e) {
    logger.exception("فشل تخزين النتيجة بالكاش — لن يؤثر على إرسال هذا الطلب", e);
  }
}

export async function closeCache() {
  if (backend) {
    await backend.close();
    backend = null;
  }
}

export async function clearAllCache() {
  if (!enabled || !backend) return -1;
  return await backend.clearAll();
}
