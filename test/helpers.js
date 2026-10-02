import fs from "node:fs";
import os from "node:os";
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
  const { app, db, runRetention } = await import("../server.js");
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  return { server, db, runRetention, base: `http://127.0.0.1:${server.address().port}` };
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
