import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import multer from "multer";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
// nginx on the same host is the only proxy in front of the app.
app.set("trust proxy", "loopback");

const port = Number(process.env.PORT) || 3030;
const host = process.env.HOST || "127.0.0.1";
const shopName = process.env.SHOP_NAME || "PrintPoint";
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const retentionDays = Number(process.env.RETENTION_DAYS) || 30;
const statsTimeZone = process.env.STATS_TIMEZONE || "Europe/Luxembourg";

const MIN_COPIES = 4;
const MAX_COPIES = 100;
const MAX_PAGES = 50;
const BULK_THRESHOLD = 10;
// Keep in sync with RATES in public/app.js; the server value is the one recorded on the order.
const RATES_CENTS = {
  "black-white": { standard: 50, bulk: 30 },
  color: { standard: 60, bulk: 40 }
};
const MAX_PHONE_LENGTH = 40;
const MAX_LOCATION_LENGTH = 300;
const TELEGRAM_CAPTION_LIMIT = 1024;
const PENDING_PHOTO_TTL_MINUTES = 30;
const DELETED_MARK = "[deleted]";
const EMAIL_PATTERN = /^[^\s@,;:<>()[\]"'\\]+@[^\s@,;:<>()[\]"'\\]+\.[^\s@,;:<>()[\]"'\\]{2,}$/;

class UserError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "orders.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_code TEXT NOT NULL UNIQUE,
    customer_email TEXT NOT NULL,
    copies INTEGER NOT NULL,
    print_mode TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    payment_proof_name TEXT,
    phone TEXT,
    location TEXT,
    pages INTEGER,
    price_cents INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name);
for (const [column, type] of [
  ["payment_proof_name", "TEXT"],
  ["phone", "TEXT"],
  ["location", "TEXT"],
  ["pages", "INTEGER"],
  ["price_cents", "INTEGER"]
]) {
  if (!orderColumns.includes(column)) {
    db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${type}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_photo_requests (
    chat_id TEXT PRIMARY KEY,
    order_code TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

function sqlTimestamp(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function priceCents(totalPages, printMode) {
  const rates = RATES_CENTS[printMode];
  const standardPages = Math.min(totalPages, BULK_THRESHOLD);
  const extraPages = Math.max(0, totalPages - BULK_THRESHOLD);
  return standardPages * rates.standard + extraPages * rates.bulk;
}

function formatPrice(cents) {
  return `€${(cents / 100).toFixed(2)}`;
}

function formatMode(mode) {
  return mode === "color" ? "Color" : "Black & white";
}

// Fixed-window counter kept in memory; entries expire with their window and the map is capped.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 10 * 60 * 1000));
  sweep.unref();

  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (hits.size >= 50000) hits.clear();
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

const allowOrderFromIp = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ORDER_RATE_LIMIT) || 8
});
const allowOrderGlobally = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: Number(process.env.ORDER_DAILY_LIMIT) || 200
});
const allowVisitFromIp = createRateLimiter({ windowMs: 30 * 60 * 1000, max: 1 });

function orderRateLimit(req, _res, next) {
  if (!allowOrderFromIp(req.ip) || !allowOrderGlobally("all")) {
    next(new UserError("too_many_requests", "Too many requests. Please try again in a few minutes.", 429));
    return;
  }
  next();
}

const resumeExtensions = new Set([".pdf", ".doc", ".docx"]);
const proofExtensions = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);

const FILE_SIGNATURES = {
  ".doc": Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
  ".docx": Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  ".jpg": Buffer.from([0xff, 0xd8, 0xff]),
  ".jpeg": Buffer.from([0xff, 0xd8, 0xff]),
  ".png": Buffer.from([0x89, 0x50, 0x4e, 0x47])
};

function hasValidSignature(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const head = Buffer.alloc(1024);
  const descriptor = fs.openSync(filePath, "r");
  const length = fs.readSync(descriptor, head, 0, head.length, 0);
  fs.closeSync(descriptor);
  const bytes = head.subarray(0, length);

  if (extension === ".pdf") return bytes.includes("%PDF-");
  if (extension === ".webp") {
    return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  }
  const signature = FILE_SIGNATURES[extension];
  return Boolean(signature) && bytes.subarray(0, signature.length).equals(signature);
}

