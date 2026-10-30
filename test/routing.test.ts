import { test } from "node:test";
import assert from "node:assert/strict";
import { isolate, fakeApi, fakePi, fakeCtx, CORE_MODELS } from "./helpers.ts";

isolate();
fakeApi(CORE_MODELS);
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx } = fakeCtx(h.reg);
const prev = (id: string, think = "low") => ({ model: { provider: "sovereigneg", id }, thinkingLevel: think });
const route = (text: string, level = "high", extra: any = {}) =>
  h.reg.virtual.route({ reason: "user", thinkingLevel: level, messages: [{ role: "user", content: text }], ...extra }, ctx);

// Make the free allowance unavailable for these tests (see allowance.test.ts for the opposite)
const HARD = "Refactor the auth module for performance, fix the race condition and investigate the root cause";

test("registers a provider with /login support and a virtual 'smart' model", () => {
  assert.ok(h.provider().oauth, "oauth config present");
  assert.equal(h.reg.virtual.id, "smart");
  assert.deepEqual(h.reg.virtual.thinkingLevels, ["low", "medium", "high"]);
});

test("thinking level acts as a spend ceiling", () => {
  assert.equal(route(HARD, "high").model.id, "claude-opus-5.5");
  assert.equal(route(HARD, "medium").model.id, "claude-sonnet-5.5");
  assert.equal(route(HARD, "low").model.id, "claude-haiku-5.5");
});

test("simple tasks stay cheap even with the highest ceiling", () => {
  assert.equal(route("fix the typo in the README, quick one", "high").model.id, "claude-haiku-5.5");
});

test("tool-call continuations keep the same model (prompt cache)", () => {
  const r = h.reg.virtual.route({ reason: "continuation", thinkingLevel: "high", messages: [], previous: prev("claude-haiku-5.5", "off") }, ctx);
  assert.equal(r.model.id, "claude-haiku-5.5");
});

test("short follow-ups keep the previous model", () => {
  assert.equal(route("continue", "high", { previous: prev("claude-sonnet-5.5") }).model.id, "claude-sonnet-5.5");
});

test("retry after a failure switches to a different model", () => {
  const r = h.reg.virtual.route(
    { reason: "retry", thinkingLevel: "high", messages: [{ role: "user", content: "x" }],
      failed: { model: { provider: "sovereigneg", id: "claude-haiku-5.5" }, message: { errorMessage: "429 rate_limit_exceeded" } } },
    ctx,
  );
  assert.notEqual(r.model.id, "claude-haiku-5.5");
});

test("hidden-thinking guard: adds reasoning_effort none for Claude 5.x only when unset", () => {
  const guard = h.reg.hooks.before_provider_request[0];
  const c = { model: { provider: "sovereigneg" } };
  assert.equal(guard({ payload: { model: "claude-sonnet-5.5", messages: [] } }, c).reasoning_effort, "none");
  assert.equal(guard({ payload: { model: "claude-sonnet-5.5", messages: [], reasoning_effort: "high" } }, c), undefined);
  assert.equal(guard({ payload: { model: "gpt-oss-20b", messages: [] } }, c), undefined);
  assert.equal(guard({ payload: { model: "claude-sonnet-5.5", messages: [] } }, { model: { provider: "anthropic" } }), undefined);
});

test("login rejects malformed keys before any network call", async () => {
  await assert.rejects(
    h.provider().oauth.login({ onAuth() {}, onPrompt: async () => "not-a-key" }),
    /doesn't look like a SovereignEG key/,
  );
});

test("login accepts a valid key and returns a non-expiring credential", async () => {
  const key = "sk-" + "c".repeat(32);
  const cred = await h.provider().oauth.login({ onAuth() {}, onPrompt: async () => key });
  assert.equal(h.provider().oauth.getApiKey(cred), key);
  assert.ok(cred.expires > Date.now() + 365 * 24 * 3600 * 1000);
});

test("API errors get a human explanation", async () => {
  const { ctx: c, notes } = fakeCtx(h.reg);
  const onEnd = h.reg.hooks.message_end[0];
  await onEnd({ message: { role: "assistant", provider: "sovereigneg", model: "x", stopReason: "error", errorMessage: "402 daily_allowance_exhausted", usage: { cost: { total: 0 } } } }, c);
  assert.ok(notes.some((n) => /allowance is used up/i.test(n)), notes.join("|"));
});
