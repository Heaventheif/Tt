# بوت تيليجرام لتحميل الوسائط — Pure JavaScript على Bun

تحويل كامل من Python (Sanic + yt-dlp + Docker) إلى **JavaScript خالص يعمل على Bun**،
بدون Docker وبدون أي كود Python.

## البنية

```
config.js            إعدادات (متغيرات البيئة)
cache.js              كاش الوسائط — bun:sqlite (أو Redis عبر REDIS_URL)
telegram-api.js       عميل Telegram Bot API عبر fetch
plugin-loader.js      يكتشف plugins/*.js تلقائياً + أدوات مشتركة (ffmpeg/ffprobe...)
main.js               نقطة الدخول — Bun.serve (webhook) + التوجيه
lib/logger.js         تسجيل بسيط
plugins/              📁 مجلد الأوامر — كل ملف = أمر/منصة مستقلة
```

## 🧩 مجلد `plugins/` — أوامر قابلة للحذف الفوري

كل ملف داخل `plugins/` مستقل تماماً. **حذف أي ملف يعطّل ذلك الأمر فوراً بدون
تعديل أي ملف آخر** — `plugin-loader.js` يفحص المجلد ديناميكياً في كل إقلاع،
لا توجد قائمة ثابتة بالأسماء في أي مكان.

| الملف | ماذا يفعل |
|---|---|
| `youtube.js` | يوتيوب (@vreden/youtube_scraper + ccproject + yt2) |
| `tiktok.js` | تيك توك (TikWM + TikMate) |
| `instagram.js` | انستغرام (@mrnima/instagram-downloader أولاً، @xncn/instadownloader احتياطي — بدون ferdev) |
| `facebook.js` | فيسبوك (facebook-video-download-api + ferdev احتياطي) |
| `soundcloud.js` | ساوندكلاود (streaming مباشر) |
| `search_youtube.js` | بحث بالاسم عبر YouTube (مكتبة `yt-search`) |
| `search_soundcloud.js` | بحث بالاسم عبر SoundCloud |
| `lyrics.js` | أمر `/lyrics` |
| `shazam.js` | التعرف على الأغاني (AudD.io) |
| `media_tools.js` | قائمة أدوات الوسائط المباشرة (شازام/كلمات/تحويل/قص/VTT) |
| `generic.js` | fallback عام (تويتر/X حالياً — انظر التعليق أعلى الملف) |

**لإضافة أمر جديد:** أنشئ ملف `plugins/xyz.js` جديد يُصدّر الشكل المناسب (راجع
التعليق التوضيحي أعلى `plugin-loader.js`). لا حاجة لتعديل أي ملف آخر إلا إن
احتجت مكتبة npm جديدة — عندها فقط أضِفها إلى `package.json`.

## ⚠️ ملاحظة هامة: لا يوجد yt-dlp

تم استبدال yt-dlp بالكامل بمزودات API/مكتبات JS (راجع تعليقات كل ملف). هذا
يعني أن بعض المواقع النادرة التي كانت مدعومة عبر yt-dlp (Bilibili, Twitch,
Reddit, ...) **لم تعد مدعومة تلقائياً** — أضِف ملف plugin مخصص لأي موقع
إضافي تحتاجه بنفس نمط `instagram.js`/`tiktok.js`.

## 🔑 متغيرات البيئة

```
TELEGRAM_TOKEN=              (إلزامي)
SERVER_URL=                  (إلزامي — رابط الخدمة على Render، بدون / في النهاية)
PORT=10000
WEBHOOK_PATH=/webhook

MAX_CONCURRENT_DOWNLOADS=2
UPLOAD_LIMIT_MB=50
PENDING_TTL_MIN=30
SEARCH_PENDING_TTL_MIN=15
RATE_LIMIT_SECONDS=3
MAX_CLIP_DURATION_SECONDS=600
ADMIN_CHAT_IDS=

CACHE_DB_PATH=media_cache.sqlite
REDIS_URL=
CACHE_TTL_DAYS=30
CACHE_HASH_LEN=8
CACHE_ENABLED=true

YT_API_1=https://ccproject.serv00.net/ytdl2.php
YT_API_2=https://yt-dlp-stream.onrender.com/api
FB_DOWNLOAD_API=https://facebook-video-download-api.onrender.com
FERDEV_API_KEY=              (انستغرام/فيسبوك الاحتياطي/تويتر — سجّل من api.ferdev.my.id/register)

LYRICS_API=https://api.lyrics.ovh/v1
GROQ_API_KEY=                (لترجمة VTT عبر Groq Whisper)
AUDD_API_KEY=                (للتعرف على الأغاني — سجّل مجاناً من audd.io)

LOG_LEVEL=INFO
```

## 🚀 النشر على Render — بدون Docker

عند إنشاء الخدمة على Render:

1. اختر **Native Environment** (وليس Docker).
2. **Runtime**: إن لم يكن Bun متاحاً كخيار native مباشر، ثبّته عبر Build Command:
   ```
   curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH" && bun install
   ```
   وإلا يكفي:
   ```
   bun install
   ```
3. **Start Command**:
   ```
   bun run main.js
   ```
4. **ffmpeg/ffprobe**: مطلوبان على النظام (للقص/التحويل/التقسيم). إن لم يكونا
   متوفرين افتراضياً على بيئة Render Native، أضِف تثبيتهما إلى Build Command
   (مثلاً عبر apt إن كانت البيئة تسمح، أو استخدم إضافة "Native Runtime" التي
   توفر ffmpeg مسبقاً).
5. أضِف كل متغيرات البيئة أعلاه من تبويب **Environment**.

## 🖥️ التشغيل محلياً

```bash
bun install
cp .env.example .env   # ثم عدّل القيم
bun run main.js
```