// multer hands over non-ASCII filenames as latin1 bytes.
function decodeFilename(name) {
  return Buffer.from(name, "latin1").toString("utf8").slice(0, 200);
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 2, fields: 12, fieldSize: 2048 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === "paymentProof") {
      if (proofExtensions.has(extension)) return cb(null, true);
      return cb(new UserError("file_type", "Payment proof must be a PDF, JPG, PNG, or WEBP file."));
    }
    if (resumeExtensions.has(extension)) return cb(null, true);
    return cb(new UserError("file_type", "Please upload a PDF, DOC, or DOCX file."));
  }
});

function isConfigured() {
  return Boolean(
    process.env.GMAIL_USER &&
    process.env.GMAIL_APP_PASSWORD &&
    process.env.PRINT_SHOP_EMAIL
  );
}

function makeTransporter() {
  const override = process.env.MAIL_TRANSPORT;
  if (override === "json") return nodemailer.createTransport({ jsonTransport: true });
  if (override) return nodemailer.createTransport(override);
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

function mailFrom() {
  return `"${shopName}" <${process.env.GMAIL_USER}>`;
}

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function telegramApi(method, body) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
  const options = body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(url, options);
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(`Telegram ${method} failed with status ${response.status}`);
  }
  return result.result;
}

async function sendTelegramDocument({ filePath, filename, caption, replyMarkup }) {
  const form = new FormData();
  form.append("chat_id", process.env.TELEGRAM_CHAT_ID);
  form.append("caption", caption.slice(0, TELEGRAM_CAPTION_LIMIT));
  form.append("document", new Blob([fs.readFileSync(filePath)]), filename);
  if (replyMarkup) {
    form.append("reply_markup", JSON.stringify(replyMarkup));
  }
  await telegramApi("sendDocument", form);
}

async function notifyAdmin(text) {
  try {
    await telegramApi("sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, text });
  } catch (error) {
    console.error("Could not send Telegram message:", error.message);
  }
}

async function answerTelegramCallback(callbackQueryId, text) {
  try {
    await telegramApi("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  } catch (error) {
    console.error("Could not answer Telegram callback:", error.message);
  }
}

async function downloadTelegramFile(fileId) {
  const file = await telegramApi("getFile", { file_id: fileId });
  const response = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!response.ok) throw new Error("Could not download Telegram file");
  return Buffer.from(await response.arrayBuffer());
}

async function registerTelegramWebhook() {
  if (!isTelegramConfigured() || !process.env.PUBLIC_URL) return;
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
    console.error("TELEGRAM_WEBHOOK_SECRET is not set: Telegram buttons and commands are disabled.");
    return;
  }
  try {
    await telegramApi("setWebhook", {
      url: `${process.env.PUBLIC_URL}/api/telegram-webhook`,
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET
    });
    await telegramApi("setMyCommands", {
      commands: [
        { command: "stats", description: "Show website visits vs orders" },
        { command: "skip", description: "Send the 'ready' email without a photo" }
      ]
    });
  } catch (error) {
    console.error("Failed to register Telegram webhook:", error.message);
  }
}

function startOfTodayUtc() {
  const now = new Date();
  try {
    const local = new Date(now.toLocaleString("en-US", { timeZone: statsTimeZone }));
    const offsetMs = Math.round((local.getTime() - now.getTime()) / 60000) * 60000;
    local.setHours(0, 0, 0, 0);
    return new Date(local.getTime() - offsetMs);
  } catch (error) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}

function getVisitStats() {
  const count = (table, since) => (since
    ? db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE created_at >= ?`).get(since).count
    : db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);

  const today = sqlTimestamp(startOfTodayUtc());
  const weekAgo = sqlTimestamp(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

  return {
    today: { visits: count("page_views", today), orders: count("orders", today) },
    last7Days: { visits: count("page_views", weekAgo), orders: count("orders", weekAgo) },
    total: { visits: count("page_views"), orders: count("orders") }
  };
}

const AUTOMATED_NOTE = "This is an automated message, please do not reply.";

const ORDER_STATUSES = {
  printing: {
    label: "Printing",
    subject: (orderCode) => `Update on your print order ${orderCode}`,
    body: (orderCode) => [
      `Good news — we've started printing your order ${orderCode}.`,
      `We'll let you know as soon as it's ready.`,
      ``,
      AUTOMATED_NOTE
    ].join("\n")
  },
  delivery: {
    label: "Delivery",
    subject: (orderCode) => `Your print order ${orderCode} is out for delivery`,
    body: (orderCode) => [`Your order ${orderCode} is on its way to you.`, ``, AUTOMATED_NOTE].join("\n")
  },
  ready: {
    label: "Order ready",
    subject: (orderCode) => `Your print order ${orderCode} is ready!`,
    body: (orderCode) => [`Your order ${orderCode} has been printed and is ready.`, ``, AUTOMATED_NOTE].join("\n")
  }
};

