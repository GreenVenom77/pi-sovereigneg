import { test } from "node:test";
import assert from "node:assert/strict";
import { openPicker, SMART_ID, type PickerItem } from "../src/picker.ts";

const item = (id: string, author: string, host: string, out: number | null, extra: Partial<PickerItem> = {}): PickerItem => ({
  id, name: id, author, host, ctx: 1_000_000, inPrice: out === null ? null : out / 5, outPrice: out, tools: true, reasoning: false, free: false, ...extra,
});
const ITEMS = [
  item("SovereignEG/Qwen3.8-27B-FP8", "Alibaba (Qwen)", "SovereignEG GPUs (Egypt)", 15, { free: true }),
  item("claude-haiku-5.5", "Anthropic", "Third-party providers", 30.86, { rec: "economy" }),
  item("claude-sonnet-5.5", "Anthropic", "Third-party providers", 617, { rec: "balanced" }),
  item("claude-fable-5.1", "Anthropic", "Third-party providers", 3085),
  item("gpt-oss-20b", "OpenAI", "Third-party providers", 4),
  item("qwen-2-1.5b", "Alibaba (Qwen)", "Third-party providers", 6, { tools: false }),
  item("nova-lite-v1", "Amazon", "Third-party providers", 13), // 4 authors → author view starts collapsed
];
const K = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", tab: "\t" };

function open(favorites = new Set<string>(), toggled: string[] = []) {
  let comp: any;
  const p = openPicker(
    { ui: { custom: (f: any) => new Promise((res) => { comp = f({ requestRender() {} }, { fg: (_: string, t: string) => t, bold: (t: string) => t }, null, res); }) } },
    ITEMS,
    { favorites, onToggleFavorite: (id) => (toggled.push(id), favorites.has(id) ? favorites.delete(id) : favorites.add(id)) },
  );
  const screen = () => comp.render(110).join("\n");
  return { comp, p, screen, type: (s: string) => [...s].forEach((c) => comp.handleInput(c)) };
}

test("category view opens the first groups and collapses the rest", () => {
  const { screen } = open();
  const s = screen();
  assert.match(s, /▾ Free today/);
  assert.match(s, /▾ Recommended/);
  assert.match(s, /▸ Coding & agents/);
  assert.match(s, /claude-haiku-5\.5/);
  assert.doesNotMatch(s, /gpt-oss-20b/); // inside a collapsed group
});

test("Tab cycles Category → Author → Host → Price", () => {
  const { comp, screen } = open();
  comp.handleInput(K.tab); assert.match(screen(), /\[Author\]/);
  comp.handleInput(K.tab); assert.match(screen(), /\[Host\]/);
  comp.handleInput(K.tab); assert.match(screen(), /\[Price\]/);
  comp.handleInput(K.tab); assert.match(screen(), /\[Category\]/);
});

test("author view starts collapsed; → expands a group and ← collapses it", () => {
  const { comp, screen } = open();
  comp.handleInput(K.tab);
  assert.doesNotMatch(screen(), /claude-sonnet/);
  comp.handleInput(K.down); // Alibaba
  comp.handleInput(K.down); // Amazon
  comp.handleInput(K.down); // Anthropic
  comp.handleInput(K.right);
  assert.match(screen(), /claude-sonnet-5\.5/);
  comp.handleInput(K.left);
  assert.doesNotMatch(screen(), /claude-sonnet/);
});

test("typing searches across all groups; Esc clears the search before closing", () => {
  const { comp, screen, type } = open();
  type("qwen");
  assert.match(screen(), /2 of 7/);
  assert.match(screen(), /qwen-2-1\.5b/);
  comp.handleInput(K.esc);
  assert.match(screen(), /7 of 7/);
});

test("Ctrl+F toggles favorites and favorites move to the top group", () => {
  const toggled: string[] = [];
  const { comp, screen } = open(new Set(), toggled);
  comp.handleInput(K.down); comp.handleInput(K.down); // first model in 'Free today'
  comp.handleInput("\x06");
  assert.deepEqual(toggled, ["SovereignEG/Qwen3.8-27B-FP8"]);
  assert.match(screen(), /▾ ★ Favorites/);
});

test("Enter selects a model; Enter on the Smart row returns SMART_ID; Esc cancels", async () => {
  const a = open(); a.comp.handleInput(K.down); a.comp.handleInput(K.down); a.comp.handleInput(K.enter);
  assert.equal(await a.p, "SovereignEG/Qwen3.8-27B-FP8");
  const b = open(); b.comp.handleInput(K.enter);
  assert.equal(await b.p, SMART_ID);
  const c = open(); c.comp.handleInput(K.esc);
  assert.equal(await c.p, null);
});
