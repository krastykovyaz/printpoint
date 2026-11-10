// Turns any accepted CV file into a PDF next to it, so the page count (and price) is read from what will
// actually be printed, and the print agent only ever receives PDFs.
// Office, iWork and plain text go through LibreOffice; Markdown and EPUB through pandoc (to .docx, images dropped) first;
// DjVu through ddjvu; photos through Pillow. Conversions run one at a time: the server is small.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const imageScript = path.join(here, "image_to_pdf.py");
// pandoc 2.9 has no --sandbox: this filter drops every image so a file cannot pull in server files or URLs.
const noImagesFilter = path.join(here, "no_images.lua");
const TIMEOUT_MS = 90_000;

export const OFFICE_EXTENSIONS = new Set([
  ".doc", ".docx", ".odt", ".rtf", ".txt", ".pages",
  ".ppt", ".pptx", ".pps", ".ppsx", ".odp", ".key",
  ".xls", ".xlsx", ".ods", ".csv"
]);
export const PANDOC_EXTENSIONS = new Set([".md", ".markdown", ".epub"]);
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);
export const CONVERTIBLE_EXTENSIONS = new Set([...OFFICE_EXTENSIONS, ...PANDOC_EXTENSIONS, ".djvu", ...IMAGE_EXTENSIONS]);

export class ConvertError extends Error {}

let queue = Promise.resolve();
function oneAtATime(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

async function libreOffice(input, outDir) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-lo-"));
  try {
    await run("soffice", [
      `-env:UserInstallation=file://${profile}`,
      "--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, input
    ], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, cwd: outDir });
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return path.join(outDir, `${path.basename(input, path.extname(input))}.pdf`);
}

async function convert(input, output) {
  const extension = path.extname(input).toLowerCase();
  const outDir = path.dirname(output);
  if (OFFICE_EXTENSIONS.has(extension)) {
    const produced = await libreOffice(input, outDir);
    if (produced !== output && fs.existsSync(produced)) fs.renameSync(produced, output);
  } else if (PANDOC_EXTENSIONS.has(extension)) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-pandoc-"));
    try {
      const docx = path.join(work, "document.docx");
      const from = extension === ".epub" ? "epub" : "markdown";
      await run("pandoc", ["--lua-filter", noImagesFilter, "-f", from, "-t", "docx", "-o", docx, input], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      const produced = await libreOffice(docx, work);
      fs.renameSync(produced, output);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  } else if (extension === ".djvu") {
    await run("ddjvu", ["-format=pdf", "-quality=85", input, output], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  } else if (IMAGE_EXTENSIONS.has(extension)) {
    let source = input;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-image-"));
    try {
      if (extension === ".heic") {
        source = path.join(work, "photo.jpg");
        await run("heif-convert", [input, source], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      }
      await run("python3", ["-I", imageScript, source, output], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  } else {
    throw new ConvertError(`Unsupported file type ${extension}.`);
  }
}

// Writes <same name>.pdf beside `input` and resolves to its path. Rejects with ConvertError when it cannot.
export function toPdf(input) {
  return oneAtATime(async () => {
    const output = path.join(path.dirname(input), `${path.basename(input, path.extname(input))}-${crypto.randomUUID().slice(0, 8)}.pdf`);
    try {
      await convert(input, output);
    } catch (error) {
      fs.rmSync(output, { force: true });
      if (error instanceof ConvertError) throw error;
      throw new ConvertError(`Conversion failed: ${error.stderr?.toString().trim().slice(0, 300) || error.message}`);
    }
    const head = fs.existsSync(output) ? fs.readFileSync(output).subarray(0, 1024) : Buffer.alloc(0);
    if (!head.includes("%PDF-")) {
      fs.rmSync(output, { force: true });
      throw new ConvertError("Conversion produced no PDF.");
    }
    return output;
  });
}
