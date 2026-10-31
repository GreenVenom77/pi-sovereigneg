import { test } from "node:test";
import assert from "node:assert/strict";
import { isolate, fakeApi, fakePi, fakeCtx, CORE_MODELS } from "./helpers.ts";

isolate();
fakeApi(CORE_MODELS, { left: 3 });
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx, notes } = fakeCtx(h.reg);
const fire = async (ev: string, payload: any = {}) => { for (const hook of h.reg.hooks[ev] ?? []) await hook(payload, ctx); };
const last = () => [...notes].reverse().find((n) => n.startsWith("STATUS "))!;
const SONNET = "claude-sonnet-5.5"; // in 123.4 / out 617 EGP per 1M (helpers)
const end = (usage: any, model = SONNET) => fire("message_end", { message: { role: "assistant", provider: "sovereigneg", model, content: [], usage } });
const spendEntries = () => h.reg.entries.filter((e: any) => e.customType === "sovereigneg-spend");

await fire("session_start", { reason: "startup" });

test("a brand-new session starts at zero and writes nothing", () => {
  assert.match(last(), /paid 0\.00 EGP/);
  assert.equal(spendEntries().length, 0);
});

test("spend is saved into the session after a reply, and only when it changed", async () => {
  await end({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }); // 617.16 EGP… helpers: 617
  assert.equal(spendEntries().length, 1);
  assert.ok(Math.abs(spendEntries()[0].data.paid - 617) < 0.01, JSON.stringify(spendEntries()[0].data));
  await fire("agent_settled"); // nothing changed since: no new entry
  assert.equal(spendEntries().length, 1);
});

test("writes are throttled, and the settle point flushes the latest total", async () => {
  await end({ input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 }); // +0.617, inside the 5 s window
  assert.equal(spendEntries().length, 1, "throttled");
  await fire("agent_settled");
  assert.equal(spendEntries().length, 2);
  assert.ok(spendEntries()[1].data.paid > spendEntries()[0].data.paid);
});

test("session_shutdown flushes unsaved spend (this is what /reload and /resume pass through)", async () => {
  await end({ input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const before = spendEntries().length;
  await fire("session_shutdown");
  assert.equal(spendEntries().length, before + 1);
});

test("/reload or /resume of that session shows the saved totals again", async () => {
  const saved = spendEntries().at(-1).data.paid;
  await fire("session_start", { reason: "reload" });
  const shown = Number(last().match(/paid ([\d.]+) EGP/)![1]);
  assert.ok(Math.abs(shown - saved) < 0.01, `${shown} vs ${saved}`);
});

test("the largest saved total in the session wins (tree navigation can't lower it)", async () => {
  h.reg.entries.push({ type: "custom", customType: "sovereigneg-spend", data: { v: 1, paid: 5, free: 2, subReplies: 0, subEgp: 0 } }); // an older, smaller one after the big ones
  await fire("session_start", { reason: "resume" });
  const shown = Number(last().match(/paid ([\d.]+) EGP/)![1]);
  assert.ok(shown > 600, String(shown));
  assert.match(last(), /free used/); // free total restored too
});

test("a different (new) session has no entries, so it starts at zero again", async () => {
  h.reg.entries.length = 0;
  await fire("session_start", { reason: "new" });
  assert.match(last(), /paid 0\.00 EGP/);
  assert.doesNotMatch(last(), /free used/);
});
