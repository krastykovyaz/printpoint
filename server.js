import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import multer from "multer";
import nodemailer from "nodemailer";
import { downloadPdf, LinkError } from "./lib/fetch-pdf.js";
import { amountMatches, closePayLink, createPayLink, fetchNotices, grandlivreConfig, linkMatches, nextPayState, verifySignature } from "./lib/grandlivre.js";
import { CONVERTIBLE_EXTENSIONS, ConvertError, toPdf } from "./lib/convert.js";
import { countPages } from "./lib/pagecount.js";
import { checkReceipt, describeReceipt } from "./lib/receipt.js";
import { createPaperTray } from "./paper-tray.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
// nginx on the same host is the only proxy in front of the app.
app.set("trust proxy", "loopback");

const port = Number(process.env.PORT) || 3030;
const host = process.env.HOST || "127.0.0.1";
const shopName = process.env.SHOP_NAME || "Print CV";
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const retentionDays = Number(process.env.RETENTION_DAYS) || 30;
const statsTimeZone = process.env.STATS_TIMEZONE || "Europe/Luxembourg";

// Normally 4. Set MIN_COPIES=1 in .env for a short while to allow single-copy orders (e.g. to test the printer).
const MIN_COPIES = Math.min(4, Math.max(1, Math.floor(Number(process.env.MIN_COPIES)) || 4));
const MAX_COPIES = 100;
const MAX_PAGES = 50;
const BULK_THRESHOLD = 10;
// Prices in cents. The defaults are the normal prices; .env can set others without a code change, e.g. the pilot
// "€0.20 a page, at least €1.00": PRICE_PAGE_CENTS=20 PRICE_BULK_CENTS=20 MIN_ORDER_CENTS=100.
// The page gets the same rules from the <meta name="price-rules"> tag, so what it shows is what is charged.
function centsSetting(name, fallback) {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(value) && value >= 0 && value <= 10000 ? value : fallback;
}
const RATES_CENTS = {
  "black-white": { standard: centsSetting("PRICE_PAGE_CENTS", 50), bulk: centsSetting("PRICE_BULK_CENTS", 30) }
};
const MIN_ORDER_CENTS = centsSetting("MIN_ORDER_CENTS", 0);
const MAX_PHONE_LENGTH = 40;
const MAX_LOCATION_LENGTH = 300;
const TELEGRAM_CAPTION_LIMIT = 1024;
const PENDING_PHOTO_TTL_MINUTES = 30;
const DELETED_MARK = "[deleted]";
// With a print agent set up, the CV stays on the server only until it is printed, or this long if it never is.
const PRINT_HOLD_HOURS = Number(process.env.PRINT_HOLD_HOURS) || 48;
const PRINT_CLAIM_TIMEOUT_MINUTES = 10;
// The agent reports the printer's state now and then; it is only kept in memory and is stale after this long.
const PRINTER_STATUS_STALE_MINUTES = 3;
let printerStatus = null;
// The only site allowed to send a finished CV into the order form (see the handoff code in public/app.js).
const HANDOFF_ORIGIN = process.env.HANDOFF_ORIGIN || "https://tsech.online";
const ORDER_CODE_PATTERN = /^QP-[0-9A-F]{6}$/;
// Grandlivre payments (see lib/grandlivre.js). Off unless both the key and the webhook secret are set.
const grandlivre = () => grandlivreConfig();
const PAY_HOLD_HOURS = Number(process.env.GRANDLIVRE_HOLD_HOURS) || 24;
const PAY_REPORTED_RECHECK_MINUTES = 5;
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
  ["price_cents", "INTEGER"],
  ["telegram_messages", "TEXT"],
  ["print_status", "TEXT"],
  ["print_claimed_at", "TEXT"],
  ["receipt_status", "TEXT"],
  ["receipt_cents", "INTEGER"],
  ["pay_state", "TEXT"],
  ["pay_state_at", "TEXT"],
  ["pay_link_id", "TEXT"],
  ["pay_link_token", "TEXT"],
  ["pay_link_url", "TEXT"],
  ["status_key", "TEXT"],
  ["pay_checked_at", "INTEGER"],
  ["paid_at", "TEXT"],
  ["shop_notified", "INTEGER DEFAULT 0"],
  ["confirmation_sent", "INTEGER DEFAULT 0"],
  ["pages_known", "INTEGER"]
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

// Alert when the sheets left drop below this share of what was loaded.
const paperTray = createPaperTray(db, Number(process.env.PAPER_ALERT_PERCENT) || 90);

