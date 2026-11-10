import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { amountMatches, closePayLink, createPayLink, fetchNotices, grandlivreConfig, linkMatches, nextPayState, verifySignature } from "../lib/grandlivre.js";
import { priceCents } from "../server.js";

const SECRET = "whsec_test_secret";
const sign = (body, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

test("the price is computed from copies × pages: €0.50 each for the first 10, €0.30 after", () => {
  const price = (pages) => priceCents(pages, "black-white");
  assert.equal(price(1), 50);
  assert.equal(price(4), 200);
  assert.equal(price(5), 250);
  assert.equal(price(10), 500);
  assert.equal(price(11), 530);
  assert.equal(price(12), 560);
  assert.equal(price(100), 500 + 90 * 30);
});

test("configuration needs both key and secret, and https (plain http only for this machine)", () => {
  assert.equal(grandlivreConfig({}), null);
  assert.equal(grandlivreConfig({ GRANDLIVRE_KEY: "glk_x" }), null);
  assert.equal(grandlivreConfig({ GRANDLIVRE_WEBHOOK_SECRET: "whsec_x" }), null);
  const ok = grandlivreConfig({ GRANDLIVRE_KEY: "glk_x", GRANDLIVRE_WEBHOOK_SECRET: "whsec_x" });
  assert.equal(ok.baseUrl, "https://app.portemonnaie.space");
  assert.equal(ok.origin, "https://app.portemonnaie.space");
  assert.equal(grandlivreConfig({ GRANDLIVRE_KEY: "k", GRANDLIVRE_WEBHOOK_SECRET: "s", GRANDLIVRE_URL: "http://pay.example.com" }), null);
  assert.equal(grandlivreConfig({ GRANDLIVRE_KEY: "k", GRANDLIVRE_WEBHOOK_SECRET: "s", GRANDLIVRE_URL: "not a url" }), null);
  assert.equal(grandlivreConfig({ GRANDLIVRE_KEY: "k", GRANDLIVRE_WEBHOOK_SECRET: "s", GRANDLIVRE_URL: "http://127.0.0.1:4000" }).origin, "http://127.0.0.1:4000");
});

test("signatures: valid, wrong secret, old or future timestamp, tampered body, malformed header", () => {
  const body = JSON.stringify({ event: "payment.confirmed", notice: "n1" });
  assert.equal(verifySignature({ header: sign(body), rawBody: Buffer.from(body), secret: SECRET }), true);
  assert.equal(verifySignature({ header: sign(body, "whsec_other"), rawBody: Buffer.from(body), secret: SECRET }), false);
  assert.equal(verifySignature({ header: sign(body, SECRET, Math.floor(Date.now() / 1000) - 301), rawBody: Buffer.from(body), secret: SECRET }), false);
  assert.equal(verifySignature({ header: sign(body, SECRET, Math.floor(Date.now() / 1000) - 299), rawBody: Buffer.from(body), secret: SECRET }), true);
  assert.equal(verifySignature({ header: sign(body, SECRET, Math.floor(Date.now() / 1000) + 400), rawBody: Buffer.from(body), secret: SECRET }), false);
  assert.equal(verifySignature({ header: sign(body), rawBody: Buffer.from(body.replace("n1", "n2")), secret: SECRET }), false);
  for (const header of [undefined, "", "garbage", "t=1,v1=abc", `t=,v1=${"a".repeat(64)}`, `v1=${"a".repeat(64)}`]) {
    assert.equal(verifySignature({ header, rawBody: Buffer.from(body), secret: SECRET }), false, String(header));
  }
  assert.equal(verifySignature({ header: sign(body), rawBody: Buffer.from(body), secret: "" }), false);
});

test("a payment counts only when its amount and currency equal the order's", () => {
  assert.equal(amountMatches(2.5, "EUR", 250), true);
  assert.equal(amountMatches(2.5, "eur", 250), true);
  assert.equal(amountMatches(0.1 + 0.2, "EUR", 30), true);
  assert.equal(amountMatches(2.49, "EUR", 250), false);
  assert.equal(amountMatches(2.5, "USD", 250), false);
  assert.equal(amountMatches("2.50", "EUR", 250), false);
  assert.equal(amountMatches(NaN, "EUR", 250), false);
});

test("a webhook's link is ours if it names the link id, token or page address", () => {
  const order = { pay_link_id: "lnk_1", pay_link_token: "TOK" };
  assert.equal(linkMatches("lnk_1", order), true);
  assert.equal(linkMatches("TOK", order), true);
  assert.equal(linkMatches("https://app.portemonnaie.space/pay/TOK", order), true);
  assert.equal(linkMatches("lnk_2", order), false);
  assert.equal(linkMatches("https://evil.example/pay/OTHER", order), false);
  assert.equal(linkMatches("", order), false);
  assert.equal(linkMatches(undefined, { pay_link_id: null, pay_link_token: null }), false);
});

test("payment states move forward and never leave paid", () => {
  assert.equal(nextPayState("awaiting_payment", "reported"), "payment_reported");
  assert.equal(nextPayState("awaiting_payment", "confirmed"), "paid");
  assert.equal(nextPayState("payment_reported", "confirmed"), "paid");
  assert.equal(nextPayState("payment_reported", "declined"), "payment_problem");
  assert.equal(nextPayState("payment_problem", "reported"), "payment_reported");
  assert.equal(nextPayState("payment_problem", "confirmed"), "paid");
  assert.equal(nextPayState("payment_mismatch", "reported"), "payment_reported");
  for (const incoming of ["reported", "declined", "confirmed", "nonsense"]) assert.equal(nextPayState("paid", incoming), "paid");
  for (const closed of ["expired", "cancelled", "manual_payment"]) assert.equal(nextPayState(closed, "confirmed"), closed);
  assert.equal(nextPayState("awaiting_payment", "nonsense"), "awaiting_payment");
});

const config = { baseUrl: "https://gl.example.test", key: "glk_secret", secret: "s" };
const reply = (status, data) => async () => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("a link is created with the server's price, the order code as reference, and the key only in the header", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ link: { id: "lnk_1", token: "TOK", url: "https://gl.example.test/pay/TOK", ref: "QP-ABC123" } }), { status: 200 });
  };
  const link = await createPayLink(config, { orderCode: "QP-ABC123", priceCents: 250 }, { fetchImpl });
  assert.deepEqual(link, { id: "lnk_1", token: "TOK", url: "https://gl.example.test/pay/TOK" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://gl.example.test/api/v1/pay-links");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.Authorization, "Bearer glk_secret");
  assert.deepEqual(JSON.parse(seen[0].init.body), { title: "Print order #QP-ABC123", amount: 2.5, currency: "EUR", ref: "QP-ABC123" });
  assert.doesNotMatch(seen[0].init.body, /glk_/);
});

