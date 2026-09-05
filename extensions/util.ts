/**
 * Dito 工具函数：路径解析、配置读写、人设/身份文件读取。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { hasPromptBundle, listEncryptedPromptNames, namespaceForDir, readEncryptedPrompt } from "./prompt-crypto.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 包根目录（extensions/ 的上一级） */
export const ROOT_DIR = join(__dirname, "..");
export const PERSONAS_DIR = join(ROOT_DIR, "personas");
export const IDENTITIES_DIR = join(ROOT_DIR, "identities");

/** 用户可写目录：~/.pi/agent/dito/ */
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
export function ditoDataDir(): string {
  return join(agentDir(), "dito");
}
export function ditoConfigPath(): string {
  return join(ditoDataDir(), "config.json");
}

export interface ProviderModelConfig {
  id: string;
  name?: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  /** 模型级 API 类型覆盖（可选，默认继承供应商 api） */
  api?: string;
  /** 模型级 baseUrl 覆盖（可选，默认继承供应商 baseUrl），用于单一供应商多端点（如 opencode-go）。 */
  baseUrl?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  models: ProviderModelConfig[];
}

export interface QqChannelConfig {
  enabled: boolean;
  /** SnowLuma OneBot WebSocket 地址（config/onebot_<uin>.json 里的端口） */
  url: string;
  accessToken: string;
  /** SnowLuma 未运行时自动拉起的启动命令（如 "/opt/snowluma/snowluma"）；空 = 不自动拉起 */
  command: string;
  /** dito qq 时自动拉起 SnowLuma（探测到已在运行则跳过） */
  autoStart: boolean;
  /** 允许响应的群号列表；空 = 不响应任何群聊（私聊不受影响） */
  groups: number[];
  /** 主人 QQ 列表：这些号的私聊拥有全部能力（含电脑控制），其余会话受限 */
  owners: number[];
  /** 群聊唤醒词：留空 = 群聊每条消息都回应；填了关键词则只有命中的消息回应。私聊不受限 */
  wakeKeywords: string[];
  /** 普通群聊消息的文字回复概率（0-1，默认 0.2）；被唤醒（@/唤醒词）时必答 */
  groupReplyChance: number;
  /** 自动表情回应：每条群消息到达时按情绪自动贴一个表情 */
  autoReact: boolean;
  /** 每次回复附带随机表情包的概率（0-1，默认 0.3；库空时自动跳过） */
  memeChance: number;
  /** 是否响应私聊 */
  friends: boolean;
  /** 被戳一戳时戳回去 */
  pokeBack: boolean;
  /** 自动同意好友/群邀请（默认关，请求只打日志） */
  autoApprove: boolean;
}

export interface MatrixChannelConfig {
  enabled: boolean;
  homeserver: string;
  /** Element 里：设置 → 帮助与关于 → 高级 → Access Token */
  accessToken: string;
  /** 允许响应的房间 ID；空 = 所有已加入房间 */
  rooms: string[];
}

export interface DitoConfig {
  version: number;
  model: {
    provider: string;
    chat: string;
    vision: string;
  };
  providers: ProviderConfig[];
  persona: {
    active: string;
    identity: string;
  };
  /** 外部聊天频道：QQ（SnowLuma OneBot）与 Matrix */
  channels: {
    qq: QqChannelConfig;
    matrix: MatrixChannelConfig;
  };
  plugins: {
    provider: { enabled: boolean };
    persona: { enabled: boolean };
    system: { enabled: boolean };
    mode: { enabled: boolean };
    knowledge_base: { enabled: boolean; dataDir: string };
    memory: { enabled: boolean; autoDiary: boolean };
    web_search: {
      enabled: boolean;
      tavilyKeys: string[];
      firecrawlKeys: string[];
      anysearchKeys: string[];
      exaKeys: string[];
      perplexityKey: string;
      searxngUrl: string;
    };
    voice: {
      enabled: boolean;
      wakeWord: string;
      stt: string;
      tts: string;
      whisperModel: string;
      whisperLanguage: string;
      espeakVoice: string;
      piperModel: string;
      piperConfig: string;
      xiaomiApiKey: string;
      xiaomiBaseUrl: string;
      xiaomiAsrModel: string;
      xiaomiTtsModel: string;
      xiaomiTtsVoice: string;
      /** MiMo 声音设计：填音色描述（如「年轻女性，清脆甜美」）即用 voicedesign 模型；留空用 preset 音色 */
      xiaomiTtsVoiceDesign: string;
      maxRecordSeconds: number;
      autoListenAfterQuestion: boolean;
      continuous: boolean;
      customSttCommand: string;
      customTtsCommand: string;
    };
    permission: {
      enabled: boolean;
      /** sudo 权限模式：开启后权限门关闭，Dito 拥有 sudo 权限（需要 root 的命令自动加 sudo）。 */
      sudoMode: boolean;
      /** 自动为需要 root 权限的命令加 sudo（仅 sudoMode 开启时生效）。 */
      autoSudo: boolean;
      /** 提权命令，默认 sudo；可改成 doas / sudo -n 等。 */
      sudoCommand: string;
    };
    ask: { enabled: boolean };
    snowluma: { enabled: boolean };
  };
}

