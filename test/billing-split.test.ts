import { test } from "node:test";
import assert from "node:assert/strict";
import { isolate, fakeApi, fakePi, fakeCtx, CORE_MODELS } from "./helpers.ts";

isolate();
fakeApi(CORE_MODELS, { left: 10 });
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx, notes } = fakeCtx(h.reg);
for (const hook of h.reg.hooks.session_start) await hook({}, ctx);
const last = () => [...notes].reverse().find((n) => n.startsWith("STATUS "))!;

test("a reply that straddles the end of the allowance is split: allowance first, the rest paid", async () => {
  // 15 EGP reply, 10 EGP left → 10 free + 5 paid
  for (const hook of h.reg.hooks.message_end) await hook({ message: { role: "assistant", provider: "sovereigneg", model: "SovereignEG/Qwen3.8-27B-FP8", content: [], usage: { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }, ctx);
  assert.match(last(), /paid 5\.00 EGP/);
  assert.match(last(), /free left 0\.0\/50 EGP/);
  assert.match(last(), /\[PAID\]/);
});