// One row per payment event received (the delivery log). A retried delivery has the same delivery id and is ignored;
// anything else is applied, and the state rules make a repeat harmless (it cannot change the state or resend messages).
db.exec(`
  CREATE TABLE IF NOT EXISTS grandlivre_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notice TEXT NOT NULL,
    state TEXT NOT NULL,
    event TEXT,
    delivery TEXT NOT NULL UNIQUE,
    order_code TEXT,
    source TEXT,
    result TEXT,
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
  return Math.max(MIN_ORDER_CENTS, standardPages * rates.standard + extraPages * rates.bulk);
}

function formatPrice(cents) {
  return `€${(cents / 100).toFixed(2)}`;
}

const PRINT_MODE_LABEL = "Black & white";

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
const allowLinkCheckFromIp = createRateLimiter({ windowMs: 15 * 60 * 1000, max: Number(process.env.LINK_CHECK_RATE_LIMIT) || 10 });
const allowLinkCheckGlobally = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 1000 });
const allowVisitFromIp = createRateLimiter({ windowMs: 30 * 60 * 1000, max: 1 });

function orderRateLimit(req, _res, next) {
  if (!allowOrderFromIp(req.ip) || !allowOrderGlobally("all")) {
    next(new UserError("too_many_requests", "Too many requests. Please try again in a few minutes.", 429));
    return;
  }
  next();
}

function linkCheckRateLimit(req, _res, next) {
  if (!allowLinkCheckFromIp(req.ip) || !allowLinkCheckGlobally("all")) {
    next(new UserError("too_many_requests", "Too many requests. Please try again in a few minutes.", 429));
    return;
  }
  next();
}

// Seam for tests: they swap `download` so no real network is needed.
const linkFetcher = { download: downloadPdf };
// Seam for tests: counts the pages of a CV file.
const pageCounter = { count: countPages };
// Seam for tests: turns a non-PDF CV into a PDF beside it.
const pdfConverter = { toPdf };
// Seam for tests, like linkFetcher: reads the amount on a payment receipt.
const receiptChecker = { check: checkReceipt };
const MAX_LINK_FETCHES = 4;
let activeLinkFetches = 0;

// Fetches a PDF a visitor linked to. Failures become the same stable user errors as bad uploads.
async function fetchResumeLink(rawUrl) {
  if (activeLinkFetches >= MAX_LINK_FETCHES) {
    throw new UserError("link_busy", "Too many links are being checked right now. Please try again in a moment.", 503);
  }
  activeLinkFetches += 1;
  try {
    return await linkFetcher.download(rawUrl, { destDir: uploadDir });
  } catch (error) {
    if (error instanceof LinkError) throw new UserError(error.code, error.message);
    throw error;
  } finally {
    activeLinkFetches -= 1;
  }
}

const resumeExtensions = new Set([".pdf", ...CONVERTIBLE_EXTENSIONS]);
const RESUME_TYPE_MESSAGE = "Please upload a PDF, Word, PowerPoint, Excel, OpenDocument, Pages, Keynote, RTF, text, Markdown, EPUB, DjVu file or a photo.";
const proofExtensions = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
const FILE_SIGNATURES = {
  ".doc": OLE_SIGNATURE,
  ".ppt": OLE_SIGNATURE,
  ".pps": OLE_SIGNATURE,
  ".xls": OLE_SIGNATURE,
  ".docx": ZIP_SIGNATURE,
  ".pptx": ZIP_SIGNATURE,
  ".ppsx": ZIP_SIGNATURE,
  ".xlsx": ZIP_SIGNATURE,
  ".odt": ZIP_SIGNATURE,
  ".odp": ZIP_SIGNATURE,
  ".ods": ZIP_SIGNATURE,
  ".epub": ZIP_SIGNATURE,
  ".pages": ZIP_SIGNATURE,
  ".key": ZIP_SIGNATURE,
  ".djvu": Buffer.from("AT&TFORM"),
  ".rtf": Buffer.from("{\\rtf"),
  ".jpg": Buffer.from([0xff, 0xd8, 0xff]),
  ".jpeg": Buffer.from([0xff, 0xd8, 0xff]),
  ".png": Buffer.from([0x89, 0x50, 0x4e, 0x47])
};

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv"]);

function hasValidSignature(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const head = Buffer.alloc(1024);
  const descriptor = fs.openSync(filePath, "r");
  const length = fs.readSync(descriptor, head, 0, head.length, 0);
  fs.closeSync(descriptor);
  const bytes = head.subarray(0, length);

  if (extension === ".pdf") return bytes.includes("%PDF-");
  if (TEXT_EXTENSIONS.has(extension)) return length > 0 && !bytes.includes(0);
  if (extension === ".heic") return bytes.subarray(4, 8).toString() === "ftyp";
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

// Every CV is kept, counted and printed as a PDF. Takes a multer-shaped file and returns one for the PDF;
// the original upload is always removed. Rejects with the same user errors as a bad upload.
async function resumeAsPdf(file) {
  if (path.extname(file.path).toLowerCase() === ".pdf") return file;
  try {
    if (!hasValidSignature(file.path)) throw new UserError("file_type", RESUME_TYPE_MESSAGE);
    let pdfPath;
    try {
      pdfPath = await pdfConverter.toPdf(file.path);
    } catch (error) {
      if (!(error instanceof ConvertError)) throw error;
      console.error(`Could not convert ${path.basename(file.path)}:`, error.message);
      throw new UserError("convert_failed", "We couldn't read this file. Please save it as a PDF and try again.");
    }
    const original = decodeFilename(file.originalname);
    const pdfName = `${path.basename(original, path.extname(original)) || "document"}.pdf`;
    return { path: pdfPath, filename: path.basename(pdfPath), originalname: Buffer.from(pdfName, "utf8").toString("latin1") };
  } finally {
    fs.rmSync(file.path, { force: true });
  }
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
    return cb(new UserError("file_type", RESUME_TYPE_MESSAGE));
  }
});

function isConfigured() {
  return Boolean(
    process.env.GMAIL_USER &&
    process.env.GMAIL_APP_PASSWORD &&
    process.env.PRINT_SHOP_EMAIL
  );
}

// Filled only by the test transport, so tests can inspect what would have been emailed.
const mailLog = [];

function makeTransporter() {
  const override = process.env.MAIL_TRANSPORT;
  if (override === "json") {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = transport.sendMail.bind(transport);
    transport.sendMail = async (mail) => {
      const info = await sendMail(mail);
      mailLog.push(JSON.parse(info.message));
      return info;
    };
    return transport;
  }
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

function printAgentEnabled() {
  return Boolean(process.env.PRINT_AGENT_TOKEN);
}

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function telegramApi(method, body) {
  const base = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
  const url = `${base}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
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
  const message = await telegramApi("sendDocument", form);
  return message.message_id;
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
        { command: "printer", description: "Show printer toner, paper and queue" },
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
    return { error: "Customer data has already been deleted." };
  }
  return { email: order.customer_email };
}

// Once an order is printed and the customer told, nothing about it should remain:
// the Telegram copies are deleted and the contact details are blanked.
async function purgeOrder(orderCode) {
  const row = db.prepare("SELECT telegram_messages, stored_name FROM orders WHERE order_code = ?").get(orderCode);
  if (row?.stored_name) fs.rmSync(path.join(uploadDir, row.stored_name), { force: true });
  let telegramDeleted = true;
  for (const messageId of JSON.parse(row?.telegram_messages || "[]")) {
    try {
      await telegramApi("deleteMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, message_id: messageId });
    } catch (error) {
      telegramDeleted = false;
      console.error(`Order ${orderCode}: could not delete Telegram message ${messageId}:`, error.message);
    }
  }
  db.prepare(`
    UPDATE orders
    SET customer_email = ?, phone = NULL, location = NULL, original_name = ?, telegram_messages = NULL
    WHERE order_code = ?
  `).run(DELETED_MARK, DELETED_MARK, orderCode);
  return { telegramDeleted };
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
    const { telegramDeleted } = await purgeOrder(orderCode);
    await notifyAdmin(
      `✅ Client notified: Order ready ${orderCode}${photo ? " (with pickup photo)" : ""}\n` +
      (telegramDeleted
        ? `🗑 The CV, receipt and customer details for this order have been deleted.`
        : `⚠️ Customer details are deleted, but Telegram would not delete the order message — remove it from this chat by hand.`)
    );
  } catch (error) {
    console.error("Could not send ready email:", error);
    await notifyAdmin(`Failed to send the "ready" email for ${orderCode} — tap "Order ready" again to retry.`);
  }
}

// Confirming in Telegram is what releases a job to the printer.
async function handlePrintButton(callbackQuery, orderCode) {
  if (!printAgentEnabled()) {
    await answerTelegramCallback(callbackQuery.id, "No printer is connected to the server.");
    return;
  }
  const order = db.prepare("SELECT stored_name, print_status, customer_email FROM orders WHERE order_code = ?").get(orderCode);
  if (!order) {
    await answerTelegramCallback(callbackQuery.id, "Order not found.");
    return;
  }
  if (order.customer_email === DELETED_MARK) {
    await answerTelegramCallback(callbackQuery.id, "This order has already been completed and deleted.");
    return;
  }
  if (order.print_status === "queued" || order.print_status === "printing") {
    await answerTelegramCallback(callbackQuery.id, "Already in the print queue.");
    return;
  }
  if (order.print_status === "printed") {
    await answerTelegramCallback(callbackQuery.id, "Already printed.");
    return;
  }
  if (!fs.existsSync(path.join(uploadDir, order.stored_name))) {
    await answerTelegramCallback(callbackQuery.id, `The file is no longer on the server (kept ${PRINT_HOLD_HOURS} hours). Print it from this chat by hand.`);
    return;
  }
  db.prepare("UPDATE orders SET print_status = 'queued', print_claimed_at = NULL WHERE order_code = ?").run(orderCode);
  await answerTelegramCallback(callbackQuery.id, "🖨 Queued — it prints in a moment.");
}

async function handlePayCheckButton(callbackQuery, orderCode) {
  try {
    const state = await refreshPayment(orderCode);
    const words = { paid: "✅ Paid", payment_reported: "💶 Reported, not confirmed yet", payment_problem: "⚠️ Declined", payment_mismatch: "⚠️ Amount does not match", awaiting_payment: "Not paid yet" };
    await answerTelegramCallback(callbackQuery.id, state ? (words[state] || state) : "No online payment for this order.");
  } catch (error) {
    console.error(`Payment check for ${orderCode} failed:`, error.message);
    await answerTelegramCallback(callbackQuery.id, "Could not reach Grandlivre. Try again in a moment.");
  }
}

