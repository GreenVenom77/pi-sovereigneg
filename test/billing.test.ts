import { test } from "node:test";
import assert from "node:assert/strict";
import { isolate, fakeApi, fakePi, fakeCtx, CORE_MODELS } from "./helpers.ts";

isolate();
// allowance: 50 EGP, 3 left; Qwen (free model) costs 15 EGP out / 3 EGP in per 1M (see helpers: in = out / 5)
fakeApi(CORE_MODELS, { left: 3 });
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx, notes } = fakeCtx(h.reg);
for (const hook of h.reg.hooks.session_start) await hook({}, ctx);
const fire = async (ev: string, payload: any = {}) => { for (const hook of h.reg.hooks[ev] ?? []) await hook(payload, ctx); };
const last = () => [...notes].reverse().find((n) => n.startsWith("STATUS "))!;
const end = (model: string, usage: any) => fire("message_end", { message: { role: "assistant", provider: "sovereigneg", model, content: [], usage } });
const FREE = "SovereignEG/Qwen3.8-27B-FP8";

test("every model is registered with zero cost so pi's own counter never shows spend", () => {
  for (const m of h.provider().models) assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, m.id);
});

test("the extension prices a reply from its tokens (pi reports cost 0)", async () => {
  // sonnet: in 123.4 / out 617 EGP per 1M → 100k in + 10k out = 12.34 + 6.17
  await end("claude-sonnet-5.5", { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
  assert.match(last(), /paid 18\.5\d EGP/);
});

test("a free reply never touches paid", async () => {
  await end(FREE, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }); // 3 EGP, allowance has exactly 3
  assert.match(last(), /paid 18\.5\d EGP/);
  assert.match(last(), /free used/);
});

test("once the allowance is used up the same model is PAID, and its replies are charged as paid", async () => {
  assert.match(last(), /Qwen3\.8-27B-FP8 \[PAID\]/);
  const before = Number(last().match(/paid ([\d.]+) EGP/)![1]);
  await end(FREE, { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }); // 15 EGP
  const after = Number(last().match(/paid ([\d.]+) EGP/)![1]);
  assert.ok(Math.abs(after - before - 15) < 0.01, `${before} → ${after}`);
});
