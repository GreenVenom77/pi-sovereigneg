// Runs as a separate process in subagents.test.ts: behaves like a pi-subagents child (env inherited from the main session).
import { fakeApi, fakePi, fakeCtx, CORE_MODELS } from "./helpers.ts";
fakeApi(CORE_MODELS, { left: 40 });
const { default: ext } = await import("../src/index.ts");
const h = fakePi();
await ext(h.pi);
const { ctx } = fakeCtx(h.reg);
ctx.hasUI = false;
const fire = async (ev: string, payload: any) => { for (const hook of h.reg.hooks[ev] ?? []) await hook(payload, ctx); };
const msg = (extra: any = {}) => ({ role: "assistant", provider: "sovereigneg", model: "SovereignEG/Qwen3.8-27B-FP8", content: [], ...extra });
await fire("message_start", { message: msg() });
await fire("message_end", { message: msg({ usage: { cost: { total: 2 } } }) });
