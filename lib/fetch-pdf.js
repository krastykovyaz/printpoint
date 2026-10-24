// Downloads a PDF from a link a visitor typed in. The visitor controls the URL, so everything here
// is about not being tricked into reaching places the visitor could not reach themselves.
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export class LinkError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MAX_URL_LENGTH = 2000;
const MAX_REDIRECTS = 3;
const ACCEPTED_TYPES = new Set(["", "application/pdf", "application/x-pdf", "application/octet-stream", "binary/octet-stream"]);

// Anything that is not a normal public internet address.
const nonPublic = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) {
  nonPublic.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
]) {
  nonPublic.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked against the IPv4 rules by BlockList.
  return !nonPublic.check(address, family === 4 ? "ipv4" : "ipv6");
}

const unreachable = () => new LinkError("link_unreachable", "We couldn't open that link.");

// Used as the socket's DNS lookup, so the address that is checked is the address that is connected to.
export function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || !addresses.every((entry) => isPublicAddress(entry.address))) {
      return callback(unreachable());
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

export function parseLink(raw) {
  const text = String(raw ?? "").trim();
  const invalid = () => new LinkError("link_invalid", "Enter a full https:// link to a PDF file.");
  if (!text || text.length > MAX_URL_LENGTH || /[\s\u0000-\u001f]/.test(text)) throw invalid();

  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalid();
  }
  if (url.protocol !== "https:" || url.username || url.password) throw invalid();
  if (url.port && url.port !== "443") throw invalid();

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw invalid();
  // Names are checked at connect time by guardedLookup; literal IPs never reach a lookup.
  if (net.isIP(host) && !isPublicAddress(host)) throw unreachable();
  return url;
}

function fileNameFor(url, contentDisposition) {
  let name = "";
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition || "");
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition || "");
  const candidate = star?.[1] || plain?.[1] || url.pathname.split("/").filter(Boolean).pop() || "";
  try {
    name = decodeURIComponent(candidate);
  } catch {
    name = candidate;
  }
  name = name.split(/[\\/]/).pop().replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 80);
  return `${name || "resume"}.pdf`;
}

function openOnce(url, transport, signal) {
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: "GET",
      agent: false,
      signal,
      timeout: 10_000,
      lookup: guardedLookup,
      headers: { "User-Agent": "PrintPoint-LinkCheck/1.0", Accept: "application/pdf,*/*;q=0.5", "Accept-Encoding": "identity" }
    }, resolve);
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
}

// Saves the PDF into destDir and returns { path, filename, originalName, size }.
// `transport` exists so tests can stand in for the network; production always uses https.
export async function downloadPdf(rawUrl, { destDir, maxBytes = 10 * 1024 * 1024, totalTimeoutMs = 20_000, transport = https } = {}) {
  let url = parseLink(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
  let destination = null;

  try {
    let response;
    for (let hop = 0; ; hop += 1) {
      try {
        response = await openOnce(url, transport, controller.signal);
      } catch (error) {
        throw error instanceof LinkError ? error : unreachable();
      }
      const { statusCode, headers } = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        if (hop >= MAX_REDIRECTS) throw unreachable();
        try {
          url = parseLink(new URL(headers.location, url).href);
        } catch {
          throw unreachable();
        }
        continue;
      }
      if (statusCode !== 200) {
        response.resume();
        throw unreachable();
      }
      break;
    }

    const type = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!ACCEPTED_TYPES.has(type)) {
      response.resume();
      throw new LinkError("link_not_pdf", "That link isn't a direct link to a PDF file.");
    }
    if (Number(response.headers["content-length"]) > maxBytes) {
      response.resume();
      throw new LinkError("link_too_large", "The PDF at that link is larger than 10 MB.");
    }

    destination = path.join(destDir, `${Date.now()}-${crypto.randomUUID()}.pdf`);
    let received = 0;
    const out = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
    response.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) response.destroy(new LinkError("link_too_large", "The PDF at that link is larger than 10 MB."));
    });
    try {
      await pipeline(response, out);
    } catch (error) {
      throw error instanceof LinkError ? error : unreachable();
    }

    const head = Buffer.alloc(1024);
    const descriptor = fs.openSync(destination, "r");
    const length = fs.readSync(descriptor, head, 0, head.length, 0);
    fs.closeSync(descriptor);
    if (received === 0 || !head.subarray(0, length).includes("%PDF-")) {
      throw new LinkError("link_not_pdf", "That link isn't a direct link to a PDF file.");
    }

    return {
      path: destination,
      filename: path.basename(destination),
      originalName: fileNameFor(url, response.headers["content-disposition"]),
      size: received
    };
  } catch (error) {
    if (destination) fs.rmSync(destination, { force: true });
    throw error instanceof LinkError ? error : unreachable();
  } finally {
    clearTimeout(timer);
  }
}
