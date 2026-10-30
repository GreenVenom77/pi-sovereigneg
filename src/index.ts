/**
 * SovereignEG for pi
 *
 *  - /login → SovereignEG: opens the dashboard key page, you paste the key,
 *    it is validated against the API before being stored.
 *    (Env var SOVEREIGNEG_API_KEY also works.)
 *  - Live model catalog from GET /v1/models (cached for offline startup).
 *  - `sovereigneg/smart`: a virtual model that routes every request to the
 *    cheapest model likely to do the job, prefers your free daily allowance,
 *    and falls back when a model is out of credit / busy.
 *  - /sm (or /sovereign models): collapsible, searchable model tree
 *    (group by Category / Author / Host / Price, favorites with Ctrl+F).
 *  - "curated" mode keeps pi's own /model list short; /sm reaches everything.
 *  - /sovereign: status, credits, task-based model picker.
 *  - Guards: hidden-thinking cost guard, friendly 402/429 messages,
 *    session budget prompt.
 *
 * Install: copy this folder to ~/.pi/agent/extensions/sovereigneg/ and run /reload
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
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
  /** Send reasoning_effort:"none" to Claude 5.x when pi sends none (hidden thinking is billed). */
  guardHiddenThinking: boolean;
  /** Ask before continuing once this many EGP were spent in a session. 0 = off. */
  sessionBudgetEgp: number;
  /** Override model preference per tier: ordered regex strings matched against model ids. */
  tiers: Partial<Record<Tier, string[]>>;
  /** "curated": pi's /model lists a short useful subset; "all": every live chat model. */
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
};

// Ordered preferences; first one that exists, supports tools, fits context and budget wins.
const DEFAULT_TIER_PREFS: Record<Tier, string[]> = {
  low: ["claude-haiku-5\\.5", "qwen3", "gpt-oss-120b", "gpt-oss-20b", "nova-lite"],
  medium: ["claude-sonnet-5\\.5", "^claude-sonnet-5$", "gpt-5", "claude-sonnet-4\\.5"],
  high: ["claude-opus-5\\.5", "^claude-opus-5$", "claude-opus-4\\.7", "claude-opus-4\\.6", "claude-fable-5\\.1"],
};

let cfg: Config = { ...DEFAULT_CONFIG };

async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    cfg = { ...DEFAULT_CONFIG, ...raw, tiers: { ...(raw.tiers ?? {}) } };
    for (const k of ["favorites", "pinned", "recent"] as const) if (!Array.isArray(cfg[k])) cfg[k] = [];
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
  vision: boolean;
  cacheRead: number | null;
  cacheWrite: number | null;
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
    cacheRead: num(p.cache_read_per_1m_egp),
    cacheWrite: num(p.cache_write_per_1m_egp),
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
    // NOTE: values are EGP per 1M tokens (pi will label them as currency of its own choosing)
    cost: {
      input: x.inPrice ?? 0,
      output: x.outPrice ?? 0,
      cacheRead: x.cacheRead ?? x.inPrice ?? 0, // real cache prices come from the API
      cacheWrite: x.cacheWrite ?? x.inPrice ?? 0,
    },
    contextWindow: x.ctx,
    maxTokens: x.maxOut,
  };
}