async function sendReadyEmail(customerEmail, orderCode, photoBuffer) {
  const mail = {
    from: mailFrom(),
    to: customerEmail,
    subject: ORDER_STATUSES.ready.subject(orderCode),
    text: ORDER_STATUSES.ready.body(orderCode)
  };
  if (photoBuffer) {
    mail.html = [
      `<p>Your order ${orderCode} has been printed and is ready.</p>`,
      `<p>Here's where to pick it up:</p>`,
      `<p><img src="cid:pickup-location" alt="Pickup location" style="max-width:100%;height:auto;" /></p>`,
      `<p style="color:#888;font-size:12px;">${AUTOMATED_NOTE}</p>`
    ].join("\n");
    mail.attachments = [{ filename: "pickup-location.jpg", content: photoBuffer, cid: "pickup-location" }];
  }
  await makeTransporter().sendMail(mail);
}

function findOrderContact(orderCode) {
  const order = db.prepare("SELECT customer_email FROM orders WHERE order_code = ?").get(orderCode);
  if (!order) return { error: "Order not found." };
  if (order.customer_email === DELETED_MARK) {
    return { error: `Customer data was deleted (older than ${retentionDays} days).` };
  }
  return { email: order.customer_email };
}

function setPendingPhotoRequest(chatId, orderCode) {
  db.prepare(`
    INSERT INTO pending_photo_requests (chat_id, order_code, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET order_code = excluded.order_code, created_at = excluded.created_at
  `).run(String(chatId), orderCode);
}

function takePendingPhotoRequest(chatId) {
  const row = db.prepare(`
    SELECT order_code FROM pending_photo_requests
    WHERE chat_id = ? AND created_at >= datetime('now', ?)
  `).get(String(chatId), `-${PENDING_PHOTO_TTL_MINUTES} minutes`);
  db.prepare("DELETE FROM pending_photo_requests WHERE chat_id = ?").run(String(chatId));
  return row ? row.order_code : null;
}

async function completeReadyRequest(chatId, photo) {
  const orderCode = takePendingPhotoRequest(chatId);
  if (!orderCode) {
    await notifyAdmin(`No order is waiting for a photo. Tap "Order ready" on the order first.`);
    return;
  }
  const contact = findOrderContact(orderCode);
  if (contact.error) {
    await notifyAdmin(`${orderCode}: ${contact.error}`);
    return;
  }
  try {
    const photoBuffer = photo ? await downloadTelegramFile(photo.file_id) : null;
    await sendReadyEmail(contact.email, orderCode, photoBuffer);
    await notifyAdmin(`✅ Client notified: Order ready ${orderCode}${photo ? " (with pickup photo)" : ""}`);
  } catch (error) {
    console.error("Could not send ready email:", error);
    await notifyAdmin(`Failed to send the "ready" email for ${orderCode} — tap "Order ready" again to retry.`);
  }
}

