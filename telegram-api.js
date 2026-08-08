// telegram-api.js — عميل خفيف لـ Telegram Bot API عبر fetch المدمج في Bun
// بديل telegram_api.py (aiohttp) — بدون أي تبعية Python.
import { basename } from "node:path";
import { getLogger } from "./lib/logger.js";

const logger = getLogger("telegram_api");

export class TelegramError extends Error {}

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

export function sanitizeFilename(name, maxLen = 150) {
  if (!name) return "file";
  name = basename(name);
  name = name.replace(INVALID_FILENAME_CHARS, "_");
  name = name.trim().replace(/^\.+|\.+$/g, "");
  return (name || "file").slice(0, maxLen);
}

export class Bot {
  constructor(token) {
    this.token = token;
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
  }

  async _call(method, params = {}) {
    const payload = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) payload[k] = v;
    }
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // لا نفترض أن الرد دائماً JSON صالح — انقطاع تيليجرام، صفحة خطأ من بروكسي/WAF،
    // أو تحديد معدل (rate limit) قد يُرجع HTML أو نصاً عادياً. تحليل JSON مباشرة
    // بدون هذا الفحص يرمي SyntaxError غير مُلتقَطة تُسقط hoisted-caller بلا رسالة
    // واضحة (وقد تُسقط bootstrap() بالكامل عند إقلاع البوت عبر setWebhook).
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new TelegramError(
        `[${method}] رد غير صالح من تيليجرام (HTTP ${res.status}): ${raw.slice(0, 200) || "(فارغ)"}`
      );
    }
    if (!res.ok || !data.ok) {
      throw new TelegramError(`[${method}] ${data.description || `HTTP ${res.status}: ${JSON.stringify(data)}`}`);
    }
    return data.result;
  }

  // ── رسائل نصية ──
  async sendMessage(chatId, text, { replyMarkup, parseMode } = {}) {
    return this._call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
      parse_mode: parseMode,
    });
  }

  async editMessageText(chatId, messageId, text, { replyMarkup, parseMode } = {}) {
    try {
      return await this._call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: replyMarkup,
        parse_mode: parseMode,
      });
    } catch (e) {
      if (String(e.message).includes("not modified")) return null;
      throw e;
    }
  }

  async deleteMessage(chatId, messageId) {
    try {
      return await this._call("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch {
      logger.warning(`[delete_message] فشل حذف الرسالة ${messageId} في ${chatId}`);
      return null;
    }
  }

  async answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    try {
      return await this._call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert,
      });
    } catch {
      logger.warning("[answer_callback_query] فشل — على الأرجح انتهت صلاحية الاستعلام");
      return null;
    }
  }

  async sendPhoto(chatId, photo, caption) {
    return this._call("sendPhoto", { chat_id: chatId, photo, caption });
  }

  // ── ملفات (multipart) ──
  async _sendFile(method, field, chatId, filePath, { filename, caption, extraFields } = {}) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption);
    for (const [k, v] of Object.entries(extraFields || {})) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    const fname = sanitizeFilename(filename || basename(filePath));
    const file = Bun.file(filePath);
    form.append(field, file, fname);

    const res = await fetch(`${this.apiBase}/${method}`, { method: "POST", body: form });
    const data = await res.json();
    if (!data.ok) throw new TelegramError(`[${method}] ${data.description || JSON.stringify(data)}`);
    return data.result;
  }

  async sendDocument(chatId, filePath, { filename, caption } = {}) {
    return this._sendFile("sendDocument", "document", chatId, filePath, { filename, caption });
  }

  // ── إعادة إرسال فورية عبر file_id مخزَّن بالكاش ──
  async sendCachedVideo(chatId, fileId, caption) {
    return this._call("sendVideo", { chat_id: chatId, video: fileId, caption });
  }

  async sendCachedAudio(chatId, fileId, caption, title) {
    return this._call("sendAudio", { chat_id: chatId, audio: fileId, caption, title });
  }

  async sendCachedDocument(chatId, fileId, caption) {
    return this._call("sendDocument", { chat_id: chatId, document: fileId, caption });
  }

  async sendAudio(chatId, filePath, { title, caption } = {}) {
    return this._sendFile("sendAudio", "audio", chatId, filePath, {
      caption,
      extraFields: { title },
    });
  }

  async sendVideo(chatId, filePath, { caption } = {}) {
    return this._sendFile("sendVideo", "video", chatId, filePath, { caption });
  }

  // ── تنزيل ملفات مُرسَلة من المستخدم (لـ shazam/lyrics) ──
  async downloadFile(fileId, destPath) {
    const info = await this._call("getFile", { file_id: fileId });
    const tgPath = info.file_path;
    const res = await fetch(`${this.fileBase}/${tgPath}`);
    if (!res.ok) throw new TelegramError(`تعذّر تنزيل الملف: HTTP ${res.status}`);
    await Bun.write(destPath, res);
    return destPath;
  }

  // ── إقلاع ──
  async setWebhook(url) {
    return this._call("setWebhook", { url });
  }
}

// ══════════════════════════════════════════════
// فلاتر بسيطة على كائنات رسائل تيليجرام الخام
// ══════════════════════════════════════════════
export function isCommand(msg) {
  return !!(msg.text || "").startsWith("/");
}

export function isPlainText(msg) {
  return "text" in msg && !isCommand(msg);
}

export function isVoice(msg) {
  return "voice" in msg;
}

export function isAudio(msg) {
  return "audio" in msg;
}

export function isVideo(msg) {
  return "video" in msg;
}

export function isVideoNote(msg) {
  return "video_note" in msg;
}

export function isRecognizableMedia(msg) {
  return isVoice(msg) || isAudio(msg) || isVideo(msg) || isVideoNote(msg);
}

export function commandName(msg) {
  const text = msg.text || "";
  const first = text.split(/\s+/)[0] || "";
  return first.slice(1).split("@")[0].toLowerCase();
}

export function commandArgs(msg) {
  const text = msg.text || "";
  const idx = text.indexOf(" ");
  return idx === -1 ? "" : text.slice(idx + 1).trim();
}