async function handleStatusButton(callbackQuery, chatId) {
  const [action, orderCode] = String(callbackQuery.data || "").split(":");
  if (action === "paycheck" && ORDER_CODE_PATTERN.test(orderCode || "")) {
    await handlePayCheckButton(callbackQuery, orderCode);
    return;
  }
  if (action === "print" && ORDER_CODE_PATTERN.test(orderCode || "")) {
    await handlePrintButton(callbackQuery, orderCode);
    return;
  }
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
  if (command === "/printer") {
    await notifyAdmin(describePrinter());
    return;
  }
  const paperCommand = /^\/paper(?:\s+(\S+))?$/.exec(command);
  if (paperCommand) {
    await notifyAdmin(handlePaperCommand(paperCommand[1]));
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

function describePrinter() {
  const counts = Object.fromEntries(
    db.prepare("SELECT print_status AS status, COUNT(*) AS n FROM orders WHERE print_status IS NOT NULL GROUP BY print_status").all()
      .map((row) => [row.status, row.n])
  );
  const queue = `Queue: ${counts.queued || 0} waiting, ${counts.printing || 0} printing, ${counts.failed || 0} failed`;
  if (!printerStatus) return ["🖨 Printer", "The print agent has not reported yet.", describePaper(), queue].join("\n");

  const ageMinutes = Math.floor((Date.now() - printerStatus.receivedAt) / 60000);
  const stale = ageMinutes >= PRINTER_STATUS_STALE_MINUTES;
  const lines = [
    `🖨 Printer ${printerStatus.printer || ""}`.trim(),
    stale ? `⚠️ Agent silent for ${ageMinutes} min — values below may be out of date.` : "Agent: online",
    `State: ${printerStatus.state}${printerStatus.reasons ? ` (${printerStatus.reasons})` : ""}`
  ];
  if (printerStatus.alert) lines.push(`Alert: ${printerStatus.alert}`);
  for (const marker of printerStatus.markers) {
    const low = marker.low !== null && marker.level !== null && marker.level <= marker.low ? " ⚠️ low" : "";
    lines.push(`${marker.name}: ${marker.level === null ? "unknown" : `${marker.level}%`}${low}`);
  }
  if (printerStatus.media.length) lines.push(`Paper loaded: ${printerStatus.media.join(", ")}`);
  lines.push(describePaper(), queue);
  return lines.join("\n");
}

function describePaper() {
  const paper = paperTray.status();
  if (!paper) return "Paper: not counted yet. Send /paper <sheets> after loading the tray.";
  return `Paper left: ~${paper.remaining} of ${paper.loaded} sheets (${paper.percent}%)`;
}

function handlePaperCommand(argument) {
  if (argument === undefined) return `📄 ${describePaper()}`;
  const sheets = Number(argument);
  if (!/^\d+$/.test(argument) || sheets < 1 || sheets > 5000) return "Send /paper followed by the number of sheets you loaded, for example /paper 250.";
  paperTray.load(sheets);
  return `📄 Counting from ${sheets} sheets. I'll warn you when fewer than ${Number(process.env.PAPER_ALERT_PERCENT) || 90}% are left.`;
}

function cleanText(value, max = 80) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "";
}

function cleanPercent(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
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
    expireUnpaidOrders();
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
    const holdCutoffMs = Date.now() - PRINT_HOLD_HOURS * 60 * 60 * 1000;
    for (const name of fs.readdirSync(uploadDir)) {
      const filePath = path.join(uploadDir, name);
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
      const expired = stats.mtimeMs < cutoffMs;
      const orphaned = !referenced.has(name) && stats.mtimeMs < orphanCutoffMs;
      const heldTooLong = printAgentEnabled() && stats.mtimeMs < holdCutoffMs;
      if (expired || orphaned || heldTooLong) fs.rmSync(filePath, { force: true });
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
      // Only Grandlivre's payment page may be framed (no third-party script is loaded), and nothing broader.
      "script-src 'self'",
      ...(grandlivre() ? [`frame-src ${grandlivre().origin}`] : []),
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
  en: { title: "Print CV — Resume printing", description: "Attach your resume, choose copies, pay, and get it printed.", locale: "en_US" },
  zh: { title: "Print CV — 简历打印", description: "上传简历，选择份数，付款后即可完成打印。", locale: "zh_CN" },
  hi: { title: "Print CV — रिज़्यूमे प्रिंटिंग", description: "अपना रिज़्यूमे अटैच करें, प्रतियाँ चुनें, भुगतान करें और प्रिंट करवाएँ।", locale: "hi_IN" },
  es: { title: "Print CV — Impresión de currículums", description: "Adjunta tu currículum, elige las copias, paga y recíbelo impreso.", locale: "es_ES" },
  fr: { title: "Print CV — Impression de CV", description: "Joignez votre CV, choisissez le nombre de copies, payez, et faites-le imprimer.", locale: "fr_FR" },
  ar: { title: "Print CV — طباعة السيرة الذاتية", description: "أرفق سيرتك الذاتية، اختر عدد النسخ، ادفع، واحصل على طباعتها.", locale: "ar_AR" },
  bn: { title: "Print CV — রিজিউমি প্রিন্টিং", description: "আপনার রিজিউমি সংযুক্ত করুন, কপির সংখ্যা নির্বাচন করুন, পেমেন্ট করুন এবং প্রিন্ট করিয়ে নিন।", locale: "bn_BD" },
  pt: { title: "Print CV — Impressão de currículos", description: "Anexe o seu currículo, escolha as cópias, pague e receba-o impresso.", locale: "pt_PT" },
  ru: { title: "Print CV — Печать резюме", description: "Прикрепите резюме, выберите количество копий, оплатите и получите распечатку.", locale: "ru_RU" },
  ur: { title: "Print CV — ریزیومے پرنٹنگ", description: "اپنا ریزیومے منسلک کریں، کاپیوں کی تعداد منتخب کریں، ادائیگی کریں اور پرنٹ کروائیں۔", locale: "ur_PK" },
  ja: { title: "Print CV — 履歴書印刷", description: "履歴書を添付し、部数を選んでお支払いいただくと印刷いたします。", locale: "ja_JP" }
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
    .replace("<title>Print CV — Resume printing</title>", `<title>${title}</title>`)
    .replaceAll('content="Print CV — Resume printing"', `content="${title}"`)
    .replace(/content="Attach your resume, choose copies, pay, and get it printed\."/g, `content="${description}"`)
    .replace('property="og:url" content="https://print.unilu.space/"', `property="og:url" content="https://print.unilu.space/${canonicalSuffix}"`)
    .replace("</head>", `    <meta property="og:locale" content="${og.locale}" />\n    <meta name="min-copies" content="${MIN_COPIES}" />\n    <meta name="price-rules" content="${escapeHtmlAttr(JSON.stringify({ page: RATES_CENTS["black-white"].standard, bulk: RATES_CENTS["black-white"].bulk, after: BULK_THRESHOLD, min: MIN_ORDER_CENTS }))}" />\n    <meta name="handoff-origin" content="${escapeHtmlAttr(HANDOFF_ORIGIN)}" />${grandlivre() ? `\n    <meta name="pay-mode" content="grandlivre" />\n    <meta name="grandlivre-origin" content="${escapeHtmlAttr(grandlivre().origin)}" />` : ""}\n  </head>`);

  res.type("html").send(html);
});

app.use(express.static(path.join(__dirname, "public"), { index: false }));

// `pageInfo` is what the server read from the document ({ pages } or { pages: null }); the browser's own page number is ignored.
function validateOrder(body, resumeFile, paymentProofFile, pageInfo = { pages: null }) {
  const email = String(body.email || "").trim().toLowerCase();
  const phone = String(body.phone || "").trim();
  const location = String(body.location || "").trim();
  const copies = Number(body.copies);
  const pagesKnown = Number.isInteger(pageInfo.pages) && pageInfo.pages > 0;
  const pages = pagesKnown ? pageInfo.pages : 1;
  const printMode = String(body.printMode || "");

  if (!resumeFile) throw new UserError("resume_required", "Please attach your resume.");
  if (!hasValidSignature(resumeFile.path)) {
    throw new UserError("file_type", RESUME_TYPE_MESSAGE);
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
    throw new UserError("pages_invalid", `Documents of up to ${MAX_PAGES} pages can be ordered here (this one has ${pages}).`);
  }
  if (!Object.hasOwn(RATES_CENTS, printMode)) {
    throw new UserError("mode_invalid", "Only black & white printing is available right now.");
  }

  const totalPages = copies * pages;
  return {
    customerEmail: email,
    phone: phone || null,
    location: location || null,
    copies,
    pages,
    pagesKnown: pagesKnown ? 1 : 0,
    totalPages,
    printMode,
    priceCents: priceCents(totalPages, printMode),
    originalName: decodeFilename(resumeFile.originalname),
    storedName: resumeFile.filename,
    paymentProofName: paymentProofFile ? paymentProofFile.filename : null,
    payState: null,
    payStateAt: null,
    statusKey: null
  };
}

const insertOrderStatement = db.prepare(`
  INSERT INTO orders (order_code, customer_email, phone, location, copies, pages, price_cents, print_mode, original_name, stored_name, payment_proof_name, pay_state, pay_state_at, status_key, pages_known)
  VALUES (@orderCode, @customerEmail, @phone, @location, @copies, @pages, @priceCents, @printMode, @originalName, @storedName, @paymentProofName, @payState, @payStateAt, @statusKey, @pagesKnown)
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
  const unknown = order.pagesKnown === 0 ? " ⚠️ page count not detected, priced as 1 page per copy — check the file" : "";
  return `${order.copies} copies × ${order.pages} page(s) = ${order.totalPages} pages · ${PRINT_MODE_LABEL} · ${formatPrice(order.priceCents)}${unknown}`;
}

async function sendShopEmail(order, resumeFile, paymentProofFile, { summaryOnly = false } = {}) {
  const subject = paymentProofFile || order.paymentKnown
    ? `New print order ${order.orderCode}`
    : `[NO PAYMENT YET] New print order ${order.orderCode}`;

  // The CV and the customer's details live in Telegram and are deleted from there once printed;
  // the inbox only gets a notice, so nothing personal piles up in the mailbox.
  if (summaryOnly) {
    await makeTransporter().sendMail({
      from: mailFrom(),
      to: process.env.PRINT_SHOP_EMAIL,
      subject,
      text: [
        `New print order: ${order.orderCode}`,
        `Printing: ${describeOrder(order)}`,
        order.paymentLine ?? (paymentProofFile ? `Payment proof: received` : `Payment proof: ⚠️ NOT ATTACHED — customer submitted without paying yet`),
        ...(describeReceipt(order.receipt, order.priceCents) ? [describeReceipt(order.receipt, order.priceCents)] : []),
        ``,
        `The CV and the customer's details are in Telegram only, and are deleted when you mark the order ready.`
      ].join("\n")
    });
    return;
  }

  const attachments = [{ filename: order.originalName, path: resumeFile.path }];
  if (paymentProofFile) {
    attachments.push({ filename: decodeFilename(paymentProofFile.originalname), path: paymentProofFile.path });
  }
  await makeTransporter().sendMail({
    from: mailFrom(),
    to: process.env.PRINT_SHOP_EMAIL,
    replyTo: order.customerEmail,
    subject,
    text: [
      `New print order: ${order.orderCode}`,
      `Customer email: ${order.customerEmail}`,
      `Phone: ${order.phone || "not provided"}`,
      `Pickup/delivery location: ${order.location || "not provided"}`,
      `Printing: ${describeOrder(order)}`,
      `Attached file: ${order.originalName}`,
      order.paymentLine ?? (paymentProofFile
        ? `Payment proof: attached`
        : `Payment proof: ⚠️ NOT ATTACHED — customer submitted without paying yet`),
      ...(describeReceipt(order.receipt, order.priceCents) ? [describeReceipt(order.receipt, order.priceCents)] : [])
    ].join("\n"),
    attachments
  });
}

