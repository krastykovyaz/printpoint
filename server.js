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
const port = Number(process.env.PORT) || 3030;
const shopName = process.env.SHOP_NAME || "PrintPoint";
const uploadDir = path.join(__dirname, "uploads");
const dataDir = path.join(__dirname, "data");

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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name);
for (const column of ["payment_proof_name", "phone", "location"]) {
  if (!orderColumns.includes(column)) {
    db.exec(`ALTER TABLE orders ADD COLUMN ${column} TEXT`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const allowedResumeMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
const allowedResumeExtensions = new Set([".pdf", ".doc", ".docx"]);

const allowedProofMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const allowedProofExtensions = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === "paymentProof") {
      if (allowedProofMimeTypes.has(file.mimetype) || allowedProofExtensions.has(extension)) {
        cb(null, true);
        return;
      }
      cb(new Error("Payment proof must be a PDF, JPG, PNG, or WEBP file."));
      return;
    }
    if (allowedResumeMimeTypes.has(file.mimetype) || allowedResumeExtensions.has(extension)) {
      cb(null, true);
      return;
    }
    cb(new Error("Please upload a PDF, DOC, or DOCX file."));
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
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

function formatMode(mode) {
  return mode === "color" ? "Color" : "Black & white";
}

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function sendTelegramDocument({ filePath, filename, caption, replyMarkup }) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`;
  const form = new FormData();
  form.append("chat_id", process.env.TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append("document", new Blob([fs.readFileSync(filePath)]), filename);
  if (replyMarkup) {
    form.append("reply_markup", JSON.stringify(replyMarkup));
  }

  const response = await fetch(url, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`Telegram API responded with ${response.status}`);
  }
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text })
  });
}

async function answerTelegramCallback(callbackQueryId, text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

async function downloadTelegramFile(fileId) {
  const infoResponse = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoResponse.json();
  if (!info.ok) throw new Error("Could not resolve Telegram file path");

  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`;
  const fileResponse = await fetch(fileUrl);
  if (!fileResponse.ok) throw new Error("Could not download Telegram file");
  return Buffer.from(await fileResponse.arrayBuffer());
}

// chat_id -> orderCode, set when "Order ready" is clicked, cleared once the pickup photo arrives.
const pendingLocationPhotoRequests = new Map();

async function registerTelegramWebhook() {
  if (!isTelegramConfigured() || !process.env.PUBLIC_URL) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `${process.env.PUBLIC_URL}/api/telegram-webhook`,
        secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined
      })
    });
    const result = await response.json();
    if (!result.ok) console.error("Failed to register Telegram webhook:", result);

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [{ command: "stats", description: "Show website visit counts" }]
      })
    });
  } catch (error) {
    console.error("Failed to register Telegram webhook:", error);
  }
}

function getVisitStats() {
  const countSince = (table, sinceClause) =>
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${sinceClause ? `WHERE ${sinceClause}` : ""}`).get().count;

  const visitsToday = countSince("page_views", "date(created_at) = date('now')");
  const visits7Days = countSince("page_views", "created_at >= datetime('now', '-7 days')");
  const visitsTotal = countSince("page_views");

  const ordersToday = countSince("orders", "date(created_at) = date('now')");
  const orders7Days = countSince("orders", "created_at >= datetime('now', '-7 days')");
  const ordersTotal = countSince("orders");

  return {
    today: { visits: visitsToday, orders: ordersToday },
    last7Days: { visits: visits7Days, orders: orders7Days },
    total: { visits: visitsTotal, orders: ordersTotal }
  };
}

const ORDER_STATUSES = {
  printing: {
    label: "Printing",
    subject: (orderCode) => `Update on your print order ${orderCode}`,
    body: (orderCode) => [
      `Good news — we've started printing your order ${orderCode}.`,
      `We'll let you know as soon as it's ready.`,
      ``,
      `This is an automated message, please do not reply.`
    ].join("\n")
  },
  delivery: {
    label: "Delivery",
    subject: (orderCode) => `Your print order ${orderCode} is out for delivery`,
    body: (orderCode) => [
      `Your order ${orderCode} is on its way to you.`,
      ``,
      `This is an automated message, please do not reply.`
    ].join("\n")
  },
  ready: {
    label: "Order ready",
    subject: (orderCode) => `Your print order ${orderCode} is ready!`,
    body: (orderCode) => [
      `Your order ${orderCode} has been printed and is ready.`,
      ``,
      `This is an automated message, please do not reply.`
    ].join("\n")
  }
};

