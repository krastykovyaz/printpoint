import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { LinkError } from "../lib/fetch-pdf.js";
import { isolateEnvironment, orderForm, PDF, postOrder, startServer } from "./helpers.js";

isolateEnvironment({ LINK_CHECK_RATE_LIMIT: "20" });

let ctx;
let realDownload;
before(async () => {
  ctx = await startServer();
  realDownload = ctx.linkFetcher.download;
});
after(() => ctx.server.close());

const uploads = () => fs.readdirSync(process.env.UPLOAD_DIR);
const orderCount = () => ctx.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
const checkLink = (url) => fetch(`${ctx.base}/api/check-link`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url })
});

// Pretends the link served a PDF: writes it where the real downloader would.
function serveFake(name = "Мой CV.pdf") {
  ctx.linkFetcher.download = async (_url, { destDir }) => {
    const filePath = path.join(destDir, `${Date.now()}-fake.pdf`);
    fs.writeFileSync(filePath, "%PDF-1.4 from a link");
    return { path: filePath, filename: path.basename(filePath), originalName: name, size: 20 };
  };
}
const failWith = (code) => {
  ctx.linkFetcher.download = async () => {
    throw new LinkError(code, "nope");
  };
};

test("check-link reports a good link and keeps nothing", async () => {
  serveFake();
  const response = await checkLink("https://cv.example.test/cv.pdf");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, filename: "Мой CV.pdf", size: 20 });
  assert.deepEqual(uploads(), []);
});

test("check-link reports each failure with a stable code", async () => {
  for (const code of ["link_not_pdf", "link_too_large", "link_unreachable"]) {
    failWith(code);
    const response = await checkLink("https://cv.example.test/cv.pdf");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, code);
  }
  ctx.linkFetcher.download = realDownload;
  for (const bad of [undefined, 42, "http://example.com/cv.pdf", "https://127.0.0.1/cv.pdf"]) {
    const response = await checkLink(bad);
    assert.equal(response.status, 400);
  }
  assert.deepEqual(uploads(), []);
});

test("an order can use a link instead of an upload", async () => {
  serveFake();
  ctx.mailLog.length = 0;
  const { status, body } = await postOrder(ctx.base, orderForm({ resumeUrl: "https://cv.example.test/cv.pdf" }, {}));
  assert.equal(status, 201);
  const row = ctx.db.prepare("SELECT original_name, stored_name FROM orders WHERE order_code = ?").get(body.orderCode);
  assert.equal(row.original_name, "Мой CV.pdf");
  const shopMail = ctx.mailLog.find((mail) => mail.to?.[0]?.address === "shop@example.test");
  assert.equal(shopMail.attachments.length, 1);
  assert.deepEqual(uploads(), []);
});

test("a file and a link together are refused, and nothing is fetched", async () => {
  let fetched = false;
  ctx.linkFetcher.download = async () => {
    fetched = true;
    throw new Error("must not be called");
  };
  const before = orderCount();
  const { status, body } = await postOrder(ctx.base, orderForm({ resumeUrl: "https://cv.example.test/cv.pdf" }, { resume: [PDF, "resume.pdf"] }));
  assert.equal(status, 400);
  assert.equal(body.code, "resume_conflict");
  assert.equal(fetched, false);
  assert.equal(orderCount(), before);
  assert.deepEqual(uploads(), []);
});

test("a link that fails stops the order cleanly", async () => {
  failWith("link_not_pdf");
  const before = orderCount();
  const { status, body } = await postOrder(ctx.base, orderForm({ resumeUrl: "https://cv.example.test/page" }, {}));
  assert.equal(status, 400);
  assert.equal(body.code, "link_not_pdf");
  assert.equal(orderCount(), before);
  assert.deepEqual(uploads(), []);
});

test("internal addresses are refused with the same answer as any dead link", async () => {
  ctx.linkFetcher.download = realDownload;
  const answers = new Set();
  for (const url of ["https://127.0.0.1/cv.pdf", "https://localhost/cv.pdf", "https://169.254.169.254/latest/meta-data/", "https://[::1]/cv.pdf"]) {
    const { status, body } = await postOrder(ctx.base, orderForm({ resumeUrl: url }, {}));
    assert.equal(status, 400);
    answers.add(`${body.code}|${body.error}`);
  }
  assert.equal(answers.size, 1);
  assert.match([...answers][0], /^link_unreachable\|/);
});

test("only a few links are fetched at once", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  ctx.linkFetcher.download = async (_url, { destDir }) => {
    await gate;
    const filePath = path.join(destDir, `${Date.now()}-${Math.random()}.pdf`);
    fs.writeFileSync(filePath, "%PDF-");
    return { path: filePath, filename: path.basename(filePath), originalName: "a.pdf", size: 5 };
  };
  const pending = Array.from({ length: 4 }, () => checkLink("https://cv.example.test/cv.pdf"));
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fifth = await checkLink("https://cv.example.test/cv.pdf");
    assert.equal(fifth.status, 503);
    assert.equal((await fifth.json()).code, "link_busy");
  } finally {
    release();
  }
  for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
});

test("link checks are rate limited per address", async () => {
  serveFake();
  let limited = null;
  for (let i = 0; i < 25 && !limited; i += 1) {
    const response = await checkLink("https://cv.example.test/cv.pdf");
    if (response.status === 429) limited = await response.json();
  }
  assert.equal(limited?.code, "too_many_requests");
});