async function sendOrderToTelegram(order, resumeFile, paymentProofFile) {
  const messageIds = [];
  messageIds.push(await sendTelegramDocument({
    filePath: resumeFile.path,
    filename: order.originalName,
    caption: [
      `New print order ${order.orderCode}`,
      `Customer email: ${order.customerEmail}`,
      `Phone: ${order.phone || "not provided"}`,
      `Pickup/delivery: ${order.location || "not provided"}`,
      `Printing: ${describeOrder(order)}`,
      order.paymentLine ?? (paymentProofFile ? `Payment: receipt attached` : `Payment: ⚠️ NOT PAID YET`),
      ...(describeReceipt(order.receipt, order.priceCents) ? [describeReceipt(order.receipt, order.priceCents)] : [])
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        ...(printAgentEnabled() ? [[{ text: "🖨 Print on printer", callback_data: `print:${order.orderCode}` }]] : []),
        ...(order.grandlivre ? [[{ text: "💶 Check payment", callback_data: `paycheck:${order.orderCode}` }]] : []),
        [
          { text: "🖨 Printing", callback_data: `printing:${order.orderCode}` },
          { text: "🚚 Delivery", callback_data: `delivery:${order.orderCode}` }
        ],
        [{ text: "✅ Order ready", callback_data: `ready:${order.orderCode}` }]
      ]
    }
  }));
  if (paymentProofFile) {
    try {
      messageIds.push(await sendTelegramDocument({
        filePath: paymentProofFile.path,
        filename: decodeFilename(paymentProofFile.originalname),
        caption: `Payment proof for order ${order.orderCode}`
      }));
    } catch (error) {
      console.error("Could not send payment proof to Telegram:", error.message);
    }
  }
  return messageIds;
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
// Telegram carries the files; email is a plain notice unless Telegram could not be used.
async function notifyShop(order, resumeFile, paymentProofFile) {
  let telegramMessages = null;
  if (isTelegramConfigured()) {
    try {
      telegramMessages = await sendOrderToTelegram(order, resumeFile, paymentProofFile);
      db.prepare("UPDATE orders SET telegram_messages = ? WHERE order_code = ?")
        .run(JSON.stringify(telegramMessages), order.orderCode);
    } catch (error) {
      console.error(`Order ${order.orderCode}: Telegram failed:`, error.message);
    }
  }

  let emailSent = false;
  try {
    await sendShopEmail(order, resumeFile, paymentProofFile, { summaryOnly: telegramMessages !== null });
    emailSent = true;
  } catch (error) {
    console.error(`Order ${order.orderCode}: shop email failed:`, error.message);
  }

  if (telegramMessages !== null && !emailSent) {
    await notifyAdmin(`⚠️ The email notice for order ${order.orderCode} could not be sent — this Telegram message is the only notification.`);
  }
  return telegramMessages !== null || emailSent;
}

