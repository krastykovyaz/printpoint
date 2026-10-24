import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";

// Must run before server.js is imported: keeps tests away from the real .env, database and uploads.
export function isolateEnvironment(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-test-"));
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: "/dev/null",
    DATA_DIR: path.join(root, "data"),
    UPLOAD_DIR: path.join(root, "uploads"),
    GMAIL_USER: "shop@example.test",
    GMAIL_APP_PASSWORD: "not-a-real-password",
    PRINT_SHOP_EMAIL: "shop@example.test",
    MAIL_TRANSPORT: "json",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    TELEGRAM_WEBHOOK_SECRET: "test-secret",
    ORDER_RATE_LIMIT: "1000",
    ORDER_DAILY_LIMIT: "1000",
    ...overrides
  });
  return root;
}

export async function startServer() {
  const { app, db, linkFetcher, mailLog, runRetention } = await import("../server.js");
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  return { server, db, linkFetcher, mailLog, runRetention, base: `http://127.0.0.1:${server.address().port}` };
}

export const PDF = new Blob(["%PDF-1.4 test resume"], { type: "application/pdf" });
export const PNG = new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" });

export function orderForm(fields = {}, files = { resume: [PDF, "resume.pdf"] }) {
  const form = new FormData();
  const values = { email: "customer@example.test", copies: "4", printMode: "black-white", ...fields };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) form.append(key, value);
  }
  for (const [key, [blob, name]] of Object.entries(files)) {
    form.append(key, blob, name);
  }
  return form;
}

export async function postOrder(base, form) {
  const response = await fetch(`${base}/api/orders`, { method: "POST", body: form });
  return { status: response.status, body: await response.json() };
}

// A stand-in for api.telegram.org that records every call (with its raw body) and numbers the messages it "sends".
export async function startFakeTelegram() {
  const calls = [];
  let nextMessageId = 100;
  const server = await new Promise((resolve) => {
    const listener = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const method = req.url.split("/").pop();
        calls.push({ method, body: Buffer.concat(chunks).toString("utf8") });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, result: method === "sendDocument" ? { message_id: nextMessageId++ } : true }));
      });
    }).listen(0, "127.0.0.1", () => resolve(listener));
  });
  return {
    server,
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    url: `http://127.0.0.1:${server.address().port}`
  };
}

export async function until(condition) {
  for (let i = 0; i < 150; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the server");
}

export function postWebhook(base, update) {
  return fetch(`${base}/api/telegram-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
    body: JSON.stringify(update)
  });
}
