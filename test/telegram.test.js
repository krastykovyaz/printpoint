import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { isolateEnvironment, orderForm, PDF, PNG, postOrder, postWebhook, startFakeTelegram, startServer, until } from "./helpers.js";

const fake = await startFakeTelegram();
const { calls, callsTo } = fake;

isolateEnvironment({
  TELEGRAM_API_BASE: fake.url,
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "42"
});

let ctx;
before(async () => {
  ctx = await startServer();
});
after(() => {
  ctx.server.close();
  fake.server.close();
});

const webhook = (update) => postWebhook(ctx.base, update);

test("files go to Telegram only; the server and the inbox keep nothing", async () => {
  ctx.mailLog.length = 0;
  const { status, body } = await postOrder(ctx.base, orderForm({ phone: "+352 1" }, { resume: [PDF, "resume.pdf"], paymentProof: [PNG, "receipt.png"] }));
  assert.equal(status, 201);
  assert.equal(callsTo("sendDocument").length, 2);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR), []);

  const shopMail = ctx.mailLog.find((mail) => mail.to?.[0]?.address === "shop@example.test");
  assert.equal(shopMail.attachments, undefined);
  assert.doesNotMatch(shopMail.text, /customer@example\.test|\+352/);
  assert.match(shopMail.text, new RegExp(body.orderCode));

  const row = ctx.db.prepare("SELECT telegram_messages FROM orders WHERE order_code = ?").get(body.orderCode);
  assert.deepEqual(JSON.parse(row.telegram_messages), [100, 101]);
});

test("marking an order ready emails the customer, then erases the Telegram copies and contact details", async () => {
  const { body } = await postOrder(ctx.base, orderForm({ phone: "+352 2", location: "Belval" }, { resume: [PDF, "resume.pdf"], paymentProof: [PNG, "receipt.png"] }));
  const ids = JSON.parse(ctx.db.prepare("SELECT telegram_messages FROM orders WHERE order_code = ?").get(body.orderCode).telegram_messages);
  ctx.mailLog.length = 0;
  callsTo("deleteMessage").length = 0;

  await webhook({ callback_query: { id: "cb1", data: `ready:${body.orderCode}`, message: { chat: { id: 42 } } } });
  await until(() => callsTo("answerCallbackQuery").length > 0);
  await webhook({ message: { chat: { id: 42 }, text: "/skip" } });
  const customerEmail = () => ctx.db.prepare("SELECT customer_email FROM orders WHERE order_code = ?").get(body.orderCode).customer_email;
  await until(() => customerEmail() === "[deleted]");

  assert.equal(callsTo("deleteMessage").length, ids.length);
  assert.ok(ctx.mailLog.some((mail) => mail.to?.[0]?.address === "customer@example.test"));
  const row = ctx.db.prepare("SELECT * FROM orders WHERE order_code = ?").get(body.orderCode);
  assert.equal(row.customer_email, "[deleted]");
  assert.equal(row.phone, null);
  assert.equal(row.location, null);
  assert.equal(row.telegram_messages, null);
});

test("an order whose Telegram upload fails falls back to email with the files attached", async () => {
  const realBase = process.env.TELEGRAM_API_BASE;
  process.env.TELEGRAM_API_BASE = "http://127.0.0.1:1";
  try {
    ctx.mailLog.length = 0;
    const { status } = await postOrder(ctx.base, orderForm());
    assert.equal(status, 201);
    const shopMail = ctx.mailLog.find((mail) => mail.to?.[0]?.address === "shop@example.test");
    assert.equal(shopMail.attachments.length, 1);
    assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR), []);
  } finally {
    process.env.TELEGRAM_API_BASE = realBase;
  }
});
