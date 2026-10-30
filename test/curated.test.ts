import { test } from "node:test";
import assert from "node:assert/strict";
import { isolate, fakeApi, fakePi, fakeCtx, model, CORE_MODELS } from "./helpers.ts";

isolate();
const authors = ["claude", "gpt", "qwen", "llama", "gemini", "deepseek", "mistral", "nova"];
const many = [...CORE_MODELS];
for (let i = 0; i < 116; i++) many.push(model(`${authors[i % 8]}-x${i}`, 20 + i * 5, { context_window: 65536 }));
fakeApi(many);
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);

test("curated mode keeps pi's /model short", () => {
  assert.equal(many.length, 120);
  assert.ok(h.lastIds().length <= 10, `registered ${h.lastIds().length}`);
  assert.ok(h.lastIds().includes("claude-sonnet-5.5"));
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

test("/sovereign list all exposes every model; curated brings the short list back", async () => {
  const { ctx } = fakeCtx(h.reg);
  await h.reg.cmds.sovereign.handler("list all", ctx);
  assert.equal(h.lastIds().length, 120);
  await h.reg.cmds.sovereign.handler("list curated", ctx);
  assert.ok(h.lastIds().length < 20);
});
