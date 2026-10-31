import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolate, fakeApi, fakePi, fakeCtx, CORE_MODELS } from "./helpers.ts";

const dir = isolate();
writeFileSync(join(dir, "sovereigneg.json"), JSON.stringify({ statusRefreshSeconds: 0.05, idleRefreshSeconds: 0 })); // poll every 50 ms while working; no idle polling in tests
const state = fakeApi(CORE_MODELS, { left: 40 });
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx, notes } = fakeCtx(h.reg);
for (const hook of h.reg.hooks.session_start) await hook({}, ctx);
const fire = async (ev: string, payload: any = {}) => { for (const hook of h.reg.hooks[ev] ?? []) await hook(payload, ctx); };
const lastStatus = () => [...notes].reverse().find((n) => n.startsWith("STATUS "))!;
const msg = (model: string, text: string, extra: any = {}) => ({ role: "assistant", provider: "sovereigneg", model, content: [{ type: "text", text }], ...extra });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("status marks the current model FREE or PAID", async () => {
  await fire("message_start", { message: msg("SovereignEG/Qwen3.8-27B-FP8", "") });
  assert.match(lastStatus(), /Qwen3\.8-27B-FP8 \[FREE\]/);
  await fire("message_start", { message: msg("claude-sonnet-5.5", "") });
  assert.match(lastStatus(), /claude-sonnet-5\.5 \[PAID\]/);
});

test("cost ticks up live while a paid reply streams (estimate, marked ≈)", async () => {
  await fire("message_start", { message: msg("claude-sonnet-5.5", "") });
  await wait(220);
  await fire("message_update", { message: msg("claude-sonnet-5.5", "x".repeat(35_000)) }); // ≈10k tokens × 617 EGP/M ≈ 6 EGP
  assert.match(lastStatus(), /paid ≈6\.\d\d EGP/);
});

test("free allowance counts down live while a free reply streams", async () => {
  await fire("message_end", { message: msg("claude-sonnet-5.5", "done", { usage: { cost: { total: 0 } } }) }); // clear previous estimate
  await fire("message_start", { message: msg("SovereignEG/Qwen3.8-27B-FP8", "") });
  await wait(220);
  await fire("message_update", { message: msg("SovereignEG/Qwen3.8-27B-FP8", "x".repeat(70_000)) }); // ≈20k tokens × 15 EGP/M = 0.3 EGP
  assert.match(lastStatus(), /free left ≈39\.[67]\/50 EGP/);
  assert.match(lastStatus(), /\[FREE\]/);
});

test("exact usage replaces the estimate when the message ends, and persists until the next refresh", async () => {
  await fire("message_end", { message: msg("SovereignEG/Qwen3.8-27B-FP8", "done", { usage: { cost: { total: 2 } } }) });
  assert.match(lastStatus(), /free left 38\.0\/50 EGP \(76%\)/);
  assert.doesNotMatch(lastStatus(), /≈/);
  assert.match(lastStatus(), /free used 2\.00/);
});

test("the router stops picking the free model as soon as the live estimate drains the allowance", async () => {
  const route = () => h.reg.virtual.route({ reason: "user", thinkingLevel: "high", messages: [{ role: "user", content: "rename this variable" }] }, ctx).model.id;
  assert.equal(route(), "SovereignEG/Qwen3.8-27B-FP8");
  await h.reg.cmds.sovereign.handler("why", ctx);
  assert.match(notes.at(-1)!, /free allowance/);
  await fire("message_end", { message: msg("SovereignEG/Qwen3.8-27B-FP8", "done", { usage: { cost: { total: 37 } } }) });
  route(); // routes again with the drained allowance
  await h.reg.cmds.sovereign.handler("why", ctx);
  assert.doesNotMatch(notes.at(-1)!, /free allowance/, "only ~1 EGP left < minimum: no longer routed as free");
});

test("a server refresh replaces the local estimate", async () => {
  state.left = 25;
  await h.reg.cmds.sovereign.handler("status", ctx); // forces refresh
  assert.match(lastStatus(), /free left 25\.0\/50 EGP \(50%\)/);
});

test("credits are polled while the agent works, and polling stops afterwards", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (u: string, o: any) => (String(u).endsWith("/credits") && calls++, realFetch(u, o));
  await fire("agent_start");
  await wait(230);
  assert.ok(calls >= 2, `expected repeated polling, got ${calls}`);
  await fire("agent_end");
  await wait(60);
  const frozen = calls;
  await wait(200);
  assert.equal(calls, frozen, "no polling after agent_end");
  (globalThis as any).fetch = realFetch;
});

test("spend from subagents (no message events here) is picked up from the server and added to the session", async () => {
  await h.reg.cmds.sovereign.handler("status", ctx); // settle baseline at the server's current number
  const before = lastStatus();
  const used = Number(/free used ([\d.]+)/.exec(before)?.[1] ?? 0);
  state.left -= 3; // a subagent spent 3 EGP of allowance; no message_end fired in this process
  await h.reg.cmds.sovereign.handler("status", ctx);
  const after = Number(/free used ([\d.]+)/.exec(lastStatus())?.[1]);
  assert.ok(Math.abs(after - used - 3) < 0.01, `free used should grow by 3, was ${used} → ${after}`);
});

test("spend already reported by message_end is not counted twice", async () => {
  await h.reg.cmds.sovereign.handler("status", ctx);
  const used = Number(/free used ([\d.]+)/.exec(lastStatus())?.[1]);
  await fire("message_end", { message: msg("SovereignEG/Qwen3.8-27B-FP8", "done", { usage: { cost: { total: 1 } } }) });
  state.left -= 1; // the server saw the same 1 EGP
  await h.reg.cmds.sovereign.handler("status", ctx);
  const after = Number(/free used ([\d.]+)/.exec(lastStatus())?.[1]);
  assert.ok(Math.abs(after - used - 1) < 0.01, `expected +1, got ${after - used}`);
});
