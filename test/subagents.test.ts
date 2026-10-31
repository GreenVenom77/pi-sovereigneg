import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isolate, fakeApi, fakePi, fakeCtx, CORE_MODELS } from "./helpers.ts";

const dir = isolate();
const state = fakeApi(CORE_MODELS, { left: 40 });
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx, notes } = fakeCtx(h.reg);
for (const hook of h.reg.hooks.session_start) await hook({}, ctx);
const lastStatus = () => [...notes].reverse().find((n) => n.startsWith("STATUS "))!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the main session claims an owner id that child processes inherit", () => {
  assert.match(process.env.PI_SOVEREIGNEG_OWNER ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(process.env.PI_SOVEREIGNEG_OWNER_PID, String(process.pid));
});

test("a child process reports its model and cost; the main session shows and counts it", async () => {
  // the child's replies cost 2 EGP of free allowance; the server sees the same 2 EGP
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", new URL("./child-run.ts", import.meta.url).pathname], {
    env: { ...process.env }, // inherits PI_SOVEREIGNEG_OWNER like a real subagent would
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const ledger = join(dir, "sovereigneg-subagents.jsonl");
  assert.ok(existsSync(ledger), "child wrote the ledger");
  assert.match(readFileSync(ledger, "utf8"), /"k":"cost".*"cost":2/);
  state.left -= 2;
  await wait(1300); // the main session tails the ledger once a second
  assert.match(lastStatus(), /subagent Qwen3\.8-27B-FP8 \[FREE\]/);
  assert.match(lastStatus(), /free used \d+/);
  await h.reg.cmds.sovereign.handler("status", ctx);
  assert.match(notes.join("\n"), /Subagents: 1 replies, 2\.00 EGP/);
});

test("spend reported by a child is not counted twice when the server refresh also sees it", async () => {
  await h.reg.cmds.sovereign.handler("status", ctx); // refresh after the server already dropped by 2
  assert.match(notes.join("\n"), /Session: 0\.00 EGP paid, 2\.00 EGP-equivalent free/);
});

test("footer counters work before any message is sent (credits are read at start-up)", () => {
  assert.match(lastStatus(), /free left/);
});
