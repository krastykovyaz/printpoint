import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { configFromEnv, readPrinterStatus } from "../agent/print-agent.js";
import { isolateEnvironment, postWebhook, startFakeTelegram, startServer, until } from "./helpers.js";

const fake = await startFakeTelegram();
isolateEnvironment({
  TELEGRAM_API_BASE: fake.url,
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "42",
  PRINT_AGENT_TOKEN: "agent-secret"
});

let ctx;
before(async () => {
  ctx = await startServer();
});
after(() => {
  ctx.server.close();
  fake.server.close();
});

const headers = { Authorization: "Bearer agent-secret", "Content-Type": "application/json" };
const messages = () => fake.callsTo("sendMessage").map((call) => call.body);
async function askPrinter() {
  const seen = messages().length;
  await postWebhook(ctx.base, { message: { text: "/printer", chat: { id: 42 } } });
  await until(() => messages().length > seen);
  return String(messages().pop());
}

test("the status endpoint refuses callers without the agent token", async () => {
  const response = await fetch(`${ctx.base}/api/agent/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401);
});

test("/printer says so before the agent has reported", async () => {
  assert.match(await askPrinter(), /has not reported yet/);
});

test("/printer shows the reported toner, paper and state, and flags low toner", async () => {
  const report = { printer: "Brother", state: "idle", reasons: "", alert: "Sleep", markers: [{ name: "BK", level: 12, low: 16 }], media: ["A4"] };
  const response = await fetch(`${ctx.base}/api/agent/status`, { method: "POST", headers, body: JSON.stringify(report) });
  assert.equal(response.status, 204);
  const text = await askPrinter();
  assert.match(text, /Agent: online/);
  assert.match(text, /State: idle/);
  assert.match(text, /BK: 12% ⚠️ low/);
  assert.match(text, /Paper loaded: A4/);
  assert.match(text, /Queue: 0 waiting, 0 printing, 0 failed/);
});

test("a malformed report cannot inject odd values into the message", async () => {
  const report = { printer: "B\nrother", state: 5, markers: [{ name: "BK", level: 900 }, "junk"], media: [{}, "A4"] };
  await fetch(`${ctx.base}/api/agent/status`, { method: "POST", headers, body: JSON.stringify(report) });
  const text = await askPrinter();
  assert.match(text, /BK: unknown/);
  assert.doesNotMatch(text, /900/);
  assert.match(text, /Paper loaded: A4/);
});

test("the agent reads toner, paper and state from ipptool and lpstat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-ipp-"));
  const ipptool = path.join(dir, "ipptool");
  const lpstat = path.join(dir, "lpstat");
  fs.writeFileSync(lpstat, `#!/bin/sh\necho "device for Brother: ipp://10.0.0.5/ipp/print"\n`, { mode: 0o755 });
  fs.writeFileSync(ipptool, `#!/bin/sh
echo "    printer-state (enum) = idle"
echo "    printer-state-reasons (keyword) = none"
echo "    marker-names (nameWithoutLanguage) = BK"
echo "    marker-levels (integer) = 55"
echo "    marker-low-levels (integer) = 16"
echo "    media-ready (keyword) = iso_a4_210x297mm"
echo "    printer-alert-description (textWithoutLanguage) = Sleep"
`, { mode: 0o755 });
  const config = configFromEnv({ PRINTER: "Brother", IPPTOOL_COMMAND: ipptool, LPSTAT_COMMAND: lpstat });
  assert.deepEqual(await readPrinterStatus(config), {
    printer: "Brother",
    state: "idle",
    reasons: "",
    alert: "Sleep",
    markers: [{ name: "BK", level: 55, low: 16 }],
    media: ["A4"]
  });
});

test("the agent gives no status when the printer cannot be read", async () => {
  const config = configFromEnv({ PRINTER: "Brother", IPPTOOL_COMMAND: "/nonexistent/ipptool" });
  assert.equal(await readPrinterStatus(config), null);
});
