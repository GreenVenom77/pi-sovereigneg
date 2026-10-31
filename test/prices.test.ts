import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeApi, fakePi, fakeCtx, model } from "./helpers.ts";

// The provider's API is the only source of models and prices. A key only known to pi (not in the environment), and a
// cache from 3 days ago with an outdated price.
const dir = mkdtempSync(join(tmpdir(), "pi-sovereigneg-prices-"));
process.env.PI_SOVEREIGNEG_DIR = dir;
delete process.env.SOVEREIGNEG_API_KEY;
const old = { ...model("claude-haiku-5.5", 30.86), pricing: { input_per_1m_egp: 6.17, output_per_1m_egp: 30.86 } };
const fresh = { ...model("claude-haiku-5.5", 30.73), pricing: { input_per_1m_egp: 6.15, output_per_1m_egp: 30.73 } };
const filler = [model("claude-sonnet-5.5", 614.63), model("claude-opus-5.5", 1229.26), model("SovereignEG/Qwen3.8-27B-FP8", 67.29, { source: "sovereign", context_window: 131072 })];
const CACHE = join(dir, "sovereigneg-cache.json");
writeFileSync(CACHE, JSON.stringify({ savedAt: new Date(Date.now() - 3 * 86400_000).toISOString(), data: [old, ...filler] }));
const realFetch = fakeApi([fresh, ...filler], { left: 40 });
let modelCalls = 0;
const inner = (globalThis as any).fetch;
let offline = false;
(globalThis as any).fetch = async (u: string, o: any) => {
  if (offline) throw new TypeError("fetch failed");
  if (String(u).endsWith("/models")) modelCalls++;
  return inner(u, o);
};
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const labels: string[] = [];
const { ctx, notes } = fakeCtx(h.reg, { ui: { select: async (_t: string, opts: string[]) => (labels.push(...opts), undefined) } });
(ctx.modelRegistry as any).getProviderAuth = async () => ({ apiKey: "sk-" + "a".repeat(32) });
const status = async () => {
  const before = notes.length;
  await h.reg.cmds.sovereign.handler("status", ctx);
  return notes.slice(before).filter((n) => !n.startsWith("STATUS ")).join("\n");
};

test("before any fetch, the cached list is shown and labelled with its age", async () => {
  const out = await status();
  assert.match(out, /cached 3 d ago/);
  assert.match(out, /Prices: offline: prices from cache, 3 d ago/);
});

test("when pi launches the list and prices are re-read from the API and the cache file is updated", async () => {
  for (const hook of h.reg.hooks.session_start) await hook({ reason: "startup" }, ctx);
  await new Promise((r) => setTimeout(r, 100)); // refresh runs in the background
  assert.ok(modelCalls >= 1);
  const out = await status();
  assert.match(out, /from the API, just now/);
  assert.doesNotMatch(out, /Prices:/);
  const saved = JSON.parse(readFileSync(CACHE, "utf8"));
  assert.equal(saved.data.find((m: any) => m.id === "claude-haiku-5.5").pricing.output_per_1m_egp, 30.73, "cache holds today's price");
});

test("every /sm re-reads the API, and shows exactly the listed prices", async () => {
  const n = modelCalls;
  labels.length = 0;
  await h.reg.cmds.sm.handler("", ctx); // no TUI picker in the test: falls back to the select list
  await h.reg.cmds.sm.handler("", ctx);
  assert.equal(modelCalls, n + 2, "one fetch per /sm");
  const sonnet = labels.find((l) => l.startsWith("claude-sonnet-5.5"))!;
  const haiku = labels.find((l) => l.startsWith("claude-haiku-5.5"))!;
  assert.match(sonnet, /out 614\.63/);
  assert.match(haiku, /in 6\.15 · out 30\.73/, "today's price, not the cached 6.17/30.86");
});

test("a price change at the provider shows up on the next /sm and lands in the cache", async () => {
  const changed = { ...fresh, pricing: { input_per_1m_egp: 7, output_per_1m_egp: 35 } };
  fakeApi([changed, ...filler], { left: 40 });
  const inner2 = (globalThis as any).fetch;
  (globalThis as any).fetch = async (u: string, o: any) => (offline ? Promise.reject(new TypeError("fetch failed")) : inner2(u, o));
  labels.length = 0;
  await h.reg.cmds.sm.handler("", ctx);
  assert.match(labels.find((l) => l.startsWith("claude-haiku-5.5"))!, /in 7\.00 · out 35\.00/);
  assert.equal(JSON.parse(readFileSync(CACHE, "utf8")).data.find((m: any) => m.id === "claude-haiku-5.5").pricing.output_per_1m_egp, 35);
});

test("losing the connection later keeps the last answer: /sm still lists the models and the cache is untouched", async () => {
  offline = true;
  labels.length = 0;
  await h.reg.cmds.sm.handler("", ctx);
  assert.ok(labels.some((l) => l.startsWith("claude-haiku-5.5") && /out 35\.00/.test(l)), "last known price");
  assert.ok(labels.length >= 4);
  assert.equal(JSON.parse(readFileSync(CACHE, "utf8")).data.find((m: any) => m.id === "claude-haiku-5.5").pricing.output_per_1m_egp, 35);
  offline = false;
});
