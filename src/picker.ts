/**
 * Collapsible, searchable model picker for SovereignEG.
 *
 *  Tab            switch grouping: Category → Author → Host → Price
 *  ↑ ↓            move            ← →   collapse / expand (or jump to / into a group)
 *  Enter          select a model, or open/close a group
 *  type…          live search     Backspace edit      Esc  clear search, then close
 *  Ctrl+F         ★ favorite the highlighted model
 */
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export const SMART_ID = "__smart__";

export interface PickerItem {
  id: string;
  name: string;
  author: string;
  host: string;
  ctx: number;
  inPrice: number | null;
  outPrice: number | null;
  tools: boolean;
  reasoning: boolean;
  free: boolean;
  rec?: "economy" | "balanced" | "top";
  /** every backend is currently unhealthy */
  down?: boolean;
  /** SovereignEG has announced deprecation */
  deprecated?: boolean;
}

type View = "category" | "author" | "host" | "price";
const VIEWS: View[] = ["category", "author", "host", "price"];
const VIEW_LABEL: Record<View, string> = { category: "Category", author: "Author", host: "Host", price: "Price" };
const VISIBLE_ROWS = 15;

interface Group {
  key: string;
  label: string;
  items: PickerItem[];
}
type Row =
  | { t: "smart" }
  | { t: "group"; g: Group; open: boolean }
  | { t: "item"; it: PickerItem; g: Group };

const byPrice = (a: PickerItem, b: PickerItem) => (a.outPrice ?? 0) - (b.outPrice ?? 0) || a.id.localeCompare(b.id);
const REC_ORDER = { economy: 0, balanced: 1, top: 2 } as const;

function fmtCtx(n: number) {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}
function fmtP(n: number | null) {
  return n === null ? "?" : n < 10 ? n.toFixed(2) : n.toFixed(0);
}

function groupsFor(view: View, items: PickerItem[], favs: Set<string>): Group[] {
  const map = new Map<string, Group>();
  const add = (key: string, label: string, it: PickerItem) => {
    if (!map.has(key)) map.set(key, { key, label, items: [] });
    map.get(key)!.items.push(it);
  };

  if (view === "category") {
    for (const it of items) {
      if (favs.has(it.id)) add("1fav", "★ Favorites", it);
      else if (it.free) add("2free", "Free today (your daily allowance)", it);
      else if (it.rec) add("3rec", "Recommended (best value / balanced / top quality)", it);
      else if (it.tools) add("4agents", "Coding & agents (tool calling)", it);
      else add("5chat", "Chat only (no tool calling)", it);
    }
  } else if (view === "author") {
    for (const it of items) add(it.author, it.author, it);
  } else if (view === "host") {
    for (const it of items) add(it.host, it.host, it);
  } else {
    for (const it of items) {
      const p = it.outPrice;
      if (p === null || p === 0) add("0", "Free / unpriced", it);
      else if (p < 30) add("1", "Budget  (< 30 EGP / 1M out)", it);
      else if (p < 300) add("2", "Mid-range  (30–300)", it);
      else if (p < 1000) add("3", "Premium  (300–1000)", it);
      else add("4", "Frontier  (≥ 1000)", it);
    }
  }

  const groups = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const g of groups) {
    g.items.sort(view === "category" && g.key === "3rec" ? (a, b) => REC_ORDER[a.rec!] - REC_ORDER[b.rec!] || byPrice(a, b) : byPrice);
  }
  return groups;
}