const orderUpload = upload.fields([{ name: "resume", maxCount: 1 }, { name: "paymentProof", maxCount: 1 }]);

const allowInspectFromIp = createRateLimiter({ windowMs: 15 * 60 * 1000, max: Number(process.env.INSPECT_RATE_LIMIT) || 30 });

// Counts the pages of the CV the visitor just chose, so the page can show the real price. Nothing is kept.
app.post("/api/inspect", (req, res, next) => {
  if (!allowInspectFromIp(req.ip)) {
    next(new UserError("too_many_requests", "Too many requests. Please try again in a few minutes.", 429));
    return;
  }
  next();
}, upload.single("resume"), async (req, res, next) => {
  let file = req.file;
  try {
    if (!file) throw new UserError("file_type", RESUME_TYPE_MESSAGE);
    file = await resumeAsPdf(file);
    if (!hasValidSignature(file.path)) throw new UserError("file_type", RESUME_TYPE_MESSAGE);
    const { pages } = await pageCounter.count(file.path);
    res.json({ pages, known: pages !== null });
  } catch (error) {
    next(error);
  } finally {
    if (file) fs.rmSync(file.path, { force: true });
  }
});

// Lets the page tell the visitor whether a pasted link works, before they order. Nothing is kept.
app.post("/api/check-link", linkCheckRateLimit, express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    const file = await fetchResumeLink(req.body?.url);
    const { pages } = await pageCounter.count(file.path);
    fs.rmSync(file.path, { force: true });
    res.json({ ok: true, filename: file.originalName, size: file.size, pages });
  } catch (error) {
    next(error);
  }
});

app.post("/api/orders", orderRateLimit, orderUpload, async (req, res, next) => {
  let resumeFile = req.files?.resume?.[0];
  const resumeUrl = String(req.body?.resumeUrl || "").trim();
  const paymentProofFile = req.files?.paymentProof?.[0];
  const removeUploads = ({ keepResume = false } = {}) => {
    for (const file of [keepResume ? null : resumeFile, paymentProofFile]) {
      if (file) fs.rmSync(file.path, { force: true });
    }
  };

  let order;
  try {
    if (resumeFile && resumeUrl) {
      throw new UserError("resume_conflict", "Attach a file or paste a link, not both.");
    }
    if (!resumeFile && resumeUrl) {
      const downloaded = await fetchResumeLink(resumeUrl);
      // Same shape multer gives uploads, including its latin1-encoded original name.
      resumeFile = {
        path: downloaded.path,
        filename: downloaded.filename,
        originalname: Buffer.from(downloaded.originalName, "utf8").toString("latin1")
      };
    }
    if (resumeFile) resumeFile = await resumeAsPdf(resumeFile);
    const pageInfo = resumeFile && hasValidSignature(resumeFile.path) ? await pageCounter.count(resumeFile.path) : { pages: null };
    order = validateOrder(req.body, resumeFile, paymentProofFile, pageInfo);
    if (!isConfigured()) {
      throw new UserError("unavailable", "Ordering is temporarily unavailable. Please try again later.", 503);
    }
    if (grandlivre()) {
      // Nothing is sent to the shop until the customer reports paying; the price below is the server's own.
      order.payState = "awaiting_payment";
      order.payStateAt = sqlTimestamp(new Date());
      order.statusKey = crypto.randomBytes(16).toString("hex");
    }
    saveOrder(order);
  } catch (error) {
    removeUploads();
    next(error);
    return;
  }

  let orderMode = "legacy";
  if (order.payState) {
    let link = null;
    try {
      link = await ensurePayLink(order.orderCode);
    } catch (error) {
      console.error(`Order ${order.orderCode}: could not make a Grandlivre link, using Revolut instead:`, error.message);
    }
    if (link) {
      removeUploads({ keepResume: true });
      res.status(201).json({
        mode: "grandlivre",
        orderCode: order.orderCode,
        statusKey: order.statusKey,
        token: link.token,
        totalPages: order.totalPages,
        price: formatPrice(order.priceCents),
        amount: (order.priceCents / 100).toFixed(2)
      });
      return;
    }
    // Grandlivre is unreachable: take the order the old way, flagged as unpaid, and tell the customer to pay by Revolut.
    orderMode = "revolut";
    order.payState = "manual_payment";
    order.paymentLine = "Payment: ⚠️ NOT PAID YET — online payment was unavailable, so the customer was told to pay by Revolut and quote the order code";
    db.prepare("UPDATE orders SET pay_state = 'manual_payment', pay_state_at = ? WHERE order_code = ?")
      .run(sqlTimestamp(new Date()), order.orderCode);
  }

  // Read the receipt's amount while the file still exists, so the shop's message can say whether it matches.
  if (paymentProofFile) {
    order.receipt = await receiptChecker.check(paymentProofFile.path, order.priceCents);
    db.prepare("UPDATE orders SET receipt_status = ?, receipt_cents = ? WHERE order_code = ?")
      .run(order.receipt.status, order.receipt.paidCents ?? null, order.orderCode);
  }

  const received = await notifyShop(order, resumeFile, paymentProofFile);
  if (!received) {
    db.prepare("DELETE FROM orders WHERE order_code = ?").run(order.orderCode);
    removeUploads();
    next(new UserError("delivery_failed", "We couldn't send your order right now. Please try again in a few minutes.", 502));
    return;
  }

  // The shop has the files now (Telegram or email). The server keeps no copy, except the CV
  // while it waits for the print button when a printer is connected.
  removeUploads({ keepResume: printAgentEnabled() && isTelegramConfigured() });

  sendCustomerConfirmation(order).catch((error) => {
    console.error(`Order ${order.orderCode}: customer confirmation failed:`, error.message);
  });

  res.status(201).json({
    mode: orderMode,
    orderCode: order.orderCode,
    totalPages: order.totalPages,
    price: formatPrice(order.priceCents),
    amount: (order.priceCents / 100).toFixed(2),
    message: "Your print request is on its way. Check your email for confirmation."
  });
});

// ---- Grandlivre payments -------------------------------------------------------------------------

const linksInFlight = new Map();

// One link per order: an existing one is reused, and simultaneous calls share a single request.
function ensurePayLink(orderCode) {
  const existing = db.prepare("SELECT pay_link_id, pay_link_token, pay_link_url FROM orders WHERE order_code = ?").get(orderCode);
  if (existing?.pay_link_id && existing.pay_link_token) {
    return Promise.resolve({ id: existing.pay_link_id, token: existing.pay_link_token, url: existing.pay_link_url });
  }
  if (linksInFlight.has(orderCode)) return linksInFlight.get(orderCode);

  const work = (async () => {
    const config = grandlivre();
    const row = db.prepare("SELECT price_cents FROM orders WHERE order_code = ?").get(orderCode);
    if (!config || !row) throw new Error("Grandlivre is not configured or the order is missing");
    const link = await createPayLink(config, { orderCode, priceCents: row.price_cents });
    db.prepare("UPDATE orders SET pay_link_id = ?, pay_link_token = ?, pay_link_url = ? WHERE order_code = ?")
      .run(link.id, link.token, link.url, orderCode);
    return link;
  })().finally(() => linksInFlight.delete(orderCode));
  linksInFlight.set(orderCode, work);
  return work;
}

