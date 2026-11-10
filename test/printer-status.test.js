import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { isolateEnvironment, startServer } from "./helpers.js";

isolateEnvironment({ PRINT_AGENT_TOKEN: "agent-secret" });

let ctx;
before(async () => {
  ctx = await startServer();
});
after(() => ctx.server.close());

const headers = { Authorization: "Bearer agent-secret", "Content-Type": "application/json" };
const report = (body) => fetch(`${ctx.base}/api/agent/status`, { method: "POST", headers, body: JSON.stringify(body) });
async function publicStatus() {
  const response = await fetch(`${ctx.base}/api/printer-status`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

test("the main page light: offline until the agent reports, then green, amber when the printer needs a person", async () => {
  assert.deepEqual(await publicStatus(), { status: "offline" });

  await report({ printer: "Brother", state: "idle", reasons: "none", markers: [{ name: "BK", level: 80 }], media: ["A4"] });
  assert.deepEqual(await publicStatus(), { status: "online" });

  await report({ printer: "Brother", state: "processing", reasons: "none" });
  assert.deepEqual(await publicStatus(), { status: "online" });

  await report({ printer: "Brother", state: "idle", reasons: "media-empty-warning" });
  assert.deepEqual(await publicStatus(), { status: "attention" });

  await report({ printer: "Brother", state: "stopped", reasons: "none" });
  assert.deepEqual(await publicStatus(), { status: "attention" });
});

test("the public answer never includes printer details", async () => {
  await report({ printer: "Brother", state: "idle", reasons: "none", alert: "secret alert", markers: [{ name: "BK", level: 5 }] });
  assert.deepEqual(Object.keys(await publicStatus()), ["status"]);
});
