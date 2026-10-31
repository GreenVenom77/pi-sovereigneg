/**
 * SovereignEG for pi
 *
 *  - /login → SovereignEG: opens the dashboard key page, you paste the key,
 *    it is validated against the API before being stored.
 *    (Env var SOVEREIGNEG_API_KEY also works.)
 *  - Models and prices come only from the provider's API (GET /v1/models), nothing is hard-coded. They are re-read
 *    when pi starts and every time /sm opens; the last answer is cached so the list still opens offline.
 *  - `sovereigneg/smart`: a virtual model that routes every request to the
 *    cheapest model likely to do the job, prefers your free daily allowance,
 *    and never switches model after an error (pi retries on the same one).
 *  - /sm (or /sovereign models): collapsible, searchable model tree
 *    (group by Category / Author / Host / Price, favorites with Ctrl+F).
 *  - "curated" mode: pi's /model lists smart plus your favorites, recent models, today's free models and the selected
 *    model; /sm reaches everything.
 *  - /sovereign: status, credits, task-based model picker.
 *  - Guards: hidden-thinking cost guard, friendly 402/429 messages,
 *    session budget prompt.
 *
 * Install: copy this folder to ~/.pi/agent/extensions/sovereigneg/ and run /reload
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ───────────────────────── constants ─────────────────────────
const PROVIDER = "sovereigneg";
/** Override with SOVEREIGNEG_BASE_URL (e.g. for an Egypt-hosted / private deployment). */
const BASE = (process.env.SOVEREIGNEG_BASE_URL || "https://backend.sovereigneg.com/v1").replace(/\/+$/, "");
const KEYS_URL = "https://sovereigneg.com/login?next=%2Fdashboard%2Fkeys";
const DASHBOARD = "https://sovereigneg.com/dashboard";
/** PI_SOVEREIGNEG_DIR relocates config/cache (used by the test-suite). */
const DIR = process.env.PI_SOVEREIGNEG_DIR || join(homedir(), ".pi", "agent");
let VERSION = "dev";
try {
  VERSION = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;
} catch {}
const CONFIG_PATH = join(DIR, "sovereigneg.json");
const CACHE_PATH = join(DIR, "sovereigneg-cache.json");
const DEBUG_PATH = join(DIR, "sovereigneg-debug.json");
const AUTH_PATH = join(DIR, "auth.json");
/** Subagent processes append what they spend here; the main session reads it (see "subagents" below). */
const LEDGER_PATH = join(DIR, "sovereigneg-subagents.jsonl");
const OWNER_ENV = "PI_SOVEREIGNEG_OWNER";
const OWNER_PID_ENV = "PI_SOVEREIGNEG_OWNER_PID";
const TEN_YEARS = 10 * 365 * 24 * 3600 * 1000;

type Tier = "low" | "medium" | "high";
const TIERS: Tier[] = ["low", "medium", "high"];
const rank = (t: Tier) => TIERS.indexOf(t);

// ───────────────────────── config ─────────────────────────
interface Config {
  /** Never auto-route to a model whose output price (EGP / 1M tokens) is above this. */
  maxOutputEgpPerM: number;
  /** Prefer models covered by your Student/Developer daily free allowance. */
  preferFreeAllowance: boolean;
  /** Which tiers may use the free allowance. */
  freeAllowanceTiers: Tier[];
  /** Ignore the allowance when less than this many EGP is left today. */
  minAllowanceLeftEgp: number;
  /** Send reasoning_effort:"none" to models whose thinking is billed but hidden when pi sends no effort (read from the API's model data). */
  guardHiddenThinking: boolean;
  /** Ask before continuing once this many EGP were spent in a session. 0 = off. */
  sessionBudgetEgp: number;
  /** Optional model preference per tier: ordered regex strings matched against model ids. Empty by default: the router then picks by price from what the API lists. */
  tiers: Partial<Record<Tier, string[]>>;
  /** "curated": pi's /model lists favorites, recent, today's free models and the selected model; "all": every live chat model. */
  modelList: "curated" | "all";
  /** Model ids you starred in the picker (always shown in /model). */
  favorites: string[];
  /** Extra regexes (matched on id) to always show in /model in curated mode. */
  pinned: string[];
  /** Recently used models (kept visible so resumed sessions never lose their model). */
  recent: string[];
  /** Update the footer while tokens stream (estimated, replaced by exact usage when the message ends). */
  liveStatus: boolean;
  /** While the agent is working, re-read /v1/credits every N seconds. 0 = off. */
  statusRefreshSeconds: number;
  /** Re-read credits this often while the agent is idle (footer stays current). 0 = off. */
  idleRefreshSeconds: number;
  /** Footer layout: "full" labels everything, "compact" is short, "auto" uses full when it fits the terminal. */
  footer: "auto" | "full" | "compact";
  /** Opt-in: show a local requests-per-minute counter in the footer (see rpmShowAtPercent). */
  showRpm: boolean;
  /** With showRpm: only show the counter once it reaches this % of your plan's limit. 0 = always show. */
  rpmShowAtPercent: number;
}

const DEFAULT_CONFIG: Config = {
  maxOutputEgpPerM: 1300,
  preferFreeAllowance: true,
  freeAllowanceTiers: ["low", "medium"],
  minAllowanceLeftEgp: 2,
  guardHiddenThinking: true,
  sessionBudgetEgp: 0,
  tiers: {},
  modelList: "curated",
  favorites: [],
  pinned: [],
  recent: [],
  liveStatus: true,
  statusRefreshSeconds: 5,
  idleRefreshSeconds: 15,
  footer: "auto",
  showRpm: false,
  rpmShowAtPercent: 60,
};

// No model ids are hard-coded. Without a `tiers` override in sovereigneg.json the router picks by price from whatever
// the API lists (cheapest for low, middle for medium, most expensive within maxOutputEgpPerM for high).
const DEFAULT_TIER_PREFS: Record<Tier, string[]> = { low: [], medium: [], high: [] };

let cfg: Config = { ...DEFAULT_CONFIG };