async function handleStatusButton(callbackQuery, chatId) {
  const [action, orderCode] = String(callbackQuery.data || "").split(":");
  if (!Object.hasOwn(ORDER_STATUSES, action) || !orderCode) return;
  const status = ORDER_STATUSES[action];

  const contact = findOrderContact(orderCode);
  if (contact.error) {
    await answerTelegramCallback(callbackQuery.id, contact.error);
    return;
  }
  if (!isConfigured()) {
    await answerTelegramCallback(callbackQuery.id, "Email is not configured.");
    return;
  }

  if (action === "ready") {
    setPendingPhotoRequest(chatId, orderCode);
    await notifyAdmin(
      `📸 Send a photo of the pickup location for order ${orderCode} within ${PENDING_PHOTO_TTL_MINUTES} minutes — ` +
      `I'll include it in the "ready" email. Or send /skip to notify the customer without a photo.`
    );
    await answerTelegramCallback(callbackQuery.id, "Send the pickup photo now.");
    return;
  }

  try {
    await makeTransporter().sendMail({
      from: mailFrom(),
      to: contact.email,
      subject: status.subject(orderCode),
      text: status.body(orderCode)
    });
    await answerTelegramCallback(callbackQuery.id, `✅ Client notified: ${status.label}`);
  } catch (error) {
    console.error("Could not send status email:", error);
    await answerTelegramCallback(callbackQuery.id, "Failed to notify client — check server logs.");
  }
}

async function handleTelegramUpdate(update) {
  const message = update?.message;
  const callbackQuery = update?.callback_query;
  const chatId = message?.chat?.id ?? callbackQuery?.message?.chat?.id;
  if (chatId === undefined || String(chatId) !== String(process.env.TELEGRAM_CHAT_ID)) return;

  if (callbackQuery) {
    await handleStatusButton(callbackQuery, chatId);
    return;
  }

  if (message?.photo?.length) {
    await completeReadyRequest(chatId, message.photo[message.photo.length - 1]);
    return;
  }

  const command = typeof message?.text === "string" ? message.text.trim().split("@")[0] : "";
  if (command === "/skip") {
    await completeReadyRequest(chatId, null);
    return;
  }
  if (command === "/stats") {
    const stats = getVisitStats();
    const line = (label, { visits, orders }) =>
      `${label}: ${visits} visited, ${orders} ordered, ${Math.max(0, visits - orders)} didn't order`;
    await notifyAdmin(
      [
        `📊 Website visits vs orders`,
        line("Today", stats.today),
        line("Last 7 days", stats.last7Days),
        line("All time", stats.total)
      ].join("\n")
    );
  }
}

function isAuthorizedWebhook(req) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return false;
  const received = Buffer.from(req.get("X-Telegram-Bot-Api-Secret-Token") || "");
  const expected = Buffer.from(secret);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// Anonymises old orders and deletes their files; also removes uploads that no order refers to.
function runRetention() {
  try {
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    db.prepare(`
      UPDATE orders
      SET customer_email = ?, phone = NULL, location = NULL, original_name = ?
      WHERE created_at < ? AND customer_email != ?
    `).run(DELETED_MARK, DELETED_MARK, sqlTimestamp(new Date(cutoffMs)), DELETED_MARK);

    const referenced = new Set();
    for (const row of db.prepare("SELECT stored_name, payment_proof_name FROM orders").all()) {
      referenced.add(row.stored_name);
      if (row.payment_proof_name) referenced.add(row.payment_proof_name);
    }
    const orphanCutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(uploadDir)) {
      const filePath = path.join(uploadDir, name);
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
      const expired = stats.mtimeMs < cutoffMs;
      const orphaned = !referenced.has(name) && stats.mtimeMs < orphanCutoffMs;
      if (expired || orphaned) fs.rmSync(filePath, { force: true });
    }

    db.prepare("DELETE FROM pending_photo_requests WHERE created_at < datetime('now', '-1 day')").run();
  } catch (error) {
    console.error("Retention cleanup failed:", error);
  }
}

app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=15552000",
    "Content-Security-Policy": [
      "default-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; ")
  });
  next();
});

app.post("/api/track-visit", (req, res) => {
  if (allowVisitFromIp(req.ip)) {
    db.prepare("INSERT INTO page_views DEFAULT VALUES").run();
  }
  res.sendStatus(204);
});

