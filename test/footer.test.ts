import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isolate, fakeApi, fakePi, fakeCtx, model } from "./helpers.ts";

const real = JSON.parse(readFileSync(new URL("./fixtures/real-api.json", import.meta.url), "utf8"));
isolate();
const models = [...real.models, model("claude-haiku-5.5", 30.86, { provider: "Anthropic", owned_by: "Anthropic" })];
fakeApi(models, { left: 24 }, { credits: { ...real.credits, rpm_limit: 20, base_rpm_limit: 1000 }, usage: real.usage });
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx, notes } = fakeCtx(h.reg);
for (const hook of h.reg.hooks.session_start) await hook({}, ctx);
const last = () => [...notes].reverse().find((n) => n.startsWith("STATUS "))!.slice(7);
const say = async (args: string) => {
  const before = notes.length;
  await h.reg.cmds.sovereign.handler(args, ctx);
  return notes.slice(before).filter((n) => !n.startsWith("STATUS ")).join("\n");
};
const sendRequests = (n: number) => { for (let i = 0; i < n; i++) h.reg.hooks.before_provider_request[0]({ payload: { model: "x", messages: [] } }, { model: { provider: "sovereigneg" } }); };
const setCols = (n: number | undefined) => Object.defineProperty(process.stdout, "columns", { value: n, configurable: true });

test("rpm is opt-in: nothing in the footer by default, however many requests were sent", async () => {
  sendRequests(19);
  await say("footer full");
  assert.doesNotMatch(last(), /rpm/);
});

test("with rpm on, it appears only once it reaches the threshold (60% of 20 = 12)", async () => {
  await say("rpm on");
  assert.match(await say("rpm"), /on, shown from 60%/);
  assert.match(last(), /rpm 19\/20!/, "19 of 20 is flagged");
});

test("below the threshold the counter stays hidden; 0% always shows it", async () => {
  await say("rpm 99");
  assert.doesNotMatch(last(), /rpm/);
  await say("rpm 0");
  assert.match(last(), /rpm 19\/20/);
  await say("rpm 60");
});

test("compact footer keeps the facts in fewer characters", async () => {
  await say("footer full");
  const full = last();
  await say("footer compact");
  const compact = last();
  assert.ok(compact.length < full.length * 0.7, `${compact.length} vs ${full.length}`);
  assert.match(compact, /^SEG /);
  assert.match(compact, /free 1\.04M \(100%\)/);
  assert.match(compact, /bal 20\.00 EGP/);
});

test("compact drops the least important segments first when the terminal is narrow", async () => {
  setCols(50);
  await say("footer compact");
  const narrow = last();
  assert.ok(narrow.length <= 48 || !narrow.includes(" · "), narrow);
  assert.match(narrow, /rpm 19\/20!/, "rpm outranks money figures once it is shown");
  assert.doesNotMatch(narrow, /paid/);
  setCols(undefined);
});

test("auto: full when it fits, compact when it doesn't", async () => {
  await say("footer auto");
  setCols(300);
  await say("footer auto");
  assert.match(last(), /^SovereignEG · /);
  setCols(70);
  await say("footer auto");
  assert.match(last(), /^SEG /);
  setCols(undefined);
});

test("invalid arguments are rejected without changing the config", async () => {
  assert.match(await say("footer wide"), /Usage/);
  assert.match(await say("rpm banana"), /Usage/);
});

test("/sovereign status shows the plan limit and, with rpm on, the live count", async () => {
  const out = await say("status");
  assert.match(out, /Rate limit: 20 requests\/min \(plan base 1000\) · 19 in the last minute/);
});
