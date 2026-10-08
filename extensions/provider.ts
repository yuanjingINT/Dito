/**
 * 模型供应商注册：从 config.json 的 providers 读取并注册到 pi。
 *
 * - REPL（dito）路径通过 models.json 加载全部供应商，可自由切换。
 * - pi 扩展（pi -e）路径：跳过 pi 内置供应商（anthropic/openai/deepseek 等，
 *   它们自带 /login、OAuth、订阅等鉴权），只注册自定义/本地供应商
 *   （opencode-free、ollama 及用户新增的自定义 id）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModelMetadata, loadConfig, refreshProviderModelMetadata, resolveApiKey, type DitoConfig, type ProviderConfig } from "./util.js";
import { resolveContextWindow } from "./context-compaction.js";

export const OPENCODE_FREE_PROVIDER_ID = "opencode-free";

/** pi 内置供应商 id（跳过注册，避免覆盖其原生鉴权）。 */
const PI_BUILTIN = new Set([
  "anthropic",
  "openai",
  "azure-openai",
  "deepseek",
  "nvidia",
  "google",
  "vertex",
  "bedrock",
  "mistral",
  "groq",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "zai-coding-cn",
  "opencode",
  "opencode-go",
  "radius",
  "huggingface",
  "fireworks",
  "together",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
  "ant-ling",
]);

/** 判断供应商 id 是否为 pi 内置（REPL 的 models.json 不应覆盖其模型定义，否则会丢失 compat/thinkingLevelMap 等细节）。 */
export function isPiBuiltinProvider(id: string): boolean {
  return PI_BUILTIN.has(id);
}

/** Ignore SDK static catalog windows; only API/cache or explicit config are authoritative. */
export function modelContextFields(p: ProviderConfig, model: { id: string; maxTokens: number }): { contextWindow: number; maxTokens: number } {
  const metadata = getModelMetadata(p, model.id);
  const configured = p.models.find((m) => m.id === model.id);
  const contextWindow = resolveContextWindow(metadata?.contextWindow ?? configured?.contextWindow);
  return { contextWindow, maxTokens: Math.min(metadata?.maxTokens ?? configured?.maxTokens ?? model.maxTokens, contextWindow) };
}

export function applyRuntimeModelMetadata(
  registry: { getAll(): Model<Api>[]; registerProvider(id: string, config: { models: Model<Api>[] }): void },
  cfg: DitoConfig,
): void {
  for (const p of cfg.providers) {
    const models = registry.getAll().filter((m) => m.provider === p.id);
    if (models.length) registry.registerProvider(p.id, { models: models.map((m) => ({ ...m, ...modelContextFields(p, m) })) });
  }
}

export function registerProviders(pi: ExtensionAPI): void {
  const cfg = loadConfig();
  for (const p of cfg.providers) {
    if (PI_BUILTIN.has(p.id)) continue;
    // 空白 key 占位：opencode 免费端点不接受非空 Authorization，用单个空格。
    const apiKey = p.apiKey === "" ? " " : p.apiKey;
    pi.registerProvider(p.id, {
      name: p.name || p.id,
      baseUrl: p.baseUrl,
      apiKey,
      api: (p.api || "openai-completions") as never,
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        reasoning: m.reasoning,
        input: m.input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...modelContextFields(p, { ...m, maxTokens: m.maxTokens || 16384 }),
      })),
    });
  }
  const refreshContext = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
    if (!ctx.model) return;
    const p: ProviderConfig = loadConfig().providers.find((provider) => provider.id === ctx.model!.provider) ?? {
      id: ctx.model.provider, name: ctx.model.provider, baseUrl: ctx.model.baseUrl, api: ctx.model.api, apiKey: "",
      models: [{ id: ctx.model.id, name: ctx.model.name, reasoning: ctx.model.reasoning, input: ctx.model.input, maxTokens: ctx.model.maxTokens }],
    };
    if (p.id !== OPENCODE_FREE_PROVIDER_ID && !resolveApiKey(p.apiKey).trim()) {
      const storedKey = await ctx.modelRegistry.getApiKeyForProvider(p.id);
      if (storedKey) p.apiKey = storedKey;
    }
    await refreshProviderModelMetadata(p);
    const models = ctx.modelRegistry.getAll().filter((m) => m.provider === p.id);
    // Register just models so native OAuth, compatibility and request settings survive.
    if (models.length) pi.registerProvider(p.id, { models: models.map((m) => ({ ...m, ...modelContextFields(p, m) })) });
  };
  pi.on("session_start", refreshContext);
  pi.on("model_select", refreshContext);
}
