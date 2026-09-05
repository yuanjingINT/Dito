/**
 * 模型供应商注册：从 config.json 的 providers 读取并注册到 pi。
 *
 * - REPL（dito）路径通过 models.json 加载全部供应商，可自由切换。
 * - pi 扩展（pi -e）路径：跳过 pi 内置供应商（anthropic/openai/deepseek 等，
 *   它们自带 /login、OAuth、订阅等鉴权），只注册自定义/本地供应商
 *   （opencode-free、ollama 及用户新增的自定义 id）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./util.js";

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
        contextWindow: m.contextWindow || 128000,
        maxTokens: m.maxTokens || 16384,
      })),
    });
  }
}
