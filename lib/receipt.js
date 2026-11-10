// Reads the amount on a payment receipt (screenshot, photo or PDF) and compares it with the order.
// Everything runs locally: the receipt never leaves this server. The result is advisory only,
// because a screenshot can be edited; the shop still decides.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const downscaleScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "downscale.py");

// Big text is the weak spot of OCR, so each image is read at a few sizes and modes, and an amount
// only counts as confirmed when more than one pass agrees on it.
// The third pass only runs when the first two do not settle it, which keeps the usual cost low.
const FIRST_PASSES = [{ width: 400, psm: 11 }, { width: 400, psm: 3 }];
const EXTRA_PASS = { width: 700, psm: 11 };
const OVERALL_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 2;
let running = 0;

const AMOUNT_PATTERN = /(?:€|EUR)\s*-?\s*(\d{1,6}[.,]\d{2})(?!\d)|-?(\d{1,6}[.,]\d{2})\s*(?:€|EUR)/gi;

export function amountsInText(text) {
  const found = [];
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const cents = Math.round(Number((match[1] || match[2]).replace(",", ".")) * 100);
    if (Number.isFinite(cents)) found.push(cents);
  }
  return found;
}

// Turns Tesseract's word table into lines of text, each with its tallest word.
export function linesFromTsv(tsv) {
  const lines = new Map();
  for (const row of tsv.split("\n").slice(1)) {
    const cols = row.split("\t");
    if (cols.length < 12 || !cols[11].trim() || Number(cols[10]) < 0) continue;
    const key = `${cols[2]}.${cols[3]}.${cols[4]}`;
    const line = lines.get(key) || { text: "", height: 0 };
    line.text += `${line.text ? " " : ""}${cols[11]}`;
    line.height = Math.max(line.height, Number(cols[9]) || 0);
    lines.set(key, line);
  }
  return [...lines.values()];
}

// One OCR pass: every amount found, and the one in the tallest text (normally the payment itself).
export function summarisePass(lines) {
  const amounts = [];
  let main = null;
  let mainHeight = -1;
  for (const line of lines) {
    for (const cents of amountsInText(line.text)) {
      amounts.push(cents);
      if (line.height > mainHeight) {
        main = cents;
        mainHeight = line.height;
      }
    }
  }
  return { amounts, main };
}

// Combines the passes into a verdict about the order's expected amount.
export function judge(passes, expectedCents) {
  const read = passes.filter((pass) => pass.amounts.length > 0);
  const all = [...new Set(read.flatMap((pass) => pass.amounts))];
  if (read.length === 0) return { status: "unreadable", amounts: [] };

  const votes = new Map();
  for (const pass of read) votes.set(pass.main, (votes.get(pass.main) || 0) + 1);
  const [leader, leaderVotes] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];

  if (leaderVotes >= 2 && leaderVotes > read.length / 2) {
    return { status: leader === expectedCents ? "match" : "mismatch", paidCents: leader, amounts: all };
  }
  return { status: "uncertain", amounts: all, mentionsExpected: all.includes(expectedCents) };
}

async function ocrImage(filePath, dir, pass, tools) {
  const scaled = path.join(dir, `scaled-${pass.width}.png`);
  await run(tools.python, ["-I", downscaleScript, filePath, scaled, String(pass.width)], { timeout: 15_000 });
  const { stdout } = await run(tools.tesseract, [scaled, "stdout", "--psm", String(pass.psm), "--dpi", "150", "tsv"], {
    timeout: 15_000,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, OMP_THREAD_LIMIT: "1" }
  });
  return summarisePass(linesFromTsv(stdout));
}

async function readPdf(filePath, tools) {
  const { stdout } = await run(tools.pdftotext, ["-layout", "-l", "3", filePath, "-"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const amounts = amountsInText(stdout);
  // A PDF has no text heights, so it can only vouch for an amount when it names exactly one
  // (ignoring €0.00 lines such as fees).
  const distinct = [...new Set(amounts.filter((cents) => cents > 0))];
  const pass = { amounts, main: distinct.length === 1 ? distinct[0] : null };
  return pass.main === null ? [pass] : [pass, pass];
}

// Never throws: any problem becomes { status: "unavailable" } and the order carries on unchecked.
export async function checkReceipt(filePath, expectedCents, tools = {}) {
  const t = { python: "python3", tesseract: "tesseract", pdftotext: "pdftotext", ...tools };
  if (running >= MAX_CONCURRENT) return { status: "unavailable", amounts: [] };
  running += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-receipt-"));
  let timer;
  try {
    const work = async () => {
      if (path.extname(filePath).toLowerCase() === ".pdf") return judge(await readPdf(filePath, t), expectedCents);
      const passes = await Promise.all(FIRST_PASSES.map((pass) => ocrImage(filePath, dir, pass, t)));
      const verdict = judge(passes, expectedCents);
      if (verdict.status === "match" || verdict.status === "mismatch") return verdict;
      return judge([...passes, await ocrImage(filePath, dir, EXTRA_PASS, t)], expectedCents);
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("receipt check timed out")), OVERALL_TIMEOUT_MS);
    });
    return await Promise.race([work(), timeout]);
  } catch (error) {
    console.error("Receipt check failed:", error.code || error.message);
    return { status: "unavailable", amounts: [] };
  } finally {
    clearTimeout(timer);
    running -= 1;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const euro = (cents) => `€${(cents / 100).toFixed(2)}`;

// One line for the shop's Telegram message and email.
export function describeReceipt(receipt, expectedCents) {
  if (!receipt) return null;
  switch (receipt.status) {
    case "match":
      return `Receipt check: ✅ shows ${euro(receipt.paidCents)}, matches the order`;
    case "mismatch":
      return `Receipt check: ⚠️ shows ${euro(receipt.paidCents)} but the order is ${euro(expectedCents)}`;
    case "uncertain": {
      const seen = receipt.amounts.slice(0, 4).map(euro).join(", ");
      return `Receipt check: ❓ couldn't confirm the amount (saw ${seen}${receipt.mentionsExpected ? `; ${euro(expectedCents)} appears but may not be the payment` : ""}) — look at the image`;
    }
    case "unreadable":
      return "Receipt check: ❓ couldn't read an amount — look at the image";
    default:
      return "Receipt check: not done automatically — look at the image";
  }
}