async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    cfg = { ...DEFAULT_CONFIG, ...raw, tiers: { ...(raw.tiers ?? {}) } };
    for (const k of ["favorites", "pinned", "recent"] as const) if (!Array.isArray(cfg[k])) cfg[k] = [];
    if (!["auto", "full", "compact"].includes(cfg.footer)) cfg.footer = "auto";
    cfg.showRpm = cfg.showRpm === true;
    if (!(typeof cfg.rpmShowAtPercent === "number" && cfg.rpmShowAtPercent >= 0 && cfg.rpmShowAtPercent <= 100)) cfg.rpmShowAtPercent = DEFAULT_CONFIG.rpmShowAtPercent;
  } catch {
    cfg = { ...DEFAULT_CONFIG };
  }
}
async function saveConfig() {
  await mkdir(DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ───────────────────────── catalog ─────────────────────────
interface Meta {
  id: string;
  name: string;
  source?: string;
  inPrice: number | null; // EGP / 1M
  outPrice: number | null;
  ctx: number;
  maxOut: number;
  tools: boolean;
  reasoning: boolean;
  /** Thinks (and bills for it) but never returns its thinking, and accepts an effort setting: see the guard. */
  hiddenReasoning: boolean;
  vision: boolean;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** 1-hour cache write price (EGP / 1M), when the API lists one. */
  cacheWrite1h: number | null;
  /** All backends unhealthy right now (healthy_backends = 0). */
  down: boolean;
  /** deprecated_at / sunset_at set by SovereignEG. */
  deprecated: boolean;
  raw: any;
}

const num = (v: any): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const REASONING_RE = /(claude-(opus|sonnet|haiku|fable)-?[45]|gpt-5|\bo[134]\b|qwen3|gpt-oss|thinking|r1\b|grok|gemini-2\.5|gemini-3)/i;
const VISION_RE = /(claude|gpt-4o|gpt-5|gemini|pixtral|-vl|vision)/i;

function toMeta(m: any): Meta {
  const p = m.pricing ?? {};
  const sp: string[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
  const caps = m.capabilities ?? {};
  const ctx = num(m.context_window) ?? num(m.context_length) ?? num(m.max_context_length) ?? num(caps.context_window) ?? 128000;
  return {
    id: m.id,
    name: m.display_name ?? m.id,
    source: m.source,
    inPrice: num(p.input_per_1m_egp) ?? num(p.max_input_per_1m_egp),
    outPrice: num(p.output_per_1m_egp) ?? num(p.max_output_per_1m_egp),
    ctx,
    maxOut: num(m.max_output_tokens) ?? num(caps.max_output_tokens) ?? Math.min(16384, Math.floor(ctx / 4)),
    tools: m.supports_tools ?? caps.supports_tools ?? (sp.includes("tools") || sp.includes("tool_choice")),
    // Verified against the real API: supported_parameters lists reasoning_effort / include_reasoning.
    // When a model lists parameters we trust that list; the id regex is only a fallback for models that don't.
    reasoning:
      m.supports_reasoning ??
      caps.supports_reasoning ??
      (sp.length ? sp.includes("reasoning_effort") || sp.includes("include_reasoning") || sp.includes("reasoning") : REASONING_RE.test(m.id)),
    vision: m.supports_vision ?? caps.supports_vision ?? VISION_RE.test(m.id),
    // Hidden-thinking guard, decided from the API's data, not from model names: a reasoning model that doesn't list
    // include_reasoning (its thinking is billed but never shown) and does accept reasoning_effort (or lists no
    // parameters at all, so we can't tell).
    hiddenReasoning:
      !!(m.supports_reasoning ?? caps.supports_reasoning ?? (sp.length ? sp.includes("reasoning_effort") || sp.includes("include_reasoning") || sp.includes("reasoning") : REASONING_RE.test(m.id))) &&
      !sp.includes("include_reasoning") &&
      (sp.length ? sp.includes("reasoning_effort") : true),
    cacheRead: num(p.cache_read_per_1m_egp),
    cacheWrite: num(p.cache_write_per_1m_egp),
    cacheWrite1h: num(p.cache_write_1h_per_1m_egp),
    down: num(m.total_backends) !== null && (m.total_backends as number) > 0 && num(m.healthy_backends) === 0,
    deprecated: !!(m.deprecated_at || m.sunset_at),
    raw: m,
  };
}

/** Tiny models (≤3B params) and very short contexts are never auto-routed or recommended. */
const TINY_RE = /(^|[-_/ ])(0\.\d+|[1-3](\.\d+)?)b(?![a-z0-9])/i;
const MIN_ROUTER_CTX = 32_768;
function routable(m: Meta): boolean {
  return !!m.tools && m.ctx >= MIN_ROUTER_CTX && !m.down && !m.deprecated && !TINY_RE.test(m.id);
}

function toPiModel(x: Meta) {
  return {
    type: "chat" as const,
    id: x.id,
    name: x.name,
    reasoning: !!x.reasoning,
    input: x.vision ? ["text", "image"] : ["text"],
    // Deliberately zero: pi multiplies these by the tokens used and shows the result in its own cost counter, in its
    // own currency symbol, and it can't tell free-allowance replies from paid ones. The extension prices every reply
    // itself (see costOfUsage) and shows the result in its own footer section.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: x.ctx,
    maxTokens: x.maxOut,
  };
}

let catalog: Meta[] = [];
let credits: any = null;
let creditsAt = 0;
let freeSinceRefresh = 0; // free-allowance spend the server has not reported yet
let paidSinceRefresh = 0; // paid spend the server has not reported yet
let activeModel = ""; // physical model serving the current/last request
const live = { egp: 0, tokens: 0, free: false }; // in-flight estimate while a reply streams
let sessionPaidEgp = 0;
let sessionFreeEgp = 0;
let lastRoute: any = null;
let lastNotice = 0;
let lastRateNotice = 0;
let lastRateLimitAt = 0; // when the last gateway rate-limit error arrived (see the retry route)
let sessionKey: string | undefined; // key from this process' /login, if any

/** EGP cost of one reply, priced from its token counts with the catalog prices (what pi would otherwise have computed). */
function costOfUsage(modelId: string, usage: any): number {
  const m = catalog.find((x) => x.id === modelId);
  const n = (v: any) => (typeof v === "number" && v > 0 ? v : 0);
  const input = n(usage?.input), output = n(usage?.output), cacheRead = n(usage?.cacheRead), cacheWrite = n(usage?.cacheWrite);
  if (m && (input || output || cacheRead || cacheWrite)) {
    const inP = m.inPrice ?? 0;
    const long = Math.min(cacheWrite, n(usage?.cacheWrite1h));
    const egp =
      (inP * input + (m.outPrice ?? 0) * output + (m.cacheRead ?? inP) * cacheRead + (m.cacheWrite ?? inP) * (cacheWrite - long) + (m.cacheWrite1h ?? 2 * inP) * long) / 1_000_000;
    return egp;
  }
  return n(usage?.cost?.total); // no token counts (or unknown model): use whatever cost the message carries
}

/** "none" = nothing fetched yet and nothing cached; "cache" = last API answer saved on disk; "live" = fetched in this run. */
type CatalogSource = "none" | "cache" | "live";
let catalogInfo: { source: CatalogSource; at: number } = { source: "none", at: 0 };
const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
/** Where the model list and prices on screen come from, or "" when they were just read from the API. */
function priceNote(): string {
  const { source, at } = catalogInfo;
  if (source === "none") return "no model list yet: connect once so it can be read from the API";
  if (source === "live") return Date.now() - at < 3600_000 ? "" : `prices from the API, ${ago(at)}: may have changed`;
  return `offline: prices from cache, ${ago(at)}, may have changed`;
}

function setCatalog(raw: any[], source: CatalogSource = "live", at = Date.now()) {
  catalogInfo = { source, at };
  catalog = raw.filter((m) => (m.modality ?? "chat") === "chat" && (m.status ?? "live") === "live").map(toMeta);
}

async function loadCache(): Promise<{ data: any[]; at: number } | undefined> {
  try {
    const j = JSON.parse(await readFile(CACHE_PATH, "utf8"));
    const at = Date.parse(j.savedAt);
    return Array.isArray(j.data) ? { data: j.data, at: isFinite(at) ? at : 0 } : undefined;
  } catch {
    return undefined;
  }
}
async function saveCache(data: any[]) {
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify({ savedAt: new Date().toISOString(), data }));
  } catch {}
}

// ───────────────────────── API helpers ─────────────────────────
async function api(path: string, key: string, signal?: AbortSignal) {
  return fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: signal ?? AbortSignal.timeout(10_000),
  });
}

async function errorCode(r: Response): Promise<string> {
  try {
    const j: any = await r.json();
    return j?.error?.code ?? j?.error?.message ?? `HTTP ${r.status}`;
  } catch {
    return `HTTP ${r.status}`;
  }
}

async function fetchCatalog(key: string, signal?: AbortSignal): Promise<any[]> {
  const r = await api("/models", key, signal);
  if (!r.ok) throw new Error(`SovereignEG rejected the key (${await errorCode(r)})`);
  const j: any = await r.json();
  return Array.isArray(j.data) ? j.data : [];
}

let catalogInflight: Promise<boolean> | null = null;
/**
 * Re-read the model list and prices from the API and save them to the cache. Called when pi starts, when /sm opens and
 * after /login: nothing else. Concurrent calls share one request. Returns false (and keeps whatever is cached) when
 * there is no key, no internet or the API refuses: the cached list stays usable offline.
 */
function refreshCatalog(ctx: any, timeoutMs = 8000): Promise<boolean> {
  if (ROLE !== "main") return Promise.resolve(false);
  if (catalogInflight) return catalogInflight;
  catalogInflight = (async () => {
    try {
      const key = await resolveKey(ctx);
      if (!key) return false;
      const live = await fetchCatalog(key, AbortSignal.timeout(timeoutMs));
      if (!live.length) return false;
      setCatalog(live);
      await saveCache(live);
      if (visibleKey() !== lastVisibleKey) reRegister(); // new/removed models; prices don't matter to pi (cost is 0)
      return true;
    } catch {
      return false;
    } finally {
      catalogInflight = null;
    }
  })();
  return catalogInflight;
}

async function resolveKey(ctx: any): Promise<string | undefined> {
  if (process.env.SOVEREIGNEG_API_KEY) return process.env.SOVEREIGNEG_API_KEY;
  try {
    const a: any = await ctx?.modelRegistry?.getProviderAuth?.(PROVIDER);
    const k = a?.apiKey ?? a?.auth?.apiKey ?? a?.key;
    if (typeof k === "string" && k) return k;
  } catch {}
  if (sessionKey) return sessionKey;
  // pi may not hand out stored credentials yet at start-up; fall back to its own auth file
  try {
    const j: any = JSON.parse(await readFile(AUTH_PATH, "utf8"));
    const e = j?.[PROVIDER];
    for (const k of [e?.key, e?.access, e?.apiKey, e?.refresh, typeof e === "string" ? e : undefined]) {
      if (typeof k === "string" && /^sk-/.test(k)) return k;
    }
  } catch {}
  return undefined;
}

let baselineNext = true; // first refresh of a session only sets the baseline
// Spend already added to the session by reconcileExternalSpend; a late subagent record for it must not count twice.
let pendFree = 0;
let pendPaid = 0;
let pendAt = 0;

/** Add server-observed spend that wasn't reported through this session's own message events. */
function reconcileExternalSpend(prev: any, next: any) {
  const pa = prev?.daily_allowance, na = next?.daily_allowance;
  if (typeof pa?.left_egp === "number" && typeof na?.left_egp === "number" && pa.resets_at === na.resets_at) {
    const extra = pa.left_egp - na.left_egp - freeSinceRefresh;
    if (extra > 0.001) (sessionFreeEgp += extra), (pendFree += extra), (pendAt = Date.now());
  }
  const pb = balanceOf(prev), nb = balanceOf(next);
  if (pb !== null && nb !== null) {
    const extra = pb - nb - paidSinceRefresh; // top-ups raise the balance, so they never count as spend
    if (extra > 0.001) (sessionPaidEgp += extra), (pendPaid += extra), (pendAt = Date.now());
  }
}