app.post("/api/track-visit", (_req, res) => {
  db.prepare("INSERT INTO page_views DEFAULT VALUES").run();
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

const indexHtmlTemplate = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");

app.get("/", (req, res) => {
  const lang = OG_TRANSLATIONS[req.query.lang] ? req.query.lang : "en";
  const og = OG_TRANSLATIONS[lang];
  const title = escapeHtmlAttr(og.title);
  const description = escapeHtmlAttr(og.description);

  const html = indexHtmlTemplate
    .replace('<html lang="en">', `<html lang="${lang}">`)
    .replace("<title>Print Point — Resume printing</title>", `<title>${title}</title>`)
    .replaceAll('content="Print Point — Resume printing"', `content="${title}"`)
    .replace(/content="Attach your resume, choose copies & color, pay, and get it printed\."/g, `content="${description}"`)
    .replace("</head>", `    <meta property="og:locale" content="${og.locale}" />\n  </head>`);

  res.type("html").send(html);
});

app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.post("/api/orders", upload.fields([{ name: "resume", maxCount: 1 }, { name: "paymentProof", maxCount: 1 }]), async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = String(req.body.phone || "").trim();
    const location = String(req.body.location || "").trim();
    const copies = Number(req.body.copies);
    const printMode = String(req.body.printMode || "");
    const resumeFile = req.files?.resume?.[0];
    const paymentProofFile = req.files?.paymentProof?.[0];

    const cleanupUploads = () => {
      if (resumeFile) fs.unlinkSync(resumeFile.path);
      if (paymentProofFile) fs.unlinkSync(paymentProofFile.path);
    };

    if (!resumeFile) {
      if (paymentProofFile) fs.unlinkSync(paymentProofFile.path);
      return res.status(400).json({ error: "Please attach your resume." });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      cleanupUploads();
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (!Number.isInteger(copies) || copies < 4 || copies > 100) {
      cleanupUploads();
      return res.status(400).json({ error: "Choose between 4 and 100 copies." });
    }
    if (!new Set(["black-white", "color"]).has(printMode)) {
      cleanupUploads();
      return res.status(400).json({ error: "Choose black & white or color printing." });
    }
    if (!isConfigured()) {
      cleanupUploads();
      return res.status(503).json({
        error: "Email delivery is not configured yet. Add Gmail settings to the .env file."
      });
    }

    const orderCode = `QP-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const order = {
      orderCode,
      customerEmail: email,
      phone: phone || null,
      location: location || null,
      copies,
      printMode,
      originalName: resumeFile.originalname,
      storedName: resumeFile.filename,
      paymentProofName: paymentProofFile ? paymentProofFile.filename : null
    };

    db.prepare(`
      INSERT INTO orders (order_code, customer_email, phone, location, copies, print_mode, original_name, stored_name, payment_proof_name)
      VALUES (@orderCode, @customerEmail, @phone, @location, @copies, @printMode, @originalName, @storedName, @paymentProofName)
    `).run(order);

    try {
      const transporter = makeTransporter();
      const details = `${copies} ${copies === 1 ? "copy" : "copies"} · ${formatMode(printMode)}`;

      const shopAttachments = [{ filename: resumeFile.originalname, path: resumeFile.path }];
      if (paymentProofFile) {
        shopAttachments.push({ filename: paymentProofFile.originalname, path: paymentProofFile.path });
      }

      await transporter.sendMail({
        from: `"${shopName}" <${process.env.GMAIL_USER}>`,
        to: process.env.PRINT_SHOP_EMAIL,
        replyTo: email,
        subject: paymentProofFile ? `New print order ${orderCode}` : `[NO PAYMENT YET] New print order ${orderCode}`,
        text: [
          `New print order: ${orderCode}`,
          `Customer email: ${email}`,
          `Phone: ${phone || "not provided"}`,
          `Pickup/delivery location: ${location || "not provided"}`,
          `Printing: ${details}`,
          `Attached file: ${resumeFile.originalname}`,
          paymentProofFile
            ? `Payment proof: ${paymentProofFile.originalname}`
            : `Payment proof: ⚠️ NOT ATTACHED — customer submitted without paying yet`
        ].join("\n"),
        attachments: shopAttachments
      });

      await transporter.sendMail({
        from: `"${shopName}" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: `We received your print order ${orderCode}`,
        text: [
          `Thanks — we received your resume print request.`,
          `Order: ${orderCode}`,
          `Printing: ${details}`,
          `We'll be in touch if anything else is needed.`
        ].join("\n")
      });
    } catch (error) {
      console.error("Could not send email:", error);
      return res.status(502).json({
        error: "Your file was saved, but the email could not be delivered. Check the Gmail settings and try again."
      });
    }

    if (isTelegramConfigured()) {
      try {
        const details = `${copies} ${copies === 1 ? "copy" : "copies"} · ${formatMode(printMode)}`;
        await sendTelegramDocument({
          filePath: resumeFile.path,
          filename: resumeFile.originalname,
          caption: [
            `New print order ${orderCode}`,
            `Customer email: ${email}`,
            `Phone: ${phone || "not provided"}`,
            `Pickup/delivery: ${location || "not provided"}`,
            `Printing: ${details}`,
            paymentProofFile ? `Payment: receipt attached` : `Payment: ⚠️ NOT PAID YET`
          ].join("\n"),
          replyMarkup: {
            inline_keyboard: [
              [
                { text: "🖨 Printing", callback_data: `printing:${orderCode}` },
                { text: "🚚 Delivery", callback_data: `delivery:${orderCode}` }
              ],
              [{ text: "✅ Order ready", callback_data: `ready:${orderCode}` }]
            ]
          }
        });
        if (paymentProofFile) {
          await sendTelegramDocument({
            filePath: paymentProofFile.path,
            filename: paymentProofFile.originalname,
            caption: `Payment proof for order ${orderCode}`
          });
        }
      } catch (error) {
        console.error("Could not send Telegram notification:", error);
      }
    }

    return res.status(201).json({
      orderCode,
      message: "Your print request is on its way. Check your email for confirmation."
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/telegram-webhook", express.json(), async (req, res) => {
  res.sendStatus(200);

  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    const receivedSecret = req.get("X-Telegram-Bot-Api-Secret-Token");
    if (receivedSecret !== process.env.TELEGRAM_WEBHOOK_SECRET) return;
  }

  const incomingMessage = req.body?.message;
  const incomingPhoto = incomingMessage?.photo;
  if (incomingPhoto && incomingPhoto.length) {
    const chatId = incomingMessage.chat?.id;
    const orderCode = pendingLocationPhotoRequests.get(chatId);
    if (!orderCode) return;

    pendingLocationPhotoRequests.delete(chatId);
    try {
      const order = db.prepare("SELECT customer_email FROM orders WHERE order_code = ?").get(orderCode);
      if (!order) {
        await sendTelegramMessage(`Order ${orderCode} not found — photo not sent.`);
        return;
      }
      const largestPhoto = incomingPhoto[incomingPhoto.length - 1];
      const photoBuffer = await downloadTelegramFile(largestPhoto.file_id);

      const transporter = makeTransporter();
      await transporter.sendMail({
        from: `"${shopName}" <${process.env.GMAIL_USER}>`,
        to: order.customer_email,
        subject: ORDER_STATUSES.ready.subject(orderCode),
        text: ORDER_STATUSES.ready.body(orderCode),
        html: [
          `<p>Your order ${orderCode} has been printed and is ready.</p>`,
          `<p>Here's where to pick it up:</p>`,
          `<p><img src="cid:pickup-location" alt="Pickup location" style="max-width:100%;height:auto;" /></p>`,
          `<p style="color:#888;font-size:12px;">This is an automated message, please do not reply.</p>`
        ].join("\n"),
        attachments: [{ filename: "pickup-location.jpg", content: photoBuffer, cid: "pickup-location" }]
      });

      await sendTelegramMessage(`✅ Client notified: Order ready (with pickup photo)`);
    } catch (error) {
      console.error("Could not send ready email with pickup photo:", error);
      await sendTelegramMessage("Failed to send the pickup photo email — check server logs.");
    }
    return;
  }

  const messageText = incomingMessage?.text;
  if (messageText && messageText.split("@")[0] === "/stats") {
    const stats = getVisitStats();
    const formatLine = (label, { visits, orders }) =>
      `${label}: ${visits} visited, ${orders} ordered, ${Math.max(0, visits - orders)} didn't order`;

    await sendTelegramMessage(
      [
        `📊 Website visits vs orders`,
        formatLine("Today", stats.today),
        formatLine("Last 7 days", stats.last7Days),
        formatLine("All time", stats.total)
      ].join("\n")
    );
    return;
  }

  const callbackQuery = req.body?.callback_query;
  if (!callbackQuery || !callbackQuery.data) return;

  const [action, orderCode] = callbackQuery.data.split(":");
  const status = ORDER_STATUSES[action];
  if (!status || !orderCode) return;

  try {
    const order = db.prepare("SELECT customer_email FROM orders WHERE order_code = ?").get(orderCode);
    if (!order) {
      await answerTelegramCallback(callbackQuery.id, "Order not found.");
      return;
    }
    if (!isConfigured()) {
      await answerTelegramCallback(callbackQuery.id, "Email is not configured.");
      return;
    }

    if (action === "ready") {
      pendingLocationPhotoRequests.set(callbackQuery.message.chat.id, orderCode);
      await sendTelegramMessage(`📸 Send a photo of the pickup location for order ${orderCode} — I'll include it in the "ready" email to the customer.`);
      await answerTelegramCallback(callbackQuery.id, "Send the pickup photo now.");
      return;
    }

    const transporter = makeTransporter();
    await transporter.sendMail({
      from: `"${shopName}" <${process.env.GMAIL_USER}>`,
      to: order.customer_email,
      subject: status.subject(orderCode),
      text: status.body(orderCode)
    });

    await answerTelegramCallback(callbackQuery.id, `✅ Client notified: ${status.label}`);
  } catch (error) {
    console.error("Could not handle Telegram status button:", error);
    await answerTelegramCallback(callbackQuery.id, "Failed to notify client — check server logs.");
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "Your file must be 10 MB or smaller." });
  }
  if (error.message) {
    return res.status(400).json({ error: error.message });
  }
  console.error(error);
  return res.status(500).json({ error: "Something went wrong. Please try again." });
});

export { app };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, () => {
    console.log(`${shopName} is running at http://localhost:${port}`);
    registerTelegramWebhook();
  });
}
