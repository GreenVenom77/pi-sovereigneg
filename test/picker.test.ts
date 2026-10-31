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

test("tabs are Favorites · Price · Author · Host", () => {
  const { screen } = open(new Set(["gpt-oss-20b"]));
  assert.match(screen(), /\[Favorites\]\s+Price\s+Author\s+Host/);
});

test("with no favorites the picker opens on Price (collapsed groups) with a hint on the Favorites tab", () => {
  const { comp, screen } = open();
  let s = screen();
  assert.match(s, /\[Price\]/);
  assert.match(s, /▸ Budget/);
  assert.doesNotMatch(s, /gpt-oss-20b/); // inside a collapsed group
  for (let i = 0; i < 3; i++) comp.handleInput(K.tab); // Price → Author → Host → Favorites
  s = screen();
  assert.match(s, /\[Favorites\]/);
  assert.match(s, /No favorites yet\. Press Ctrl\+F/);
  assert.doesNotMatch(s, /claude-haiku/);
});

test("Price tab: a model that is free right now sits in 'Free today' and returns to its price group once it is no longer free", () => {
  const paid = item("claude-sonnet-5.5", "Anthropic", "Third-party providers", 617);
  const run = (free: boolean) => {
    let comp: any;
    openPicker(
      { ui: { custom: (f: any) => new Promise((res) => { comp = f({ requestRender() {} }, { fg: (_: string, t: string) => t, bold: (t: string) => t }, null, res); }) } },
      [{ ...paid, free }, item("gpt-oss-20b", "OpenAI", "Third-party providers", 4)],
      { favorites: new Set<string>(), onToggleFavorite() {} },
    );
    return comp.render(110).join("\n");
  };
  let s = run(true); // opens on Price (no favorites)
  assert.match(s, /\[Price\]/);
  assert.match(s, /▾ Free today \(your daily allowance\) \(1\)/);
  assert.match(s, /claude-sonnet-5\.5/);
  assert.doesNotMatch(s, /Premium/);
  s = run(false); // allowance used up: back in the Premium group, no free group
  assert.doesNotMatch(s, /Free today/);
  assert.match(s, /Premium {2}\(300–1000\)/);
});

test("FREE (low) marks free models whose allowance is below the router's buffer; plain FREE otherwise", () => {
  const render = (freeLow: boolean) => {
    let comp: any;
    openPicker(
      { ui: { custom: (f: any) => new Promise((res) => { comp = f({ requestRender() {} }, { fg: (_: string, t: string) => t, bold: (t: string) => t }, null, res); }) } },
      [item("SovereignEG/Qwen3.8-27B-FP8", "Alibaba (Qwen)", "SovereignEG GPUs (Egypt)", 15, { free: true, freeLow })],
      { favorites: new Set<string>(), onToggleFavorite() {} },
    );
    return comp.render(120).join("\n");
  };
  let s = render(false);
  assert.match(s, /▾ Free today/);
  assert.match(s, /FREE(?! \(low\))/);
  assert.doesNotMatch(s, /FREE \(low\)/);
  s = render(true);
  assert.match(s, /▾ Free today/); // still in the group: it is free to use, just not auto-picked
  assert.match(s, /FREE \(low\)/);
});

test("the Favorites tab lists only starred models and is the first tab when there are favorites", () => {
  const { screen } = open(new Set(["gpt-oss-20b", "claude-haiku-5.5"]));
  const s = screen();
  assert.match(s, /\[Favorites\]/);
  assert.match(s, /▾ ★ Favorites \(2\)/);
  assert.match(s, /gpt-oss-20b/);
  assert.match(s, /claude-haiku-5\.5/);
  assert.doesNotMatch(s, /claude-sonnet|nova-lite|qwen-2/);
});

test("searching on the Favorites tab also finds non-favorites, listed after the favorites", () => {
  const { screen, type } = open(new Set(["claude-haiku-5.5"]));
  type("claude");
  const s = screen();
  assert.match(s, /▾ ★ Favorites \(1\)/);
  assert.match(s, /▾ Other models \(2\)/);
  assert.match(s, /claude-sonnet-5\.5/);
  assert.match(s, /claude-fable-5\.1/);
});

test("Tab cycles Favorites → Price → Author → Host", () => {
  const { comp, screen } = open(new Set(["gpt-oss-20b"]));
  assert.match(screen(), /\[Favorites\]/);
  comp.handleInput(K.tab); assert.match(screen(), /\[Price\]/);
  comp.handleInput(K.tab); assert.match(screen(), /\[Author\]/);
  comp.handleInput(K.tab); assert.match(screen(), /\[Host\]/);
  comp.handleInput(K.tab); assert.match(screen(), /\[Favorites\]/);
});

test("author view starts collapsed; → expands a group and ← collapses it", () => {
  const { comp, screen } = open();
  comp.handleInput(K.tab); // Price → Author
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

test("Ctrl+F stars a model (shown with ★ and listed in the Favorites tab) and un-stars it again", () => {
  const toggled: string[] = [];
  const { comp, screen } = open(new Set(), toggled);
  comp.handleInput(K.down); comp.handleInput(K.right); comp.handleInput(K.down); // Price: first group → open it → first model
  const first = screen().match(/› .*?(\S+)\s{2}\d/)?.[1];
  comp.handleInput("\x06");
  assert.deepEqual(toggled, [first]);
  assert.match(screen(), /★/);
  for (let i = 0; i < 3; i++) comp.handleInput(K.tab); // → Favorites
  assert.match(screen(), /▾ ★ Favorites \(1\)/);
  comp.handleInput(K.down); comp.handleInput(K.down); // the starred model
  comp.handleInput("\x06"); // un-star on the Favorites tab: it leaves the list
  assert.match(screen(), /No favorites yet/);
});

test("Enter selects a model; Enter on the Smart row returns SMART_ID; Esc cancels", async () => {
  const a = open(new Set(["SovereignEG/Qwen3.8-27B-FP8"])); a.comp.handleInput(K.down); a.comp.handleInput(K.down); a.comp.handleInput(K.enter); // Favorites tab: smart → group → model
  assert.equal(await a.p, "SovereignEG/Qwen3.8-27B-FP8");
  const b = open(); b.comp.handleInput(K.enter);
  assert.equal(await b.p, SMART_ID);
  const c = open(); c.comp.handleInput(K.esc);
  assert.equal(await c.p, null);
});

test("rows label every number and show cache prices; the highlighted model gets a full detail line", () => {
  const withCache = [item("claude-haiku-5.5", "Anthropic", "Third-party providers", 30.86, { rec: "economy", cacheRead: 0.62, cacheWrite: 7.71, cacheWrite1h: 12.34 })];
  let comp: any;
  openPicker(
    { ui: { custom: (f: any) => new Promise((res) => { comp = f({ requestRender() {} }, { fg: (_: string, t: string) => t, bold: (t: string) => t }, null, res); }) } },
    withCache,
    { favorites: new Set<string>(), onToggleFavorite() {} },
  );
  comp.handleInput(K.down); comp.handleInput(K.down); // smart → group → the model
  const s = comp.render(140).join("\n");
  assert.match(s, /EGP per 1M tokens · ctx = context window/);
  assert.match(s, /1M ctx · in 6\.17 · out 30\.86 · cache r 0\.62 w 7\.71/);
  assert.match(s, /cache read 0\.62 · cache write 7\.71 \(1h 12\.34\)/);
});
