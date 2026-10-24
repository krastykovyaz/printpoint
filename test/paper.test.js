import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { configFromEnv, runOnce } from "../agent/print-agent.js";
import { isolateEnvironment, orderForm, postOrder, postWebhook, startFakeTelegram, startServer, until } from "./helpers.js";

const fake = await startFakeTelegram();
isolateEnvironment({
  TELEGRAM_API_BASE: fake.url,
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "42",
  PRINT_AGENT_TOKEN: "agent-secret",
  PAPER_ALERT_PERCENT: "90"
});

const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "printpoint-paper-"));
const fakeLp = path.join(toolDir, "lp");
fs.writeFileSync(fakeLp, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

let ctx;
let config;
before(async () => {
  ctx = await startServer();
  config = configFromEnv({ PRINT_SERVER: ctx.base, PRINT_AGENT_TOKEN: "agent-secret", PRINTER: "Brother", LP_COMMAND: fakeLp });
});
after(() => {
  ctx.server.close();
  fake.server.close();
});

const messages = () => fake.callsTo("sendMessage").map((call) => String(call.body));
async function say(text) {
  const seen = messages().length;
  await postWebhook(ctx.base, { message: { text, chat: { id: 42 } } });
  await until(() => messages().length > seen);
  return messages().pop();
}

async function printOrder(copies) {
  const { body } = await postOrder(ctx.base, orderForm({ copies: String(copies) }));
  const code = body.orderCode;
  ctx.db.prepare("UPDATE orders SET print_status = 'queued', pages = 1 WHERE order_code = ?").run(code);
  assert.equal(await runOnce(config), "printed");
  return code;
}

test("/paper without a number shows that nothing is counted yet", async () => {
  assert.match(await say("/paper"), /not counted yet/);
});

test("/paper rejects anything that is not a sensible number of sheets", async () => {
  for (const bad of ["/paper abc", "/paper 0", "/paper -5", "/paper 99999"]) {
    assert.match(await say(bad), /followed by the number of sheets/);
  }
});

test("each printed order is subtracted, and the warning comes once when under 90% is left", async () => {
  assert.match(await say("/paper 100"), /Counting from 100 sheets/);
  const before = messages().length;
  await printOrder(5); // 95 left: still above 90%
  await until(() => messages().length > before);
  assert.match(await say("/paper"), /95 of 100 sheets \(95%\)/);
  assert.ok(!messages().some((text) => /Time to think about refilling/.test(text)));

  await printOrder(10); // 85 left: below 90%
  await until(() => messages().some((text) => /Time to think about refilling/.test(text)));
  const warnings = () => messages().filter((text) => /Time to think about refilling/.test(text)).length;
  assert.equal(warnings(), 1);

  await printOrder(5); // 80 left: no second warning
  assert.match(await say("/paper"), /80 of 100 sheets \(80%\)/);
  assert.equal(warnings(), 1);
});

test("/printer includes the paper line, and the tray reports empty when it runs out", async () => {
  assert.match(await say("/printer"), /Paper left: ~80 of 100/);
  await say("/paper 6");
  await printOrder(6);
  await until(() => messages().some((text) => /tray should be empty/.test(text)));
  assert.match(await say("/paper"), /0 of 6 sheets \(0%\)/);
});