async function refreshCredits(ctx: any, force = false) {
  if (!force && Date.now() - creditsAt < 60_000) return credits;
  const key = await resolveKey(ctx);
  if (!key) return null;
  try {
    const r = await api("/credits", key);
    if (r.ok) {
      const next = await r.json();
      // Spend this process never saw (subagents, other sessions on the same key) shows up as a server-side drop
      // that our own message events don't explain. Fold it into the session totals.
      if (credits && !baselineNext) {
        drainLedger(); // exact subagent records first, so they aren't also counted as "unexplained" spend
        reconcileExternalSpend(credits, next);
      }
      baselineNext = false;
      credits = next;
      creditsAt = Date.now();
      freeSinceRefresh = 0; // the server number now includes everything spent so far
      paidSinceRefresh = 0;
    } else if (r.status === 403) {
      credits = null; // key has no billing/inference scope
    }
  } catch {}
  if (cfg.modelList === "curated") {
    const k = visibleKey();
    if (lastVisibleKey && k !== lastVisibleKey) reRegister(); // e.g. today's free models appeared
  }
  return credits;
}

function allowanceModels(): string[] {
  const a = credits?.daily_allowance;
  if (!a || a.issued === false) return [];
  return (a.models ?? []).map((x: any) => (typeof x === "string" ? x : x?.id ?? x?.model ?? x?.name)).filter(Boolean);
}
/** Allowance left today according to the server, minus what we've spent since the last refresh. */
function allowanceBaseLeft(): number | null {
  const a = credits?.daily_allowance;
  if (!a || a.issued === false) return null;
  return Math.max(0, (a.left_egp ?? 0) - freeSinceRefresh);
}
/** Same, also minus the reply that is streaming right now (estimate). */
function allowanceLeftEgp(): number | null {
  const base = allowanceBaseLeft();
  return base === null ? null : Math.max(0, base - (live.free ? live.egp : 0));
}
/**
 * True if the next reply of `id` is drawn from the free allowance: it is an allowance model AND today's allowance is not
 * used up. "Left" is the server's figure minus what we spent since the last read, so it flips to PAID as soon as the
 * allowance runs out, not when the next refresh arrives. (minAllowanceLeftEgp is only a routing buffer, see allowanceIds.)
 */
function isFreeModel(id: string): boolean {
  const base = allowanceBaseLeft();
  return base !== null && base > 0 && allowanceModels().includes(id);
}
/** Allowance models that still have budget right now (used by the router). */
function allowanceIds(): Set<string> {
  const left = allowanceLeftEgp();
  if (left === null || left <= 0 || left < cfg.minAllowanceLeftEgp) return new Set(); // never route to a spent allowance, even with a 0 buffer
  return new Set(allowanceModels());
}
/**
 * Count one finished reply's cost. Free-allowance models are charged to the allowance first; whatever the allowance
 * can't cover (it ran out during this reply, or it was already empty) is paid. Other models are all paid.
 * `fromLedger` = reported by a subagent process rather than this session.
 */
function applyCost(model: string, cost: number, fromLedger = false) {
  if (!(cost > 0)) return;
  const covered = allowanceModels().includes(model);
  let rest = cost;
  if (fromLedger) {
    if (Date.now() - pendAt > 30_000) pendFree = pendPaid = 0;
    if (covered) {
      const a = Math.min(rest, pendFree); // already counted from a server-side drop
      pendFree -= a;
      rest -= a;
    }
  }
  const freePart = covered ? Math.min(rest, allowanceBaseLeft() ?? 0) : 0;
  let paidPart = rest - freePart;
  if (fromLedger) {
    const a = Math.min(paidPart, pendPaid);
    pendPaid -= a;
    paidPart -= a;
  }
  if (freePart > 0) (sessionFreeEgp += freePart), (freeSinceRefresh += freePart);
  if (paidPart > 0) (sessionPaidEgp += paidPart), (paidSinceRefresh += paidPart);
}

// ───────────────────────── session spend that survives /reload and /resume ─────────────────────────
// The paid / free-used totals are saved into the pi session itself (a custom entry, never sent to the model), so
// they come back after /reload, /resume and restarts. Totals only grow, so on load the largest value found anywhere in
// the session wins (which also makes navigating the session tree harmless).
const SPEND_ENTRY = "sovereigneg-spend";
type Spend = { paid: number; free: number; subReplies: number; subEgp: number };
const SPEND_KEYS: Array<keyof Spend> = ["paid", "free", "subReplies", "subEgp"];
let persisted: Spend = { paid: 0, free: 0, subReplies: 0, subEgp: 0 };
function spendSnapshot(): Spend {
  return { paid: sessionPaidEgp, free: sessionFreeEgp, subReplies: subStats.replies, subEgp: subStats.egp };
}
function restoreSpend(ctx: any) {
  const best: Spend = { paid: 0, free: 0, subReplies: 0, subEgp: 0 };
  try {
    for (const e of ctx?.sessionManager?.getEntries?.() ?? []) {
      if (e?.type !== "custom" || e.customType !== SPEND_ENTRY || !e.data) continue;
      for (const k of SPEND_KEYS) {
        const v = Number(e.data[k]);
        if (isFinite(v) && v > best[k]) best[k] = v;
      }
    }
  } catch {}
  sessionPaidEgp = best.paid;
  sessionFreeEgp = best.free;
  subStats.replies = best.subReplies;
  subStats.egp = best.subEgp;
  persisted = { ...best };
}

// ───────────────────────── requests per minute (opt-in footer counter) ─────────────────────────
// Counts requests sent by this process and its subagents in the last 60 s. Other pi sessions on the same key are
// invisible here, so with several sessions open the real number can be higher than shown.
let reqTimes: number[] = [];
function noteRequest(t = Date.now()) {
  reqTimes.push(t);
  if (reqTimes.length > 1000) reqTimes = reqTimes.slice(-1000);
}
function rpmNow(): number {
  const cutoff = Date.now() - 60_000;
  reqTimes = reqTimes.filter((t) => t >= cutoff);
  return reqTimes.length;
}

// ───────────────────────── subagents ─────────────────────────
// pi-subagents runs each child as its own pi process, so the child's message events never reach the main session.
// Each child instance of this extension therefore appends what it sends/spends to a small shared file, tagged with
// the main session's id (inherited through the environment); the main session tails it.
type Role = "main" | "child";
let ROLE: Role = "main";
let OWNER = "";
let ledgerOffset = 0;
const subActive = new Map<string, { model: string; at: number }>();
const subStats = { replies: 0, egp: 0 };

function claimRole() {
  const envOwner = process.env[OWNER_ENV];
  if (envOwner && process.env[OWNER_PID_ENV] !== String(process.pid)) {
    ROLE = "child";
    OWNER = envOwner;
    return;
  }
  ROLE = "main";
  OWNER = envOwner || randomUUID(); // children spawned later inherit these
  process.env[OWNER_ENV] = OWNER;
  process.env[OWNER_PID_ENV] = String(process.pid);
}
function ledgerWrite(rec: Record<string, unknown>) {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(LEDGER_PATH, JSON.stringify({ ...rec, owner: OWNER, pid: process.pid, t: Date.now() }) + "\n");
  } catch {}
}
function ledgerInit() {
  try {
    if (statSync(LEDGER_PATH).size > 1_000_000) unlinkSync(LEDGER_PATH);
  } catch {}
  try {
    ledgerOffset = statSync(LEDGER_PATH).size;
  } catch {
    ledgerOffset = 0;
  }
}
/** Read new complete lines from the ledger; returns how many records belonged to this session. */
function drainLedger(): number {
  let size: number;
  try {
    size = statSync(LEDGER_PATH).size;
  } catch {
    return 0;
  }
  if (size < ledgerOffset) ledgerOffset = 0;
  if (size === ledgerOffset) return 0;
  const buf = Buffer.alloc(size - ledgerOffset);
  try {
    const fd = openSync(LEDGER_PATH, "r");
    try {
      readSync(fd, buf, 0, buf.length, ledgerOffset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return 0;
  }
  const end = buf.lastIndexOf(10);
  if (end < 0) return 0; // partial line, wait for the rest
  ledgerOffset += end + 1;
  let mine = 0;
  for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.owner !== OWNER || typeof r.model !== "string") continue;
    mine++;
    subActive.set(String(r.pid), { model: r.model, at: Date.now() });
    if (r.k === "start") noteRequest(typeof r.t === "number" ? r.t : Date.now());
    if (r.k === "cost" && typeof r.cost === "number") {
      applyCost(r.model, r.cost, true);
      subStats.replies++;
      subStats.egp += r.cost;
    }
  }
  return mine;
}
function activeSubModels(): string[] {
  const now = Date.now();
  for (const [k, v] of subActive) if (now - v.at > 60_000) subActive.delete(k);
  return [...new Set([...subActive.values()].filter((v) => now - v.at < 20_000).map((v) => v.model))];
}

