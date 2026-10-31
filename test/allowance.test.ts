import { test } from "node:test";
import assert from "node:assert/strict";
import { isolate, fakeApi, fakePi, fakeCtx, CORE_MODELS } from "./helpers.ts";

isolate();
const state = fakeApi(CORE_MODELS, { left: 40 });
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx, notes } = fakeCtx(h.reg);
for (const hook of h.reg.hooks.session_start) await hook({}, ctx);
const route = (t: string, lvl = "high") => h.reg.virtual.route({ reason: "user", thinkingLevel: lvl, messages: [{ role: "user", content: t }] }, ctx).model.id;
const HARD = "Refactor the architecture for performance, fix the race condition and investigate the root cause of the distributed deadlock";

test("easy and medium tasks use today's free allowance", () => {
  assert.equal(route("rename this variable"), "SovereignEG/Qwen3.8-27B-FP8");
  assert.equal(route("investigate this bug and optimize the query"), "SovereignEG/Qwen3.8-27B-FP8");
});

test("the top tier is never routed to the free model", () => {
  assert.equal(route(HARD), "claude-opus-5.5");
});

test("once the allowance is nearly used up, routing switches to paid models", async () => {
  state.left = 0.5;
  await h.reg.cmds.sovereign.handler("status", ctx); // forces a credits refresh
  assert.equal(route("rename this variable"), "SovereignEG/Qwen3.8-27B-FP8"); // cheapest by price, now paid
});

test("today's free-allowance models (from /v1/credits, not a built-in list) appear in pi's /model", () => {
  assert.ok(h.lastIds().includes("SovereignEG/Qwen3.8-27B-FP8"), h.lastIds().join(","));
});

test("footer shows the free allowance left in EGP and percent", () => {
  assert.ok(notes.some((n) => /^STATUS SovereignEG · .*free left [\d.]+\/50 EGP \(\d+%\)/.test(n)), notes.join("|"));
});