test("link creation retries once on a server error or network failure, but not on a refusal", async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("socket hang up");
    return new Response(JSON.stringify({ link: { id: "l", token: "t" } }), { status: 200 });
  };
  assert.equal((await createPayLink(config, { orderCode: "QP-1", priceCents: 50 }, { fetchImpl: flaky })).token, "t");
  assert.equal(calls, 2);

  calls = 0;
  const down = async () => {
    calls += 1;
    return new Response("{}", { status: 503 });
  };
  await assert.rejects(createPayLink(config, { orderCode: "QP-1", priceCents: 50 }, { fetchImpl: down }), /503/);
  assert.equal(calls, 2);

  calls = 0;
  const refused = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "invalid_amount" }), { status: 400 });
  };
  await assert.rejects(createPayLink(config, { orderCode: "QP-1", priceCents: 50 }, { fetchImpl: refused }), /400/);
  assert.equal(calls, 1);

  await assert.rejects(createPayLink(config, { orderCode: "QP-1", priceCents: 50 }, { fetchImpl: reply(200, { link: {} }) }), /200/);
});

test("a slow Grandlivre does not hold the order: the call times out", async () => {
  const slow = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const keepAlive = setInterval(() => {}, 1000); // a real socket keeps the process alive; this fake has none
  try {
    const started = Date.now();
    await assert.rejects(createPayLink(config, { orderCode: "QP-1", priceCents: 50 }, { fetchImpl: slow, timeoutMs: 40 }));
    assert.ok(Date.now() - started < 1000);
  } finally {
    clearInterval(keepAlive);
  }
});

test("notices come back oldest first, and closing a link reports success", async () => {
  const notices = [{ notice: "n2", state: "confirmed" }, { notice: "n1", state: "reported" }];
  const list = await fetchNotices(config, "QP-1", { fetchImpl: reply(200, { notices }) });
  assert.deepEqual(list.map((n) => n.notice), ["n1", "n2"]);
  await assert.rejects(fetchNotices(config, "QP-1", { fetchImpl: reply(500, {}) }), /500/);
  assert.equal(await closePayLink(config, "lnk_1", { fetchImpl: reply(200, { ok: true }) }), true);
  assert.equal(await closePayLink(config, "lnk_1", { fetchImpl: reply(404, {}) }), false);
});