function balanceOf(c: any): number | null {
  for (const k of ["balance_egp", "balance", "credit_egp", "credits_egp", "available_egp"]) {
    const v = c?.[k];
    if (typeof v === "number") return v;
  }
  return null;
}
const balanceEgp = (): number | null => balanceOf(credits);
function contentChars(content: any): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const p of content) {
    if (typeof p?.text === "string") n += p.text.length;
    else if (typeof p?.thinking === "string") n += p.thinking.length;
    else if (p?.arguments) n += JSON.stringify(p.arguments).length;
  }
  return n;
}
function tokensPerEgp(): number | null {
  const a = credits?.daily_allowance;
  return a && typeof a.approx_daily_tokens === "number" && a.daily_allowance_egp > 0 ? a.approx_daily_tokens / a.daily_allowance_egp : null;
}
function fmtTok(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : `${Math.round(n)}`;
}
/** The `rpm 14/20` footer segment: opt-in, and only once it is close enough to the limit to matter. */
function rpmSegment(): string | null {
  if (!cfg.showRpm) return null;
  const n = rpmNow();
  if (n === 0) return null;
  const limit = rpmLimit();
  if (limit === null) return `rpm ${n}`;
  if ((100 * n) / limit < cfg.rpmShowAtPercent) return null;
  return `rpm ${n}/${limit}${n >= limit * 0.9 ? "!" : ""}`;
}
/** Model id without vendor prefix; `short` also drops the `claude-` prefix (haiku-5.5). */
function modelLabel(id: string, short = false): string {
  const base = String(id).split("/").pop() ?? String(id);
  return short ? base.replace(/^claude-/i, "") : base;
}

/**
 * Footer text. "full" labels every figure; "compact" keeps the same facts in fewer characters, ordered by how much
 * they matter so that a narrow terminal (or the segment trimming below) only ever loses the least important ones.
 * "auto" shows the full text when it fits the terminal and the compact one when it doesn't.
 */
function statusText(): string {
  const id = activeModel || lastRoute?.model;
  const streaming = live.egp > 0;
  const approx = streaming ? "≈" : "";
  const tag = (m: string, free: boolean) => `${m} ${free ? "[FREE]" : "[PAID]"}`;
  const modelFree = id ? (streaming ? live.free : isFreeModel(id)) : false;
  const paid = (sessionPaidEgp + (live.free ? 0 : live.egp)).toFixed(2);
  const tpe = tokensPerEgp(); // free allowance is shown in tokens whenever the API tells us how many it is worth
  const usedEgp = sessionFreeEgp + (live.free ? live.egp : 0);
  const showUsed = sessionFreeEgp > 0 || (streaming && live.free);
  const left = allowanceLeftEgp();
  const total = credits?.daily_allowance?.daily_allowance_egp;
  const hasAllowance = left !== null && total > 0;
  const pct = hasAllowance ? Math.round((100 * left!) / total) : 0;
  const bal = balanceEgp();
  const balText = bal !== null ? Math.max(0, bal - paidSinceRefresh - (live.free ? 0 : live.egp)).toFixed(2) : null;
  const subs = activeSubModels();
  const rpm = rpmSegment();

  const full = (): string => {
    const parts: string[] = [];
    if (id) parts.push(tag(modelLabel(id), modelFree));
    parts.push(`paid ${approx}${paid} EGP`);
    if (showUsed) parts.push(`free used ${approx}${tpe ? fmtTok(usedEgp * tpe) : usedEgp.toFixed(2)}`);
    if (hasAllowance) parts.push(tpe ? `free left ${approx}${fmtTok(left! * tpe)}/${fmtTok(total * tpe)} tokens (${pct}%)` : `free left ${approx}${left!.toFixed(1)}/${total} EGP (${pct}%)`);
    if (balText !== null) parts.push(`balance ${approx}${balText} EGP`);
    if (rpm) parts.push(rpm);
    if (subs.length) parts.push(`subagent ${subs.map((m) => tag(modelLabel(m), isFreeModel(m))).join(", ")}`);
    return `SovereignEG · ${parts.join(" · ")}`;
  };

  const compact = (max: number): string => {
    // most important first: whatever doesn't fit is dropped from the end
    const segs: string[] = [];
    if (id) segs.push(`${modelLabel(id, true)} ${modelFree ? "FREE" : "PAID"}`);
    if (rpm) segs.push(rpm); // only present when it is close to the limit, so it outranks the money figures
    if (hasAllowance) segs.push(`free ${approx}${tpe ? fmtTok(left! * tpe) : left!.toFixed(1)} (${pct}%)`);
    if (balText !== null) segs.push(`bal ${approx}${balText} EGP`);
    segs.push(`paid ${approx}${paid}`);
    if (subs.length) segs.push(`sub ${subs.map((m) => `${modelLabel(m, true)} ${isFreeModel(m) ? "FREE" : "PAID"}`).join(", ")}`);
    const join = () => `SEG ${segs.join(" · ")}`;
    while (segs.length > 1 && join().length > max) segs.pop();
    return join();
  };

  const cols = typeof process.stdout?.columns === "number" ? process.stdout.columns : 0;
  const max = cols > 0 ? cols - 2 : Infinity;
  if (cfg.footer === "full") return full();
  if (cfg.footer === "compact") return compact(max);
  const f = full();
  return f.length <= max ? f : compact(max);
}

// ───────────────────────── what pi's /model shows ─────────────────────────
let reRegister: () => void = () => {};
let lastVisibleKey = "";
let routedId = ""; // model the smart router is using right now (it must be registered in pi to be usable)

/**
 * What pi's own /model shows (besides `smart`): your favorites, recently used models (the first is the one selected),
 * today's free-allowance models (from /v1/credits), the model smart is using now, plus anything matching `pinned`.
 * Nothing is hard-coded; the whole catalog is one /sm away.
 */
function visibleIds(): Set<string> {
  if (cfg.modelList === "all") return new Set(catalog.map((m) => m.id));
  const keep = new Set<string>([...cfg.favorites, ...cfg.recent, ...allowanceModels(), ...(routedId ? [routedId] : [])]);
  for (const p of cfg.pinned) {
    try { const re = new RegExp(p, "i"); catalog.forEach((m) => re.test(m.id) && keep.add(m.id)); } catch {}
  }
  return new Set(catalog.filter((m) => keep.has(m.id)).map((m) => m.id));
}
const visibleKey = () => [...visibleIds()].sort().join("|");

// ───────────────────────── display metadata ─────────────────────────
const AUTHOR_RULES: Array<[RegExp, string]> = [
  [/claude/i, "Anthropic"], [/gpt|\bo[134]\b|chatgpt/i, "OpenAI"], [/qwen/i, "Alibaba (Qwen)"], [/llama/i, "Meta"],
  [/gemini|gemma/i, "Google"], [/deepseek/i, "DeepSeek"], [/mistral|mixtral|pixtral/i, "Mistral"], [/grok/i, "xAI"],
  [/nova/i, "Amazon"], [/glm/i, "Z.ai"], [/kimi|moonshot/i, "Moonshot"], [/ernie/i, "Baidu"], [/aion/i, "AionLabs"],
  [/bge|minilm|mpnet/i, "Embeddings"],
];
function authorOf(m: Meta): string {
  // Models SovereignEG brands as its own (id `SovereignEG/…` or owned_by SovereignEG) are grouped under SovereignEG,
  // even when the API credits another author (e.g. SovereignEG/Qwen… → provider Alibaba).
  if (m.id.startsWith("SovereignEG/") || String(m.raw?.owned_by ?? "").trim().toLowerCase() === "sovereigneg") return "SovereignEG";
  const raw = m.raw?.provider ?? m.raw?.owned_by; // verified: owned_by is the host/owner, provider is the model author
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  for (const [re, name] of AUTHOR_RULES) if (re.test(m.id)) return name;
  return m.id.includes("/") ? m.id.split("/")[0] : "Other";
}
function hostOf(m: Meta): string {
  if (m.source === "sovereign" || m.id.startsWith("SovereignEG/")) return "SovereignEG GPUs (Egypt)";
  if (m.source === "serverless") return "Third-party providers";
  return "Unknown host";
}
/** What the router would pick for each tier right now (from the API's models and prices): economy / balanced / top. */
function recommendedMap(): Map<string, "economy" | "balanced" | "top"> {
  const label: Record<Tier, "economy" | "balanced" | "top"> = { low: "economy", medium: "balanced", high: "top" };
  const out = new Map<string, "economy" | "balanced" | "top">();
  for (const t of TIERS) {
    const p = pickModel(t, { needTokens: 8000 });
    if (p && !out.has(p.meta.id)) out.set(p.meta.id, label[t]);
  }
  return out;
}

// ───────────────────────── task classifier ─────────────────────────
const HARD_EN = /\b(architect\w*|refactor\w*|migrat\w*|race condition|concurren\w*|deadlock|memory leak|performance|optimi[sz]\w*|security|vulnerab\w*|algorithm\w*|root cause|investigat\w*|from scratch|rewrite|design (a|the)|trade-?offs?|scalab\w*|distributed)\b/gi;
const HARD_AR = /(معمار|أعد كتابة|إعادة كتابة|حسّن|الأداء|ثغر|خوارزمي|صمم|تصميم|ترحيل)/g;
const EASY_EN = /\b(typo|rename|reformat|formatting|lint|comment|docstring|one-?liner|trivial|quick(ly)?|tiny|what does|explain (this|the) (line|function)|translate|summari[sz]e)\b/gi;
const EASY_AR = /(ترجم|لخّص|لخص|اشرح|تصحيح إملائي)/g;
const PATH_RE = /[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|cs|cpp|php|sql|kt|swift)\b/g;

function textOf(m: any): string {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (p?.type === "text" ? p.text : "")).join("\n");
  return "";
}
function lastUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return textOf(messages[i]);
  return "";
}
function arabicRatio(s: string): number {
  const letters = s.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return 0;
  return (s.match(/[\u0600-\u06FF]/g)?.length ?? 0) / letters;
}

