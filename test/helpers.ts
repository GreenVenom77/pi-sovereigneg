import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Point the extension's config/cache at a throw-away dir so tests never touch ~/.pi */
export function isolate(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-sovereigneg-"));
  process.env.PI_SOVEREIGNEG_DIR = dir;
  process.env.SOVEREIGNEG_API_KEY = "sk-" + "a".repeat(32);
  return dir;
}

export const model = (id: string, outPrice: number | null, extra: any = {}) => ({
  id,
  modality: "chat",
  status: "live",
  supports_tools: true,
  pricing: outPrice === null ? null : { input_per_1m_egp: outPrice / 5, output_per_1m_egp: outPrice },
  context_window: 1_000_000,
  source: "serverless",
  ...extra,
});

export const CORE_MODELS = [
  model("claude-haiku-5.5", 30.86, { owned_by: "Anthropic" }),
  model("claude-sonnet-5.5", 617, { owned_by: "Anthropic" }),
  model("claude-opus-5.5", 1234, { owned_by: "Anthropic" }),
  model("SovereignEG/Qwen3.8-27B-FP8", 15, { source: "sovereign", context_window: 131072, owned_by: "Alibaba", supported_parameters: ["tools", "tool_choice", "reasoning_effort", "include_reasoning"] }),
];

/**
 * Replace global fetch with a fake SovereignEG API. `state.left` controls the free allowance.
 * Pass `extras.credits` / `extras.usage` to serve real-shaped payloads instead.
 */
export function fakeApi(models: any[], state: { left: number } = { left: 40 }, extras: { credits?: any; usage?: any } = {}) {
  (globalThis as any).fetch = async (url: string) => {
    const u = String(url);
    const body = u.endsWith("/models")
      ? { data: models }
      : u.endsWith("/credits")
        ? extras.credits ?? { daily_allowance: { issued: true, daily_allowance_egp: 50, left_egp: state.left, models: ["SovereignEG/Qwen3.8-27B-FP8"], resets_at: "2026-10-30T21:00:00Z" } }
        : u.endsWith("/usage")
          ? extras.usage ?? {}
          : {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return state;
}

/** A minimal stand-in for pi's ExtensionAPI that records what the extension registers. */
export function fakePi() {
  const reg: any = { providerRegs: [], hooks: {}, cmds: {}, virtual: null, setModelCalls: [] as string[], entries: [] as any[] };
  const pi: any = {
    registerProvider: (_n: string, c: any) => reg.providerRegs.push({ cfg: c, ids: c.models.map((m: any) => m.id) }),
    registerVirtualModel: (m: any) => (reg.virtual = m),
    registerCommand: (n: string, c: any) => (reg.cmds[n] = c),
    on: (e: string, h: any) => ((reg.hooks[e] ??= []).push(h)),
    getCommands: () => [],
    appendEntry: (customType: string, data: any) => reg.entries.push({ type: "custom", customType, data }),
    setModel: async (m: any) => (reg.setModelCalls.push(m.id), true),
  };
  return { pi, reg, lastIds: (): string[] => reg.providerRegs.at(-1).ids, provider: () => reg.providerRegs.at(-1).cfg };
}

export function fakeCtx(reg: any, opts: { visible?: () => string[]; ui?: any } = {}) {
  const notes: string[] = [];
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    model: { provider: "sovereigneg", id: "smart" },
    ui: { notify: (m: string) => notes.push(m), setStatus: (_k: string, s: string) => notes.push("STATUS " + s), ...opts.ui },
    sessionManager: { getEntries: () => reg.entries },
    modelRegistry: {
      find: (_p: string, id: string) => ((opts.visible?.() ?? reg.providerRegs.at(-1)?.ids ?? []).includes(id) ? { provider: "sovereigneg", id } : undefined),
      getAvailable: () => (reg.providerRegs.at(-1)?.ids ?? []).map((id: string) => ({ provider: "sovereigneg", id })),
    },
  };
  return { ctx, notes };
}
