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

test("accepts a valid order, prices it on the server and keeps no copy of the files", async () => {
  const { status, body } = await postOrder(ctx.base, orderForm({}, { resume: [PDF, "resume.pdf"], paymentProof: [PNG, "receipt.png"] }));
  assert.equal(status, 201);
  assert.match(body.orderCode, /^QP-[0-9A-F]{6}$/);
  assert.equal(body.price, "€2.00");

  const row = ctx.db.prepare("SELECT * FROM orders WHERE order_code = ?").get(body.orderCode);
  assert.equal(row.customer_email, "customer@example.test");
  assert.equal(row.price_cents, 200);
  assert.deepEqual(uploads(), []);
});

test("with Telegram off, the email carries the files so the shop can still print", async () => {
  ctx.mailLog.length = 0;
  const { status } = await postOrder(ctx.base, orderForm({}, { resume: [PDF, "resume.pdf"] }));
  assert.equal(status, 201);
  const shopMail = ctx.mailLog.find((mail) => mail.to?.[0]?.address === "shop@example.test");
  assert.equal(shopMail.attachments.length, 1);
});

// Runs a block with a stand-in for the page counter (the real one reads the file with pdfinfo).
async function withPages(result, run) {
  const real = ctx.pageCounter.count;
  ctx.pageCounter.count = async () => result;
  try {
    return await run();
  } finally {
    ctx.pageCounter.count = real;
  }
}

test("prices copies × pages from the document, with the discount only past 10 pages (12 pages = 10 × €0.50 + 2 × €0.30)", async () => {
  await withPages({ pages: 3 }, async () => {
    // The browser claims 1 page; only the document's own count is used.
    const { status, body } = await postOrder(ctx.base, orderForm({ copies: "4", pages: "1" }));
    assert.equal(status, 201);
    assert.equal(body.totalPages, 12);
    assert.equal(body.price, "€5.60");
    assert.equal(ctx.db.prepare("SELECT pages, pages_known FROM orders WHERE order_code = ?").get(body.orderCode).pages, 3);
  });
});

test("a page number typed in the browser can never lower the price", async () => {
  await withPages({ pages: 5 }, async () => {
    for (const pages of ["0", "1", "-3", "abc", "9999"]) {
      const { status, body } = await postOrder(ctx.base, orderForm({ copies: "4", pages }));
      assert.equal(status, 201, pages);
      assert.equal(body.totalPages, 20, pages);
    }
  });
});

test("a document with too many pages is refused, and one whose pages cannot be read is priced as one page and flagged", async () => {
  await withPages({ pages: 60 }, async () => {
    const { status, body } = await postOrder(ctx.base, orderForm({ copies: "4" }));
    assert.equal(status, 400);
    assert.equal(body.code, "pages_invalid");
  });
  await withPages({ pages: null }, async () => {
    ctx.mailLog.length = 0;
    const { status, body } = await postOrder(ctx.base, orderForm({ copies: "4" }));
    assert.equal(status, 201);
    assert.equal(body.totalPages, 4);
    assert.equal(ctx.db.prepare("SELECT pages_known FROM orders WHERE order_code = ?").get(body.orderCode).pages_known, 0);
    const shopMail = ctx.mailLog.find((mail) => mail.to?.[0]?.address === "shop@example.test");
    assert.match(shopMail.text, /page count not detected, priced as 1 page per copy/);
  });
});

test("the page count endpoint reports a CV's pages, refuses other files, and keeps nothing", async () => {
  await withPages({ pages: 7 }, async () => {
    const form = new FormData();
    form.append("resume", PDF, "cv.pdf");
    const ok = await fetch(`${ctx.base}/api/inspect`, { method: "POST", body: form });
    assert.deepEqual(await ok.json(), { pages: 7, known: true });

    const bad = new FormData();
    bad.append("resume", new Blob(["<html>"]), "evil.pdf");
    const refused = await fetch(`${ctx.base}/api/inspect`, { method: "POST", body: bad });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).code, "file_type");
    assert.deepEqual(uploads(), []);
  });
  await withPages({ pages: null }, async () => {
    const form = new FormData();
    form.append("resume", PDF, "old.pdf");
    assert.deepEqual(await (await fetch(`${ctx.base}/api/inspect`, { method: "POST", body: form })).json(), { pages: null, known: false });
  });
});

test("rejects invalid input with a stable error code and leaves no files behind", async (t) => {
  const cases = [
    ["missing resume", orderForm({}, {}), "resume_required"],
    ["malformed email", orderForm({ email: "not-an-email" }), "email_invalid"],
    ["two recipients in one email", orderForm({ email: "a@b.co,victim@x.co" }), "email_invalid"],
    ["too few copies", orderForm({ copies: "3" }), "copies_invalid"],
    ["too many copies", orderForm({ copies: "101" }), "copies_invalid"],
    ["fractional copies", orderForm({ copies: "4.5" }), "copies_invalid"],
    ["unknown print mode", orderForm({ printMode: "constructor" }), "mode_invalid"],
    ["colour is not offered", orderForm({ printMode: "color" }), "mode_invalid"],
    ["over-long location", orderForm({ location: "A".repeat(301) }), "field_too_long"],
    ["wrong extension", orderForm({}, { resume: [new Blob(["MZ"]), "setup.exe"] }), "file_type"],
    ["zip-less file renamed to .pptx", orderForm({}, { resume: [new Blob(["MZ binary"]), "slides.pptx"] }), "file_type"],
    ["text file with NUL bytes", orderForm({}, { resume: [new Blob([Buffer.from([0x4d, 0x5a, 0, 0])]), "notes.md"] }), "file_type"],
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
  assert.match(french, /Print CV — Impression de CV/);

  for (const lang of ["constructor", "__proto__", "toString", "xx"]) {
    const response = await fetch(`${ctx.base}/?lang=${lang}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html lang="en">/);
  }
});

test("publishes the minimum order to the page so it can be relaxed from the server's settings", async () => {
  assert.match(await (await fetch(`${ctx.base}/`)).text(), /<meta name="min-copies" content="4" \/>/);
});

test("names tsech.online as the only site allowed to hand a CV into the form", async () => {
  assert.match(await (await fetch(`${ctx.base}/`)).text(), /<meta name="handoff-origin" content="https:\/\/tsech\.online" \/>/);
});

test("sends security headers and does not advertise the framework", async () => {
  const response = await fetch(`${ctx.base}/`);
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  // Without Grandlivre configured, no third-party script or frame is allowed and the page runs the old payment flow.
  assert.match(response.headers.get("content-security-policy"), /script-src 'self';/);
  assert.doesNotMatch(response.headers.get("content-security-policy"), /frame-src|portemonnaie/);
  const page = await (await fetch(`${ctx.base}/`)).text();
  assert.doesNotMatch(page, /name="pay-mode"/);
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
    VALUES ('QP-OLD001', 'old@example.test', '+352 1', 'somewhere', 4, 'black-white', 'cv.pdf', ?, datetime('now', '-40 days'))
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
});