function classify(text: string, messages: any[]) {
  let score = 0;
  const reasons: string[] = [];
  const len = text.length;
  if (len > 6000) (score += 2), reasons.push("very long prompt");
  else if (len > 1500) (score += 1), reasons.push("long prompt");

  const hard = (text.match(HARD_EN)?.length ?? 0) + (text.match(HARD_AR)?.length ?? 0);
  const easy = (text.match(EASY_EN)?.length ?? 0) + (text.match(EASY_AR)?.length ?? 0);
  if (hard) (score += Math.min(hard, 3) * 1.5), reasons.push(`${hard} complexity keyword(s)`);
  if (easy) (score -= Math.min(easy, 2) * 1.5), reasons.push(`${easy} simple-task keyword(s)`);
  if (/```|Traceback|\bat .+\(.+:\d+:\d+\)|Error:/.test(text)) (score += 1), reasons.push("code/stack trace");
  if (new Set(text.match(PATH_RE) ?? []).size > 3) (score += 1), reasons.push("many files mentioned");
  if (messages.length > 40) (score += 1), reasons.push("long conversation");

  const arabic = arabicRatio(text) > 0.3;
  if (arabic) reasons.push("Arabic prompt");
  const tier: Tier = score >= 4 ? "high" : score >= 1.5 ? "medium" : "low";
  return { score, tier, reasons, hard, easy, arabic };
}

// ───────────────────────── model picking ─────────────────────────
function pickModel(tier: Tier, opts: { needTokens: number; exclude?: Set<string>; arabic?: boolean }): { meta: Meta; free: boolean } | undefined {
  const exclude = opts.exclude ?? new Set<string>();
  // Tool-capable, big enough, and either priced or served on SovereignEG's own GPUs (unpriced allowed there)
  const cands = catalog.filter(
    (m) =>
      routable(m) &&
      !exclude.has(m.id) &&
      m.ctx >= opts.needTokens * 1.3 &&
      (m.outPrice !== null || m.source === "sovereign" || m.id.startsWith("SovereignEG/")),
  );
  if (!cands.length) return undefined;
  const free = allowanceIds();

  // 1) free allowance
  if (cfg.preferFreeAllowance && cfg.freeAllowanceTiers.includes(tier) && free.size) {
    const f = cands.filter((m) => free.has(m.id)).sort((a, b) => (b.outPrice ?? 0) - (a.outPrice ?? 0));
    if (f.length) return { meta: f[0], free: true };
  }

  const affordable = cands.filter((m) => m.outPrice === null || m.outPrice <= cfg.maxOutputEgpPerM);
  if (!affordable.length) return undefined;

  // 2) curated preferences
  let prefs = (cfg.tiers[tier] ?? DEFAULT_TIER_PREFS[tier]).slice();
  for (const p of prefs) {
    const re = new RegExp(p, "i");
    const hit = affordable.find((m) => re.test(m.id));
    if (hit) return { meta: hit, free: free.has(hit.id) };
  }

  // 3) price-based fallback
  const priced = affordable.filter((m) => m.outPrice !== null).sort((a, b) => a.outPrice! - b.outPrice!);
  if (!priced.length) return { meta: affordable[0], free: false };
  const idx = tier === "low" ? 0 : tier === "high" ? priced.length - 1 : Math.floor(priced.length / 2);
  return { meta: priced[idx], free: free.has(priced[idx].id) };
}

/** Requests-per-minute limit reported by /v1/credits (null when the API doesn't say). */
function rpmLimit(): number | null {
  const n = credits?.rpm_limit;
  return typeof n === "number" && n > 0 ? n : null;
}
/** Labelled prices for lists: in / out / cache read / cache write, EGP per 1M tokens. */
function fmtPriceFull(m: Meta) {
  const f = (n: number | null) => (n === null ? "–" : n.toFixed(2)); // exactly as the pricing page lists it
  return `in ${f(m.inPrice)} · out ${f(m.outPrice)} · cache r ${f(m.cacheRead)} / w ${f(m.cacheWrite)} EGP per 1M`;
}
function fmtCtx(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`;
}

// ───────────────────────── error explanations ─────────────────────────
const HINTS: Array<[RegExp, string | (() => string)]> = [
  [/daily_allowance_exhausted/i, "Today's free allowance is used up (it renews 00:00 Cairo time). Switch to a pay-as-you-go model or turn on 'Use balance automatically' in Billing → Plans."],
  [/daily_allowance_pending/i, "Your pack was just bought; today's allowance appears within a minute. Retry shortly."],
  [/insufficient_balance|insufficient_quota|quota_exceeded|\b402\b/i, `Out of EGP credit. Top up at ${DASHBOARD} (Billing), or switch to a model covered by your free allowance.`],
  [/inflight_busy/i, "Your credit is held by requests still running. Retry in ~10 seconds."],
  [/allowance_capacity_busy|allowance_capacity_unavailable/i, "The shared free-allowance GPUs are busy. Retry in a few seconds or use a pay-as-you-go model."],
  [/concurrency_limit_exceeded/i, "Too many simultaneous requests on your plan. Wait 2 seconds and retry."],
  [/rate_limit_exceeded|too many requests|\b429\b/i, () => `Rate limited${rpmLimit() ? ` (your plan allows ${rpmLimit()} requests/min)` : ""}. pi will back off and retry${RATE_LIMIT_RE.test(lastErrorText) ? " on the same model" : ""}. Agent loops and subagents send one request per step; a higher limit can be requested via support@sovereigneg.com.`],
  [/key_expired|key_revoked|invalid_api_key|missing_auth_header|invalid_token/i, "API key problem. Run /login and choose SovereignEG to add a fresh key."],
  [/key_scope_insufficient/i, "This key's scope can't call models. Create an inference-scope key in the dashboard."],
  [/ip_not_allowed/i, "This key has an IP allow-list that doesn't include your current IP."],
  [/org_suspended/i, "Your organization is suspended — contact support@sovereigneg.com."],
  [/model_not_found/i, "Model id not found. Open /sm to re-read the model list from the API."],
  [/unsupported_parameter/i, "This model doesn't support a parameter pi sent. Try another model."],
  [/prompt_too_long_for_plan|max_tokens_exceeded/i, "Prompt or max_tokens exceeds the plan/model limit. Compact the session (/compact) or pick a larger-context model."],
  [/request_too_large|\b413\b/i, "Request body over the 32 MiB limit. Compact the session or drop big attachments."],
];
/** Gateway-level rate limit (per key / plan): another model would hit the same limit, so retries stay on the same one. */
const RATE_LIMIT_RE = /rate_limit_exceeded/i;
let lastErrorText = "";
function explain(text: string): string | undefined {
  lastErrorText = text;
  const h = HINTS.find(([re]) => re.test(text))?.[1];
  return typeof h === "function" ? h() : h;
}
/** Seconds the server asked us to wait, if the error text carries it (header values aren't exposed for failed requests). */
function retryAfterSeconds(text: string): number | null {
  const m = text.match(/retry[-_ ]?after(?:[-_ ]?(ms|seconds|s))?["'\s:=]+(\d+(?:\.\d+)?)/i) ?? text.match(/retry in (\d+(?:\.\d+)?)\s*s\b/i);
  if (!m) return null;
  const n = Number(m[m.length - 1]);
  if (!isFinite(n) || n <= 0) return null;
  return m[1]?.toLowerCase() === "ms" ? n / 1000 : n;
}

// ───────────────────────── extension ─────────────────────────
export default async function (pi: ExtensionAPI) {
  await loadConfig();
  claimRole();

  // 1) catalog: only ever what the API said. Start from the cache (works offline), then re-read it from the API.
  const cached = await loadCache();
  if (cached) setCatalog(cached.data, "cache", cached.at);
  if (process.env.SOVEREIGNEG_API_KEY) {
    try {
      const live = await fetchCatalog(process.env.SOVEREIGNEG_API_KEY, AbortSignal.timeout(4000));
      if (live.length) (setCatalog(live), await saveCache(live));
    } catch {}
  }

  const registerProvider = () => {
    const vis = visibleIds();
    lastVisibleKey = visibleKey();
    pi.registerProvider(PROVIDER, {
      name: "SovereignEG",
      baseUrl: BASE,
      apiKey: "$SOVEREIGNEG_API_KEY",
      api: "openai-completions",
      models: catalog.filter((m) => vis.has(m.id)).map(toPiModel),
      oauth: {
        name: "SovereignEG (API key)",
        async login(cb: any) {
          cb.onAuth?.({
            url: KEYS_URL,
            instructions: "Sign in, click “Create new key”, copy the sk-… key (shown only once), then paste it here.",
          });
          const key = String((await cb.onPrompt({ message: "Paste your SovereignEG API key (sk-…)" })) ?? "").trim();
          if (!/^sk-[0-9a-f]{32}$/i.test(key)) {
            throw new Error("That doesn't look like a SovereignEG key (expected sk- followed by 32 hex characters).");
          }
          const live = await fetchCatalog(key); // throws a readable error on 401
          sessionKey = key;
          if (live.length) {
            setCatalog(live);
            await saveCache(live);
            setTimeout(registerProvider, 0); // re-register with the live catalog
          }
          return { refresh: key, access: key, expires: Date.now() + TEN_YEARS };
        },
        async refreshToken(c: any) {
          return c; // API keys don't expire (unless you set an expiry in the dashboard)
        },
        getApiKey(c: any) {
          return c.access;
        },
      },
    } as any);
  };
  reRegister = registerProvider;
  registerProvider();

  // 2) smart router
  pi.registerVirtualModel({
    provider: PROVIDER,
    id: "smart",
    name: "Smart (auto-route)",
    // The level is a *spend ceiling*: low = economy, medium = balanced, high = allow top models
    thinkingLevels: ["low", "medium", "high"],
    route(request: any, ctx: any) {
      const reg = ctx.modelRegistry;
      const messages: any[] = request.messages ?? [];
      const find = (id: string) => reg.find(PROVIDER, id);

      // Retry after a failure: stay on the same model. The user decides whether to switch (/model or /sm).
      if (request.reason === "retry" && request.failed) {
        const err = String(request.failed.message?.errorMessage ?? "");
        const sameModel = { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? "low" };
        lastRoute = { ...lastRoute, model: request.failed.model.id, note: "error: retrying on the same model (switch with /model or /sm)", at: Date.now() };
        // On the gateway's rate limit, top up pi's own backoff (2/4/8 s) with the server's retry-after value if it sent one.
        const wait = RATE_LIMIT_RE.test(err) ? retryAfterSeconds(err) : null;
        const sinceFail = Date.now() - lastRateLimitAt;
        const ms = wait ? Math.min(60_000, wait * 1000 - (sinceFail < 120_000 ? sinceFail : 0)) : 0; // unknown failure time = wait in full
        if (ms <= 500) return sameModel;
        return new Promise((res) => {
          const t = setTimeout(() => res(sameModel), ms);
          request.signal?.addEventListener?.("abort", () => (clearTimeout(t), res(sameModel)), { once: true });
        });
      }

      // Tool follow-ups keep the same model (preserves prompt cache)
      if (request.reason !== "user" && request.previous) {
        return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "low" };
      }

      const text = lastUserText(messages);
      const c = classify(text, messages);

      // Short follow-ups ("continue", "yes do it") stay on the current model
      if (request.previous && text.length < 120 && !c.hard && !c.easy) {
        lastRoute = { tier: lastRoute?.tier ?? "medium", model: request.previous.model.id, note: "short follow-up: kept previous model", reasons: [], at: Date.now() };
        return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "low" };
      }

      const ceiling: Tier = request.thinkingLevel === "high" ? "high" : request.thinkingLevel === "low" ? "low" : "medium";
      const tier: Tier = rank(c.tier) <= rank(ceiling) ? c.tier : ceiling;
      const need = JSON.stringify(messages).length / 3.2;
      const pick = pickModel(tier, { needTokens: need, arabic: c.arabic });
      if (!pick) {
        const any = reg.getAvailable?.().find((m: any) => m.provider === PROVIDER);
        if (!any) throw new Error("No SovereignEG models available: run /login and pick SovereignEG (or open /sm once online).");
        return { model: any, thinkingLevel: "low" };
      }
      const thinking = tier === "low" ? "off" : tier === "medium" ? "low" : c.score >= 7 ? "high" : "medium";
      lastRoute = { tier, ceiling, score: c.score, reasons: c.reasons, model: pick.meta.id, free: pick.free, thinking, at: Date.now() };
      const done = (model: any) => (model ? { model, thinkingLevel: thinking } : { model: reg.getAvailable?.().find((m: any) => m.provider === PROVIDER), thinkingLevel: "low" });
      const chosen = find(pick.meta.id);
      if (chosen) {
        routedId = pick.meta.id;
        return done(chosen);
      }
      // The router may use any model the API lists, but pi's /model only shows favorites and the selected model:
      // register the chosen one on demand (it stays listed while smart is using it).
      routedId = pick.meta.id;
      registerProvider();
      const now = find(pick.meta.id);
      if (now) return done(now);
      return new Promise((res) => setTimeout(() => res(done(find(pick.meta.id))), 60));
    },
  } as any);

  // 3) hidden-thinking guard (some models think, and bill for it, by default when no effort is sent) + request counter
  pi.on("before_provider_request", (event: any, ctx: any) => {
    if (ctx.model?.provider !== PROVIDER) return;
    if (ROLE === "main") noteRequest(); // subagent processes are counted through the ledger
    if (!cfg.guardHiddenThinking) return;
    const p = event.payload;
    if (!p || typeof p !== "object" || !Array.isArray(p.messages)) return;
    if (typeof p.model !== "string" || !catalog.find((m) => m.id === p.model)?.hiddenReasoning) return;
    if (p.reasoning_effort !== undefined || p.reasoning !== undefined || "thinking" in p) return;
    return { ...p, reasoning_effort: "none" };
  });

  // 4) friendly feedback on responses
  pi.on("after_provider_response", (event: any, ctx: any) => {
    if (ctx.model?.provider !== PROVIDER || !ctx.hasUI) return;
    const h = event.headers ?? {};
    const clamped = h["x-output-clamped"];
    const planCap = h["x-plan-output-cap"];
    const now = Date.now();
    if (now - lastNotice < 8000) return;
    if (clamped) (lastNotice = now), ctx.ui.notify(`Reply length limited to ${clamped} tokens (credit or spend cap is running low).`, "warning");
    else if (planCap) (lastNotice = now), ctx.ui.notify(`Plan output cap: replies limited to ${planCap} tokens.`, "info");
    else if (event.status === 402) (lastNotice = now), ctx.ui.notify(explain("402") ?? "Payment required.", "error");
  });

  let lastPaint = 0;
  const status = (ctx: any, force = true) => {
    if (!ctx?.hasUI) return;
    const now = Date.now();
    if (!force && now - lastPaint < 200) return; // don't repaint on every streamed token
    lastPaint = now;
    ctx.ui.setStatus("sovereigneg", statusText());
  };

  // Save the totals into the session (throttled; unchanged totals write nothing).
  let persistAt = 0;
  let persistTimer: any;
  const persistSpend = (force = false) => {
    if (ROLE !== "main" || tickCtx?.hasUI === false) return;
    const s = spendSnapshot();
    if (SPEND_KEYS.every((k) => Math.abs(s[k] - persisted[k]) < 1e-6)) return;
    const wait = 5000 - (Date.now() - persistAt);
    if (!force && wait > 0) {
      if (!persistTimer) (persistTimer = setTimeout(() => ((persistTimer = undefined), persistSpend(true)), wait)).unref?.();
      return;
    }
    clearTimeout(persistTimer);
    persistTimer = undefined;
    try {
      pi.appendEntry(SPEND_ENTRY, { v: 1, ...s });
      persisted = { ...s };
      persistAt = Date.now();
    } catch {}
  };

  const resetLive = () => {
    live.egp = 0;
    live.tokens = 0;
    live.free = false;
  };
  const isOurs = (m: any) => m?.role === "assistant" && (!m.provider || m.provider === PROVIDER);

  pi.on("message_start", async (event: any, ctx: any) => {
    const m = event.message;
    if (!isOurs(m)) return;
    resetLive();
    if (m.model) activeModel = m.model;
    if (ROLE === "child") ledgerWrite({ k: "start", model: m.model });
    status(ctx);
  });

  // Live estimate while the reply streams: exact output tokens if the stream reports them, else ~chars/3.5
  pi.on("message_update", async (event: any, ctx: any) => {
    if (!cfg.liveStatus) return;
    const m = event.message ?? event.partial;
    if (!isOurs(m)) return;
    if (m.model) activeModel = m.model;
    const out = m.usage?.output > 0 ? m.usage.output : contentChars(m.content) / 3.5;
    const price = catalog.find((x) => x.id === m.model)?.outPrice ?? 0;
    live.tokens = out;
    live.egp = (out * price) / 1_000_000;
    live.free = isFreeModel(m.model);
    status(ctx, false);
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    const m = event.message;
    if (m?.role !== "assistant" || m.provider !== PROVIDER) return;
    const cost = costOfUsage(m.model, m.usage);
    if (ROLE === "child") ledgerWrite({ k: "cost", model: m.model, cost });
    else applyCost(m.model, cost);
    persistSpend();
    activeModel = m.model ?? activeModel;
    resetLive(); // swap the estimate for the exact figure
    if (m.stopReason === "error" && m.errorMessage && ctx.hasUI) {
      const text = String(m.errorMessage);
      const hint = explain(text);
      if (/rate_limit_exceeded|too many requests|\b429\b/i.test(text)) lastRateLimitAt = Date.now();
      const limited = hint !== undefined && HINTS.find(([re]) => re.test(text))?.[1] instanceof Function;
      // pi retries a rate limit several times in a row: say it once, not on every attempt
      if (hint && !(limited && Date.now() - lastRateNotice < 20_000)) {
        if (limited) lastRateNotice = Date.now();
        ctx.ui.notify(hint, limited ? "warning" : "error");
      }
    }
    status(ctx);
  });

  // Footer upkeep. One timer for the whole session: it keeps the real allowance/balance fresh while the agent works
  // (statusRefreshSeconds) AND while it is idle (idleRefreshSeconds), and retries quickly until the first read works.
  let working = false;
  let resizeHooked = false;
  let tickCtx: any;
  let timer: any;
  let credFails = 0;
  const schedule = () => {
    clearTimeout(timer);
    if (ROLE === "child" || !tickCtx) return; // subagent processes leave this to the main session
    const secs = !credits ? Math.min(60, 3 * 2 ** Math.min(credFails, 5)) : working ? cfg.statusRefreshSeconds : cfg.idleRefreshSeconds;
    if (!(secs > 0)) return;
    timer = setTimeout(async () => {
      try {
        await refreshCredits(tickCtx, true);
        credFails = credits ? 0 : credFails + 1;
        status(tickCtx, false);
      } finally {
        schedule(); // sequential: a slow API can never stack requests
      }
    }, secs * 1000);
    timer.unref?.();
  };
  // Subagents: tail what child processes report, show their model, count their spend, refresh while they run.
  let ledgerTimer: any;
  let lastSubs = "";
  const startLedger = () => {
    clearInterval(ledgerTimer);
    if (ROLE !== "main") return;
    ledgerInit();
    ledgerTimer = setInterval(() => {
      const n = drainLedger();
      const subs = activeSubModels().join("|");
      if (n > 0 || subs !== lastSubs) {
        lastSubs = subs;
        status(tickCtx);
      }
      if (n > 0) persistSpend();
      if (n > 0 && Date.now() - creditsAt > Math.max(1, cfg.statusRefreshSeconds) * 1000) {
        refreshCredits(tickCtx, true).then(() => status(tickCtx)).catch(() => {});
      }
    }, 1000);
    ledgerTimer.unref?.();
  };
  pi.on("agent_start", async (_e: any, ctx: any) => {
    tickCtx = ctx;
    working = true;
    schedule();
  });
  pi.on("agent_end", async () => {
    working = false;
    schedule();
  });
  pi.on("session_shutdown", async () => {
    clearTimeout(timer);
    clearInterval(ledgerTimer);
    persistSpend(true); // /reload, /resume, /new and quit all pass through here
  });

  pi.on("model_select", async (event: any) => {
    const m = event.model;
    if (m?.provider !== PROVIDER || m.id === "smart") return;
    routedId = "";
    if (cfg.recent[0] === m.id) return;
    cfg.recent = [m.id, ...cfg.recent.filter((x) => x !== m.id)].slice(0, 8);
    saveConfig().catch(() => {});
    if (visibleKey() !== lastVisibleKey) setTimeout(reRegister, 0);
  });

  pi.on("session_start", async (_e: any, ctx: any) => {
    tickCtx = ctx;
    if (!resizeHooked && ROLE === "main") {
      resizeHooked = true; // the footer layout depends on the terminal width
      process.stdout?.on?.("resize", () => status(tickCtx, false));
    }
    if (ROLE === "main" && ctx.hasUI !== false) {
      // headless sessions inside this process (in-process subagents) must not wipe the main session's totals
      restoreSpend(ctx); // this session's saved totals (zero for a brand-new session)
      freeSinceRefresh = 0;
      paidSinceRefresh = 0;
      pendFree = pendPaid = 0;
      baselineNext = true;
    }
    status(ctx); // paint right away, even before the first credits read
    startLedger();
    const key = await resolveKey(ctx);
    if (!key && ctx.hasUI) ctx.ui.notify("SovereignEG: run /login and pick SovereignEG (or set SOVEREIGNEG_API_KEY).", "info");
    await refreshCredits(ctx, true);
    credFails = credits ? 0 : 1;
    status(ctx);
    void refreshCatalog(ctx).then((ok) => ok && status(ctx)); // pi just launched: re-read models and prices
    schedule(); // keeps trying (and then keeps refreshing) without waiting for the first message
  });

  pi.on("agent_settled", async (_e: any, ctx: any) => {
    await refreshCredits(ctx, true); // final read picks up anything subagents spent after the last poll
    persistSpend(true);
    status(ctx);
  });

  // 5) session budget
  pi.on("input", async (event: any, ctx: any) => {
    if (cfg.sessionBudgetEgp > 0 && sessionPaidEgp >= cfg.sessionBudgetEgp && event.source === "interactive" && ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "SovereignEG budget reached",
        `You've spent ${sessionPaidEgp.toFixed(2)} EGP this session (limit ${cfg.sessionBudgetEgp}). Continue and raise the limit by the same amount?`,
      );
      if (!ok) return { action: "handled" };
      cfg.sessionBudgetEgp += cfg.sessionBudgetEgp;
    }
    return { action: "continue" };
  });

  // 6) /sovereign command (+ /sm shortcut for the model tree)
  pi.registerCommand("sm", {
    description: "SovereignEG model tree (re-reads models and prices from the API; group, search, favorite, switch)",
    handler: async (args: string, ctx: any) => runSovereign(`models ${args ?? ""}`, ctx),
  });
  const SUBS = ["models", "status", "pick", "list", "why", "budget", "rpm", "footer", "raw", "help"];
  let runSovereign: (args: string, ctx: any) => Promise<any> = async () => {};
  pi.registerCommand("sovereign", {
    description: "SovereignEG: models (tree), status, pick, list, why, budget",
    getArgumentCompletions: (prefix: string) => {
      const items = SUBS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length ? items : null;
    },
    handler: async (args: string, ctx: any) => runSovereign(args, ctx),
  });
  runSovereign = async (args: string, ctx: any) => {
    {
      const [sub = "status", ...rest] = (args || "").trim().split(/\s+/);
      const arg = rest.join(" ").trim();
      const say = (t: string, lvl: "info" | "warning" | "error" = "info") => ctx.ui.notify(t, lvl);

      if (sub === "help") {
        return say(
          [
            "/sovereign            status, credit and free allowance",
            "/sm  (= /sovereign models)   collapsible model tree: Tab regroups, type to search, Ctrl+F ★",
            "/sovereign list curated|all  what pi's own /model shows (curated = favorites + selected model, or everything)",
            "/sovereign pick [task]       recommend a model for a task",
            "/sovereign why               why the router chose its last model",
            "/sovereign budget <EGP>      ask before exceeding this session spend",
            "/sovereign rpm [on|off|<%>]  footer requests/min counter (off by default; <%> = show from that % of your limit)",
            "/sovereign footer [auto|full|compact]  footer layout",
            "/sovereign raw               dump raw API samples to a debug file",
            "Models and prices always come from the API (re-read on launch and on /sm, cached for offline use).",
            "Tip: /model → sovereigneg/smart, thinking level = spend ceiling (low/medium/high)",
          ].join("\n"),
        );
      }

      if (sub === "status") {
        const key = await resolveKey(ctx);
        if (!key) return say("No API key. Run /login → SovereignEG (or set SOVEREIGNEG_API_KEY).", "warning");
        const c = await refreshCredits(ctx, true);
        const lines = [`pi-sovereigneg v${VERSION}`, `Endpoint: ${BASE}`];
        if (!c) lines.push("Credits: unavailable (key may lack inference/billing scope)");
        else {
          const plan = c.tier_display_name ?? c.tier ?? c.plan;
          if (plan) lines.push(`Plan: ${plan}`);
          const bal = balanceEgp();
          if (bal !== null) {
            const split = typeof c.promotional_egp === "number" || typeof c.paid_egp === "number" ? ` (promo ${(c.promotional_egp ?? 0).toFixed(2)}, paid ${(c.paid_egp ?? 0).toFixed(2)})` : "";
            lines.push(`Balance: ${bal.toFixed(2)} EGP${split}`);
          }
          const rl = rpmLimit();
          if (rl !== null) lines.push(`Rate limit: ${rl} requests/min${typeof c.base_rpm_limit === "number" && c.base_rpm_limit !== rl ? ` (plan base ${c.base_rpm_limit})` : ""}${cfg.showRpm ? ` · ${rpmNow()} in the last minute (this session only)` : ""}`);
          for (const e of c.expiring_credits ?? []) if (e?.amount_egp > 0 && e.expires_at) lines.push(`  ${e.amount_egp} EGP expires ${String(e.expires_at).slice(0, 10)}`);
          const a = c.daily_allowance;
          if (a && a.issued !== false) {
            const tokens = typeof a.approx_tokens_left === "number" ? ` ≈ ${(a.approx_tokens_left / 1e6).toFixed(2)}M tokens` : "";
            const when = a.resets_at ? new Date(a.resets_at).toLocaleString() : "?";
            lines.push(`Free allowance: ${(allowanceLeftEgp() ?? a.left_egp).toFixed(2)}/${a.daily_allowance_egp} EGP left${tokens} · renews ${when}`);
            lines.push(`  covers: ${(a.models ?? []).map((x: any) => (typeof x === "string" ? x : x?.id ?? x?.model)).join(", ")}`);
            if (a.balance_fallback === false) lines.push("  balance fallback is OFF: free models stop when the allowance is used up");
          }
        }
        try {
          const r = await api("/usage", key);
          if (r.ok) {
            const u: any = await r.json();
            if (typeof u.spend_egp === "number") lines.push(`This month (${u.period ?? "?"}): ${u.spend_egp.toFixed(2)} EGP · ${((u.total_tokens ?? 0) / 1e6).toFixed(2)}M tokens`);
          }
        } catch {}
        lines.push(`Models: ${catalog.length} (${catalog.filter(routable).length} routable) · ${catalogInfo.source === "live" ? `from the API, ${ago(catalogInfo.at)}` : catalogInfo.source === "cache" ? `cached ${ago(catalogInfo.at)} (offline?)` : "none yet"}`);
        if (priceNote()) lines.push(`Prices: ${priceNote()}`);
        lines.push(`Session: ${sessionPaidEgp.toFixed(2)} EGP paid, ${sessionFreeEgp.toFixed(2)} EGP-equivalent free`);
        if (subStats.replies) lines.push(`Subagents: ${subStats.replies} replies, ${subStats.egp.toFixed(2)} EGP (reported by child processes)`);
        status(ctx);
        return say(lines.join("\n"));
      }

      if (sub === "why") {
        if (!lastRoute) return say("The smart router hasn't routed anything yet. Select sovereigneg/smart via /model.");
        const r = lastRoute;
        return say(
          [
            `Model: ${r.model}${r.free ? " (free allowance)" : ""}`,
            `Tier: ${r.tier}${r.ceiling ? ` (ceiling ${r.ceiling}, score ${r.score})` : ""}`,
            r.reasons?.length ? `Signals: ${r.reasons.join(", ")}` : undefined,
            r.note ? `Note: ${r.note}` : undefined,
          ].filter(Boolean).join("\n"),
        );
      }

      if (sub === "budget") {
        const n = Number(arg);
        if (!isFinite(n) || n < 0) return say(`Usage: /sovereign budget <EGP>   (current: ${cfg.sessionBudgetEgp || "off"}; 0 = off)`, "warning");
        cfg.sessionBudgetEgp = n;
        await saveConfig();
        return say(n ? `I'll ask before you spend more than ${n} EGP in a session.` : "Session budget prompt disabled.");
      }

      if (sub === "rpm") {
        const a = arg.toLowerCase();
        if (a === "on" || a === "off") cfg.showRpm = a === "on";
        else if (a !== "" && /^\d+$/.test(a) && Number(a) <= 100) (cfg.showRpm = true), (cfg.rpmShowAtPercent = Number(a));
        else if (a !== "") return say("Usage: /sovereign rpm [on|off|<percent 0-100>]", "warning");
        if (a !== "") (await saveConfig()), status(ctx);
        const lim = rpmLimit();
        return say(`rpm counter: ${cfg.showRpm ? `on, shown from ${cfg.rpmShowAtPercent}% of the limit` : "off"} · ${rpmNow()} request(s) in the last minute${lim ? ` of ${lim}` : ""} (this session and its subagents only)`);
      }

      if (sub === "footer") {
        const a = arg.toLowerCase();
        if (a === "auto" || a === "full" || a === "compact") (cfg.footer = a), await saveConfig(), status(ctx);
        else if (a !== "") return say("Usage: /sovereign footer [auto|full|compact]", "warning");
        return say(`Footer layout: ${cfg.footer}${cfg.footer === "auto" ? " (full when it fits the terminal, compact otherwise)" : ""}`);
      }

      if (sub === "raw") {
        const key = await resolveKey(ctx);
        const out: any = { note: "No API key included; per-request ids are redacted. Balances and plan details remain: review before sharing publicly." };
        if (key) {
          try { out.models_sample = (await fetchCatalog(key)).slice(0, 3); } catch (e: any) { out.models_error = String(e.message); }
          try {
            const r = await api("/credits", key);
            const cj: any = r.ok ? await r.json() : { status: r.status };
            if (Array.isArray(cj.recent_transactions)) cj.recent_transactions = `${cj.recent_transactions.length} entries omitted (contain request ids)`;
            out.credits = cj;
          } catch {}
          try { const r = await api("/usage", key); out.usage = r.ok ? await r.json() : { status: r.status }; } catch {}
        }
        await mkdir(DIR, { recursive: true });
        await writeFile(DEBUG_PATH, JSON.stringify(out, null, 2));
        return say(`Wrote ${DEBUG_PATH}`);
      }

      const switchTo = async (meta: Meta) => {
        if (!visibleIds().has(meta.id)) {
          // Not in pi's /model list (not a favorite) → list it as the selected model, then select it
          cfg.recent = [meta.id, ...cfg.recent.filter((x) => x !== meta.id)].slice(0, 8);
          registerProvider();
          await new Promise((r) => setTimeout(r, 60));
        }
        const model = ctx.modelRegistry.find(PROVIDER, meta.id);
        if (!model) return say(`${meta.id} isn't registered. Open /sm again to re-read the model list.`, "warning");
        const ok = await pi.setModel(model);
        say(ok ? `Switched to ${meta.id}` : "No credentials for SovereignEG — run /login.", ok ? "info" : "error");
      };

      if (sub === "list") {
        if (arg !== "curated" && arg !== "all") return say(`pi's /model list is "${cfg.modelList}". Use: /sovereign list curated | all`);
        cfg.modelList = arg;
        await saveConfig();
        registerProvider();
        return say(arg === "all" ? `/model now lists all ${catalog.length} live chat models.` : "/model now lists a short curated set. Use /sm for everything.");
      }

      if (sub === "models") {
        await refreshCredits(ctx);
        await refreshCatalog(ctx, 4000); // every time: prices on screen come from the API, or from the cache when offline
        if (!catalog.length) return say("No model list yet. Connect to the internet once (and /login) so SovereignEG's models can be read from the API.", "warning");
        const rec = recommendedMap();
        const items = catalog.map((m) => ({
          id: m.id, name: m.name, author: authorOf(m), host: hostOf(m), ctx: m.ctx,
          inPrice: m.inPrice, outPrice: m.outPrice,
          cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, cacheWrite1h: m.cacheWrite1h,
          tools: m.tools, reasoning: m.reasoning,
          free: isFreeModel(m.id), freeLow: isFreeModel(m.id) && !allowanceIds().has(m.id), rec: rec.get(m.id), down: m.down, deprecated: m.deprecated,
        }));
        let choice: string | null = null;
        try {
          if (ctx.mode !== "tui") throw new Error("not tui");
          const { openPicker } = await import("./picker.ts");
          const favs = new Set(cfg.favorites);
          const before = cfg.favorites.join("|");
          choice = await openPicker(ctx, items, {
            favorites: favs,
            onToggleFavorite: (id: string) => (favs.has(id) ? favs.delete(id) : favs.add(id)),
            note: priceNote(),
          });
          cfg.favorites = [...favs];
          if (cfg.favorites.join("|") !== before) {
            await saveConfig();
            registerProvider(); // favorites are always visible in /model
          }
        } catch {
          // Non-TUI mode (or picker failed): flat searchable select
          const f = arg.toLowerCase();
          const list = items.filter((i) => !f || i.id.toLowerCase().includes(f)).sort((a, b) => (a.outPrice ?? 1e9) - (b.outPrice ?? 1e9)).slice(0, 80);
          const map = new Map(list.map((i) => [`${i.id}  ·  ${fmtCtx(i.ctx)} ctx  ·  ${fmtPriceFull(catalog.find((m) => m.id === i.id)!)}${i.free ? (i.freeLow ? "  [FREE today (low)]" : "  [FREE today]") : ""}`, i.id]));
          const picked = list.length ? await ctx.ui.select(`SovereignEG models (cheapest first${priceNote() ? ` · ${priceNote()}` : ""})`, [...map.keys()]) : undefined;
          choice = picked ? map.get(picked) ?? null : null;
        }
        if (!choice) return;
        if (choice === "__smart__") {
          const smart = ctx.modelRegistry.find(PROVIDER, "smart");
          if (!smart) return say("Select “smart” with pi's /model → sovereigneg/smart.", "info");
          const ok = await pi.setModel(smart);
          return say(ok ? "Switched to smart routing. Thinking level = spend ceiling (low / medium / high)." : "No credentials — run /login.", ok ? "info" : "error");
        }
        const meta = catalog.find((m) => m.id === choice);
        if (meta) await switchTo(meta);
        return;
      }

      if (sub === "pick") {
        const task = arg || (await ctx.ui.input("What are you about to do?", "e.g. refactor the auth module and add tests"));
        if (!task) return;
        await refreshCredits(ctx);
        const c = classify(task, []);
        const opts = new Map<string, Meta>();
        for (const t of TIERS) {
          const p = pickModel(t, { needTokens: 8000, arabic: c.arabic });
          if (p) opts.set(`${t.toUpperCase()}${t === c.tier ? " ← suggested" : ""}: ${p.meta.id}  ·  ${fmtCtx(p.meta.ctx)}  ·  ${p.free ? "FREE today" : fmtPriceFull(p.meta)}`, p.meta);
        }
        if (!opts.size) return say("No suitable models in the catalog. Open /sm to re-read the list from the API.", "warning");
        say(`Task looks like “${c.tier}” complexity${c.reasons.length ? ` (${c.reasons.join(", ")})` : ""}${c.arabic ? "; Arabic detected" : ""}.`);
        const choice = await ctx.ui.select("Recommended models — pick one to switch", [...opts.keys()]);
        if (choice) await switchTo(opts.get(choice)!);
        return;
      }

      say(`Unknown subcommand “${sub}”. Try /sovereign help`, "warning");
    }
  };
}
