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
    lpstatCommand: env.LPSTAT_COMMAND || "lpstat",
    ipptoolCommand: env.IPPTOOL_COMMAND || "ipptool",
    statusSeconds: env.STATUS_SECONDS === undefined ? 60 : Number(env.STATUS_SECONDS),
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

// Asks CUPS (which asks the printer) for toner, paper and state. Returns null when the printer cannot be read.
export async function readPrinterStatus(config) {
  if (!config.printer) return null;
  try {
    // The queue lists every size CUPS supports; the printer itself says what is in the tray.
    const device = (await run(config.lpstatCommand, ["-v", config.printer]).catch(() => ({ stdout: "" }))).stdout.match(/ (ipps?:\/\/\S+)/);
    const { stdout } = await run(
      config.ipptoolCommand,
      ["-tv", device?.[1] || `ipp://localhost/printers/${encodeURIComponent(config.printer)}`, "get-printer-attributes.test"],
      { timeout: 20_000 }
    );
    const values = (key) => {
      const line = stdout.split("\n").find((text) => text.trim().startsWith(`${key} (`));
      return line ? line.slice(line.indexOf("=") + 1).trim().split(",") : [];
    };
    const names = values("marker-names");
    const levels = values("marker-levels");
    const lows = values("marker-low-levels");
    return {
      printer: config.printer,
      state: ({ 3: "idle", 4: "printing", 5: "stopped" })[values("printer-state")[0]] || values("printer-state")[0] || "unknown",
      reasons: values("printer-state-reasons").filter((reason) => reason && reason !== "none").join(", "),
      alert: values("printer-alert-description")[0] || "",
      markers: names.map((name, index) => ({ name, level: Number(levels[index]), low: lows[index] === undefined ? null : Number(lows[index]) })),
      media: values("media-ready").map((size) => size.replace(/^iso_|^na_/, "").replace(/_.*/, "").toUpperCase())
    };
  } catch {
    return null;
  }
}

async function reportStatus(config) {
  const status = await readPrinterStatus(config);
  if (!status) return;
  await api(config, "/api/agent/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(status)
  });
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
  let lastStatus = 0;
  for (;;) {
    let outcome = "idle";
    if (config.statusSeconds > 0 && Date.now() - lastStatus >= config.statusSeconds * 1000) {
      lastStatus = Date.now();
      await reportStatus(config).catch((error) => console.error(`Status report failed: ${error.message}`));
    }
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
