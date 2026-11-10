import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { isolateEnvironment, orderForm, postOrder, startServer } from "./helpers.js";

// The pilot price, set from .env: €0.20 a page, at least €1.00 an order, single copies allowed.
isolateEnvironment({ PRICE_PAGE_CENTS: "20", PRICE_BULK_CENTS: "20", MIN_ORDER_CENTS: "100", MIN_COPIES: "1" });
const { priceCents } = await import("../server.js");

let ctx;
before(async () => {
  ctx = await startServer();
});
after(() => ctx.server.close());

test("pilot price: 1 to 5 pages cost €1.00, then €0.20 a page", () => {
  const price = (pages) => priceCents(pages, "black-white");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 10, 11, 20, 50].map(price), [100, 100, 100, 100, 100, 120, 140, 200, 220, 400, 1000]);
});

test("the page is given the same price rules the server charges", async () => {
  const html = await (await fetch(`${ctx.base}/`)).text();
  assert.match(html, /<meta name="price-rules" content="\{&quot;page&quot;:20,&quot;bulk&quot;:20,&quot;after&quot;:10,&quot;min&quot;:100\}" \/>/);
});

test("orders are charged the pilot price", async () => {
  const real = ctx.pageCounter.count;
  try {
    ctx.pageCounter.count = async () => ({ pages: 1 });
    const one = await postOrder(ctx.base, orderForm({ copies: "1" }));
    assert.equal(one.status, 201);
    assert.equal(one.body.price, "€1.00");

    ctx.pageCounter.count = async () => ({ pages: 7 });
    const seven = await postOrder(ctx.base, orderForm({ copies: "1" }));
    assert.equal(seven.body.price, "€1.40");

    ctx.pageCounter.count = async () => ({ pages: 3 });
    const sixPages = await postOrder(ctx.base, orderForm({ copies: "2" }));
    assert.equal(sixPages.body.totalPages, 6);
    assert.equal(sixPages.body.price, "€1.20");
    assert.equal(ctx.db.prepare("SELECT price_cents FROM orders WHERE order_code = ?").get(sixPages.body.orderCode).price_cents, 120);
  } finally {
    ctx.pageCounter.count = real;
  }
});
