import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { amountsInText, checkReceipt, describeReceipt, judge, linesFromTsv, summarisePass } from "../lib/receipt.js";

const has = (tool) => {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("amounts are read in the usual European and English forms, and dates are not mistaken for amounts", () => {
  assert.deepEqual(amountsInText("€2.00"), [200]);
  assert.deepEqual(amountsInText("-€1.00"), [100]);
  assert.deepEqual(amountsInText("2,50 €"), [250]);
  assert.deepEqual(amountsInText("EUR 12.70 and 0,00 EUR"), [1270, 0]);
  assert.deepEqual(amountsInText("€ 5,60"), [560]);
  assert.deepEqual(amountsInText("24.10.2026 14:32 ref 20.10"), []);
  assert.deepEqual(amountsInText("Balance 15.20"), []);
});

test("the tallest amount on a pass is taken as the payment", () => {
  const tsv = ["level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t0\t0\t10\t128\t90\t€2.00",
    "5\t1\t2\t1\t1\t1\t0\t0\t10\t30\t90\tFee",
    "5\t1\t2\t1\t1\t2\t0\t0\t10\t32\t90\t€0.00",
    "5\t1\t3\t1\t1\t1\t0\t0\t10\t32\t90\tBalance",
    "5\t1\t3\t1\t1\t2\t0\t0\t10\t32\t90\t€15.20"].join("\n");
  assert.deepEqual(summarisePass(linesFromTsv(tsv)), { amounts: [200, 0, 1520], main: 200 });
});

test("an amount only counts as confirmed when passes agree on it", () => {
  const pass = (main, ...rest) => ({ amounts: [main, ...rest], main });
  assert.equal(judge([pass(200, 1520), pass(200), pass(200, 0)], 200).status, "match");
  assert.deepEqual(judge([pass(100, 200), pass(100, 200), pass(100)], 200), { status: "mismatch", paidCents: 100, amounts: [100, 200] });
  // Two passes agree on 2.50 while the order is 2.00: that is a mismatch, not a match.
  assert.deepEqual(judge([pass(200), pass(250), pass(250, 200)], 200).paidCents, 250);
  // Passes disagree about the big number: never claim a match.
  assert.equal(judge([pass(200), pass(250), pass(300)], 200).status, "uncertain");
  assert.equal(judge([pass(200), { amounts: [], main: null }, { amounts: [], main: null }], 200).status, "uncertain");
  assert.deepEqual(judge([{ amounts: [], main: null }], 200), { status: "unreadable", amounts: [] });
  const unsure = judge([pass(150), pass(300, 200), { amounts: [], main: null }], 200);
  assert.equal(unsure.status, "uncertain");
  assert.equal(unsure.mentionsExpected, true);
});

test("each verdict becomes a clear one-line message for the shop", () => {
  assert.match(describeReceipt({ status: "match", paidCents: 200 }, 200), /✅ shows €2\.00, matches the order/);
  assert.match(describeReceipt({ status: "mismatch", paidCents: 100 }, 200), /⚠️ shows €1\.00 but the order is €2\.00/);
  assert.match(describeReceipt({ status: "uncertain", amounts: [150, 300], mentionsExpected: false }, 200), /❓ .*€1\.50, €3\.00.*look at the image/);
  assert.match(describeReceipt({ status: "unreadable", amounts: [] }, 200), /couldn't read an amount/);
  assert.match(describeReceipt({ status: "unavailable", amounts: [] }, 200), /not done automatically/);
  assert.equal(describeReceipt(null, 200), null);
});

test("when the reading tools are missing the order is simply left unchecked", async () => {
  const result = await checkReceipt("/nonexistent/receipt.png", 200, { python: "no-such-tool", tesseract: "no-such-tool" });
  assert.equal(result.status, "unavailable");
});

// Real OCR on drawn receipts. Skipped where Tesseract, Pillow or librsvg are not installed.
const toolsPresent = has("tesseract") && has("rsvg-convert") && has("python3") && has("pdftotext");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-ocr-"));

function receipt(name, { main, fee = "€0.00", balance = "€15.20" }, format = "png") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1700" viewBox="0 0 1080 1700">
<rect width="1080" height="1700" fill="#fff"/>
<text x="540" y="260" font-family="DejaVu Sans" font-size="48" fill="#222" text-anchor="middle">Payment sent</text>
<text x="540" y="470" font-family="DejaVu Sans" font-size="170" font-weight="700" fill="#000" text-anchor="middle">${main}</text>
<text x="540" y="590" font-family="DejaVu Sans" font-size="44" fill="#555" text-anchor="middle">To Aleksandr Kovyaz</text>
<text x="80" y="900" font-family="DejaVu Sans" font-size="42" fill="#555">Fee</text><text x="1000" y="900" font-family="DejaVu Sans" font-size="42" text-anchor="end">${fee}</text>
<text x="80" y="1000" font-family="DejaVu Sans" font-size="42" fill="#555">Balance</text><text x="1000" y="1000" font-family="DejaVu Sans" font-size="42" text-anchor="end">${balance}</text>
</svg>`;
  const svgPath = path.join(dir, `${name}.svg`);
  const out = path.join(dir, `${name}.${format}`);
  fs.writeFileSync(svgPath, svg);
  execFileSync("rsvg-convert", ["-f", format, svgPath, "-o", out]);
  return out;
}

test("real OCR: a matching receipt in dot and comma styles", { skip: !toolsPresent && "OCR tools not installed" }, async () => {
  assert.deepEqual(await checkReceipt(receipt("dot", { main: "€2.00" }), 200), { status: "match", paidCents: 200, amounts: [200, 0, 1520] });
  const comma = await checkReceipt(receipt("comma", { main: "2,50 €", fee: "0,00 €", balance: "12,70 €" }), 250);
  assert.equal(comma.status, "match");
  assert.equal(comma.paidCents, 250);
});

test("real OCR: a different amount is reported, and a balance equal to the price does not fool it", { skip: !toolsPresent && "OCR tools not installed" }, async () => {
  const wrongAmount = await checkReceipt(receipt("short", { main: "€1.00" }), 200);
  assert.equal(wrongAmount.status, "mismatch");
  assert.equal(wrongAmount.paidCents, 100);

  // The payment was 1.00 but the balance afterwards happens to be 2.00 = the order price.
  const balanceTrap = await checkReceipt(receipt("trap", { main: "-€1.00", balance: "€2.00" }), 200);
  assert.equal(balanceTrap.status, "mismatch");

  // Paid 2.50 for a 2.00 order: must not be read as 2.00.
  const overpaid = await checkReceipt(receipt("over", { main: "2,50 €", fee: "0,00 €", balance: "12,70 €" }), 200);
  assert.equal(overpaid.status, "mismatch");
  assert.equal(overpaid.paidCents, 250);
});

test("real OCR: a picture with no amount, and a PDF receipt", { skip: !toolsPresent && "OCR tools not installed" }, async () => {
  const blank = path.join(dir, "blank.svg");
  fs.writeFileSync(blank, `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#fff"/><text x="40" y="300" font-family="DejaVu Sans" font-size="48">Thank you!</text></svg>`);
  execFileSync("rsvg-convert", [blank, "-o", path.join(dir, "blank.png")]);
  assert.equal((await checkReceipt(path.join(dir, "blank.png"), 200)).status, "unreadable");

  const pdf = receipt("pdfreceipt", { main: "€2.00", balance: "€2.00" }, "pdf");
  // The PDF names one non-zero amount (the fee line is €0.00), so it can vouch for it.
  assert.equal((await checkReceipt(pdf, 200)).status, "match");
  assert.equal((await checkReceipt(pdf, 300)).status, "mismatch");
});