function orderFromRow(row) {
  const pages = row.pages || 1;
  return {
    orderCode: row.order_code,
    customerEmail: row.customer_email,
    phone: row.phone,
    location: row.location,
    copies: row.copies,
    pages,
    totalPages: row.copies * pages,
    priceCents: row.price_cents,
    pagesKnown: row.pages_known,
    originalName: row.original_name,
    grandlivre: true,
    paymentKnown: true
  };
}

const euros = (value) => `€${Number(value).toFixed(2)}`;
const insertPaymentEvent = db.prepare(`
  INSERT OR IGNORE INTO grandlivre_events (notice, state, event, delivery, order_code, source)
  VALUES (@notice, @state, @event, @delivery, @orderCode, @source)
`);

// Records one payment event and moves the order's payment state. Safe to call twice with the same event.
// Returns what happened and what should now be done about it (see runPaymentEffects).
function applyPaymentEvent(evt, source = "webhook") {
  const state = String(evt.state || "");
  if (!["reported", "confirmed", "declined"].includes(state) || !evt.notice || !evt.ref) return { result: "ignored" };

  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM orders WHERE order_code = ?").get(String(evt.ref));
    if (!row || !row.pay_state) return { result: "unknown_order" };

    const recorded = insertPaymentEvent.run({
      notice: String(evt.notice), state, event: evt.event || `payment.${state}`,
      delivery: evt.delivery || `${source}-${crypto.randomUUID()}`, orderCode: row.order_code, source
    });
    if (recorded.changes === 0) return { result: "duplicate" };
    const finish = (result, extra = {}) => {
      db.prepare("UPDATE grandlivre_events SET result = ? WHERE id = ?").run(result, recorded.lastInsertRowid);
      return { result, row, evt, state, ...extra };
    };

    if (["expired", "cancelled", "manual_payment"].includes(row.pay_state)) return finish("order_closed");

    const consistent = linkMatches(evt.link, row) && amountMatches(evt.amount, evt.currency, row.price_cents);
    if (!consistent) {
      if (row.pay_state !== "paid") {
        db.prepare("UPDATE orders SET pay_state = 'payment_mismatch', pay_state_at = ? WHERE order_code = ?")
          .run(sqlTimestamp(new Date()), row.order_code);
      }
      return finish("mismatch");
    }

    const to = nextPayState(row.pay_state, state);
    if (to === row.pay_state) return finish("unchanged");
    db.prepare("UPDATE orders SET pay_state = ?, pay_state_at = ?, paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END WHERE order_code = ?")
      .run(to, sqlTimestamp(new Date()), to, sqlTimestamp(new Date()), row.order_code);
    return finish("applied", { from: row.pay_state, to });
  })();
}

function payerText(evt) {
  return `${evt.payerName ? ` by ${String(evt.payerName).slice(0, 60)}` : ""}${evt.receipt ? " (proof attached)" : ""}`;
}

// Tells the shop once, using the order's files, with the payment line saying where the money stands.
async function notifyShopOnce(orderCode, paymentLine) {
  const claimed = db.prepare("UPDATE orders SET shop_notified = 1 WHERE order_code = ? AND shop_notified = 0").run(orderCode).changes === 1;
  if (!claimed) return;
  const row = db.prepare("SELECT * FROM orders WHERE order_code = ?").get(orderCode);
  const filePath = path.join(uploadDir, row.stored_name);
  if (!fs.existsSync(filePath)) {
    await notifyAdmin(`⚠️ ${orderCode}: the payment came in but the CV is no longer on the server. Ask the customer to send it again.`);
    return;
  }
  const order = { ...orderFromRow(row), paymentLine };
  const resumeFile = { path: filePath, filename: row.stored_name, originalname: Buffer.from(row.original_name, "utf8").toString("latin1") };
  const delivered = await notifyShop(order, resumeFile, null);
  if (!delivered) {
    db.prepare("UPDATE orders SET shop_notified = 0 WHERE order_code = ?").run(orderCode);
    return;
  }
  // As with a normal order, the shop has the file now; keep ours only if the printer fetches it.
  if (!(printAgentEnabled() && isTelegramConfigured())) fs.rmSync(filePath, { force: true });
}

async function sendPaymentEmail(row, subject, lines) {
  await makeTransporter().sendMail({ from: mailFrom(), to: row.customer_email, subject, text: lines.join("\n") });
}

// The slow part of a payment event: messages, emails, and releasing the print job. Never throws.
async function runPaymentEffects(outcome) {
  try {
    const { row, evt, state } = outcome;
    if (outcome.result === "mismatch") {
      await notifyAdmin(`⚠️ A payment (${state}) for ${row.order_code} does not match the order: it says ${euros(evt.amount)} ${String(evt.currency || "").toUpperCase()} but the order is ${euros(row.price_cents / 100)}, or it belongs to a different link. The order is NOT marked paid.`);
      return;
    }
    if (outcome.result === "order_closed") {
      await notifyAdmin(`⚠️ A payment (${state}) of ${euros(evt.amount)}${payerText(evt)} arrived for order ${row.order_code}, which is ${row.pay_state}. Check it in Grandlivre and contact the customer or refund.`);
      return;
    }
    if (outcome.result !== "applied") return;

    if (outcome.to === "payment_reported") {
      await notifyShopOnce(row.order_code, `Payment: 💶 reported${payerText(evt)} for ${euros(evt.amount)}. Waiting for you to confirm the money in Grandlivre.`);
      await notifyAdmin(`💶 Payment reported for ${row.order_code}${payerText(evt)}: ${euros(evt.amount)}. Mark it received in Grandlivre (Profile › Money › Payments) once the money is in.`);
    } else if (outcome.to === "paid") {
      await notifyShopOnce(row.order_code, `Payment: ✅ confirmed in Grandlivre, ${euros(evt.amount)}.`);
      const fresh = db.prepare("SELECT * FROM orders WHERE order_code = ?").get(row.order_code);
      if (db.prepare("UPDATE orders SET confirmation_sent = 1 WHERE order_code = ? AND confirmation_sent = 0").run(row.order_code).changes === 1) {
        sendPaymentEmail(fresh, `Payment confirmed — print order ${row.order_code}`, [
          `Thanks — your payment is confirmed.`,
          `Order: ${row.order_code}`,
          `Printing: ${describeOrder(orderFromRow(fresh))}`,
          `We'll let you know when it is ready.`
        ]).catch((error) => console.error(`Order ${row.order_code}: payment email failed:`, error.message));
      }
      let printing = false;
      if (printAgentEnabled() && isTelegramConfigured() && fs.existsSync(path.join(uploadDir, fresh.stored_name))) {
        printing = db.prepare("UPDATE orders SET print_status = 'queued', print_claimed_at = NULL WHERE order_code = ? AND (print_status IS NULL OR print_status = 'failed')")
          .run(row.order_code).changes === 1;
      }
      await notifyAdmin(printing
        ? `✅ Payment confirmed for ${row.order_code}. It is queued for the printer.`
        : `✅ Payment confirmed for ${row.order_code}. Print it from the order message above.`);
    } else if (outcome.to === "payment_problem") {
      const fresh = db.prepare("SELECT * FROM orders WHERE order_code = ?").get(row.order_code);
      sendPaymentEmail(fresh, `Problem with the payment for order ${row.order_code}`, [
        `We could not confirm your payment for order ${row.order_code}.`,
        `Please contact us and quote the order code so we can sort it out.`
      ]).catch((error) => console.error(`Order ${row.order_code}: payment email failed:`, error.message));
      await notifyAdmin(`⚠️ Payment for ${row.order_code} was declined in Grandlivre. The customer was emailed to contact you.`);
    }
  } catch (error) {
    console.error("Payment follow-up failed:", error);
  }
}

