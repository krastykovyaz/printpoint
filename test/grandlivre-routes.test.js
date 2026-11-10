import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { after, before, test } from "node:test";
import { isolateEnvironment, orderForm, PDF, postOrder, postWebhook, startFakeTelegram, startServer, until } from "./helpers.js";

const SECRET = "whsec_test_secret";
const KEY = "glk_test_key";

// A stand-in for Grandlivre: records calls, hands out links, serves canned payment notices.
const gl = { calls: [], mode: "ok", notices: {}, nextId: 1 };
gl.server = await new Promise((resolve) => {
  const listener = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url, "http://x");
      gl.calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && url.pathname === "/api/v1/pay-links") {
        if (gl.mode === "down") return res.writeHead(503).end("{}");
        const n = gl.nextId++;
        return res.end(JSON.stringify({ link: { id: `lnk_${n}`, token: `TOK${n}`, url: `${gl.url}/pay/TOK${n}`, ref: JSON.parse(raw).ref } }));
      }
      if (req.method === "GET" && url.pathname === "/api/v1/notices") {
        return res.end(JSON.stringify({ notices: gl.notices[url.searchParams.get("ref")] || [] }));
      }
      if (req.method === "DELETE") return res.end(JSON.stringify({ ok: true }));
      res.writeHead(404).end("{}");
    });
  }).listen(0, "127.0.0.1", () => resolve(listener));
});
gl.url = `http://127.0.0.1:${gl.server.address().port}`;

const tg = await startFakeTelegram();
isolateEnvironment({
  GRANDLIVRE_URL: gl.url, GRANDLIVRE_KEY: KEY, GRANDLIVRE_WEBHOOK_SECRET: SECRET,
  TELEGRAM_API_BASE: tg.url, TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "42",
  PRINT_AGENT_TOKEN: "agent-secret"
});

let ctx;
before(async () => {
  ctx = await startServer();
});
after(() => {
  ctx.server.close();
  gl.server.close();
  tg.server.close();
});

const uploads = () => fs.readdirSync(process.env.UPLOAD_DIR);
const row = (code) => ctx.db.prepare("SELECT * FROM orders WHERE order_code = ?").get(code);
const glCalls = (method, pathname) => gl.calls.filter((call) => call.method === method && call.path === pathname);
const shopMessages = () => tg.callsTo("sendDocument").filter((call) => call.body.includes("New print order"));
const adminTexts = () => tg.callsTo("sendMessage").map((call) => JSON.parse(call.body).text);
const shopMail = () => ctx.mailLog.filter((mail) => mail.to?.[0]?.address === "shop@example.test");
const customerMail = () => ctx.mailLog.filter((mail) => mail.to?.[0]?.address === "customer@example.test");
const statusOf = (order, { key = order.statusKey, reload = false } = {}) =>
  fetch(`${ctx.base}/api/orders/${order.orderCode}/status${reload ? "?reload=1" : ""}`, { headers: key ? { "X-Order-Key": key } : {} });

async function newOrder(fields = {}) {
  gl.mode = "ok";
  const { status, body } = await postOrder(ctx.base, orderForm({ copies: "5", ...fields }, { resume: [PDF, "cv.pdf"] }));
  assert.equal(status, 201);
  assert.equal(body.mode, "grandlivre");
  return body;
}

function payload(order, overrides = {}) {
  const r = row(order.orderCode);
  return {
    event: "payment.reported", notice: `n-${crypto.randomUUID()}`, link: r.pay_link_id, ref: order.orderCode, state: "reported",
    amount: 2.5, currency: "EUR", payerName: "Krasty", known: false, receipt: true,
    reportedAt: new Date().toISOString(), confirmedAt: null, at: new Date().toISOString(), ...overrides
  };
}