export function defaultProviders(): ProviderConfig[] {
  return [
    {
      id: "opencode-free",
      name: "OpenCode 免费 (Zen)",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: " ",
      api: "openai-completions",
      models: [
        { id: "big-pickle", name: "Big Pickle（免费）", reasoning: true, input: ["text"], contextWindow: 272000, maxTokens: 16384 },
        { id: "mimo-v2.5-free", name: "MiMo v2.5（免费·视觉）", reasoning: false, input: ["text", "image"], contextWindow: 272000, maxTokens: 16384 },
      ],
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "$OPENCODE_API_KEY",
      api: "openai-completions",
      models: [
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 384000 },
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 384000 },
        { id: "kimi-k3", name: "Kimi K3", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072 },
        { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 262144 },
        { id: "kimi-k2.6", name: "Kimi K2.6", reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },
        { id: "glm-5.2", name: "GLM-5.2", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 131072 },
        { id: "mimo-v2.5", name: "MiMo V2.5", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000 },
        { id: "minimax-m2.7", name: "MiniMax-M2.7", reasoning: true, input: ["text"], contextWindow: 204800, maxTokens: 131072 },
        { id: "qwen3.6-plus", name: "Qwen3.6 Plus", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 65536 },
        // anthropic-messages 端点（/zen/go 无 /v1）
        { id: "qwen3.8-max", name: "Qwen3.8 Max", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 131072, api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" },
        { id: "qwen3.7-max", name: "Qwen3.7 Max", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 65536, api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" },
        { id: "minimax-m3", name: "MiniMax-M3", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 131072, api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" },
        // openai-responses 端点（/zen/go/v1）
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true, input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000, api: "openai-responses" },
      ],
    },
    {
      id: "deepseek",
      name: "DeepSeek（官方·国内直连）",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "$DEEPSEEK_API_KEY",
      api: "openai-completions",
      models: [
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 384000 },
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 384000 },
      ],
    },
    {
      id: "zhipu",
      name: "智谱 GLM（BigModel）",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "$ZHIPUAI_API_KEY",
      api: "openai-completions",
      models: [
        { id: "glm-5.3-flash", name: "GLM-5.3-Flash（闪存·快）", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16384 },
        { id: "glm-4-flash", name: "GLM-4-Flash（免费）", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384 },
        { id: "glm-4v-flash", name: "GLM-4V-Flash（免费·视觉）", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
        { id: "glm-5.2", name: "GLM-5.2（旗舰）", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16384 },
      ],
    },
    {
      id: "dashscope",
      name: "阿里云百炼 Qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "$DASHSCOPE_API_KEY",
      api: "openai-completions",
      models: [
        { id: "qwen-turbo", name: "Qwen Turbo", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
        { id: "qwen-plus", name: "Qwen Plus", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
        { id: "qwen-max", name: "Qwen Max", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 8192 },
        { id: "qwen-vl-plus", name: "Qwen VL Plus（视觉）", reasoning: false, input: ["text", "image"], contextWindow: 32768, maxTokens: 4096 },
      ],
    },
    {
      id: "moonshot",
      name: "月之暗面 Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "$MOONSHOT_API_KEY",
      api: "openai-completions",
      models: [
        { id: "kimi-latest", name: "Kimi Latest", reasoning: true, input: ["text", "image"], contextWindow: 131072, maxTokens: 16384 },
        { id: "moonshot-v1-128k", name: "Moonshot V1 128K", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
        { id: "kimi-k2-0711-preview", name: "Kimi K2（推理）", reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },
      ],
    },
    {
      id: "siliconflow",
      name: "硅基流动 SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "$SILICONFLOW_API_KEY",
      api: "openai-completions",
      models: [
        { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek-V3", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 8192 },
        { id: "Qwen/Qwen2.5-7B-Instruct", name: "Qwen2.5-7B（免费）", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 8192 },
        { id: "THUDM/glm-4-9b-chat", name: "GLM-4-9B（免费）", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 8192 },
        { id: "Qwen/Qwen3-235B-A22B-Instruct", name: "Qwen3-235B（推理）", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 16384 },
      ],
    },
    {
      id: "volcengine",
      name: "火山方舟 豆包",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "$ARK_API_KEY",
      api: "openai-completions",
      models: [
        { id: "doubao-seed-1-6-250615", name: "Doubao Seed 1.6", reasoning: false, input: ["text"], contextWindow: 262144, maxTokens: 16384 },
        { id: "doubao-1-5-pro-32k-250115", name: "Doubao 1.5 Pro 32K", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096 },
        { id: "doubao-1-5-vision-pro-32k-250115", name: "Doubao 1.5 Vision Pro（视觉）", reasoning: false, input: ["text", "image"], contextWindow: 32768, maxTokens: 4096 },
      ],
    },
    {
      id: "anthropic",
      name: "Anthropic Claude",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "$ANTHROPIC_API_KEY",
      api: "anthropic-messages",
      models: [
        { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 },
        { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
      ],
    },
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "$OPENAI_API_KEY",
      api: "openai-completions",
      models: [
        { id: "gpt-4o", name: "GPT-4o", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
        { id: "gpt-4o-mini", name: "GPT-4o mini", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
      ],
    },
    {
      id: "ollama",
      name: "Ollama (本地)",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
      api: "openai-completions",
      models: [
        { id: "qwen2.5:7b", name: "Qwen2.5 7B", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 },
      ],
    },
  ];
}

export function defaultConfig(): DitoConfig {
  return {
    version: 1,
    model: { provider: "opencode-free", chat: "big-pickle", vision: "mimo-v2.5-free" },
    providers: defaultProviders(),
    persona: { active: "dito", identity: "默认" },
    channels: {
      qq: {
        enabled: false,
        url: "ws://127.0.0.1:3001",
        accessToken: "",
        command: "",
        autoStart: true,
        owners: [1471048379],
        wakeKeywords: [],
        groupReplyChance: 0.2,
        autoReact: true,
        memeChance: 0.3,
        groups: [],
        friends: true,
        pokeBack: true,
        autoApprove: false,
      },
      matrix: {
        enabled: false,
        homeserver: "https://matrix.org",
        accessToken: "",
        rooms: [],
      },
    },
    plugins: {
      provider: { enabled: true },
      persona: { enabled: true },
      system: { enabled: true },
      mode: { enabled: true },
      knowledge_base: { enabled: true, dataDir: "" },
      memory: { enabled: true, autoDiary: true },
      web_search: {
        enabled: true,
        tavilyKeys: [],
        firecrawlKeys: [],
        anysearchKeys: [],
        exaKeys: [],
        perplexityKey: "",
        searxngUrl: "",
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
        customTtsCommand: "",
      },
      permission: { enabled: true, sudoMode: false, autoSudo: true, sudoCommand: "sudo" },
      ask: { enabled: true },
      snowluma: { enabled: true },
    },
  };
}

/** 解析 apiKey：支持 $ENV / ${ENV} 引用与字面量；空白 key 返回空（免鉴权）。 */
export function resolveApiKey(key: string): string {
  const k = key.trim();
  if (k === "") return "";
  if (k.startsWith("${") && k.endsWith("}")) return process.env[k.slice(2, -1)] ?? "";
  if (k.startsWith("$")) return process.env[k.slice(1)] ?? "";
  return k;
}

export interface ModelInfo {
  id: string;
  name: string;
}

/** 从供应商 API 拉取模型列表（GET {baseUrl}/models，OpenAI/Anthropic 兼容）。 */
export async function fetchModelList(p: ProviderConfig): Promise<ModelInfo[]> {
  const base = p.baseUrl.trim().replace(/\/+$/, "");
  if (!base) return [];
  const headers: Record<string, string> = {};
  const key = resolveApiKey(p.apiKey);
  if (p.api === "anthropic-messages") {
    if (key) {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    }
  } else if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  const resp = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) return [];
  const json = (await resp.json()) as {
    data?: { id: string; display_name?: string; name?: string }[];
    models?: { id: string; name?: string }[];
  };
  const arr = json.data ?? json.models ?? [];
  return arr.map((m) => ({ id: m.id, name: m.display_name || m.name || m.id }));
}

/** 把 API 拉到的模型列表合并进供应商配置：以拉取结果为主、保留列表外已有模型。
 *  空列表（接口失败/无 Key）绝不覆盖现有模型——旧版刷新曾因此把模型列表清空。 */
export function applyFetchedModels(p: ProviderConfig, list: ModelInfo[]): boolean {
  if (!Array.isArray(list) || list.length === 0) return false;
  const existing = new Map(p.models.map((m) => [m.id, m]));
  const fetchedIds = new Set(list.map((m) => m.id));
  const merged: ProviderModelConfig[] = list.map((m) => {
    const hit = existing.get(m.id);
    if (hit) return hit;
    return {
      id: m.id,
      name: m.name || m.id,
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
    };
  });
  for (const m of p.models) {
    if (!fetchedIds.has(m.id)) merged.push(m);
  }
  p.models = merged;
  return true;
}

/** 供应商还没有任何模型时，用内置预置模型兜底（仅对预置 id 生效）。 */
export function backfillPresetModels(p: ProviderConfig): boolean {
  if (p.models.length > 0) return false;
  const preset = defaultProviders().find((d) => d.id === p.id);
  if (!preset || preset.models.length === 0) return false;
  p.models = preset.models.map((m) => ({ ...m }));
  return true;
}

/** 深合并：config 优先覆盖默认值 */
function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out: T = { ...base };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const baseVal = base[key];
    const patchVal = patch[key];
    if (
      baseVal &&
      patchVal &&
      typeof baseVal === "object" &&
      typeof patchVal === "object" &&
      !Array.isArray(baseVal) &&
      !Array.isArray(patchVal)
    ) {
      out[key] = deepMerge(baseVal, patchVal as never) as never;
    } else if (patchVal !== undefined) {
      out[key] = patchVal as never;
    }
  }
  return out;
}

/** 把内置预置供应商中用户尚未配置的追加到配置（让老配置文件自动获得新增供应商，如 opencode-go）。
 *  同时自愈两类历史问题：预置供应商的模型列表被旧版刷新清空 → 用预置模型兜底；
 *  chat/vision 指向不存在的模型（或为空）→ 落回该供应商的可用模型。 */
function mergePresetProviders(config: DitoConfig): void {
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

/** 清洗配置里的不可见控制字符（如终端粘贴误入的 \x16/Ctrl+V），它们会让 fetch 直接 ERR_INVALID_URL。 */
function sanitizeProvider(p: ProviderConfig): void {
  const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, "");
  p.id = clean(p.id).trim();
  p.name = clean(p.name).trim();
  p.baseUrl = clean(p.baseUrl).trim();
  p.apiKey = clean(p.apiKey).trim();
  p.api = clean(p.api).trim();
}

export function loadConfig(): DitoConfig {
  const path = ditoConfigPath();
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<DitoConfig>;
      const merged = deepMerge(defaultConfig(), raw);
      // 按 id 合并供应商：保留用户已有配置，追加预置里新增的供应商（而非整体替换）。
      mergePresetProviders(merged);
      for (const p of merged.providers) sanitizeProvider(p);
      return merged;
    } catch (err) {
      console.error(`[dito] 配置解析失败，使用默认配置：${(err as Error).message}`);
    }
  }
  return defaultConfig();
}

export function saveConfig(config: DitoConfig): void {
  mkdirSync(ditoDataDir(), { recursive: true });
  writeFileSync(ditoConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

/** 列出目录下的某个扩展名文件（去掉扩展名，按文件名排序）。若存在加密提示词包，优先返回加密包内的名称。 */
export function listFiles(dir: string, ext: string): string[] {
  const ns = namespaceForDir(dir);
  if (ns && (hasPromptBundle() || process.env.DITO_DESKTOP === "1")) {
    const names = listEncryptedPromptNames(ns, ext);
    if (names.length > 0) return names;
    if (process.env.DITO_DESKTOP === "1") return [];
  }
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => entry.name.slice(0, -ext.length))
    .sort((a, b) => a.localeCompare(b, "zh"));
}

/** 读取人设/身份文件内容（去掉开头和结尾空行）。若存在加密提示词包，优先解密读取。 */
export function readTextFile(dir: string, name: string, ext: string): string {
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

export function readPersona(name: string): string {
  return readTextFile(PERSONAS_DIR, name, ".md");
}

export function readIdentity(name: string): string {
  return readTextFile(IDENTITIES_DIR, name, ".md");
}
