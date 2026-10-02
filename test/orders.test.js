import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { isolateEnvironment, orderForm, PDF, PNG, postOrder, startServer } from "./helpers.js";

isolateEnvironment();

let ctx;
before(async () => {
  ctx = await startServer();
});
after(() => ctx.server.close());

const uploads = () => fs.readdirSync(process.env.UPLOAD_DIR);
const orderCount = () => ctx.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;

test("accepts a valid order, stores it and prices it on the server", async () => {
  const { status, body } = await postOrder(ctx.base, orderForm({}, { resume: [PDF, "resume.pdf"], paymentProof: [PNG, "receipt.png"] }));
  assert.equal(status, 201);
  assert.match(body.orderCode, /^QP-[0-9A-F]{6}$/);
  assert.equal(body.price, "€2.00");

  const row = ctx.db.prepare("SELECT * FROM orders WHERE order_code = ?").get(body.orderCode);
  assert.equal(row.customer_email, "customer@example.test");
  assert.equal(row.price_cents, 200);
  assert.ok(uploads().includes(row.stored_name));
  assert.ok(uploads().includes(row.payment_proof_name));
});

test("prices copies × pages with the discount only past 10 pages", async () => {
  const { status, body } = await postOrder(ctx.base, orderForm({ copies: "4", pages: "3", printMode: "color" }));
  assert.equal(status, 201);
  assert.equal(body.totalPages, 12);
  assert.equal(body.price, "€6.80");
});

test("rejects invalid input with a stable error code and leaves no files behind", async (t) => {
  const cases = [
    ["missing resume", orderForm({}, {}), "resume_required"],
    ["malformed email", orderForm({ email: "not-an-email" }), "email_invalid"],
    ["two recipients in one email", orderForm({ email: "a@b.co,victim@x.co" }), "email_invalid"],
    ["too few copies", orderForm({ copies: "3" }), "copies_invalid"],
    ["too many copies", orderForm({ copies: "101" }), "copies_invalid"],
    ["fractional copies", orderForm({ copies: "4.5" }), "copies_invalid"],
    ["zero pages", orderForm({ pages: "0" }), "pages_invalid"],
    ["unknown print mode", orderForm({ printMode: "constructor" }), "mode_invalid"],
    ["over-long location", orderForm({ location: "A".repeat(301) }), "field_too_long"],
    ["wrong extension", orderForm({}, { resume: [new Blob(["text"]), "note.txt"] }), "file_type"],
    ["script renamed to .pdf", orderForm({}, { resume: [new Blob(["<script>alert(1)</script>"]), "evil.pdf"] }), "file_type"],
    ["html claiming to be a pdf", orderForm({}, { resume: [new Blob(["<html>"], { type: "application/pdf" }), "evil.html"] }), "file_type"],
    ["fake receipt image", orderForm({}, { resume: [PDF, "resume.pdf"], paymentProof: [new Blob(["MZ"]), "receipt.png"] }), "file_type"]
  ];
  const filesBefore = uploads().length;
  const ordersBefore = orderCount();

  for (const [name, form, code] of cases) {
    await t.test(name, async () => {
      const { status, body } = await postOrder(ctx.base, form);
      assert.equal(status, 400);
      assert.equal(body.code, code);
    });
  }

  assert.equal(uploads().length, filesBefore);
  assert.equal(orderCount(), ordersBefore);
});

test("rejects a file over 10 MB", async () => {
  const big = new Blob(["%PDF-", Buffer.alloc(10 * 1024 * 1024 + 1)]);
  const { status, body } = await postOrder(ctx.base, orderForm({}, { resume: [big, "big.pdf"] }));
  assert.equal(status, 400);
  assert.equal(body.code, "file_too_large");
});

test("serves the page in the requested language and ignores unknown or prototype keys", async () => {
  const french = await (await fetch(`${ctx.base}/?lang=fr`)).text();
  assert.match(french, /<html lang="fr">/);
  assert.match(french, /Print Point — Impression de CV/);

  for (const lang of ["constructor", "__proto__", "toString", "xx"]) {
    const response = await fetch(`${ctx.base}/?lang=${lang}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html lang="en">/);
  }
});

test("sends security headers and does not advertise the framework", async () => {
  const response = await fetch(`${ctx.base}/`);
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
});

test("does not expose server files", async () => {
  for (const file of ["/server.js", "/.env", "/package.json", "/data/orders.db"]) {
    assert.equal((await fetch(`${ctx.base}${file}`)).status, 404);
  }
});

test("counts repeated visits from one address once per window", async () => {
  const count = () => ctx.db.prepare("SELECT COUNT(*) AS n FROM page_views").get().n;
  const before = count();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await fetch(`${ctx.base}/api/track-visit`, { method: "POST" })).status, 204);
  }
  assert.equal(count(), before + 1);
});

test("webhook ignores callers without the secret and never leaks parser errors", async () => {
  const unauthenticated = await fetch(`${ctx.base}/api/telegram-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: { chat: { id: 1 }, text: "/stats" } })
  });
  assert.equal(unauthenticated.status, 200);

  const malformed = await fetch(`${ctx.base}/api/telegram-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{bad"
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Invalid request.", code: "bad_request" });
});

test("retention anonymises old orders and deletes their files", async () => {
  const oldFile = "old-resume.pdf";
  const orphan = "orphan.pdf";
  for (const name of [oldFile, orphan]) {
    const filePath = path.join(process.env.UPLOAD_DIR, name);
    fs.writeFileSync(filePath, "%PDF-");
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, longAgo, longAgo);
  }
  ctx.db.prepare(`
    INSERT INTO orders (order_code, customer_email, phone, location, copies, print_mode, original_name, stored_name, created_at)
    VALUES ('QP-OLD001', 'old@example.test', '+352 1', 'somewhere', 4, 'color', 'cv.pdf', ?, datetime('now', '-40 days'))
  `).run(oldFile);
  const recent = (await postOrder(ctx.base, orderForm())).body.orderCode;

  ctx.runRetention();

  const old = ctx.db.prepare("SELECT * FROM orders WHERE order_code = 'QP-OLD001'").get();
  assert.equal(old.customer_email, "[deleted]");
  assert.equal(old.phone, null);
  assert.equal(old.location, null);
  assert.ok(!uploads().includes(oldFile));
  assert.ok(!uploads().includes(orphan));

  const kept = ctx.db.prepare("SELECT * FROM orders WHERE order_code = ?").get(recent);
  assert.equal(kept.customer_email, "customer@example.test");
  assert.ok(uploads().includes(kept.stored_name));
});
