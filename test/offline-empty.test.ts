import { test } from "node:test";
import assert from "node:assert/strict";
import { isolate, fakePi, fakeCtx } from "./helpers.ts";

// First ever run without internet: no cache and no built-in list, so there are simply no models yet.
isolate();
(globalThis as any).fetch = async () => { throw new TypeError("fetch failed"); };
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx, notes } = fakeCtx(h.reg);

test("nothing is hard-coded: with no cache and no network there are no models", async () => {
  assert.deepEqual(h.lastIds(), []);
  await h.reg.cmds.sm.handler("", ctx);
  assert.ok(notes.some((n) => /No model list yet/.test(n)), notes.join("|"));
});

test("there is no /sovereign refresh: /sm is the refresh", async () => {
  for (const sub of ["refresh"]) {
    notes.length = 0;
    await h.reg.cmds.sovereign.handler(sub, ctx);
    assert.ok(notes.some((n) => /Unknown subcommand/.test(n)), sub);
  }
});
