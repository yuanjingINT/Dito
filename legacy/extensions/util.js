import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { hasPromptBundle, listEncryptedPromptNames, namespaceForDir, readEncryptedPrompt } from "./prompt-crypto.js";
import { channelDataDir, migrateChannelData, userDataDir, writePrivateJson } from "./user-data.js";
import { DEFAULT_CONTEXT_COMPACTION } from "./context-compaction.js";
import { cachedModelInfo, fetchEndpointModels } from "./model-metadata.js";
import { DEFAULT_MEMORY_CONFIG, resolveMemoryConfig } from "./memory-config.js";
import { DEFAULT_DITO_RE_CONFIG } from "./plugins/dito-re.js";
import { DEFAULT_SUBAGENT_CONFIG } from "./subagent-config.js";
const HERE = typeof import.meta !== "undefined" && typeof import.meta.url === "string" ? dirname(fileURLToPath(import.meta.url)) : typeof __dirname !== "undefined" ? __dirname : ".";
const ROOT_DIR = process.env.DITO_RESOURCE_DIR || join(HERE, "../..");
const PERSONAS_DIR = join(ROOT_DIR, "personas");
const IDENTITIES_DIR = join(ROOT_DIR, "identities");
const DITO_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "../package.json"), "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const DITO_IS_ALPHA = DITO_VERSION.endsWith("-alpha");
function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
function ditoDataDir() {
  return join(agentDir(), "dito");
}
function ditoConfigPath() {
  return process.env.DITO_CONFIG_FILE || join(ditoDataDir(), "config.json");
}
function ditoUserDir() {
  return userDataDir(ditoDataDir());
}
function ditoChannelDir(channel) {
  return channelDataDir(ditoDataDir(), channel);
}
function scopedDataDir(scope) {
  const channel = scope?.startsWith("qq-") ? "qq" : scope?.startsWith("matrix-") ? "matrix" : void 0;
  if (!channel) return ditoDataDir();
  migrateChannelData(ditoDataDir());
  return ditoChannelDir(channel);
}
function defaultProviders() {
  return [
    {
      id: "opencode-free",
      name: "OpenCode 免费 (Zen)",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: " ",
      api: "openai-completions",
      models: [
        { id: "big-pickle", name: "Big Pickle（免费）", reasoning: true, input: ["text"], maxTokens: 16384 },
        { id: "mimo-v2.5-free", name: "MiMo v2.5（免费·视觉）", reasoning: false, input: ["text", "image"], maxTokens: 16384 }
      ]
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "$OPENCODE_API_KEY",
      api: "openai-completions",
      models: [
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, input: ["text"], maxTokens: 384e3 },
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, input: ["text"], maxTokens: 384e3 },
        { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", reasoning: true, input: ["text", "image"], maxTokens: 384e3 },
        { id: "kimi-k3", name: "Kimi K3", reasoning: true, input: ["text", "image"], maxTokens: 131072 },
        { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", reasoning: true, input: ["text", "image"], maxTokens: 262144 },
        { id: "kimi-k2.6", name: "Kimi K2.6", reasoning: true, input: ["text", "image"], maxTokens: 65536 },
        { id: "glm-5.2", name: "GLM-5.2", reasoning: true, input: ["text"], maxTokens: 131072 },
        { id: "mimo-v2.5", name: "MiMo V2.5", reasoning: true, input: ["text", "image"], maxTokens: 128e3 },
        { id: "minimax-m2.7", name: "MiniMax-M2.7", reasoning: true, input: ["text"], maxTokens: 131072 },
        { id: "qwen3.6-plus", name: "Qwen3.6 Plus", reasoning: true, input: ["text", "image"], maxTokens: 65536 },
        // anthropic-messages 端点（/zen/go 无 /v1）
        { id: "qwen3.8-max", name: "Qwen3.8 Max", reasoning: true, input: ["text", "image"], maxTokens: 131072, api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" },
        { id: "qwen3.7-max", name: "Qwen3.7 Max", reasoning: true, input: ["text"], maxTokens: 65536, api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" },
        { id: "minimax-m3", name: "MiniMax-M3", reasoning: true, input: ["text", "image"], maxTokens: 131072, api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" },
        // openai-responses 端点（/zen/go/v1）
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true, input: ["text", "image"], maxTokens: 128e3, api: "openai-responses" }
      ]
    },
    {
      id: "deepseek",
      name: "DeepSeek（官方·国内直连）",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "$DEEPSEEK_API_KEY",
      api: "openai-completions",
      models: [
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, input: ["text"], maxTokens: 384e3 },
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, input: ["text"], maxTokens: 384e3 }
      ]
    },
    {
      id: "zhipu",
      name: "智谱 GLM（BigModel）",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "$ZHIPUAI_API_KEY",
      api: "openai-completions",
      models: [
        { id: "glm-5.3-flash", name: "GLM-5.3-Flash（闪存·快）", reasoning: true, input: ["text"], maxTokens: 16384 },
        { id: "glm-4-flash", name: "GLM-4-Flash（免费）", reasoning: false, input: ["text"], maxTokens: 16384 },
        { id: "glm-4v-flash", name: "GLM-4V-Flash（免费·视觉）", reasoning: false, input: ["text", "image"], maxTokens: 16384 },
        { id: "glm-5.2", name: "GLM-5.2（旗舰）", reasoning: true, input: ["text"], maxTokens: 16384 }
      ]
    },
    {
      id: "dashscope",
      name: "阿里云百炼 Qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "$DASHSCOPE_API_KEY",
      api: "openai-completions",
      models: [
        { id: "qwen-turbo", name: "Qwen Turbo", reasoning: false, input: ["text"], maxTokens: 8192 },
        { id: "qwen-plus", name: "Qwen Plus", reasoning: false, input: ["text"], maxTokens: 8192 },
        { id: "qwen-max", name: "Qwen Max", reasoning: false, input: ["text"], maxTokens: 8192 },
        { id: "qwen-vl-plus", name: "Qwen VL Plus（视觉）", reasoning: false, input: ["text", "image"], maxTokens: 4096 }
      ]
    },
    {
      id: "moonshot",
      name: "月之暗面 Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "$MOONSHOT_API_KEY",
      api: "openai-completions",
      models: [
        { id: "kimi-latest", name: "Kimi Latest", reasoning: true, input: ["text", "image"], maxTokens: 16384 },
        { id: "moonshot-v1-128k", name: "Moonshot V1 128K", reasoning: false, input: ["text"], maxTokens: 8192 },
        { id: "kimi-k2-0711-preview", name: "Kimi K2（推理）", reasoning: true, input: ["text", "image"], maxTokens: 65536 }
      ]
    },
    {
      id: "siliconflow",
      name: "硅基流动 SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "$SILICONFLOW_API_KEY",
      api: "openai-completions",
      models: [
        { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek-V3", reasoning: false, input: ["text"], maxTokens: 8192 },
        { id: "Qwen/Qwen2.5-7B-Instruct", name: "Qwen2.5-7B（免费）", reasoning: false, input: ["text"], maxTokens: 8192 },
        { id: "THUDM/glm-4-9b-chat", name: "GLM-4-9B（免费）", reasoning: false, input: ["text"], maxTokens: 8192 },
        { id: "Qwen/Qwen3-235B-A22B-Instruct", name: "Qwen3-235B（推理）", reasoning: true, input: ["text"], maxTokens: 16384 }
      ]
    },
    {
      id: "volcengine",
      name: "火山方舟 豆包",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "$ARK_API_KEY",
      api: "openai-completions",
      models: [
        { id: "doubao-seed-1-6-250615", name: "Doubao Seed 1.6", reasoning: false, input: ["text"], maxTokens: 16384 },
        { id: "doubao-1-5-pro-32k-250115", name: "Doubao 1.5 Pro 32K", reasoning: false, input: ["text"], maxTokens: 4096 },
        { id: "doubao-1-5-vision-pro-32k-250115", name: "Doubao 1.5 Vision Pro（视觉）", reasoning: false, input: ["text", "image"], maxTokens: 4096 }
      ]
    },
    {
      id: "anthropic",
      name: "Anthropic Claude",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "$ANTHROPIC_API_KEY",
      api: "anthropic-messages",
      models: [
        { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", reasoning: true, input: ["text", "image"], maxTokens: 16384 },
        { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", reasoning: true, input: ["text", "image"], maxTokens: 8192 }
      ]
    },
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "$OPENAI_API_KEY",
      api: "openai-completions",
      models: [
        { id: "gpt-4o", name: "GPT-4o", reasoning: false, input: ["text", "image"], maxTokens: 16384 },
        { id: "gpt-4o-mini", name: "GPT-4o mini", reasoning: false, input: ["text", "image"], maxTokens: 16384 }
      ]
    },
    {
      id: "ollama",
      name: "Ollama (本地)",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
      api: "openai-completions",
      models: [
        { id: "qwen2.5:7b", name: "Qwen2.5 7B", reasoning: false, input: ["text"], maxTokens: 8192 }
      ]
    }
  ];
}
function defaultConfig() {
  return {
    version: 1,
    model: { provider: "opencode-free", chat: "big-pickle", vision: "mimo-v2.5-free" },
    providers: defaultProviders(),
    contextCompaction: { ...DEFAULT_CONTEXT_COMPACTION },
    persona: { active: "dito", identity: "默认" },
    channels: {
      qq: {
        enabled: false,
        url: "ws://127.0.0.1:3001",
        accessToken: "",
        command: "",
        autoStart: true,
        owners: [],
        wakeKeywords: [],
        groupReplyChance: 0.2,
        wakeOnlyGroups: [],
        autoReact: true,
        memeChance: 0.3,
        groups: [],
        friends: true,
        pokeBack: true,
        autoApprove: false,
        admin: { port: 3880, token: "" }
      },
      matrix: {
        enabled: false,
        homeserver: "https://matrix.org",
        accessToken: "",
        rooms: []
      },
      mobile: {
        enabled: false,
        relayUrl: "",
        room: "",
        hostToken: "",
        autoApprove: false,
        devices: [],
        tunnel: {},
        pwaDir: ""
      }
    },
    plugins: {
      manager: { version: 1, initialized: false, installed: ["tui"] },
      provider: { enabled: true },
      persona: { enabled: true },
      system: { enabled: true },
      mode: { enabled: true },
      knowledge_base: { enabled: true, dataDir: "" },
      memory: { ...DEFAULT_MEMORY_CONFIG },
      web_search: {
        enabled: true,
        tavilyKeys: [],
        firecrawlKeys: [],
        anysearchKeys: [],
        exaKeys: [],
        perplexityKey: "",
        searxngUrl: ""
      },
      voice: {
        enabled: true,
        wakeWord: "",
        stt: "whisper",
        tts: "espeak",
        whisperModel: "~/.local/share/whisper/models/ggml-small-q5_1.bin",
        whisperLanguage: "zh",
        espeakVoice: "zh",
        piperModel: "",
        piperConfig: "",
        xiaomiApiKey: "",
        xiaomiBaseUrl: "https://api.xiaomimimo.com/v1",
        xiaomiAsrModel: "mimo-v2.5-asr",
        xiaomiTtsModel: "mimo-v2.5-tts",
        xiaomiTtsVoice: "冰糖",
        xiaomiTtsVoiceDesign: "",
        maxRecordSeconds: 8,
        autoListenAfterQuestion: true,
        continuous: false,
        customSttCommand: "",
        customTtsCommand: ""
      },
      permission: { enabled: true, sudoMode: false, autoSudo: true, sudoCommand: "sudo" },
      ask: { enabled: true },
      snowluma: { enabled: true },
      mcp: {
        enabled: true,
        server: { enabled: true, port: 3878, token: "", allowBash: false },
        clients: []
      },
      "dito-re": {
        ...DEFAULT_DITO_RE_CONFIG,
        topics: DEFAULT_DITO_RE_CONFIG.topics.map((topic) => ({ ...topic, keywords: [...topic.keywords] }))
      },
      subagent: { ...DEFAULT_SUBAGENT_CONFIG }
    }
  };
}
function resolveApiKey(key) {
  const k = key.trim();
  if (k === "") return "";
  if (k.startsWith("${") && k.endsWith("}")) return process.env[k.slice(2, -1)] ?? "";
  if (k.startsWith("$")) return process.env[k.slice(1)] ?? "";
  return k;
}
let providerSessionId = "";
function providerRequestHeaders(p, extra) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": `dito-agent/${DITO_VERSION}`,
    ...extra
  };
  try {
    const host = new URL(p.baseUrl).hostname;
    if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
      if (!providerSessionId) providerSessionId = randomUUID();
      headers["x-opencode-session"] = providerSessionId;
    }
  } catch {
  }
  const key = resolveApiKey(p.apiKey);
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}
function metadataEndpoint(p, model) {
  return { id: p.id, baseUrl: model?.baseUrl || p.baseUrl, api: model?.api || p.api, apiKey: resolveApiKey(p.apiKey).trim(), models: p.models };
}
function getModelMetadata(p, id) {
  return cachedModelInfo(metadataEndpoint(p, p.models.find((m) => m.id === id)), id, join(ditoDataDir(), "model-metadata"));
}
async function fetchModelList(p, options = {}) {
  const endpoints = /* @__PURE__ */ new Map();
  for (const model of [void 0, ...p.models.filter((m) => m.baseUrl || m.api)]) {
    const endpoint = metadataEndpoint(p, model);
    endpoints.set(`${endpoint.api}
${endpoint.baseUrl}`, endpoint);
  }
  const lists = await Promise.all([...endpoints.values()].map((endpoint) => fetchEndpointModels(endpoint, join(ditoDataDir(), "model-metadata"), options)));
  const merged = /* @__PURE__ */ new Map();
  for (const list of lists) for (const model of list) merged.set(model.id, model);
  return [...merged.values()];
}
async function refreshProviderModelMetadata(p) {
  await fetchModelList(p);
  for (const model of p.models) {
    const metadata = getModelMetadata(p, model.id);
    if (metadata?.contextWindow) model.contextWindow = metadata.contextWindow;
    if (metadata?.maxTokens) model.maxTokens = metadata.maxTokens;
  }
}
function applyFetchedModels(p, list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const existing = new Map(p.models.map((m) => [m.id, m]));
  const fetchedIds = new Set(list.map((m) => m.id));
  const merged = list.map((m) => {
    const hit = existing.get(m.id);
    if (hit) return { ...hit, ...m, contextWindow: m.contextWindow ?? hit.contextWindow, input: m.input ?? hit.input, reasoning: m.reasoning ?? hit.reasoning, maxTokens: m.maxTokens ?? hit.maxTokens };
    return {
      id: m.id,
      name: m.name || m.id,
      reasoning: false,
      input: ["text"],
      ...m.contextWindow ? { contextWindow: m.contextWindow } : {},
      maxTokens: m.maxTokens ?? 16384,
      ...m.reasoning !== void 0 ? { reasoning: m.reasoning } : {},
      ...m.input ? { input: m.input } : {}
    };
  });
  for (const m of p.models) {
    if (!fetchedIds.has(m.id)) merged.push(m);
  }
  p.models = merged;
  return true;
}
function backfillPresetModels(p) {
  if (p.models.length > 0) return false;
  const preset = defaultProviders().find((d) => d.id === p.id);
  if (!preset || preset.models.length === 0) return false;
  p.models = preset.models.map((m) => ({ ...m }));
  return true;
}
function deepMerge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const baseVal = base[key];
    const patchVal = patch[key];
    if (baseVal && patchVal && typeof baseVal === "object" && typeof patchVal === "object" && !Array.isArray(baseVal) && !Array.isArray(patchVal)) {
      out[key] = deepMerge(baseVal, patchVal);
    } else if (patchVal !== void 0) {
      out[key] = patchVal;
    }
  }
  return out;
}
function mergePresetProviders(config) {
  const presets = new Map(defaultProviders().map((p) => [p.id, p]));
  const existing = new Set(config.providers.map((p) => p.id));
  for (const preset of defaultProviders()) {
    if (!existing.has(preset.id)) {
      config.providers.push(preset);
      existing.add(preset.id);
    }
  }
  for (const p of config.providers) {
    const preset = presets.get(p.id);
    if (preset && p.models.length === 0 && preset.models.length > 0) {
      p.models = preset.models.map((m) => ({ ...m }));
    }
  }
  const active = config.providers.find((p) => p.id === config.model.provider) ?? config.providers[0];
  if (active) {
    if (!active.models.some((m) => m.id === config.model.chat)) {
      config.model.chat = active.models[0]?.id ?? "";
    }
    if (!active.models.some((m) => m.id === config.model.vision)) {
      config.model.vision = (active.models.find((m) => m.input.includes("image")) ?? active.models[0])?.id ?? "";
    }
  }
}
function sanitizeProvider(p) {
  const clean = (s) => (typeof s === "string" ? s : "").replace(/[\u0000-\u001f\u007f]/g, "");
  p.id = clean(p.id).trim();
  p.name = clean(p.name).trim();
  p.baseUrl = clean(p.baseUrl).trim();
  p.apiKey = clean(p.apiKey).trim();
  p.api = clean(p.api).trim();
}
function loadConfig() {
  // One-shot C tool bridges must never migrate or rewrite the caller's config.
  const readOnly = process.env.DITO_CONFIG_READONLY === "1";
  const path = ditoConfigPath();
  let config = defaultConfig();
  let legacyChannels = {};
  let shouldRewritePublicConfig = false;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const legacyCompaction = raw.contextCompaction;
      if (legacyCompaction && typeof legacyCompaction === "object") {
        const migrated = { ...legacyCompaction };
        if (migrated.trimAtRatio === void 0 && migrated.thresholdRatio !== void 0) {
          migrated.trimAtRatio = migrated.thresholdRatio;
        }
        if (migrated.compactTailTokens === void 0) migrated.compactTailTokens = 16384;
        delete migrated.thresholdRatio;
        delete migrated.retainRatio;
        delete migrated.headroomTokens;
        raw.contextCompaction = migrated;
      }
      legacyChannels = raw.channels ?? {};
      shouldRewritePublicConfig = "qq" in legacyChannels || "matrix" in legacyChannels;
      const merged = deepMerge(defaultConfig(), raw);
      mergePresetProviders(merged);
      for (const p of merged.providers) sanitizeProvider(p);
      config = merged;
    } catch (err) {
      console.error(`[dito] 配置解析失败，使用默认配置：${err.message}`);
    }
  }
  if (!readOnly) migrateChannelData(ditoDataDir());
  for (const channel of ["qq", "matrix"]) {
    const channelPath = join(ditoChannelDir(channel), "config.json");
    if (existsSync(channelPath)) {
      const raw = JSON.parse(readFileSync(channelPath, "utf-8"));
      config.channels[channel] = deepMerge(config.channels[channel], raw);
    } else {
      const legacy = legacyChannels[channel];
      if (legacy && typeof legacy === "object") {
        config.channels[channel] = deepMerge(config.channels[channel], legacy);
      }
      if (!readOnly) writePrivateJson(channelPath, config.channels[channel]);
      shouldRewritePublicConfig = true;
    }
  }
  if (shouldRewritePublicConfig && !readOnly) {
    mkdirSync(ditoDataDir(), { recursive: true });
    writePrivateJson(ditoConfigPath(), { ...config, channels: { mobile: config.channels.mobile } });
  }
  config.plugins.memory = resolveMemoryConfig(config.plugins.memory);
  for (const p of config.providers) for (const model of p.models) {
    const metadata = getModelMetadata(p, model.id);
    if (metadata?.contextWindow) model.contextWindow = metadata.contextWindow;
    if (metadata?.maxTokens) model.maxTokens = metadata.maxTokens;
  }
  return config;
}
function saveConfig(config) {
  migrateChannelData(ditoDataDir());
  for (const channel of ["qq", "matrix"]) {
    writePrivateJson(join(ditoChannelDir(channel), "config.json"), config.channels[channel]);
  }
  mkdirSync(ditoDataDir(), { recursive: true });
  const publicConfig = { ...config, channels: { mobile: config.channels.mobile } };
  writePrivateJson(ditoConfigPath(), publicConfig);
}
function listFiles(dir, ext) {
  const ns = namespaceForDir(dir);
  if (ns && (hasPromptBundle() || process.env.DITO_DESKTOP === "1")) {
    const names = listEncryptedPromptNames(ns, ext);
    if (names.length > 0) return names;
    if (process.env.DITO_DESKTOP === "1") return [];
  }
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(ext)).map((entry) => entry.name.slice(0, -ext.length)).sort((a, b) => a.localeCompare(b, "zh"));
}
function readTextFile(dir, name, ext) {
  const ns = namespaceForDir(dir);
  if (ns && (hasPromptBundle() || process.env.DITO_DESKTOP === "1")) {
    const encrypted = readEncryptedPrompt(ns, `${name}${ext}`);
    if (encrypted !== null) return encrypted;
    if (process.env.DITO_DESKTOP === "1") return "";
  }
  const path = join(dir, `${name}${ext}`);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8").trim();
}
function readPersona(name) {
  return readTextFile(PERSONAS_DIR, name, ".md");
}
function readIdentity(name) {
  return readTextFile(IDENTITIES_DIR, name, ".md");
}
export {
  DITO_IS_ALPHA,
  DITO_VERSION,
  IDENTITIES_DIR,
  PERSONAS_DIR,
  ROOT_DIR,
  agentDir,
  applyFetchedModels,
  backfillPresetModels,
  defaultConfig,
  defaultProviders,
  ditoChannelDir,
  ditoConfigPath,
  ditoDataDir,
  ditoUserDir,
  fetchModelList,
  getModelMetadata,
  listFiles,
  loadConfig,
  providerRequestHeaders,
  readIdentity,
  readPersona,
  readTextFile,
  refreshProviderModelMetadata,
  resolveApiKey,
  saveConfig,
  scopedDataDir
};