const OG_TRANSLATIONS = {
  en: { title: "Print Point — Resume printing", description: "Attach your resume, choose copies & color, pay, and get it printed.", locale: "en_US" },
  zh: { title: "Print Point — 简历打印", description: "上传简历，选择份数与颜色，付款后即可完成打印。", locale: "zh_CN" },
  hi: { title: "Print Point — रिज़्यूमे प्रिंटिंग", description: "अपना रिज़्यूमे अटैच करें, प्रतियाँ और रंग चुनें, भुगतान करें और प्रिंट करवाएँ।", locale: "hi_IN" },
  es: { title: "Print Point — Impresión de currículums", description: "Adjunta tu currículum, elige copias y color, paga y recíbelo impreso.", locale: "es_ES" },
  fr: { title: "Print Point — Impression de CV", description: "Joignez votre CV, choisissez le nombre de copies et la couleur, payez, et faites-le imprimer.", locale: "fr_FR" },
  ar: { title: "Print Point — طباعة السيرة الذاتية", description: "أرفق سيرتك الذاتية، اختر عدد النسخ واللون، ادفع، واحصل على طباعتها.", locale: "ar_AR" },
  bn: { title: "Print Point — রিজিউমি প্রিন্টিং", description: "আপনার রিজিউমি সংযুক্ত করুন, কপি ও রং নির্বাচন করুন, পেমেন্ট করুন এবং প্রিন্ট করিয়ে নিন।", locale: "bn_BD" },
  pt: { title: "Print Point — Impressão de currículos", description: "Anexe o seu currículo, escolha cópias e cor, pague e receba-o impresso.", locale: "pt_PT" },
  ru: { title: "Print Point — Печать резюме", description: "Прикрепите резюме, выберите количество копий и цвет, оплатите и получите распечатку.", locale: "ru_RU" },
  ur: { title: "Print Point — ریزیومے پرنٹنگ", description: "اپنا ریزیومے منسلک کریں، کاپیوں کی تعداد اور رنگ منتخب کریں، ادائیگی کریں اور پرنٹ کروائیں۔", locale: "ur_PK" },
  ja: { title: "Print Point — 履歴書印刷", description: "履歴書を添付し、部数と色を選んでお支払いいただくと印刷いたします。", locale: "ja_JP" }
};

function escapeHtmlAttr(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const indexHtmlPath = path.join(__dirname, "public", "index.html");
let indexTemplate = { mtimeMs: 0, html: "" };

function getIndexTemplate() {
  const { mtimeMs } = fs.statSync(indexHtmlPath);
  if (mtimeMs !== indexTemplate.mtimeMs) {
    indexTemplate = { mtimeMs, html: fs.readFileSync(indexHtmlPath, "utf8") };
  }
  return indexTemplate.html;
}

app.get("/", (req, res) => {
  const requested = req.query.lang;
  const lang = typeof requested === "string" && Object.hasOwn(OG_TRANSLATIONS, requested) ? requested : "en";
  const og = OG_TRANSLATIONS[lang];
  const title = escapeHtmlAttr(og.title);
  const description = escapeHtmlAttr(og.description);
  const canonicalSuffix = lang === "en" ? "" : `?lang=${lang}`;

  const html = getIndexTemplate()
    .replace('<html lang="en">', `<html lang="${lang}">`)
    .replace("<title>Print Point — Resume printing</title>", `<title>${title}</title>`)
    .replaceAll('content="Print Point — Resume printing"', `content="${title}"`)
    .replace(/content="Attach your resume, choose copies & color, pay, and get it printed\."/g, `content="${description}"`)
    .replace('property="og:url" content="https://print.unilu.space/"', `property="og:url" content="https://print.unilu.space/${canonicalSuffix}"`)
    .replace("</head>", `    <meta property="og:locale" content="${og.locale}" />\n  </head>`);

  res.type("html").send(html);
});

app.use(express.static(path.join(__dirname, "public"), { index: false }));

function validateOrder(body, resumeFile, paymentProofFile) {
  const email = String(body.email || "").trim().toLowerCase();
  const phone = String(body.phone || "").trim();
  const location = String(body.location || "").trim();
  const copies = Number(body.copies);
  const pages = body.pages === undefined || body.pages === "" ? 1 : Number(body.pages);
  const printMode = String(body.printMode || "");

  if (!resumeFile) throw new UserError("resume_required", "Please attach your resume.");
  if (!hasValidSignature(resumeFile.path)) {
    throw new UserError("file_type", "Please upload a PDF, DOC, or DOCX file.");
  }
  if (paymentProofFile && !hasValidSignature(paymentProofFile.path)) {
    throw new UserError("file_type", "Payment proof must be a PDF, JPG, PNG, or WEBP file.");
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new UserError("email_invalid", "Enter a valid email address.");
  }
  if (phone.length > MAX_PHONE_LENGTH || location.length > MAX_LOCATION_LENGTH) {
    throw new UserError("field_too_long", "The phone number or location is too long.");
  }
  if (!Number.isInteger(copies) || copies < MIN_COPIES || copies > MAX_COPIES) {
    throw new UserError("copies_invalid", `Choose between ${MIN_COPIES} and ${MAX_COPIES} copies.`);
  }
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) {
    throw new UserError("pages_invalid", `Enter between 1 and ${MAX_PAGES} pages.`);
  }
  if (!Object.hasOwn(RATES_CENTS, printMode)) {
    throw new UserError("mode_invalid", "Choose black & white or color printing.");
  }

  const totalPages = copies * pages;
  return {
    customerEmail: email,
    phone: phone || null,
    location: location || null,
    copies,
    pages,
    totalPages,
    printMode,
    priceCents: priceCents(totalPages, printMode),
    originalName: decodeFilename(resumeFile.originalname),
    storedName: resumeFile.filename,
    paymentProofName: paymentProofFile ? paymentProofFile.filename : null
  };
}

