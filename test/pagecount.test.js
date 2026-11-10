import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { countPages } from "../lib/pagecount.js";

const has = (tool) => {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-pages-"));

// A small, valid PDF with the given number of blank pages.
function pdfWithPages(count) {
  const pages = Array.from({ length: count }, (_, i) => `${3 + i} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj`);
  const kids = Array.from({ length: count }, (_, i) => `${3 + i} 0 R`).join(" ");
  return `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[${kids}]/Count ${count}>>endobj\n${pages.join("\n")}\ntrailer<</Root 1 0 R/Size ${3 + count}>>\n%%EOF\n`;
}

test("reads the page count of PDFs", { skip: !has("pdfinfo") && "pdfinfo not installed" }, async () => {
  for (const count of [1, 3, 12]) {
    const file = path.join(dir, `p${count}.pdf`);
    fs.writeFileSync(file, pdfWithPages(count));
    assert.deepEqual(await countPages(file), { pages: count });
  }
});

test("reads the page count Word saved in a .docx", { skip: !has("python3") && "python3 not installed" }, async () => {
  const make = (name, appXml) => {
    const file = path.join(dir, name);
    execFileSync("python3", ["-I", "-c", "import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1], 'w')\nz.writestr('[Content_Types].xml', '<x/>')\nz.writestr('docProps/app.xml', sys.argv[2])\nz.close()", file, appXml]);
    return file;
  };
  assert.deepEqual(await countPages(make("seven.docx", "<Properties><Pages>7</Pages></Properties>")), { pages: 7 });
  assert.deepEqual(await countPages(make("nopages.docx", "<Properties><Words>3</Words></Properties>")), { pages: null });
  assert.deepEqual(await countPages(make("zero.docx", "<Properties><Pages>0</Pages></Properties>")), { pages: null });
});

test("anything unreadable counts as unknown, never as an error", async () => {
  const junk = path.join(dir, "junk.pdf");
  fs.writeFileSync(junk, "%PDF-1.4 not really a pdf");
  assert.deepEqual(await countPages(junk), { pages: null });
  fs.writeFileSync(path.join(dir, "old.doc"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  assert.deepEqual(await countPages(path.join(dir, "old.doc")), { pages: null });
  assert.deepEqual(await countPages(path.join(dir, "missing.pdf")), { pages: null });
  assert.deepEqual(await countPages(path.join(dir, "x.pdf"), { pdfinfo: "no-such-tool" }), { pages: null });
  const notZip = path.join(dir, "notzip.docx");
  fs.writeFileSync(notZip, "PK nonsense");
  assert.deepEqual(await countPages(notZip), { pages: null });
});
