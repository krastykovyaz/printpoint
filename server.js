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
const shopName = process.env.SHOP_NAME || "QuickPrint";
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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const allowedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
const allowedExtensions = new Set([".pdf", ".doc", ".docx"]);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (allowedMimeTypes.has(file.mimetype) || allowedExtensions.has(extension)) {
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

app.use(express.static(path.join(__dirname, "public")));

app.post("/api/orders", upload.single("resume"), async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const copies = Number(req.body.copies);
    const printMode = String(req.body.printMode || "");

    if (!req.file) {
      return res.status(400).json({ error: "Please attach your resume." });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Choose between 1 and 100 copies." });
    }
    if (!new Set(["black-white", "color"]).has(printMode)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Choose black & white or color printing." });
    }
    if (!isConfigured()) {
      fs.unlinkSync(req.file.path);
      return res.status(503).json({
        error: "Email delivery is not configured yet. Add Gmail settings to the .env file."
      });
    }

    const orderCode = `QP-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const order = {
      orderCode,
      customerEmail: email,
      copies,
      printMode,
      originalName: req.file.originalname,
      storedName: req.file.filename
    };

    db.prepare(`
      INSERT INTO orders (order_code, customer_email, copies, print_mode, original_name, stored_name)
      VALUES (@orderCode, @customerEmail, @copies, @printMode, @originalName, @storedName)
    `).run(order);

    try {
      const transporter = makeTransporter();
      const details = `${copies} ${copies === 1 ? "copy" : "copies"} · ${formatMode(printMode)}`;

      await transporter.sendMail({
        from: `"${shopName}" <${process.env.GMAIL_USER}>`,
        to: process.env.PRINT_SHOP_EMAIL,
        replyTo: email,
        subject: `New print order ${orderCode}`,
        text: [
          `New print order: ${orderCode}`,
          `Customer email: ${email}`,
          `Printing: ${details}`,
          `Attached file: ${req.file.originalname}`
        ].join("\n"),
        attachments: [{ filename: req.file.originalname, path: req.file.path }]
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

    return res.status(201).json({
      orderCode,
      message: "Your print request is on its way. Check your email for confirmation."
    });
  } catch (error) {
    return next(error);
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
  });
}
