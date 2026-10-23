import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { configFromEnv, runOnce } from "../agent/print-agent.js";
import { isolateEnvironment, orderForm, PDF, PNG, postOrder, postWebhook, startFakeTelegram, startServer, until } from "./helpers.js";

const fake = await startFakeTelegram();
isolateEnvironment({
  TELEGRAM_API_BASE: fake.url,
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "42",
  PRINT_AGENT_TOKEN: "agent-secret"
});

// A stand-in for `lp` that records how it was called and can be told to fail.
const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-lp-"));
const lpLog = path.join(toolDir, "lp.log");
const fakeLp = path.join(toolDir, "lp");
fs.writeFileSync(fakeLp, `#!/bin/sh
if [ -f "${toolDir}/fail" ]; then echo "printer offline" >&2; exit 1; fi
echo "$@" >> "${lpLog}"
for last; do :; done
cp "$last" "${toolDir}/last.pdf"
`, { mode: 0o755 });

let ctx;
let config;
before(async () => {
  ctx = await startServer();
  config = { ...configFromEnv({ PRINT_SERVER: ctx.base, PRINT_AGENT_TOKEN: "agent-secret", PRINTER: "Brother", LP_COMMAND: fakeLp }) };
});
after(() => {
  ctx.server.close();
  fake.server.close();
});

const uploads = () => fs.readdirSync(process.env.UPLOAD_DIR);
const status = (code) => ctx.db.prepare("SELECT print_status FROM orders WHERE order_code = ?").get(code).print_status;
const answers = () => fake.callsTo("answerCallbackQuery").map((call) => call.body);
// Taps the Print button and waits for the bot's reply, which is sent after the database is updated.
async function press(code) {
  const seen = answers().length;
  await postWebhook(ctx.base, { callback_query: { id: `cb-${code}-${seen}`, data: `print:${code}`, message: { chat: { id: 42 } } } });
  await until(() => answers().length > seen);
  return answers().pop();
}

test("the agent endpoints refuse callers without the token", async () => {
  for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: "agent-secret" }]) {
    assert.equal((await fetch(`${ctx.base}/api/agent/next`, { headers })).status, 401);
  }
});

test("an order is not printed until the Print button is tapped, then it prints the right copies", async () => {
  const { body } = await postOrder(ctx.base, orderForm({ copies: "5" }, { resume: [PDF, "cv.pdf"], paymentProof: [PNG, "receipt.png"] }));
  const code = body.orderCode;

  // The CV waits on the server; the receipt does not.
  assert.equal(uploads().length, 1);
  assert.match(fake.callsTo("sendDocument")[0].body, new RegExp(`print:${code}`));

  assert.equal(await runOnce(config), "idle");
  assert.equal(status(code), null);

  await press(code);
  assert.equal(status(code), "queued");
  assert.equal(await runOnce(config), "printed");

  const call = fs.readFileSync(lpLog, "utf8").trim().split("\n").pop();
  assert.match(call, /-d Brother -n 5 -o print-color-mode=monochrome .*job\.pdf$/);
  assert.equal(fs.readFileSync(path.join(toolDir, "last.pdf"), "utf8"), "%PDF-1.4 test resume");

  assert.equal(status(code), "printed");
  assert.deepEqual(uploads(), []);
  await until(() => fake.callsTo("sendMessage").some((m) => m.body.includes(`Sent to the printer: ${code}`)));
  assert.equal(await runOnce(config), "idle");
});

test("a second tap does not print twice", async () => {
  const { body } = await postOrder(ctx.base, orderForm());
  assert.match(await press(body.orderCode), /Queued/);
  assert.match(await press(body.orderCode), /Already in the print queue/);
  assert.equal(await runOnce(config), "printed");
  assert.match(await press(body.orderCode), /Already printed/);
});

test("a printer error is reported, the file is kept, and a retry works", async () => {
  const { body } = await postOrder(ctx.base, orderForm());
  const code = body.orderCode;
  fs.writeFileSync(path.join(toolDir, "fail"), "");
  await press(code);
  assert.equal(await runOnce(config), "failed");
  assert.equal(status(code), "failed");
  assert.equal(uploads().length, 1);
  await until(() => fake.callsTo("sendMessage").some((m) => m.body.includes("printer offline")));

  fs.rmSync(path.join(toolDir, "fail"));
  await press(code);
  assert.equal(await runOnce(config), "printed");
  assert.deepEqual(uploads(), []);
});

test("a job another agent is holding cannot be fetched, and marking the order ready also removes a waiting file", async () => {
  const { body } = await postOrder(ctx.base, orderForm());
  const code = body.orderCode;
  const headers = { Authorization: "Bearer agent-secret" };
  assert.equal((await fetch(`${ctx.base}/api/agent/jobs/${code}/file`, { headers })).status, 404);
  assert.equal((await fetch(`${ctx.base}/api/agent/jobs/../../etc/passwd/file`, { headers })).status, 404);

  assert.equal(uploads().length, 1);
  await postWebhook(ctx.base, { callback_query: { id: "cb-ready", data: `ready:${code}`, message: { chat: { id: 42 } } } });
  await postWebhook(ctx.base, { message: { chat: { id: 42 }, text: "/skip" } });
  await until(() => uploads().length === 0);
});

test("files nobody printed are removed after the hold time", async () => {
  const { body } = await postOrder(ctx.base, orderForm());
  const [name] = uploads();
  const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
  fs.utimesSync(path.join(process.env.UPLOAD_DIR, name), old, old);
  ctx.runRetention();
  assert.deepEqual(uploads(), []);

  assert.match(await press(body.orderCode), /no longer on the server/);
  assert.equal(status(body.orderCode), null);
});
