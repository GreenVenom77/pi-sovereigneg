/**
 * Tests built from REAL SovereignEG responses (test/fixtures/real-api.json, Student plan, 2026-10-29).
 * They lock in the verified field names: provider, context_window, pricing.*, supported_parameters,
 * capabilities.supports_tools, balance_egp, daily_allowance.*, rpm_limit, expiring_credits, usage.spend_egp …
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolate, fakeApi, fakePi, fakeCtx, model } from "./helpers.ts";

const real = JSON.parse(readFileSync(new URL("./fixtures/real-api.json", import.meta.url), "utf8"));
const dir = isolate();

// Real chat models + one big paid model so the router has an alternative to the free model
const models = [...real.models, model("claude-haiku-5.5", 30.86, { provider: "Anthropic", owned_by: "Anthropic" })];
fakeApi(models, { left: 24 }, { credits: real.credits, usage: real.usage });

const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx, notes } = fakeCtx(h.reg);
for (const hook of h.reg.hooks.session_start) await hook({}, ctx);
const lastStatus = () => [...notes].reverse().find((n) => n.startsWith("STATUS "))!;

test("embedding models are excluded; chat models are mapped with real fields", () => {
  const ids = h.provider().models.map((m: any) => m.id);
  assert.ok(!ids.includes("SovereignEG/embeddinggemma-300m"));
  const q = h.provider().models.find((m: any) => m.id === "SovereignEG/Qwen3.8-27B-FP8");
  assert.equal(q.contextWindow, 131072);
  assert.equal(q.reasoning, true, "reasoning is detected from supported_parameters");
  assert.equal(q.cost.input, 8.41);
  assert.equal(q.cost.output, 67.29);
  assert.equal(q.cost.cacheRead, 1.29, "real cache-read price is used");
});

test("tiny / short-context models are never routed or recommended, even though they claim tool support", () => {
  const route = (t: string, lvl: string) => h.reg.virtual.route({ reason: "user", thinkingLevel: lvl, messages: [{ role: "user", content: t }] }, ctx).model.id;
  for (const lvl of ["low", "medium", "high"]) {
    assert.notEqual(route("rename this variable", lvl), "Qwen/Qwen3-0.6B");
    assert.notEqual(route("refactor the architecture for performance", lvl), "Qwen/Qwen3-0.6B");
  }
});

test("author comes from `provider` (Alibaba), not `owned_by` (SovereignEG)", async () => {
  let comp: any;
  const { ctx: c } = fakeCtx(h.reg, {
    ui: {
      custom: (f: any) =>
        new Promise((res) => {
          comp = f({ requestRender() {} }, { fg: (_: string, t: string) => t, bold: (t: string) => t }, null, res);
          setTimeout(() => { comp.handleInput("\t"); comp.handleInput("\x1b"); }, 0); // Tab → Author view, Esc → close
        }),
    },
  });
  await h.reg.cmds.sm.handler("", c);
  const screen = comp.render(100).join("\n");
  assert.match(screen, /\[Author\]/);
  assert.match(screen, /Alibaba \(2\)/); // both Qwen models, grouped under their real author
  assert.doesNotMatch(screen, /SovereignEG \(\d+\)/, "no group named after the host");
});

test("footer shows live balance and the free allowance from the real credits shape", () => {
  assert.match(lastStatus(), /balance 20\.00 EGP/);
  assert.match(lastStatus(), /free left 24\.0\/24 EGP \(100%\)/);
  assert.match(lastStatus(), /rpm 0\/20/, "Student plan limit of 20 requests/min is surfaced");
});

test("the free Qwen model is used while the allowance has budget", () => {
  const r = h.reg.virtual.route({ reason: "user", thinkingLevel: "medium", messages: [{ role: "user", content: "rename this variable" }] }, ctx);
  assert.equal(r.model.id, "SovereignEG/Qwen3.8-27B-FP8");
});

test("requests per minute are counted and the user is warned before hitting the plan limit", async () => {
  const before = h.reg.hooks.before_provider_request[0];
  const c = { ...ctx, model: { provider: "sovereigneg" } };
  for (let i = 0; i < 15; i++) before({ payload: { model: "x", messages: [] } }, c);
  await new Promise((r) => setTimeout(r, 220)); // footer repaints are throttled to one per 200 ms
  before({ payload: { model: "x", messages: [] } }, c);
  assert.match(lastStatus(), /rpm 16\/20/);
  assert.ok(notes.some((n) => /Approaching your plan's rate limit: 16\/20/.test(n)), notes.join("|"));
});

test("/sovereign status prints plan, balance split, expiry, allowance tokens and monthly usage", async () => {
  notes.length = 0;
  await h.reg.cmds.sovereign.handler("status", ctx);
  const out = notes.join("\n");
  assert.match(out, /Plan: Student · 20 requests\/min \(standard 1000\)/);
  assert.match(out, /Balance: 20\.00 EGP \(promo 20\.00, paid 0\.00\)/);
  assert.match(out, /20 EGP expires 2026-11-28/);
  assert.match(out, /Free allowance: 24\.00\/24 EGP left ≈ 1\.04M tokens/);
  assert.match(out, /balance fallback is OFF/);
  assert.match(out, /This month \(2026-10\): 23\.99 EGP · 3\.79M tokens/);
});

test("/sovereign raw redacts per-request ids", async () => {
  const withTx = { ...real.credits, recent_transactions: [{ id: "secret-id", request_id: "req_secret", amount_egp: 0 }] };
  fakeApi(models, { left: 24 }, { credits: withTx, usage: real.usage });
  await h.reg.cmds.sovereign.handler("raw", ctx);
  const file = readFileSync(join(dir, "sovereigneg-debug.json"), "utf8");
  assert.doesNotMatch(file, /req_secret|secret-id/);
  assert.match(file, /entries omitted/);
});
