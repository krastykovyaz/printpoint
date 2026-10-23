// Runs on the computer next to the printer (a Raspberry Pi or a laptop with CUPS).
// It only makes outgoing HTTPS calls: ask the server for a confirmed job, print it, report back.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const PRINTABLE = new Set([".pdf", ".doc", ".docx"]);

export function configFromEnv(env = process.env) {
  return {
    server: (env.PRINT_SERVER || "https://print.unilu.space").replace(/\/$/, ""),
    token: env.PRINT_AGENT_TOKEN || "",
    printer: env.PRINTER || "",
    lpCommand: env.LP_COMMAND || "lp",
    sofficeCommand: env.SOFFICE_COMMAND || "soffice",
    lpOptions: (env.LP_OPTIONS ?? "-o print-color-mode=monochrome").split(/\s+/).filter(Boolean),
    pollSeconds: Number(env.POLL_SECONDS) || 5
  };
}

async function api(config, pathname, options = {}) {
  const response = await fetch(`${config.server}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.token}`, ...options.headers }
  });
  if (response.status === 401) throw new Error("The server rejected the agent token.");
  return response;
}

async function toPdf(config, file, dir) {
  await run(config.sofficeCommand, ["--headless", "--convert-to", "pdf", "--outdir", dir, file], { timeout: 120_000 });
  const pdf = path.join(dir, `${path.basename(file, path.extname(file))}.pdf`);
  if (!fs.existsSync(pdf)) throw new Error("The document could not be converted to PDF.");
  return pdf;
}

// Handles at most one job. Returns "idle", "printed" or "failed".
export async function runOnce(config) {
  const next = await api(config, "/api/agent/next");
  if (next.status === 204) return "idle";
  if (!next.ok) throw new Error(`Server answered ${next.status} when asking for a job.`);
  const job = await next.json();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-job-"));
  try {
    if (!PRINTABLE.has(job.extension)) throw new Error(`Unsupported file type ${job.extension}.`);
    const download = await api(config, `/api/agent/jobs/${job.orderCode}/file`);
    if (!download.ok) throw new Error(`Could not download the file (${download.status}).`);
    let file = path.join(dir, `job${job.extension}`);
    fs.writeFileSync(file, Buffer.from(await download.arrayBuffer()));
    if (job.extension !== ".pdf") file = await toPdf(config, file, dir);

    const args = [...(config.printer ? ["-d", config.printer] : []), "-n", String(job.copies), ...config.lpOptions, file];
    await run(config.lpCommand, args, { timeout: 60_000 });
    await report(config, job.orderCode, { ok: true });
    return "printed";
  } catch (error) {
    await report(config, job.orderCode, { ok: false, error: error.stderr?.trim() || error.message }).catch(() => {});
    return "failed";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function report(config, orderCode, body) {
  const response = await api(config, `/api/agent/jobs/${orderCode}/done`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Server answered ${response.status} to the result report.`);
}

async function main() {
  const config = configFromEnv();
  if (!config.token) {
    console.error("Set PRINT_AGENT_TOKEN (the same value as on the server).");
    process.exit(1);
  }
  console.log(`Print agent watching ${config.server}${config.printer ? ` for printer ${config.printer}` : ""}`);
  for (;;) {
    let outcome = "idle";
    try {
      outcome = await runOnce(config);
      if (outcome !== "idle") console.log(`Job ${outcome}.`);
    } catch (error) {
      console.error(error.message);
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    // After a job, look again straight away; otherwise wait.
    if (outcome === "idle") await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
