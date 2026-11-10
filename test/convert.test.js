import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { isolateEnvironment, orderForm, startServer } from "./helpers.js";

isolateEnvironment();
const { ConvertError, toPdf } = await import("../lib/convert.js");
const { countPages } = await import("../lib/pagecount.js");

function has(command) {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const noOffice = !has("soffice") && "LibreOffice not installed";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-convert-"));

// A Word file with two pages and no saved page count (like a Google Docs export).
function makeDocx(file) {
  execFileSync("python3", ["-I", "-c", `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], "w")
z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
z.writestr("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/><w:t>two</w:t></w:r></w:p></w:body></w:document>')
z.close()
`, file]);
  return file;
}

async function pagesOf(input) {
  const pdf = await toPdf(input);
  try {
    return (await countPages(pdf)).pages;
  } finally {
    fs.rmSync(pdf, { force: true });
  }
}

test("converts Word, text, Markdown and photos to PDF with the right page count", { skip: noOffice }, async () => {
  assert.equal(await pagesOf(makeDocx(path.join(dir, "two.docx"))), 2);

  fs.writeFileSync(path.join(dir, "notes.txt"), "Hello\nworld\n");
  assert.equal(await pagesOf(path.join(dir, "notes.txt")), 1);

  // The image points at a server file: it must be dropped, not embedded.
  fs.writeFileSync(path.join(dir, "cv.md"), "# Jane Doe\n\n![secret](/etc/hostname)\n\n- Python\n- SQL\n");
  assert.equal(await pagesOf(path.join(dir, "cv.md")), 1);

  execFileSync("python3", ["-I", "-c", "import sys; from PIL import Image; Image.new('RGBA', (300, 400), (0, 0, 0, 128)).save(sys.argv[1])", path.join(dir, "scan.png")]);
  assert.equal(await pagesOf(path.join(dir, "scan.png")), 1);
});

test("a damaged file is reported as ConvertError and leaves no PDF behind", { skip: noOffice }, async () => {
  const broken = path.join(dir, "broken.pptx");
  fs.writeFileSync(broken, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]));
  await assert.rejects(toPdf(broken), ConvertError);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("broken") && name.endsWith(".pdf")), []);
});

let ctx;
before(async () => {
  ctx = await startServer();
});
after(() => {
  ctx?.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the page counts a Word file from its converted PDF and keeps nothing", { skip: noOffice }, async () => {
  const form = new FormData();
  form.append("resume", new Blob([fs.readFileSync(makeDocx(path.join(dir, "inspect.docx")))]), "cv.docx");
  const response = await fetch(`${ctx.base}/api/inspect`, { method: "POST", body: form });
  assert.deepEqual(await response.json(), { pages: 2, known: true });
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR), []);
});

test("an order for a Markdown CV is stored and printed as a PDF", { skip: noOffice }, async () => {
  const response = await fetch(`${ctx.base}/api/orders`, {
    method: "POST",
    body: orderForm({}, { resume: [new Blob(["# Jane Doe\n\nData analyst\n"]), "Jane CV.md"] })
  });
  assert.equal(response.status, 201, await response.clone().text());
  const row = ctx.db.prepare("SELECT stored_name, original_name, pages FROM orders ORDER BY rowid DESC LIMIT 1").get();
  assert.match(row.stored_name, /\.pdf$/);
  assert.equal(row.original_name, "Jane CV.pdf");
  assert.equal(row.pages, 1);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).filter((name) => name.endsWith(".md")), []);
});

test("an unreadable file gets the convert_failed error", { skip: noOffice }, async () => {
  const form = new FormData();
  form.append("resume", new Blob([Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)])]), "slides.pptx");
  const response = await fetch(`${ctx.base}/api/inspect`, { method: "POST", body: form });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "convert_failed");
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR), []);
});