// Asks Grandlivre where an order's payments stand and applies them: the fallback for a missed webhook.
async function refreshPayment(orderCode) {
  const config = grandlivre();
  const row = db.prepare("SELECT pay_state FROM orders WHERE order_code = ?").get(orderCode);
  if (!config || !row?.pay_state) return null;
  db.prepare("UPDATE orders SET pay_checked_at = ? WHERE order_code = ?").run(Date.now(), orderCode);
  for (const notice of await fetchNotices(config, orderCode)) {
    await runPaymentEffects(applyPaymentEvent({ ...notice, event: `payment.${notice.state}` }, "poll"));
  }
  return db.prepare("SELECT pay_state FROM orders WHERE order_code = ?").get(orderCode).pay_state;
}

// Reported payments nobody has confirmed after a few minutes are checked directly.
async function checkReportedPayments() {
  if (!grandlivre()) return;
  const stale = sqlTimestamp(new Date(Date.now() - PAY_REPORTED_RECHECK_MINUTES * 60 * 1000));
  const rows = db.prepare(`
    SELECT order_code FROM orders
    WHERE pay_state = 'payment_reported' AND pay_state_at < ? AND (pay_checked_at IS NULL OR pay_checked_at < ?)
    LIMIT 20
  `).all(stale, Date.now() - 2 * 60 * 1000);
  for (const { order_code: orderCode } of rows) {
    await refreshPayment(orderCode).catch((error) => console.error(`Payment check for ${orderCode} failed:`, error.message));
  }
}

// Orders nobody paid for: drop the CV and the contact details, and close the payment link.
function expireUnpaidOrders() {
  const cutoff = sqlTimestamp(new Date(Date.now() - PAY_HOLD_HOURS * 60 * 60 * 1000));
  const rows = db.prepare("SELECT order_code, stored_name, pay_link_id FROM orders WHERE pay_state = 'awaiting_payment' AND created_at < ?").all(cutoff);
  for (const row of rows) {
    fs.rmSync(path.join(uploadDir, row.stored_name), { force: true });
    db.prepare(`
      UPDATE orders SET pay_state = 'expired', pay_state_at = ?, customer_email = ?, phone = NULL, location = NULL, original_name = ?
      WHERE order_code = ?
    `).run(sqlTimestamp(new Date()), DELETED_MARK, DELETED_MARK, row.order_code);
    closeLinkQuietly(row.pay_link_id);
  }
  return rows.length;
}

function closeLinkQuietly(linkId) {
  const config = grandlivre();
  if (!config || !linkId) return;
  closePayLink(config, linkId).catch((error) => console.error("Could not close a Grandlivre link:", error.message));
}

const allowStatusFromIp = createRateLimiter({ windowMs: 60 * 1000, max: 60 });
const allowWebhookFromIp = createRateLimiter({ windowMs: 60 * 1000, max: 120 });

function findOrderByKey(code, key) {
  if (!ORDER_CODE_PATTERN.test(code) || typeof key !== "string" || !/^[0-9a-f]{32}$/.test(key)) return null;
  const row = db.prepare("SELECT * FROM orders WHERE order_code = ? AND status_key IS NOT NULL").get(code);
  if (!row) return null;
  const received = Buffer.from(key);
  const expected = Buffer.from(row.status_key);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected) ? row : null;
}

const CUSTOMER_PAY_STATES = {
  awaiting_payment: "awaiting",
  payment_reported: "confirming",
  paid: "paid",
  payment_problem: "problem",
  payment_mismatch: "problem",
  manual_payment: "manual",
  expired: "expired",
  cancelled: "expired"
};

// What the customer's page shows. Asking again (reload, or a long wait) also lets us catch a missed webhook.
app.get("/api/orders/:code/status", (req, res, next) => {
  if (!allowStatusFromIp(req.ip)) {
    next(new UserError("too_many_requests", "Too many requests. Please try again in a few minutes.", 429));
    return;
  }
  (async () => {
    let row = findOrderByKey(req.params.code, req.get("X-Order-Key"));
    if (!row || !row.pay_state) {
      res.status(404).json({ error: "Order not found.", code: "not_found" });
      return;
    }
    const lingering = row.pay_state === "payment_reported"
      && row.pay_state_at < sqlTimestamp(new Date(Date.now() - PAY_REPORTED_RECHECK_MINUTES * 60 * 1000));
    const reloaded = req.query.reload === "1" && ["awaiting_payment", "payment_reported", "payment_problem"].includes(row.pay_state);
    if ((lingering || reloaded) && grandlivre() && (!row.pay_checked_at || row.pay_checked_at < Date.now() - 20 * 1000)) {
      await refreshPayment(row.order_code).catch((error) => console.error(`Payment check for ${row.order_code} failed:`, error.message));
      row = db.prepare("SELECT * FROM orders WHERE order_code = ?").get(row.order_code);
    }
    const state = CUSTOMER_PAY_STATES[row.pay_state] || "problem";
    res.set("Cache-Control", "no-store").json({
      state,
      orderCode: row.order_code,
      amount: (row.price_cents / 100).toFixed(2),
      ...(state === "awaiting" && row.pay_link_token ? { token: row.pay_link_token } : {})
    });
  })().catch(next);
});

// "Start over": drop an order that has not been paid, close its link and delete its CV.
app.post("/api/orders/:code/cancel", express.json({ limit: "1kb" }), (req, res, next) => {
  if (!allowStatusFromIp(req.ip)) {
    next(new UserError("too_many_requests", "Too many requests. Please try again in a few minutes.", 429));
    return;
  }
  const row = findOrderByKey(req.params.code, req.body?.key);
  if (!row || row.pay_state !== "awaiting_payment") {
    res.status(404).json({ error: "Order not found.", code: "not_found" });
    return;
  }
  fs.rmSync(path.join(uploadDir, row.stored_name), { force: true });
  db.prepare(`
    UPDATE orders SET pay_state = 'cancelled', pay_state_at = ?, customer_email = ?, phone = NULL, location = NULL, original_name = ?
    WHERE order_code = ?
  `).run(sqlTimestamp(new Date()), DELETED_MARK, DELETED_MARK, row.order_code);
  closeLinkQuietly(row.pay_link_id);
  res.sendStatus(204);
});