// Used until a live catalog has been fetched (ids/prices taken from the public docs).
const FALLBACK_RAW = [
  { id: "claude-haiku-5.5", display_name: "Claude Haiku 5.5", provider: "Anthropic", source: "serverless", pricing: { input_per_1m_egp: 6.17, output_per_1m_egp: 30.86 }, context_window: 1000000 },
  { id: "claude-sonnet-5.5", display_name: "Claude Sonnet 5.5", provider: "Anthropic", source: "serverless", pricing: { input_per_1m_egp: 123.43, output_per_1m_egp: 617.16 }, context_window: 1000000 },
  { id: "claude-opus-5.5", display_name: "Claude Opus 5.5", provider: "Anthropic", source: "serverless", pricing: { input_per_1m_egp: 246.86, output_per_1m_egp: 1234.32 }, context_window: 1000000 },
  { id: "gpt-oss-20b", display_name: "gpt-oss-20b", provider: "OpenAI", source: "serverless", pricing: null, context_window: 131072 },
  // from a real /v1/models response
  { id: "SovereignEG/Qwen3.8-27B-FP8", display_name: "Qwen3.8-27B-FP8", provider: "Alibaba", source: "sovereign", pricing: { input_per_1m_egp: 8.41, output_per_1m_egp: 67.29, cache_read_per_1m_egp: 1.29 }, context_window: 131072, supported_parameters: ["tools", "tool_choice", "reasoning_effort", "include_reasoning"] },
].map((m) => ({ ...m, modality: "chat", status: "live", supports_tools: true }));

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
let sessionKey: string | undefined; // key from this process' /login, if any

function setCatalog(raw: any[]) {
  catalog = raw.filter((m) => (m.modality ?? "chat") === "chat" && (m.status ?? "live") === "live").map(toMeta);
}