const insertOrderStatement = db.prepare(`
  INSERT INTO orders (order_code, customer_email, phone, location, copies, pages, price_cents, print_mode, original_name, stored_name, payment_proof_name)
  VALUES (@orderCode, @customerEmail, @phone, @location, @copies, @pages, @priceCents, @printMode, @originalName, @storedName, @paymentProofName)
`);

function saveOrder(order) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    order.orderCode = `QP-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    try {
      insertOrderStatement.run(order);
      return;
    } catch (error) {
      if (error.code !== "SQLITE_CONSTRAINT_UNIQUE") throw error;
    }
  }
  throw new Error("Could not allocate a unique order code");
}

function describeOrder(order) {
  return `${order.copies} copies × ${order.pages} page(s) = ${order.totalPages} pages · ${formatMode(order.printMode)} · ${formatPrice(order.priceCents)}`;
}

async function sendShopEmail(order, resumeFile, paymentProofFile) {
  const attachments = [{ filename: order.originalName, path: resumeFile.path }];
  if (paymentProofFile) {
    attachments.push({ filename: decodeFilename(paymentProofFile.originalname), path: paymentProofFile.path });
  }
  await makeTransporter().sendMail({
    from: mailFrom(),
    to: process.env.PRINT_SHOP_EMAIL,
    replyTo: order.customerEmail,
    subject: paymentProofFile
      ? `New print order ${order.orderCode}`
      : `[NO PAYMENT YET] New print order ${order.orderCode}`,
    text: [
      `New print order: ${order.orderCode}`,
      `Customer email: ${order.customerEmail}`,
      `Phone: ${order.phone || "not provided"}`,
      `Pickup/delivery location: ${order.location || "not provided"}`,
      `Printing: ${describeOrder(order)}`,
      `Attached file: ${order.originalName}`,
      paymentProofFile
        ? `Payment proof: attached`
        : `Payment proof: ⚠️ NOT ATTACHED — customer submitted without paying yet`
    ].join("\n"),
    attachments
  });
}

async function sendOrderToTelegram(order, resumeFile, paymentProofFile) {
  await sendTelegramDocument({
    filePath: resumeFile.path,
    filename: order.originalName,
    caption: [
      `New print order ${order.orderCode}`,
      `Customer email: ${order.customerEmail}`,
      `Phone: ${order.phone || "not provided"}`,
      `Pickup/delivery: ${order.location || "not provided"}`,
      `Printing: ${describeOrder(order)}`,
      paymentProofFile ? `Payment: receipt attached` : `Payment: ⚠️ NOT PAID YET`
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "🖨 Printing", callback_data: `printing:${order.orderCode}` },
          { text: "🚚 Delivery", callback_data: `delivery:${order.orderCode}` }
        ],
        [{ text: "✅ Order ready", callback_data: `ready:${order.orderCode}` }]
      ]
    }
  });
  if (paymentProofFile) {
    try {
      await sendTelegramDocument({
        filePath: paymentProofFile.path,
        filename: decodeFilename(paymentProofFile.originalname),
        caption: `Payment proof for order ${order.orderCode}`
      });
    } catch (error) {
      console.error("Could not send payment proof to Telegram:", error.message);
    }
  }
}

async function sendCustomerConfirmation(order) {
  await makeTransporter().sendMail({
    from: mailFrom(),
    to: order.customerEmail,
    subject: `We received your print order ${order.orderCode}`,
    text: [
      `Thanks — we received your resume print request.`,
      `Order: ${order.orderCode}`,
      `Printing: ${describeOrder(order)}`,
      `We'll be in touch if anything else is needed.`
    ].join("\n")
  });
}

