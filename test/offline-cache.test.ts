import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolate, fakePi, fakeCtx, model } from "./helpers.ts";

// Launching pi without internet: the models come from the cache written by the last successful fetch.
const dir = isolate();
const data = [model("claude-haiku-5.5", 30.73), model("claude-sonnet-5.5", 614.63), model("claude-opus-5.5", 1229.26)];
writeFileSync(join(dir, "sovereigneg.json"), JSON.stringify({ favorites: ["claude-haiku-5.5", "claude-sonnet-5.5"] }));
writeFileSync(join(dir, "sovereigneg-cache.json"), JSON.stringify({ savedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), data }));
(globalThis as any).fetch = async () => { throw new TypeError("fetch failed"); };
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const labels: string[] = [];
const { ctx, notes } = fakeCtx(h.reg, { ui: { select: async (_t: string, opts: string[]) => (labels.push(...opts), undefined) } });

test("offline at launch: pi's /model still has your favorites, from the cache", () => {
  assert.deepEqual(h.lastIds().sort(), ["claude-haiku-5.5", "claude-sonnet-5.5"]);
});

test("offline at launch: /sm lists the cached models with the cache age instead of failing", async () => {
  for (const hook of h.reg.hooks.session_start) await hook({ reason: "startup" }, ctx);
  await h.reg.cmds.sm.handler("", ctx);
  assert.equal(labels.length, 3);
  assert.match(labels.find((l) => l.startsWith("claude-sonnet-5.5"))!, /out 614\.63/);
  await h.reg.cmds.sovereign.handler("status", ctx);
  assert.ok(notes.some((n) => /offline: prices from cache, 2 h ago/.test(n)), notes.join("|"));
});
