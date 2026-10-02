import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { isolateEnvironment, orderForm, postOrder, startServer } from "./helpers.js";

// Mail points at a closed port and Telegram is off, so no channel can reach the shop.
isolateEnvironment({ MAIL_TRANSPORT: "smtp://127.0.0.1:1", ORDER_RATE_LIMIT: "2" });

let ctx;
before(async () => {
  ctx = await startServer();
});
after(() => ctx.server.close());

test("an order nobody can be told about is rejected and fully rolled back", async () => {
  const { status, body } = await postOrder(ctx.base, orderForm());
  assert.equal(status, 502);
  assert.equal(body.code, "delivery_failed");
  assert.doesNotMatch(body.error, /gmail|smtp|settings/i);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 0);
  assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, 0);
});

test("order attempts are rate limited per address before any upload is stored", async () => {
  await postOrder(ctx.base, orderForm());
  const { status, body } = await postOrder(ctx.base, orderForm());
  assert.equal(status, 429);
  assert.equal(body.code, "too_many_requests");
  assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, 0);
});