// The order counts as received once the shop has it through at least one channel.
async function notifyShop(order, resumeFile, paymentProofFile) {
  const channels = [sendShopEmail(order, resumeFile, paymentProofFile)];
  if (isTelegramConfigured()) channels.push(sendOrderToTelegram(order, resumeFile, paymentProofFile));

  const results = await Promise.allSettled(channels);
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`Order ${order.orderCode}: ${index === 0 ? "shop email" : "Telegram"} failed:`, result.reason?.message || result.reason);
    }
  });

  const [emailResult, telegramResult] = results;
  if (emailResult.status === "rejected" && telegramResult?.status === "fulfilled") {
    await notifyAdmin(`⚠️ The email copy of order ${order.orderCode} could not be sent — this Telegram message is the only notification.`);
  }
  return results.some((result) => result.status === "fulfilled");
}

const orderUpload = upload.fields([{ name: "resume", maxCount: 1 }, { name: "paymentProof", maxCount: 1 }]);

app.post("/api/orders", orderRateLimit, orderUpload, async (req, res, next) => {
  const resumeFile = req.files?.resume?.[0];
  const paymentProofFile = req.files?.paymentProof?.[0];
  const removeUploads = () => {
    for (const file of [resumeFile, paymentProofFile]) {
      if (file) fs.rmSync(file.path, { force: true });
    }
  };

  let order;
  try {
    order = validateOrder(req.body, resumeFile, paymentProofFile);
    if (!isConfigured()) {
      throw new UserError("unavailable", "Ordering is temporarily unavailable. Please try again later.", 503);
    }
    saveOrder(order);
  } catch (error) {
    removeUploads();
    next(error);
    return;
  }

  const received = await notifyShop(order, resumeFile, paymentProofFile);
  if (!received) {
    db.prepare("DELETE FROM orders WHERE order_code = ?").run(order.orderCode);
    removeUploads();
    next(new UserError("delivery_failed", "We couldn't send your order right now. Please try again in a few minutes.", 502));
    return;
  }

  sendCustomerConfirmation(order).catch((error) => {
    console.error(`Order ${order.orderCode}: customer confirmation failed:`, error.message);
  });

  res.status(201).json({
    orderCode: order.orderCode,
    totalPages: order.totalPages,
    price: formatPrice(order.priceCents),
    message: "Your print request is on its way. Check your email for confirmation."
  });
});

app.post("/api/telegram-webhook", express.json({ limit: "100kb" }), (req, res) => {
  res.sendStatus(200);
  if (!isAuthorizedWebhook(req)) return;
  handleTelegramUpdate(req.body).catch((error) => {
    console.error("Telegram update failed:", error);
  });
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof UserError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof multer.MulterError) {
    const known = {
      LIMIT_FILE_SIZE: ["file_too_large", "Your file must be 10 MB or smaller."],
      LIMIT_FIELD_VALUE: ["field_too_long", "One of the fields is too long."]
    };
    const [code, message] = known[error.code] || ["bad_upload", "The upload could not be processed."];
    res.status(400).json({ error: message, code });
    return;
  }
  if (error.type === "entity.parse.failed" || error.status === 400) {
    res.status(400).json({ error: "Invalid request.", code: "bad_request" });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Something went wrong. Please try again.", code: "server_error" });
});

export { app, db, priceCents, runRetention };

// PM2 loads the script through its own wrapper, so argv[1] is not this file there.
const entryCandidates = [process.argv[1], process.env.pm_exec_path].filter(Boolean);
if (entryCandidates.some((candidate) => path.resolve(candidate) === fileURLToPath(import.meta.url))) {
  app.listen(port, host, () => {
    console.log(`${shopName} is running at http://${host}:${port}`);
    registerTelegramWebhook();
    runRetention();
    setInterval(runRetention, 12 * 60 * 60 * 1000).unref();
  });
}
