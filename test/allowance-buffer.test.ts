import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolate, fakeApi, fakePi, fakeCtx, CORE_MODELS } from "./helpers.ts";

const dir = isolate();
writeFileSync(join(dir, "sovereigneg.json"), JSON.stringify({ minAllowanceLeftEgp: 0 })); // no buffer: use the allowance to the last piastre
const state = fakeApi(CORE_MODELS, { left: 40 });
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx, notes } = fakeCtx(h.reg);
for (const hook of h.reg.hooks.session_start) await hook({}, ctx);
const routeAndWhy = async (t: string) => {
  notes.length = 0;
  h.reg.virtual.route({ reason: "user", thinkingLevel: "medium", messages: [{ role: "user", content: t }] }, ctx);
  await h.reg.cmds.sovereign.handler("why", ctx);
  return notes.join("\n");
};

test("with a 0 buffer the router still uses the allowance while any is left", async () => {
  state.left = 0.3;
  await h.reg.cmds.sovereign.handler("status", ctx); // refresh credits
  assert.match(await routeAndWhy("rename this variable"), /\(free allowance\)/);
});

test("with a 0 buffer the router never routes to an allowance that is completely used up", async () => {
  state.left = 0;
  await h.reg.cmds.sovereign.handler("status", ctx);
  assert.doesNotMatch(await routeAndWhy("rename this variable"), /\(free allowance\)/);
});
