import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { isolateEnvironment, orderForm, PDF, PNG, postOrder, startFakeTelegram, startServer } from "./helpers.js";

const fake = await startFakeTelegram();
isolateEnvironment({ TELEGRAM_API_BASE: fake.url, TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "42" });

let ctx;
before(async () => {
  ctx = await startServer();
});
after(() => {
  ctx.server.close();
  fake.server.close();
});

const withReceipt = { resume: [PDF, "cv.pdf"], paymentProof: [PNG, "receipt.png"] };
const lastOrderMessage = () => fake.callsTo("sendDocument").filter((call) => call.body.includes("New print order")).pop().body;
const verdict = (receipt) => {
  ctx.receiptChecker.check = async () => receipt;
};

test("a matching receipt is reported in Telegram and stored", async () => {
  verdict({ status: "match", paidCents: 200, amounts: [200] });
  const { status, body } = await postOrder(ctx.base, orderForm({}, withReceipt));
  assert.equal(status, 201);
  assert.match(lastOrderMessage(), /Receipt check: ✅ shows €2\.00, matches the order/);
  const row = ctx.db.prepare("SELECT receipt_status, receipt_cents FROM orders WHERE order_code = ?").get(body.orderCode);
  assert.deepEqual({ ...row }, { receipt_status: "match", receipt_cents: 200 });
});

test("a wrong amount is flagged with both figures", async () => {
  verdict({ status: "mismatch", paidCents: 100, amounts: [100] });
  const { body } = await postOrder(ctx.base, orderForm({}, withReceipt));
  assert.match(lastOrderMessage(), /Receipt check: ⚠️ shows €1\.00 but the order is €2\.00/);
  assert.equal(ctx.db.prepare("SELECT receipt_status FROM orders WHERE order_code = ?").get(body.orderCode).receipt_status, "mismatch");
});

test("an unreadable or unavailable check never blocks the order and tells the shop to look", async () => {
  for (const [receipt, pattern] of [
    [{ status: "unreadable", amounts: [] }, /couldn't read an amount/],
    [{ status: "unavailable", amounts: [] }, /not done automatically/],
    [{ status: "uncertain", amounts: [150, 300], mentionsExpected: false }, /couldn't confirm the amount \(saw €1\.50, €3\.00\)/]
  ]) {
    verdict(receipt);
    const { status } = await postOrder(ctx.base, orderForm({}, withReceipt));
    assert.equal(status, 201);
    assert.match(lastOrderMessage(), pattern);
  }
});

test("the email notice carries the verdict too, without the receipt or contact details", async () => {
  verdict({ status: "mismatch", paidCents: 100, amounts: [100] });
  ctx.mailLog.length = 0;
  await postOrder(ctx.base, orderForm({}, withReceipt));
  const shopMail = ctx.mailLog.find((mail) => mail.to?.[0]?.address === "shop@example.test");
  assert.match(shopMail.text, /Receipt check: ⚠️ shows €1\.00 but the order is €2\.00/);
  assert.equal(shopMail.attachments, undefined);
});

test("no receipt means no check and no verdict line", async () => {
  let called = false;
  ctx.receiptChecker.check = async () => {
    called = true;
    return { status: "match", paidCents: 200, amounts: [200] };
  };
  const { body } = await postOrder(ctx.base, orderForm({}, { resume: [PDF, "cv.pdf"] }));
  assert.equal(called, false);
  assert.doesNotMatch(lastOrderMessage(), /Receipt check/);
  assert.match(lastOrderMessage(), /NOT PAID YET/);
  assert.equal(ctx.db.prepare("SELECT receipt_status FROM orders WHERE order_code = ?").get(body.orderCode).receipt_status, null);
});

test("a receipt file nobody can read does not break the order (real checker, tools absent)", async () => {
  ctx.receiptChecker.check = (filePath, cents) => import("../lib/receipt.js").then((m) => m.checkReceipt(filePath, cents, { python: "no-such-tool", tesseract: "no-such-tool" }));
  const { status } = await postOrder(ctx.base, orderForm({}, withReceipt));
  assert.equal(status, 201);
  assert.match(lastOrderMessage(), /Receipt check: not done automatically/);
});