// Grandlivre tells us when a payment is reported, confirmed or declined. Only the signature decides who may call.
app.post("/grandlivre/webhook", (req, res, next) => {
  if (!allowWebhookFromIp(req.ip)) {
    res.sendStatus(429);
    return;
  }
  next();
}, express.raw({ type: () => true, limit: "100kb" }), (req, res) => {
  const config = grandlivre();
  const delivery = String(req.get("X-Grandlivre-Delivery") || "").slice(0, 80);
  const eventName = String(req.get("X-Grandlivre-Event") || "").slice(0, 40);
  if (!config || !Buffer.isBuffer(req.body)
    || !verifySignature({ header: req.get("X-Grandlivre-Signature"), rawBody: req.body, secret: config.secret })) {
    console.warn(`Grandlivre webhook rejected: delivery=${delivery} event=${eventName}`);
    res.status(401).json({ error: "Invalid signature.", code: "bad_signature" });
    return;
  }
  let body;
  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid request.", code: "bad_request" });
    return;
  }
  if (body?.test === true || eventName === "payment.test") {
    console.log(`Grandlivre test delivery received: delivery=${delivery}`);
    res.json({ ok: true, test: true });
    return;
  }
  const outcome = applyPaymentEvent({ ...body, event: eventName || body?.event, delivery }, "webhook");
  console.log(`Grandlivre delivery=${delivery} event=${eventName} order=${String(body?.ref || "").slice(0, 20)} result=${outcome.result}`);
  res.json({ ok: true });
  runPaymentEffects(outcome);
});
app.all("/grandlivre/webhook", (_req, res) => res.set("Allow", "POST").sendStatus(405));

function isAuthorizedAgent(req) {
  const token = process.env.PRINT_AGENT_TOKEN;
  if (!token) return false;
  const match = /^Bearer (.+)$/.exec(req.get("Authorization") || "");
  if (!match) return false;
  const received = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function requireAgent(req, res, next) {
  if (!isAuthorizedAgent(req)) {
    res.status(401).json({ error: "Unauthorized.", code: "unauthorized" });
    return;
  }
  res.set("Cache-Control", "no-store");
  next();
}

// The printer's computer asks for work. A job is handed out only after the Print button was tapped.
app.get("/api/agent/next", requireAgent, async (_req, res) => {
  db.prepare(`
    UPDATE orders SET print_status = 'queued'
    WHERE print_status = 'printing' AND print_claimed_at < ?
  `).run(sqlTimestamp(new Date(Date.now() - PRINT_CLAIM_TIMEOUT_MINUTES * 60 * 1000)));

  for (;;) {
    const job = db.prepare(`
      SELECT order_code, stored_name, original_name, copies FROM orders
      WHERE print_status = 'queued' ORDER BY id LIMIT 1
    `).get();
    if (!job) {
      res.sendStatus(204);
      return;
    }
    if (!fs.existsSync(path.join(uploadDir, job.stored_name))) {
      db.prepare("UPDATE orders SET print_status = 'failed' WHERE order_code = ?").run(job.order_code);
      await notifyAdmin(`⚠️ ${job.order_code} could not be printed: the file is no longer on the server. Print it from this chat by hand.`);
      continue;
    }
    db.prepare("UPDATE orders SET print_status = 'printing', print_claimed_at = ? WHERE order_code = ?")
      .run(sqlTimestamp(new Date()), job.order_code);
    res.json({
      orderCode: job.order_code,
      copies: job.copies,
      extension: path.extname(job.stored_name).toLowerCase()
    });
    return;
  }
});

function findClaimedJob(req, res) {
  const orderCode = req.params.orderCode;
  const job = ORDER_CODE_PATTERN.test(orderCode)
    ? db.prepare("SELECT order_code, stored_name FROM orders WHERE order_code = ? AND print_status = 'printing'").get(orderCode)
    : null;
  if (!job) res.status(404).json({ error: "No such job.", code: "job_not_found" });
  return job;
}

app.get("/api/agent/jobs/:orderCode/file", requireAgent, (req, res) => {
  const job = findClaimedJob(req, res);
  if (!job) return;
  res.type("application/octet-stream").sendFile(path.join(uploadDir, job.stored_name));
});

app.post("/api/agent/jobs/:orderCode/done", requireAgent, express.json({ limit: "10kb" }), async (req, res) => {
  const job = findClaimedJob(req, res);
  if (!job) return;
  if (req.body?.ok === true) {
    fs.rmSync(path.join(uploadDir, job.stored_name), { force: true });
    db.prepare("UPDATE orders SET print_status = 'printed' WHERE order_code = ?").run(job.order_code);
    await notifyAdmin(`🖨 Sent to the printer: ${job.order_code}. Tap "Order ready" once the customer has it.`);
    const used = db.prepare("SELECT copies, pages FROM orders WHERE order_code = ?").get(job.order_code);
    const paperAlert = paperTray.use(used.copies * (used.pages || 1));
    if (paperAlert === "empty") await notifyAdmin("📄 The tray should be empty now. Load paper and send /paper <sheets>.");
    else if (paperAlert) await notifyAdmin(`📄 ${describePaper()}. Time to think about refilling.`);
  } else {
    const reason = String(req.body?.error || "unknown error").slice(0, 200);
    db.prepare("UPDATE orders SET print_status = 'failed' WHERE order_code = ?").run(job.order_code);
    await notifyAdmin(`⚠️ Printing ${job.order_code} failed: ${reason}\nTap "Print on printer" to try again.`);
  }
  res.sendStatus(204);
});

app.post("/api/agent/status", requireAgent, express.json({ limit: "10kb" }), (req, res) => {
  const body = req.body || {};
  printerStatus = {
    receivedAt: Date.now(),
    printer: cleanText(body.printer, 40),
    state: cleanText(body.state, 20) || "unknown",
    reasons: cleanText(body.reasons, 80),
    alert: cleanText(body.alert, 80),
    markers: (Array.isArray(body.markers) ? body.markers : []).slice(0, 8).map((marker) => ({
      name: cleanText(marker?.name, 20) || "Toner",
      level: cleanPercent(marker?.level),
      low: cleanPercent(marker?.low)
    })),
    media: (Array.isArray(body.media) ? body.media : []).slice(0, 6).map((size) => cleanText(size, 30)).filter(Boolean)
  };
  res.sendStatus(204);
});

// Public and deliberately coarse: the main page shows a green light when the printer can take orders now.
// "online": the agent reported in the last few minutes and the printer is ready; "attention": the agent is there
// but the printer needs a person (paper, toner, jam, door); "offline": no recent report from the agent.
function publicPrinterState() {
  if (!printerStatus) return "offline";
  if (Date.now() - printerStatus.receivedAt >= PRINTER_STATUS_STALE_MINUTES * 60000) return "offline";
  if (printerStatus.state === "stopped" || /empty|jam|open|offline|error/i.test(printerStatus.reasons || "")) return "attention";
  return "online";
}

app.get("/api/printer-status", (_req, res) => {
  res.set("Cache-Control", "no-store").json({ status: publicPrinterState() });
});

app.post("/api/telegram-webhook",express.json({ limit: "100kb" }), (req, res) => {
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

export { app, checkReportedPayments, db, ensurePayLink, expireUnpaidOrders, linkFetcher, mailLog, pageCounter, pdfConverter, priceCents, receiptChecker, refreshPayment, runRetention };

// PM2 loads the script through its own wrapper, so argv[1] is not this file there.
const entryCandidates = [process.argv[1], process.env.pm_exec_path].filter(Boolean);
if (entryCandidates.some((candidate) => path.resolve(candidate) === fileURLToPath(import.meta.url))) {
  app.listen(port, host, () => {
    console.log(`${shopName} is running at http://${host}:${port}`);
    registerTelegramWebhook();
    runRetention();
    setInterval(runRetention, 12 * 60 * 60 * 1000).unref();
    setInterval(expireUnpaidOrders, 60 * 60 * 1000).unref();
    setInterval(() => checkReportedPayments().catch((error) => console.error("Payment recheck failed:", error.message)), 2 * 60 * 1000).unref();
  });
}
