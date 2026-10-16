import { getModelMetadata, loadConfig, refreshProviderModelMetadata, resolveApiKey } from "./util.js";
import { resolveContextWindow } from "./context-compaction.js";
const OPENCODE_FREE_PROVIDER_ID = "opencode-free";
const PI_BUILTIN = /* @__PURE__ */ new Set([
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
  "ant-ling"
]);
function isPiBuiltinProvider(id) {
  return PI_BUILTIN.has(id);
}
function modelContextFields(p, model) {
  const metadata = getModelMetadata(p, model.id);
  const configured = p.models.find((m) => m.id === model.id);
  const contextWindow = resolveContextWindow(metadata?.contextWindow ?? configured?.contextWindow);
  return { contextWindow, maxTokens: Math.min(metadata?.maxTokens ?? configured?.maxTokens ?? model.maxTokens, contextWindow) };
}
function applyRuntimeModelMetadata(registry, cfg) {
  for (const p of cfg.providers) {
    const models = registry.getAll().filter((m) => m.provider === p.id);
    if (models.length) registry.registerProvider(p.id, { models: models.map((m) => ({ ...m, ...modelContextFields(p, m) })) });
  }
}
function registerProviders(pi) {
  const cfg = loadConfig();
  for (const p of cfg.providers) {
    if (PI_BUILTIN.has(p.id)) continue;
    const apiKey = p.apiKey === "" ? " " : p.apiKey;
    pi.registerProvider(p.id, {
      name: p.name || p.id,
      baseUrl: p.baseUrl,
      apiKey,
      api: p.api || "openai-completions",
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        reasoning: m.reasoning,
        input: m.input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...modelContextFields(p, { ...m, maxTokens: m.maxTokens || 16384 })
      }))
    });
  }
  const refreshContext = async (_event, ctx) => {
    if (!ctx.model) return;
    const p = loadConfig().providers.find((provider) => provider.id === ctx.model.provider) ?? {
      id: ctx.model.provider,
      name: ctx.model.provider,
      baseUrl: ctx.model.baseUrl,
      api: ctx.model.api,
      apiKey: "",
      models: [{ id: ctx.model.id, name: ctx.model.name, reasoning: ctx.model.reasoning, input: ctx.model.input, maxTokens: ctx.model.maxTokens }]
    };
    if (p.id !== OPENCODE_FREE_PROVIDER_ID && !resolveApiKey(p.apiKey).trim()) {
      const storedKey = await ctx.modelRegistry.getApiKeyForProvider(p.id);
      if (storedKey) p.apiKey = storedKey;
    }
    await refreshProviderModelMetadata(p);
    const models = ctx.modelRegistry.getAll().filter((m) => m.provider === p.id);
    if (models.length) pi.registerProvider(p.id, { models: models.map((m) => ({ ...m, ...modelContextFields(p, m) })) });
  };
  pi.on("session_start", refreshContext);
  pi.on("model_select", refreshContext);
}
export {
  OPENCODE_FREE_PROVIDER_ID,
  applyRuntimeModelMetadata,
  isPiBuiltinProvider,
  modelContextFields,
  registerProviders
};