async function deliver(body, { secret = SECRET, t = Math.floor(Date.now() / 1000), tamper = false, method = "POST", header, delivery = `d-${crypto.randomUUID()}` } = {}) {
  const raw = JSON.stringify(body);
  const signature = header ?? `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
  return fetch(`${ctx.base}/grandlivre/webhook`, {
    method,
    headers: { "Content-Type": "application/json", "X-Grandlivre-Signature": signature, "X-Grandlivre-Event": body.event || "", "X-Grandlivre-Delivery": delivery },
    body: method === "POST" ? (tamper ? raw.replace("2.5", "0.1") : raw) : undefined
  });
}

test("pressing Pay creates the order at the server's price, makes one link with the order code, and tells nobody yet", async () => {
  const before = gl.calls.length;
  const { status, body } = await postOrder(ctx.base, orderForm({ copies: "5", amount: "0.01", price: "1", total: "0.01" }, { resume: [PDF, "cv.pdf"] }));
  assert.equal(status, 201);
  assert.equal(body.mode, "grandlivre");
  assert.equal(body.amount, "2.50");
  assert.match(body.statusKey, /^[0-9a-f]{32}$/);

  const created = gl.calls.slice(before).filter((call) => call.method === "POST");
  assert.equal(created.length, 1);
  assert.equal(created[0].auth, `Bearer ${KEY}`);
  assert.deepEqual(created[0].body, { title: `Print order #${body.orderCode}`, amount: 2.5, currency: "EUR", ref: body.orderCode });

  const r = row(body.orderCode);
  assert.equal(r.pay_state, "awaiting_payment");
  assert.equal(r.price_cents, 250);
  assert.equal(r.pay_link_token, body.token);
  assert.equal(uploads().length >= 1, true);
  assert.equal(shopMessages().some((call) => call.body.includes(body.orderCode)), false);
  assert.equal(shopMail().some((mail) => mail.text?.includes(body.orderCode)), false);
});

test("the status page needs the order's secret key and shows the payment window's token while unpaid", async () => {
  const order = await newOrder();
  assert.equal((await statusOf(order, { key: null })).status, 404);
  assert.equal((await statusOf(order, { key: "0".repeat(32) })).status, 404);
  assert.equal((await statusOf({ ...order, orderCode: "QP-000000" })).status, 404);
  // The key is never accepted from the URL, where access logs would record it.
  assert.equal((await fetch(`${ctx.base}/api/orders/${order.orderCode}/status?key=${order.statusKey}`)).status, 404);
  const ok = await (await statusOf(order)).json();
  assert.deepEqual(ok, { state: "awaiting", orderCode: order.orderCode, amount: "2.50", token: order.token });
});

test("an order never gets a second link", async () => {
  const order = await newOrder();
  const posts = () => glCalls("POST", "/api/v1/pay-links").length;
  const before = posts();
  const [a, b] = await Promise.all([ctx.ensurePayLink(order.orderCode), ctx.ensurePayLink(order.orderCode)]);
  assert.equal(a.token, order.token);
  assert.equal(b.token, order.token);
  assert.equal(posts(), before);
});

test("the webhook refuses unsigned, wrongly signed, stale and tampered calls, and only accepts POST", async () => {
  const order = await newOrder();
  const body = payload(order);
  assert.equal((await deliver(body, { header: "" })).status, 401);
  assert.equal((await deliver(body, { secret: "whsec_other" })).status, 401);
  assert.equal((await deliver(body, { t: Math.floor(Date.now() / 1000) - 400 })).status, 401);
  assert.equal((await deliver(body, { tamper: true })).status, 401);
  assert.equal((await deliver(body, { method: "GET" })).status, 405);
  assert.equal(row(order.orderCode).pay_state, "awaiting_payment");
});