async function loadCache(): Promise<any[] | undefined> {
  try {
    const j = JSON.parse(await readFile(CACHE_PATH, "utf8"));
    return Array.isArray(j.data) ? j.data : undefined;
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

async function resolveKey(ctx: any): Promise<string | undefined> {
  if (process.env.SOVEREIGNEG_API_KEY) return process.env.SOVEREIGNEG_API_KEY;
  try {
    const a: any = await ctx?.modelRegistry?.getProviderAuth?.(PROVIDER);
    const k = a?.apiKey ?? a?.auth?.apiKey ?? a?.key;
    if (typeof k === "string" && k) return k;
  } catch {}
  return sessionKey;
}

async function refreshCredits(ctx: any, force = false) {
  if (!force && Date.now() - creditsAt < 60_000) return credits;
  const key = await resolveKey(ctx);
  if (!key) return null;
  try {
    const r = await api("/credits", key);
    if (r.ok) {
      credits = await r.json();
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
/** True if `id` is an allowance model and the allowance still has budget (before counting the live reply). */
function isFreeModel(id: string): boolean {
  const base = allowanceBaseLeft();
  return base !== null && base >= cfg.minAllowanceLeftEgp && allowanceModels().includes(id);
}
/** Allowance models that still have budget right now (used by the router). */
function allowanceIds(): Set<string> {
  const left = allowanceLeftEgp();
  if (left === null || left < cfg.minAllowanceLeftEgp) return new Set();
  return new Set(allowanceModels());
}
let rpmTimes: number[] = [];
const rpmLimit = (): number | null => (typeof credits?.rpm_limit === "number" && credits.rpm_limit > 0 ? credits.rpm_limit : null);
function rpmUsed(now = Date.now()): number {
  rpmTimes = rpmTimes.filter((t) => now - t < 60_000);
  return rpmTimes.length;
}
function balanceEgp(): number | null {
  for (const k of ["balance_egp", "balance", "credit_egp", "credits_egp", "available_egp"]) {
    const v = credits?.[k];
    if (typeof v === "number") return v;
  }
  return null;
}
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
function statusText(): string {
  const parts: string[] = [];
  const id = activeModel || lastRoute?.model;
  const streaming = live.egp > 0;
  const approx = streaming ? "≈" : "";
  if (id) parts.push(`${String(id).split("/").pop()} ${(streaming ? live.free : isFreeModel(id)) ? "[FREE]" : "[PAID]"}`);
  parts.push(`paid ${approx}${(sessionPaidEgp + (live.free ? 0 : live.egp)).toFixed(2)} EGP`);
  if (sessionFreeEgp > 0 || (streaming && live.free)) parts.push(`free used ${approx}${(sessionFreeEgp + (live.free ? live.egp : 0)).toFixed(2)}`);
  const left = allowanceLeftEgp();
  const total = credits?.daily_allowance?.daily_allowance_egp;
  if (left !== null && total > 0) parts.push(`free left ${approx}${left.toFixed(1)}/${total} EGP (${Math.round((100 * left) / total)}%)`);
  const bal = balanceEgp();
  if (bal !== null) parts.push(`balance ${approx}${Math.max(0, bal - paidSinceRefresh - (live.free ? 0 : live.egp)).toFixed(2)} EGP`);
  const lim = rpmLimit();
  if (lim && lim <= 120) parts.push(`rpm ${rpmUsed()}/${lim}`);
  return `SovereignEG · ${parts.join(" · ")}`;
}

// ───────────────────────── what pi's /model shows ─────────────────────────
const extraIds = new Set<string>(); // models picked via /sm this session
let reRegister: () => void = () => {};
let lastVisibleKey = "";

function visibleIds(): Set<string> {
  if (cfg.modelList === "all") return new Set(catalog.map((m) => m.id));
  const keep = new Set<string>([...cfg.favorites, ...cfg.recent, ...extraIds, ...allowanceModels()]);
  for (const t of TIERS) {
    for (const p of cfg.tiers[t] ?? DEFAULT_TIER_PREFS[t]) {
      let re: RegExp;
      try { re = new RegExp(p, "i"); } catch { continue; }
      let n = 0;
      for (const m of catalog) if (n < 2 && routable(m) && re.test(m.id)) (keep.add(m.id), n++);
    }
  }
  for (const p of cfg.pinned) {
    try { const re = new RegExp(p, "i"); catalog.forEach((m) => re.test(m.id) && keep.add(m.id)); } catch {}
  }
  const out = new Set(catalog.filter((m) => keep.has(m.id)).map((m) => m.id));
  return out.size >= 3 ? out : new Set(catalog.slice(0, 40).map((m) => m.id));
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
/** First match per tier from the curated preference lists. */
function recommendedMap(): Map<string, "economy" | "balanced" | "top"> {
  const label: Record<Tier, "economy" | "balanced" | "top"> = { low: "economy", medium: "balanced", high: "top" };
  const out = new Map<string, "economy" | "balanced" | "top">();
  for (const t of TIERS) {
    for (const p of cfg.tiers[t] ?? DEFAULT_TIER_PREFS[t]) {
      let re: RegExp;
      try { re = new RegExp(p, "i"); } catch { continue; }
      const hit = catalog.find((m) => routable(m) && re.test(m.id) && !out.has(m.id));
      if (hit) { out.set(hit.id, label[t]); break; }
    }
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
  const reachable = visibleIds();
  const cands = catalog.filter(
    (m) =>
      reachable.has(m.id) &&
      routable(m) &&
      !exclude.has(m.id) &&
      m.ctx >= opts.needTokens * 1.3 &&
      (m.outPrice !== null || m.source === "sovereign" || m.id.startsWith("SovereignEG/") || m.id.startsWith("gpt-oss")),
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
  if (opts.arabic && tier === "low") prefs = ["qwen", "claude-haiku", ...prefs];
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

function fmtPrice(m: Meta) {
  const f = (n: number | null) => (n === null ? "?" : n < 10 ? n.toFixed(2) : n.toFixed(0));
  return `${f(m.inPrice)}/${f(m.outPrice)} EGP`;
}
function fmtCtx(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`;
}

// ───────────────────────── error explanations ─────────────────────────
const HINTS: Array<[RegExp, string]> = [
  [/daily_allowance_exhausted/i, "Today's free allowance is used up (it renews 00:00 Cairo time). Switch to a pay-as-you-go model or turn on 'Use balance automatically' in Billing → Plans."],
  [/daily_allowance_pending/i, "Your pack was just bought; today's allowance appears within a minute. Retry shortly."],
  [/insufficient_balance|insufficient_quota|quota_exceeded|\b402\b/i, `Out of EGP credit. Top up at ${DASHBOARD} (Billing), or switch to a model covered by your free allowance.`],
  [/inflight_busy/i, "Your credit is held by requests still running. Retry in ~10 seconds."],
  [/allowance_capacity_busy|allowance_capacity_unavailable/i, "The shared free-allowance GPUs are busy. Retry in a few seconds or use a pay-as-you-go model."],
  [/concurrency_limit_exceeded/i, "Too many simultaneous requests on your plan. Wait 2 seconds and retry."],
  [/rate_limit_exceeded|\b429\b/i, "Rate limited (RPM). pi will back off; consider a per-key limit increase via support@sovereigneg.com."],
  [/key_expired|key_revoked|invalid_api_key|missing_auth_header|invalid_token/i, "API key problem. Run /login and choose SovereignEG to add a fresh key."],
  [/key_scope_insufficient/i, "This key's scope can't call models. Create an inference-scope key in the dashboard."],
  [/ip_not_allowed/i, "This key has an IP allow-list that doesn't include your current IP."],
  [/org_suspended/i, "Your organization is suspended — contact support@sovereigneg.com."],
  [/model_not_found/i, "Model id not found. Run /sovereign refresh to update the catalog."],
  [/unsupported_parameter/i, "This model doesn't support a parameter pi sent. Try another model."],
  [/prompt_too_long_for_plan|max_tokens_exceeded/i, "Prompt or max_tokens exceeds the plan/model limit. Compact the session (/compact) or pick a larger-context model."],
  [/request_too_large|\b413\b/i, "Request body over the 32 MiB limit. Compact the session or drop big attachments."],
];
function explain(text: string): string | undefined {
  return HINTS.find(([re]) => re.test(text))?.[1];
}

// ───────────────────────── extension ─────────────────────────
export default async function (pi: ExtensionAPI) {
  await loadConfig();

  // 1) catalog: cache → fallback, then try live (short timeout) if a key is in the env
  const cached = await loadCache();
  setCatalog(cached ?? FALLBACK_RAW);
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

      // Retry after a failure → pick a different model (keep tier)
      if (request.reason === "retry" && request.failed) {
        const err = String(request.failed.message?.errorMessage ?? "");
        const exclude = new Set<string>([request.failed.model.id]);
        if (/allowance|concurrency_limit/i.test(err)) allowanceIds().forEach((i) => exclude.add(i));
        const tier: Tier = lastRoute?.tier ?? "medium";
        const need = JSON.stringify(messages).length / 3.2;
        const alt = pickModel(tier, { needTokens: need, exclude });
        const model = alt && find(alt.meta.id);
        if (model) {
          lastRoute = { ...lastRoute, model: alt!.meta.id, note: `fallback after: ${err.slice(0, 80)}`, at: Date.now() };
          return { model, thinkingLevel: request.failed.thinkingLevel ?? "low" };
        }
        return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? "low" };
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
      const model = pick && find(pick.meta.id);
      if (!pick || !model) {
        const any = reg.getAvailable?.().find((m: any) => m.provider === PROVIDER);
        if (!any) throw new Error("No SovereignEG models available — run /login and pick SovereignEG.");
        return { model: any, thinkingLevel: "low" };
      }
      const thinking = tier === "low" ? "off" : tier === "medium" ? "low" : c.score >= 7 ? "high" : "medium";
      lastRoute = { tier, ceiling, score: c.score, reasons: c.reasons, model: pick.meta.id, free: pick.free, thinking, at: Date.now() };
      return { model, thinkingLevel: thinking };
    },
  } as any);

  // 3) hidden-thinking guard (Claude 5.x thinks — and bills — by default when no effort is sent)
  const HIDDEN_RE = /^claude-(haiku|sonnet|opus|fable)-5(\.\d+)?$/i;
  let lastRpmWarn = 0;
  pi.on("before_provider_request", (event: any, ctx: any) => {
    if (ctx.model?.provider !== PROVIDER) return;
    // Rolling requests-per-minute vs the plan limit (Student plans are limited to 20 RPM; agent loops can hit that)
    const nowMs = Date.now();
    rpmTimes.push(nowMs);
    const used = rpmUsed(nowMs);
    const limit = rpmLimit();
    if (limit && used >= Math.ceil(limit * 0.8) && nowMs - lastRpmWarn > 60_000 && ctx.hasUI) {
      lastRpmWarn = nowMs;
      ctx.ui.notify(`Approaching your plan's rate limit: ${used}/${limit} requests in the last minute. pi will back off on 429s.`, "warning");
    }
    status(ctx, false);
    if (!cfg.guardHiddenThinking) return;
    const p = event.payload;
    if (!p || typeof p !== "object" || !Array.isArray(p.messages)) return;
    if (typeof p.model !== "string" || !HIDDEN_RE.test(p.model)) return;
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
    else if (event.status === 429) (lastNotice = now), ctx.ui.notify(`Rate limited — retry in ${h["retry-after"] ?? "a few"}s.`, "warning");
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
    const cost = m.usage?.cost?.total ?? 0;
    if (isFreeModel(m.model)) {
      sessionFreeEgp += cost;
      freeSinceRefresh += cost;
    } else {
      sessionPaidEgp += cost;
      paidSinceRefresh += cost;
    }
    activeModel = m.model ?? activeModel;
    resetLive(); // swap the estimate for the exact figure
    if (m.stopReason === "error" && m.errorMessage && ctx.hasUI) {
      const hint = explain(String(m.errorMessage));
      if (hint) ctx.ui.notify(hint, "error");
    }
    status(ctx);
  });

  // While the agent works, keep the real allowance/balance fresh instead of waiting for the turn to end
  let poll: any;
  const stopPolling = () => poll && (clearInterval(poll), (poll = undefined));
  pi.on("agent_start", async (_e: any, ctx: any) => {
    stopPolling();
    if (cfg.statusRefreshSeconds <= 0) return;
    let inflight = false; // never stack requests if the API is slower than the interval
    poll = setInterval(async () => {
      if (inflight) return;
      inflight = true;
      try {
        await refreshCredits(ctx, true);
        status(ctx, false);
      } finally {
        inflight = false;
      }
    }, cfg.statusRefreshSeconds * 1000);
    poll.unref?.();
  });
  pi.on("agent_end", async () => stopPolling());
  pi.on("session_shutdown", async () => stopPolling());

  pi.on("model_select", async (event: any) => {
    const m = event.model;
    if (m?.provider !== PROVIDER || m.id === "smart") return;
    if (cfg.recent[0] === m.id) return;
    cfg.recent = [m.id, ...cfg.recent.filter((x) => x !== m.id)].slice(0, 8);
    saveConfig().catch(() => {});
  });

  pi.on("session_start", async (_e: any, ctx: any) => {
    sessionPaidEgp = 0;
    sessionFreeEgp = 0;
    const key = await resolveKey(ctx);
    if (!key && ctx.hasUI) ctx.ui.notify("SovereignEG: run /login and pick SovereignEG (or set SOVEREIGNEG_API_KEY).", "info");
    await refreshCredits(ctx, true);
    status(ctx);
  });

  pi.on("agent_settled", async (_e: any, ctx: any) => {
    await refreshCredits(ctx);
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
    description: "SovereignEG model tree (group, search, favorite, switch)",
    handler: async (args: string, ctx: any) => runSovereign(`models ${args ?? ""}`, ctx),
  });
  const SUBS = ["models", "status", "pick", "list", "why", "refresh", "budget", "raw", "help"];
  let runSovereign: (args: string, ctx: any) => Promise<any> = async () => {};
  pi.registerCommand("sovereign", {
    description: "SovereignEG: models (tree), status, pick, list, why, refresh, budget",
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
            "/sovereign list curated|all  what pi's own /model shows (curated = short list)",
            "/sovereign pick [task]       recommend a model for a task",
            "/sovereign why               why the router chose its last model",
            "/sovereign refresh           re-fetch the live catalog",
            "/sovereign budget <EGP>      ask before exceeding this session spend",
            "/sovereign raw               dump raw API samples to a debug file",
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
          if (plan) lines.push(`Plan: ${plan}${c.rpm_limit ? ` · ${c.rpm_limit} requests/min` : ""}${c.base_rpm_limit && c.base_rpm_limit !== c.rpm_limit ? ` (standard ${c.base_rpm_limit})` : ""}`);
          const bal = balanceEgp();
          if (bal !== null) {
            const split = typeof c.promotional_egp === "number" || typeof c.paid_egp === "number" ? ` (promo ${(c.promotional_egp ?? 0).toFixed(2)}, paid ${(c.paid_egp ?? 0).toFixed(2)})` : "";
            lines.push(`Balance: ${bal.toFixed(2)} EGP${split}`);
          }
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
        lines.push(`Models in catalog: ${catalog.length} (${catalog.filter(routable).length} routable)`);
        lines.push(`Session: ${sessionPaidEgp.toFixed(2)} EGP paid, ${sessionFreeEgp.toFixed(2)} EGP-equivalent free`);
        status(ctx);
        return say(lines.join("\n"));
      }

      if (sub === "refresh") {
        const key = await resolveKey(ctx);
        if (!key) return say("No API key. Run /login first.", "warning");
        try {
          const live = await fetchCatalog(key);
          setCatalog(live);
          await saveCache(live);
          registerProvider();
          await refreshCredits(ctx, true);
          return say(`Catalog updated: ${catalog.length} live chat models.`);
        } catch (e: any) {
          return say(String(e.message ?? e), "error");
        }
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
          // Not in pi's curated /model list yet → add it for this session, then select it
          extraIds.add(meta.id);
          registerProvider();
          await new Promise((r) => setTimeout(r, 60));
        }
        const model = ctx.modelRegistry.find(PROVIDER, meta.id);
        if (!model) return say(`${meta.id} isn't registered. Try /sovereign refresh.`, "warning");
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
        const free = allowanceIds();
        const rec = recommendedMap();
        const items = catalog.map((m) => ({
          id: m.id, name: m.name, author: authorOf(m), host: hostOf(m), ctx: m.ctx,
          inPrice: m.inPrice, outPrice: m.outPrice, tools: m.tools, reasoning: m.reasoning,
          free: free.has(m.id), rec: rec.get(m.id), down: m.down, deprecated: m.deprecated,
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
          const map = new Map(list.map((i) => [`${i.id}  ·  ${fmtCtx(i.ctx)}  ·  ${fmtPrice(catalog.find((m) => m.id === i.id)!)}/1M${i.free ? "  [FREE today]" : ""}`, i.id]));
          const picked = list.length ? await ctx.ui.select("SovereignEG models (cheapest first)", [...map.keys()]) : undefined;
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
          if (p) opts.set(`${t.toUpperCase()}${t === c.tier ? " ← suggested" : ""}: ${p.meta.id}  ·  ${fmtCtx(p.meta.ctx)}  ·  ${p.free ? "FREE today" : fmtPrice(p.meta) + "/1M"}`, p.meta);
        }
        if (!opts.size) return say("No suitable models in the catalog. Try /sovereign refresh.", "warning");
        say(`Task looks like “${c.tier}” complexity${c.reasons.length ? ` (${c.reasons.join(", ")})` : ""}${c.arabic ? "; Arabic detected" : ""}.`);
        const choice = await ctx.ui.select("Recommended models — pick one to switch", [...opts.keys()]);
        if (choice) await switchTo(opts.get(choice)!);
        return;
      }

      say(`Unknown subcommand “${sub}”. Try /sovereign help`, "warning");
    }
  };
}
