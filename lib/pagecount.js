// How many pages a CV has, read from the file itself, so the price never depends on a number typed in the browser.
// PDF: asked from poppler's pdfinfo. Word .docx: the count Word saved in the file. Old Word .doc and anything
// unreadable: unknown, and the order is priced as one page per copy and flagged to the shop.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const docxScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "docx_pages.py");

// Resolves to { pages: <whole number> | null }. Never throws.
export async function countPages(filePath, tools = {}) {
  const { pdfinfo = "pdfinfo", python = "python3" } = tools;
  try {
    const extension = path.extname(filePath).toLowerCase();
    let text = "";
    if (extension === ".pdf") {
      const { stdout } = await run(pdfinfo, [filePath], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      text = (/^Pages:\s+(\d+)/m.exec(stdout) || [])[1] || "";
    } else if (extension === ".docx") {
      const { stdout } = await run(python, ["-I", docxScript, filePath], { timeout: 10_000, maxBuffer: 1024 });
      text = stdout.trim();
    }
    const pages = Number(text);
    return { pages: Number.isInteger(pages) && pages > 0 ? pages : null };
  } catch {
    return { pages: null };
  }
}
