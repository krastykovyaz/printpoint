import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { downloadPdf, guardedLookup, isPublicAddress, LinkError, parseLink } from "../lib/fetch-pdf.js";

const PDF_BODY = "%PDF-1.4 a resume";

// Stands in for the https module: serves canned responses, records how it was called.
function fakeTransport(routes) {
  const calls = [];
  return {
    calls,
    request(url, options, callback) {
      calls.push({ url: url.href, options });
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => setImmediate(() => {
        const route = routes[url.href];
        if (!route) return request.emit("error", new Error("ECONNREFUSED"));
        const response = Readable.from([Buffer.from(route.body ?? "")]);
        response.statusCode = route.status ?? 200;
        response.headers = route.headers ?? { "content-type": "application/pdf" };
        callback(response);
      });
      return request;
    }
  };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-link-"));
const rejectsWith = (promise, code) => assert.rejects(promise, (error) => error instanceof LinkError && error.code === code);

test("addresses that are not on the public internet are refused, including mapped IPv6 forms", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "not-an-ip"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("links must be plain https URLs without credentials or odd ports", () => {
  const invalid = ["", "   ", "not a url", "http://example.com/cv.pdf", "ftp://example.com/cv.pdf", "file:///etc/passwd",
    "javascript:alert(1)", "https://user:pw@example.com/cv.pdf", "https://example.com:8443/cv.pdf", "https://example.com/a b.pdf",
    `https://example.com/${"a".repeat(2000)}`];
  for (const link of invalid) {
    assert.throws(() => parseLink(link), (error) => error.code === "link_invalid", link.slice(0, 40));
  }
  assert.equal(parseLink(" https://example.com/cv.pdf ").hostname, "example.com");
  assert.equal(parseLink("https://example.com:443/cv.pdf").hostname, "example.com");
});

test("literal internal addresses are refused however they are written", () => {
  for (const link of ["https://127.0.0.1/cv.pdf", "https://[::1]/cv.pdf", "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/cv.pdf", "https://2130706433/cv.pdf", "https://0x7f.1/cv.pdf", "https://[::ffff:127.0.0.1]/cv.pdf", "https://0/cv.pdf"]) {
    assert.throws(() => parseLink(link), (error) => error.code === "link_unreachable", link);
  }
});

test("a name that resolves to an internal address is refused at connect time and nothing is written", async () => {
  await new Promise((resolve) => guardedLookup("localhost", {}, (error) => {
    assert.equal(error?.code, "link_unreachable");
    resolve();
  }));
  const destDir = tempDir();
  await rejectsWith(downloadPdf("https://localhost/cv.pdf", { destDir }), "link_unreachable");
  assert.deepEqual(fs.readdirSync(destDir), []);
});

test("downloads a PDF, names it from the URL and requests it safely", async () => {
  const destDir = tempDir();
  const transport = fakeTransport({ "https://cv.example.test/files/My%20CV.pdf": { body: PDF_BODY } });
  const file = await downloadPdf("https://cv.example.test/files/My%20CV.pdf", { destDir, transport });

  assert.equal(file.originalName, "My CV.pdf");
  assert.equal(file.size, PDF_BODY.length);
  assert.equal(fs.readFileSync(file.path, "utf8"), PDF_BODY);
  assert.equal(path.dirname(file.path), destDir);
  const { options } = transport.calls[0];
  assert.equal(options.lookup, guardedLookup);
  assert.equal(options.agent, false);
  assert.equal(options.headers["Accept-Encoding"], "identity");
});

test("prefers the server's Content-Disposition name and strips anything unsafe", async () => {
  const destDir = tempDir();
  const transport = fakeTransport({
    "https://cv.example.test/download?id=7": {
      body: PDF_BODY,
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="../../etc/Anna <Müller>.pdf"` }
    }
  });
  const file = await downloadPdf("https://cv.example.test/download?id=7", { destDir, transport });
  assert.equal(file.originalName, "Anna Müller.pdf");
});

test("rejects things that are not PDFs, and leaves no file behind", async () => {
  const destDir = tempDir();
  const cases = [
    ["a web page", { body: "<html>login</html>", headers: { "content-type": "text/html" } }],
    ["a Drive-style preview page claiming to be a PDF", { body: "<html>preview</html>" }],
    ["an empty body", { body: "" }]
  ];
  for (const [name, route] of cases) {
    const transport = fakeTransport({ "https://cv.example.test/a": route });
    await rejectsWith(downloadPdf("https://cv.example.test/a", { destDir, transport }), "link_not_pdf");
  }
  assert.deepEqual(fs.readdirSync(destDir), []);
});

test("enforces the size limit from the header and while streaming", async () => {
  const destDir = tempDir();
  const declared = fakeTransport({ "https://cv.example.test/a": { body: PDF_BODY, headers: { "content-type": "application/pdf", "content-length": "5000" } } });
  await rejectsWith(downloadPdf("https://cv.example.test/a", { destDir, maxBytes: 100, transport: declared }), "link_too_large");

  const streamed = fakeTransport({ "https://cv.example.test/a": { body: PDF_BODY + "x".repeat(500) } });
  await rejectsWith(downloadPdf("https://cv.example.test/a", { destDir, maxBytes: 100, transport: streamed }), "link_too_large");
  assert.deepEqual(fs.readdirSync(destDir), []);
});

test("follows a few redirects but re-checks every hop", async () => {
  const destDir = tempDir();
  const redirect = (location) => ({ status: 302, headers: { location }, body: "" });

  const ok = fakeTransport({
    "https://a.example.test/cv": redirect("https://b.example.test/real.pdf"),
    "https://b.example.test/real.pdf": { body: PDF_BODY }
  });
  assert.equal((await downloadPdf("https://a.example.test/cv", { destDir, transport: ok })).originalName, "real.pdf");

  for (const target of ["http://b.example.test/real.pdf", "https://127.0.0.1/real.pdf", "https://169.254.169.254/latest/", "https://u:p@b.example.test/x.pdf", "file:///etc/passwd"]) {
    const transport = fakeTransport({ "https://a.example.test/cv": redirect(target) });
    await rejectsWith(downloadPdf("https://a.example.test/cv", { destDir, transport }), "link_unreachable");
    assert.equal(transport.calls.length, 1, `must not follow ${target}`);
  }

  const loop = fakeTransport({ "https://a.example.test/cv": redirect("https://a.example.test/cv") });
  await rejectsWith(downloadPdf("https://a.example.test/cv", { destDir, transport: loop }), "link_unreachable");
  assert.equal(loop.calls.length, 4);
});

test("errors from the other side look the same as blocked addresses, so the server cannot be used to probe", async () => {
  const destDir = tempDir();
  const messages = new Set();
  for (const route of [{ status: 404, body: "no" }, { status: 500, body: "boom" }, undefined]) {
    const transport = fakeTransport(route ? { "https://cv.example.test/a": route } : {});
    await assert.rejects(downloadPdf("https://cv.example.test/a", { destDir, transport }), (error) => {
      messages.add(`${error.code}|${error.message}`);
      return true;
    });
  }
  await assert.rejects(downloadPdf("https://localhost/a", { destDir }), (error) => {
    messages.add(`${error.code}|${error.message}`);
    return true;
  });
  assert.equal(messages.size, 1);
});