test("a reported payment tells the shop once but does not mark the order paid or print", async () => {
  const order = await newOrder();
  const body = payload(order);
  const shopBefore = shopMessages().length;
  assert.equal((await deliver(body)).status, 200);
  await until(() => shopMessages().length > shopBefore);

  assert.equal(row(order.orderCode).pay_state, "payment_reported");
  const message = shopMessages().pop().body;
  assert.match(message, /Payment: 💶 reported by Krasty \(proof attached\) for €2\.50/);
  assert.match(message, new RegExp(`paycheck:${order.orderCode}`));
  assert.equal(row(order.orderCode).print_status, null);
  assert.equal(customerMail().some((mail) => mail.subject?.includes("Payment confirmed") && mail.subject.includes(order.orderCode)), false);
  const status = await (await statusOf(order)).json();
  assert.equal(status.state, "confirming");

  // The same delivery again changes nothing (wait for the owner's message first: it follows the shop's).
  await until(() => adminTexts().some((text) => text.includes(`Payment reported for ${order.orderCode}`)));
  const after = shopMessages().length;
  const texts = adminTexts().length;
  assert.equal((await deliver(body)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(shopMessages().length, after);
  assert.equal(adminTexts().length, texts);
});

test("a retried delivery (same delivery id) is recognised and ignored", async () => {
  const order = await newOrder();
  const body = payload(order, { notice: "retry1" });
  await deliver(body, { delivery: "d-fixed-1" });
  await until(() => row(order.orderCode).pay_state === "payment_reported");
  const rows = () => ctx.db.prepare("SELECT COUNT(*) AS n FROM grandlivre_events WHERE order_code = ?").get(order.orderCode).n;
  const before = rows();
  assert.equal((await deliver(body, { delivery: "d-fixed-1" })).status, 200);
  assert.equal(rows(), before);
  assert.equal(ctx.db.prepare("SELECT result FROM grandlivre_events WHERE delivery = 'd-fixed-1'").get().result, "applied");
});

test("a confirmed payment marks the order paid, emails the customer and releases the print job; replays change nothing", async () => {
  const order = await newOrder();
  await deliver(payload(order));
  const confirmed = payload(order, { event: "payment.confirmed", state: "confirmed", confirmedAt: new Date().toISOString() });
  ctx.mailLog.length = 0;
  assert.equal((await deliver(confirmed)).status, 200);
  await until(() => row(order.orderCode).print_status === "queued");

  const r = row(order.orderCode);
  assert.equal(r.pay_state, "paid");
  assert.ok(r.paid_at);
  assert.equal(r.print_status, "queued");
  await until(() => customerMail().some((mail) => mail.subject === `Payment confirmed — print order ${order.orderCode}`));
  await until(() => adminTexts().some((text) => text.includes(`Payment confirmed for ${order.orderCode}`)));
  assert.equal((await (await statusOf(order)).json()).state, "paid");

  const mails = ctx.mailLog.length;
  const texts = adminTexts().length;
  assert.equal((await deliver(confirmed)).status, 200);
  // A late "reported" or "declined" must never take a paid order back.
  await deliver(payload(order, { state: "declined", event: "payment.declined" }));
  await deliver(payload(order));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(row(order.orderCode).pay_state, "paid");
  assert.equal(ctx.mailLog.length, mails);
  assert.equal(adminTexts().length, texts);
});

test("a confirmation that arrives first still tells the shop, exactly once", async () => {
  const order = await newOrder();
  const before = shopMessages().length;
  await deliver(payload(order, { event: "payment.confirmed", state: "confirmed" }));
  await until(() => row(order.orderCode).print_status === "queued");
  await until(() => shopMessages().length > before);
  assert.match(shopMessages().pop().body, /Payment: ✅ confirmed in Grandlivre, €2\.50/);
  assert.equal(shopMessages().length, before + 1);
});

test("a payment of the wrong amount, currency or link is flagged and never marks the order paid", async () => {
  const order = await newOrder();
  const texts = adminTexts().length;
  await deliver(payload(order, { event: "payment.confirmed", state: "confirmed", amount: 2.0 }));
  await until(() => adminTexts().length > texts);
  assert.equal(row(order.orderCode).pay_state, "payment_mismatch");
  assert.match(adminTexts().pop(), /does not match the order.*NOT marked paid/s);
  assert.equal(row(order.orderCode).print_status, null);
  assert.equal((await (await statusOf(order)).json()).state, "problem");

  const other = await newOrder();
  await deliver(payload(other, { event: "payment.confirmed", state: "confirmed", currency: "USD" }));
  await until(() => row(other.orderCode).pay_state === "payment_mismatch");
  const wrongLink = await newOrder();
  await deliver(payload(wrongLink, { event: "payment.confirmed", state: "confirmed", link: "lnk_not_ours" }));
  await until(() => row(wrongLink.orderCode).pay_state === "payment_mismatch");

  // The customer then pays the right amount: that one counts.
  await deliver(payload(order, { event: "payment.confirmed", state: "confirmed" }));
  await until(() => row(order.orderCode).pay_state === "paid");
});

test("an unknown reference, a test message and a bad body are answered without harm", async () => {
  assert.equal((await deliver({ event: "payment.confirmed", notice: "x1", link: "l", ref: "QP-FFFFFF", state: "confirmed", amount: 2.5, currency: "EUR" })).status, 200);
  assert.equal((await deliver({ event: "payment.confirmed", notice: "x2", link: "l", ref: "QP-FFFFFF", state: "weird" })).status, 200);
  const test = await deliver({ event: "payment.test", test: true });
  assert.deepEqual(await test.json(), { ok: true, test: true });
  const raw = "not json";
  const t = Math.floor(Date.now() / 1000);
  const response = await fetch(`${ctx.base}/grandlivre/webhook`, {
    method: "POST",
    headers: { "X-Grandlivre-Signature": `t=${t},v1=${crypto.createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}` },
    body: raw
  });
  assert.equal(response.status, 400);
});

test("a declined payment emails the customer, and a corrected report can still be confirmed", async () => {
  const order = await newOrder();
  ctx.mailLog.length = 0;
  await deliver(payload(order, { event: "payment.declined", state: "declined", notice: "nd1" }));
  await until(() => row(order.orderCode).pay_state === "payment_problem");
  await until(() => customerMail().some((mail) => mail.subject?.startsWith("Problem with the payment")));
  assert.equal((await (await statusOf(order)).json()).state, "problem");

  // The payer corrects it and reports again on the same notice: that must not be mistaken for a repeat.
  await deliver(payload(order, { notice: "nd1" }));
  await until(() => row(order.orderCode).pay_state === "payment_reported");
  await deliver(payload(order, { notice: "nd1", event: "payment.confirmed", state: "confirmed" }));
  await until(() => row(order.orderCode).pay_state === "paid");
});

test("a missed webhook is caught by asking Grandlivre: on reload, after a wait, and from the Telegram button", async () => {
  // 1. The customer reloads the page after paying; the confirmation never arrived by webhook.
  const order = await newOrder();
  gl.notices[order.orderCode] = [{ notice: "p1", link: row(order.orderCode).pay_link_id, ref: order.orderCode, state: "confirmed", amount: 2.5, currency: "EUR", payerName: "Krasty", known: false, receipt: true }];
  const status = await (await statusOf(order, { reload: true })).json();
  assert.equal(status.state, "paid");
  assert.equal(glCalls("GET", "/api/v1/notices").some((call) => call.query.includes(order.orderCode)), true);

  // 2. A reported payment that nobody confirmed for minutes is re-checked by the background job.
  const waiting = await newOrder();
  await deliver(payload(waiting, { notice: "w1" }));
  await until(() => row(waiting.orderCode).pay_state === "payment_reported");
  ctx.db.prepare("UPDATE orders SET pay_state_at = datetime('now', '-10 minutes') WHERE order_code = ?").run(waiting.orderCode);
  gl.notices[waiting.orderCode] = [{ notice: "w1", link: row(waiting.orderCode).pay_link_id, ref: waiting.orderCode, state: "confirmed", amount: 2.5, currency: "EUR" }];
  await ctx.checkReportedPayments();
  assert.equal(row(waiting.orderCode).pay_state, "paid");

  // 3. The owner presses "Check payment" in Telegram.
  const pressed = await newOrder();
  await deliver(payload(pressed, { notice: "b1" }));
  await until(() => row(pressed.orderCode).pay_state === "payment_reported");
  gl.notices[pressed.orderCode] = [{ notice: "b1", link: row(pressed.orderCode).pay_link_id, ref: pressed.orderCode, state: "confirmed", amount: 2.5, currency: "EUR" }];
  const answers = tg.callsTo("answerCallbackQuery").length;
  await postWebhook(ctx.base, { callback_query: { id: "cb-paycheck", data: `paycheck:${pressed.orderCode}`, message: { chat: { id: 42 } } } });
  await until(() => tg.callsTo("answerCallbackQuery").length > answers);
  assert.match(tg.callsTo("answerCallbackQuery").pop().body, /Paid/);
  assert.equal(row(pressed.orderCode).pay_state, "paid");
});

test("if Grandlivre is down the order is still taken, flagged unpaid, with the Revolut fallback", async () => {
  gl.mode = "down";
  const posts = glCalls("POST", "/api/v1/pay-links").length;
  const { status, body } = await postOrder(ctx.base, orderForm({ copies: "5" }, { resume: [PDF, "cv.pdf"] }));
  assert.equal(status, 201);
  assert.equal(body.mode, "revolut");
  assert.equal(body.amount, "2.50");
  assert.equal(glCalls("POST", "/api/v1/pay-links").length - posts, 2);
  assert.equal(row(body.orderCode).pay_state, "manual_payment");
  assert.equal(row(body.orderCode).pay_link_id, null);
  await until(() => shopMessages().some((call) => call.body.includes(body.orderCode)));
  assert.match(shopMessages().find((call) => call.body.includes(body.orderCode)).body, /NOT PAID YET — online payment was unavailable/);
  gl.mode = "ok";
});

test("orders left unpaid are cleaned up and their links closed; a late payment is flagged, not accepted", async () => {
  const order = await newOrder();
  const file = row(order.orderCode).stored_name;
  assert.ok(uploads().includes(file));
  ctx.db.prepare("UPDATE orders SET created_at = datetime('now', '-25 hours') WHERE order_code = ?").run(order.orderCode);
  const linkId = row(order.orderCode).pay_link_id;
  assert.ok(ctx.expireUnpaidOrders() >= 1);

  const r = row(order.orderCode);
  assert.equal(r.pay_state, "expired");
  assert.equal(r.customer_email, "[deleted]");
  assert.equal(uploads().includes(file), false);
  await until(() => glCalls("DELETE", `/api/v1/pay-links/${linkId}`).length === 1);

  const texts = adminTexts().length;
  await deliver(payload(order, { event: "payment.confirmed", state: "confirmed" }));
  await until(() => adminTexts().length > texts);
  assert.match(adminTexts().pop(), /arrived for order .* which is expired/);
  assert.equal(row(order.orderCode).pay_state, "expired");
});

test("a customer can start over: the order, its CV and its link are dropped, and only with the right key", async () => {
  const order = await newOrder();
  const cancel = (key) => fetch(`${ctx.base}/api/orders/${order.orderCode}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
  assert.equal((await cancel("0".repeat(32))).status, 404);
  const file = row(order.orderCode).stored_name;
  const linkId = row(order.orderCode).pay_link_id;
  assert.equal((await cancel(order.statusKey)).status, 204);
  assert.equal(row(order.orderCode).pay_state, "cancelled");
  assert.equal(uploads().includes(file), false);
  await until(() => glCalls("DELETE", `/api/v1/pay-links/${linkId}`).length === 1);
  assert.equal((await cancel(order.statusKey)).status, 404);
});

test("the page frames only the Grandlivre payment page and runs no script from it", async () => {
  const response = await fetch(`${ctx.base}/`);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, new RegExp(`frame-src ${gl.url.replace(/[.]/g, "\\.")};`));
  assert.doesNotMatch(csp, /unsafe|\*/);
  const html = await response.text();
  assert.match(html, /<meta name="pay-mode" content="grandlivre" \/>/);
  assert.match(html, new RegExp(`<meta name="grandlivre-origin" content="${gl.url.replace(/[.]/g, "\\.")}" />`));
});
