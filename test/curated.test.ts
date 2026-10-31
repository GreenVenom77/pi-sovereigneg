import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolate, fakeApi, fakePi, fakeCtx, model, CORE_MODELS } from "./helpers.ts";

const dir = isolate();
writeFileSync(join(dir, "sovereigneg.json"), JSON.stringify({ favorites: ["claude-sonnet-5.5", "claude-haiku-5.5"] }));
const authors = ["claude", "gpt", "qwen", "llama", "gemini", "deepseek", "mistral", "nova"];
const many = [...CORE_MODELS];
for (let i = 0; i < 116; i++) many.push(model(`${authors[i % 8]}-x${i}`, 20 + i * 5, { context_window: 65536 }));
fakeApi(many);
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);

test("curated mode: pi's /model lists smart plus your favorites (nothing else yet: no recent models, no free-allowance info)", () => {
  assert.equal(many.length, 120);
  assert.equal(h.reg.virtual.id, "smart");
  assert.deepEqual(h.lastIds().sort(), ["claude-haiku-5.5", "claude-sonnet-5.5"]);
});

test("/sm: picking a model that is hidden from /model registers and selects it", async () => {
  assert.ok(!h.lastIds().includes("llama-x3"));
  const { ctx } = fakeCtx(h.reg, {
    ui: {
      custom: (factory: any) =>
        new Promise((res) => {
          const c = factory({ requestRender() {} }, { fg: (_: string, t: string) => t, bold: (t: string) => t }, null, res);
          setTimeout(() => {
            for (const ch of "llama-x3") c.handleInput(ch);
            c.handleInput("\x1b[B"); // group header
            c.handleInput("\r"); // (search auto-expands, Enter on header is a no-op)
            c.handleInput("\x1b[B"); // first match
            c.handleInput("\r");
          }, 0);
        }),
    },
  });
  await h.reg.cmds.sm.handler("", ctx);
  assert.equal(h.reg.setModelCalls.at(-1), "llama-x3");
  assert.ok(h.lastIds().includes("llama-x3"));
});

test("recently used models stay in /model (newest first, at most 8); smart doesn't count as a model", async () => {
  const sel = h.reg.hooks.model_select[0];
  await sel({ model: { provider: "sovereigneg", id: "llama-x3" } });
  await sel({ model: { provider: "sovereigneg", id: "qwen-x2" } });
  await sel({ model: { provider: "sovereigneg", id: "smart" } });
  await new Promise((r) => setTimeout(r, 20));
  // Qwen is in today's free allowance (fake /v1/credits, loaded by the /sm above), so it is listed too
  assert.deepEqual(h.lastIds().sort(), ["SovereignEG/Qwen3.8-27B-FP8", "claude-haiku-5.5", "claude-sonnet-5.5", "llama-x3", "qwen-x2"]);
  for (let i = 20; i < 30; i++) await sel({ model: { provider: "sovereigneg", id: `${authors[i % 8]}-x${i}` } }); // ids that exist in the catalog
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.lastIds().length, 2 + 1 + 8, "favorites + today's free model + the 8 most recent");
  assert.ok(!h.lastIds().includes("llama-x3"));
});

test("/sovereign list all exposes every model; curated brings favorites-only back", async () => {
  const { ctx } = fakeCtx(h.reg);
  await h.reg.cmds.sovereign.handler("list all", ctx);
  assert.equal(h.lastIds().length, 120);
  await h.reg.cmds.sovereign.handler("list curated", ctx);
  assert.ok(h.lastIds().length <= 12 && h.lastIds().includes("claude-sonnet-5.5"));
});