/** Opens the picker. Resolves to a model id, SMART_ID, or null when cancelled. */
export async function openPicker(
  ctx: any,
  items: PickerItem[],
  opts: { favorites: Set<string>; onToggleFavorite: (id: string) => void },
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
    let view: View = "category";
    let query = "";
    let cursor = 0;
    let top = 0;
    const collapsed: Record<View, Set<string>> = { category: new Set(), author: new Set(), host: new Set(), price: new Set() };
    const initialized = new Set<View>();
    let rows: Row[] = [];

    const accent = (s: string) => theme.fg("accent", s);
    const dim = (s: string) => theme.fg("dim", s);
    const muted = (s: string) => theme.fg("muted", s);
    const bold = (s: string) => theme.bold(s);

    function filtered(): PickerItem[] {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.length) return items;
      return items.filter((it) => {
        const hay = `${it.id} ${it.name} ${it.author} ${it.host} ${it.free ? "free" : ""} ${it.tools ? "tools agent coding" : "chat"} ${it.reasoning ? "reasoning thinking" : ""}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
    }

    function rebuild(keepKey?: string) {
      const groups = groupsFor(view, filtered(), opener.favorites);
      if (!initialized.has(view)) {
        initialized.add(view);
        // Category view: open the first two groups; other views start fully collapsed (overview first)
        groups.forEach((g, i) => {
          if (!(view === "category" ? i < 2 : groups.length <= 3)) collapsed[view].add(g.key);
        });
      }
      const searching = query.trim().length > 0;
      const next: Row[] = [];
      const smartMatch = !searching || /smart|auto|route/.test(query.toLowerCase());
      if (smartMatch) next.push({ t: "smart" });
      for (const g of groups) {
        const open = searching || !collapsed[view].has(g.key);
        next.push({ t: "group", g, open });
        if (open) for (const it of g.items) next.push({ t: "item", it, g });
      }
      rows = next;
      if (keepKey) {
        const idx = rows.findIndex((r) => rowKey(r) === keepKey);
        if (idx >= 0) cursor = idx;
      }
      cursor = Math.max(0, Math.min(cursor, rows.length - 1));
    }
    const rowKey = (r: Row) => (r.t === "smart" ? "smart" : r.t === "group" ? `g:${r.g.key}` : `i:${r.it.id}`);
    const opener = opts;
    rebuild();

    function badges(it: PickerItem): string {
      const b: string[] = [];
      if (it.down) b.push("DOWN");
      if (it.deprecated) b.push("deprecated");
      if (it.free) b.push("FREE");
      if (it.rec) b.push(it.rec === "economy" ? "best value" : it.rec === "balanced" ? "balanced" : "top quality");
      if (it.reasoning) b.push("reasoning");
      if (!it.tools) b.push("no tools");
      return b.join(" · ");
    }

    function lineFor(r: Row, selected: boolean, width: number): string {
      let text: string;
      if (r.t === "smart") {
        text = `${bold("Smart (auto-route)")}  ${dim("picks per request · thinking level = spend ceiling")}`;
      } else if (r.t === "group") {
        text = `${r.open ? "▾" : "▸"} ${bold(r.g.label)} ${dim(`(${r.g.items.length})`)}`;
      } else {
        const it = r.it;
        const fav = opener.favorites.has(it.id) ? "★ " : "  ";
        text = `   ${fav}${it.id}  ${dim(`${fmtCtx(it.ctx)} · ${fmtP(it.inPrice)}/${fmtP(it.outPrice)} EGP`)}  ${muted(badges(it))}`;
      }
      const prefix = selected ? accent("› ") : "  ";
      return truncateToWidth(prefix + text, width);
    }

    function render(width: number): string[] {
      const lines: string[] = [];
      const total = filtered().length;
      lines.push(truncateToWidth(accent(bold("SovereignEG models")) + dim(`  ${total} of ${items.length}`), width));
      lines.push(
        truncateToWidth(
          VIEWS.map((v) => (v === view ? accent(bold(`[${VIEW_LABEL[v]}]`)) : dim(` ${VIEW_LABEL[v]} `))).join(" "),
          width,
        ),
      );
      lines.push(truncateToWidth(`${muted("Search:")} ${query}${accent("▏")}`, width));
      lines.push("");

      if (cursor < top) top = cursor;
      if (cursor >= top + VISIBLE_ROWS) top = cursor - VISIBLE_ROWS + 1;
      top = Math.max(0, Math.min(top, Math.max(0, rows.length - VISIBLE_ROWS)));

      if (top > 0) lines.push(dim(`  ↑ ${top} more`));
      if (!rows.length) lines.push(theme.fg("warning", "  No models match your search."));
      rows.slice(top, top + VISIBLE_ROWS).forEach((r, i) => lines.push(lineFor(r, top + i === cursor, width)));
      const below = rows.length - (top + VISIBLE_ROWS);
      if (below > 0) lines.push(dim(`  ↓ ${below} more`));

      lines.push("");
      lines.push(truncateToWidth(dim("↑↓ move · ←→ fold · Enter select · Tab group by · type to search · Ctrl+F ★ · Esc close"), width));
      return lines;
    }

    function toggleGroup(g: Group, open?: boolean) {
      const key = `g:${g.key}`;
      const isOpen = !collapsed[view].has(g.key);
      const want = open ?? !isOpen;
      if (want) collapsed[view].delete(g.key);
      else collapsed[view].add(g.key);
      rebuild(key);
    }

    function handleInput(data: string) {
      const r = rows[cursor];
      if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
      else if (matchesKey(data, Key.down)) cursor = Math.min(rows.length - 1, cursor + 1);
      else if (matchesKey(data, Key.home)) cursor = 0;
      else if (matchesKey(data, Key.end)) cursor = rows.length - 1;
      else if (matchesKey(data, Key.right)) {
        if (r?.t === "group") {
          if (!r.open) toggleGroup(r.g, true);
          else cursor = Math.min(rows.length - 1, cursor + 1);
        }
      } else if (matchesKey(data, Key.left)) {
        if (r?.t === "item") {
          const gi = rows.findIndex((x) => x.t === "group" && x.g === r.g);
          if (gi >= 0) cursor = gi;
        } else if (r?.t === "group" && r.open && !query.trim()) toggleGroup(r.g, false);
      } else if (matchesKey(data, Key.enter)) {
        if (r?.t === "group") {
          if (!query.trim()) toggleGroup(r.g);
        } else if (r?.t === "smart") return done(SMART_ID);
        else if (r?.t === "item") return done(r.it.id);
      } else if (matchesKey(data, Key.tab)) {
        view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
        cursor = 0;
        top = 0;
        rebuild();
      } else if (matchesKey(data, Key.escape)) {
        if (query) {
          query = "";
          cursor = 0;
          rebuild();
        } else return done(null);
      } else if (matchesKey(data, Key.ctrl("f"))) {
        if (r?.t === "item") {
          opener.onToggleFavorite(r.it.id);
          rebuild(rowKey(r));
        }
      } else if (matchesKey(data, Key.backspace)) {
        if (query) {
          query = query.slice(0, -1);
          cursor = 0;
          rebuild();
        }
      } else if (!data.startsWith("\x1b") && /^[^\x00-\x1f\x7f]+$/u.test(data)) {
        query += data; // printable text (also pasted)
        cursor = 0;
        top = 0;
        rebuild();
      } else return;
      tui.requestRender();
    }

    return { render, invalidate: () => {}, handleInput };
  });
}
