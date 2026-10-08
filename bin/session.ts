/**
 * Dito 会话共享工厂：终端 TUI（dito）与 Web UI（dito web）复用同一套会话创建逻辑。
 *
 * - 从 config.json 生成 models.json
 * - 按配置匹配供应商/模型，进行可用模型回退
 * - 建立持久化会话（默认续接全局最近一次对话）
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { buildDitoSystemPrompt } from "../extensions/persona.js";
import { setMemoryScope } from "../extensions/memory.js";
import { setKbScope } from "../extensions/knowledge-base.js";
import { bootDitoPlugins } from "../extensions/plugin-kernel.js";
import { DITO_PLUGINS } from "../extensions/plugins/index.js";
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";

import { applyRuntimeModelMetadata, isPiBuiltinProvider } from "../extensions/provider.js";
import { loadConfig, refreshProviderModelMetadata, resolveApiKey, type DitoConfig } from "../extensions/util.js";
import { registerContextCompaction, resolveCompactionBudget, resolveContextWindow } from "../extensions/context-compaction.js";

const DITO_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "dito");
const DITO_SESSIONS_DIR = join(DITO_DIR, "sessions");

/** 在全局会话目录里找最近一次会话文件（按修改时间）。 */
function findMostRecentSessionFile(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    files.sort((a, b) => statSync(join(dir, b)).mtime.getTime() - statSync(join(dir, a)).mtime.getTime());
    return join(dir, files[0]);
  } catch {
    return null;
  }
}

export interface SessionSummary {
  /** 会话文件绝对路径 */
  path: string;
  /** 会话开始时间（ms） */
  startedAt: number;
  /** user+assistant 消息条数 */
  messageCount: number;
  /** 第一条用户消息预览 */
  preview: string;
}

/** 从会话 jsonl 轻量提取：开始时间、消息条数、第一条用户消息（只 parse 必要的行）。 */
function summarizeSessionFile(path: string): SessionSummary | null {
  try {
    const stat = statSync(path);
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n");
    let startedAt = stat.mtime.getTime();
    let messageCount = 0;
    let preview = "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith(`{"type":"session"`)) {
        try {
          const head = JSON.parse(line) as { timestamp?: string };
          if (head.timestamp) startedAt = Date.parse(head.timestamp) || startedAt;
        } catch { /* 头行坏了就用 mtime */ }
        continue;
      }
      if (!line.includes(`"type":"message"`)) continue;
      const isUser = line.includes(`"role":"user"`);
      const isAssistant = line.includes(`"role":"assistant"`);
      if (!isUser && !isAssistant) continue;
      messageCount++;
      if (isUser && !preview) {
        try {
          const entry = JSON.parse(line) as { message?: { content?: unknown } };
          const content = entry.message?.content;
          const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
                  .map((b) => b.text ?? "")
                  .join(" ")
              : "";
          preview = text.replace(/\s+/g, " ").trim().slice(0, 60);
        } catch { /* 预览解析失败不影响列表 */ }
      }
    }
    return { path, startedAt, messageCount, preview };
  } catch {
    return null;
  }
}

/** 列出全部会话（按会话开始时间从新到旧）。
 *  用文件头里的 session timestamp 而非 mtime：打开会话会写入条目、mtime 会跳，
 *  按 mtime 排序会导致「上一个会话」在两个文件之间来回弹。 */
export function listSessions(): SessionSummary[] {
  try {
    const files = readdirSync(DITO_SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));
    const summaries = files
      .map((f) => summarizeSessionFile(join(DITO_SESSIONS_DIR, f)))
      .filter((s): s is SessionSummary => s !== null);
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries;
  } catch {
    return [];
  }
}

/** 解析会话管理器：指定文件打开；否则 fresh=true 开新会话、续接全局最近一次会话。
 *  sessionsDir 可为频道指定独立会话目录（与终端会话完全隔离）。 */
function resolveSessionManager(fresh: boolean, sessionFile?: string, sessionsDir?: string, ephemeral = false): SessionManager {
  const dir = sessionsDir ?? DITO_SESSIONS_DIR;
  if (ephemeral) return SessionManager.inMemory(process.cwd());
  mkdirSync(dir, { recursive: true });
  if (sessionFile) return SessionManager.open(sessionFile, dir, process.cwd());
  if (!fresh) {
    const recent = findMostRecentSessionFile(dir);
    if (recent) return SessionManager.open(recent, dir, process.cwd());
  }
  return SessionManager.create(process.cwd(), dir);
}

/**
 * Dito 扩展装配（终端与 Web 共用）。
 * 通过插件内核引导：内核只负责加载，能力全部由插件提供，
 * 是否加载由 config.plugins.<id>.enabled 决定。
 */
export function ditoExtensions(pi: ExtensionAPI): void {
  bootDitoPlugins(pi, DITO_PLUGINS);
}

/** 带插件过滤的扩展工厂：频道进程可以跳过面向终端的插件（如 system/mode）。 */
function makeExtensionFactory(skipPluginIds?: string[], settingsManager?: SettingsManager, cfg?: DitoConfig): (pi: ExtensionAPI) => void {
  return (pi) => {
    bootDitoPlugins(pi, DITO_PLUGINS.filter((p) => !skipPluginIds?.includes(p.id)));
    if (settingsManager && cfg) registerContextCompaction(pi, settingsManager, cfg.contextCompaction);
  };
}

/** 每次从 config.providers 重新生成 models.json，供应商/模型切换即时生效。
 *  disableThinking=true 时（频道进程专用文件），给当前聊天供应商的全部推理模型注入
 *  modelOverrides.thinkingLevelMap —— 各思考档位都映射为 reasoning_effort "none"，
 *  服务端不再产生推理 token。部分网关会把推理流进正文而非独立 thinking 事件，
 *  频道消息里出现思维链时用它从源头根治；终端不传，保持原行为。 */
export function buildModelsJson(disableThinking = false, cfg = loadConfig()): string {
  const providers: Record<string, unknown> = {};
  for (const p of cfg.providers) {
    if (isPiBuiltinProvider(p.id)) {
      const entry: Record<string, unknown> = { name: p.name || p.id };
      const key = resolveApiKey(p.apiKey).trim();
      if (key) entry.apiKey = key;
      // 内置供应商保留 pi 自带的模型细节（compat/thinkingLevelMap 等），
      // 只把 config 里新增的自定义模型合并进 models.json，避免覆盖官方模型。
      let builtinIds = new Set<string>();
      try {
        const builtinModels = getBuiltinModels(p.id as BuiltinProvider);
        builtinIds = new Set(builtinModels.map((m) => m.id));
        const customModels = p.models.filter((m) => !builtinIds.has(m.id));
        if (customModels.length > 0) {
          entry.models = customModels.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            reasoning: m.reasoning,
            input: m.input,
            ...(Number.isFinite(resolveContextWindow(m.contextWindow)) ? { contextWindow: m.contextWindow } : {}),
            maxTokens: m.maxTokens || 16384,
            ...(m.api ? { api: m.api } : {}),
            ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
            ...(m.cost ? { cost: m.cost } : {}),
          }));
        }
      } catch {
        // 未知/动态内置供应商：退回只写鉴权，行为与之前一致。
      }
      if (disableThinking && p.id === cfg.model.provider) {
        const none = { minimal: "none", low: "none", medium: "none", high: "none" };
        const overrides: Record<string, { thinkingLevelMap: typeof none }> = {};
        try {
          for (const m of getBuiltinModels(p.id as BuiltinProvider)) {
            if (m.reasoning) overrides[m.id] = { thinkingLevelMap: none };
          }
        } catch {
          /* 目录不可用时下面兜底覆盖 config 里的模型 */
        }
        for (const m of p.models) if (m.reasoning) overrides[m.id] = { thinkingLevelMap: none };
        if (Object.keys(overrides).length > 0) entry.modelOverrides = overrides;
      }
      providers[p.id] = entry;
      continue;
    }
    const resolvedKey = resolveApiKey(p.apiKey);
    const entry: Record<string, unknown> = {
      baseUrl: p.baseUrl,
      apiKey: resolvedKey === "" ? " " : resolvedKey,
      api: p.api || "openai-completions",
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        reasoning: m.reasoning,
        input: m.input,
        ...(Number.isFinite(resolveContextWindow(m.contextWindow)) ? { contextWindow: m.contextWindow } : {}),
        maxTokens: m.maxTokens || 16384,
        ...(m.api ? { api: m.api } : {}),
        ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
        ...(m.cost ? { cost: m.cost } : {}),
      })),
    };
    if (disableThinking && p.id === cfg.model.provider) {
      const none = { minimal: "none", low: "none", medium: "none", high: "none" };
      const overrides: Record<string, { thinkingLevelMap: typeof none }> = {};
      for (const m of p.models) if (m.reasoning) overrides[m.id] = { thinkingLevelMap: none };
      if (Object.keys(overrides).length > 0) entry.modelOverrides = overrides;
    }
    providers[p.id] = entry;
  }
  return JSON.stringify({ providers }, null, 2);
}

export function writeModelsJson(cfg = loadConfig()): void {
  mkdirSync(DITO_DIR, { recursive: true });
  writeFileSync(join(DITO_DIR, "models.json"), buildModelsJson(false, cfg));
}

export interface TuiSession {
  /** 自定义界面必须显式绑定，SDK 会话默认只有无交互的 UI。 */
  bindExtensions: AgentSession["bindExtensions"];
  readonly extensionRunner: Pick<AgentSession["extensionRunner"], "getUIContext">;
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<unknown>;
  subscribe(cb: (event: unknown) => void): () => void;
  dispose(): void;
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
  setThinkingLevel(level: string): void;
  /** 手动压缩当前会话上下文。 */
  compact(customInstructions?: string): Promise<unknown>;
  /** 是否有任务在跑（流式输出中）。 */
  readonly isStreaming: boolean;
  /** 当前上下文估算；压缩后尚未收到下一次模型响应时 percent 可能为空。 */
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  /** 中断当前任务（pi AgentSession.abort）。 */
  abort(): Promise<void>;
  /** 当前会话文件路径（新会话在落盘前为 undefined）。 */
  readonly sessionFile: string | undefined;
  /** 全部历史消息（含恢复的会话），供 TUI 渲染历史。 */
  readonly messages: unknown[];
}

export interface SessionBundle {
  session: TuiSession;
  modelName: string;
  providerId: string;
  modelId: string;
}

/**
 * 创建 Dito 会话。
 * - options.fresh：开新会话（否则续接全局最近一次对话）
 * - options.sessionFile：打开指定会话文件（tab+a / tab+w 切换会话用）
 * - options.extraExtensions：进程级附加扩展（QQ/Matrix 频道用它注册频道专属工具）
 * - options.systemPrompt：覆盖默认系统提示词（频道传自己的场景提示词）
 * - options.skipPluginIds：跳过指定插件（频道进程跳过面向终端的注入）
 * 返回会话句柄 + 当前模型名。启动失败（无可用模型）会抛错。
 */
export interface CreateSessionOptions {
  fresh?: boolean;
  sessionFile?: string;
  extraExtensions?: ((pi: ExtensionAPI) => void)[];
  systemPrompt?: string;
  skipPluginIds?: string[];
  /** 独立会话目录（频道用，避免与终端会话互相污染） */
  sessionsDir?: string;
  /** 每聊天的记忆库 scope（频道用，记忆按会话隔离） */
  /** 每聊天的记忆/知识库 scope（频道用，记忆与上传按会话隔离） */
  memoryScope?: string;
  /** 关闭模型思考：把思考档位映射为 reasoning_effort "none"（频道用——
   *  部分网关会把推理流进正文而非独立 thinking 事件，关掉思考从源头根治思维链外泄） */
  disableThinking?: boolean;
  /** 子代理使用的明确模型，支持 provider/model 或模型 id；留空沿用主代理配置。 */
  model?: string;
  /** 子代理临时会话不落盘。 */
  ephemeral?: boolean;
}

let createQueue: Promise<unknown> = Promise.resolve();

/**
 * 创建 Dito 会话（串行化：memoryScope 等进程级状态只在创建窗口内生效）。
 * - fresh：开新会话（否则续接全局最近一次对话）
 * - sessionFile：打开指定会话文件（频道/会话切换用）
 * - extraExtensions：进程级附加扩展（频道注册专属工具）
 * - systemPrompt：覆盖默认系统提示词
 * - skipPluginIds：跳过指定插件
 */
export async function createSession(options: CreateSessionOptions = {}): Promise<SessionBundle> {
  const queued = createQueue.then(() => runCreate(options), () => runCreate(options));
  createQueue = queued.catch(() => {});
  return queued;
}

async function runCreate(options: CreateSessionOptions): Promise<SessionBundle> {
  setMemoryScope(options.memoryScope);
  setKbScope(options.memoryScope);
  try {
    return await createSessionInner(options);
  } finally {
    setMemoryScope(undefined);
    setKbScope(undefined);
  }
}

async function createSessionInner(options: CreateSessionOptions): Promise<SessionBundle> {
  const cfg = loadConfig();
  const requestedProvider = options.model?.split("/")[0];
  await Promise.all(cfg.providers.filter((p) => p.id === cfg.model.provider || p.id === requestedProvider).map(refreshProviderModelMetadata));
  writeModelsJson(cfg);

  // 频道关闭思考：用带 modelOverrides 的独立 models 文件建运行时。
  // 覆盖必须走配置层——会话启动时 pi 会用注册表对象刷新 agent 的 model，
  // 直接改内存里的模型对象会被冲掉。
  let modelsPath = join(DITO_DIR, "models.json");
  if (options.disableThinking) {
    modelsPath = join(DITO_DIR, "models-channel.json");
    writeFileSync(modelsPath, buildModelsJson(true, cfg));
  }

  const modelRuntime = await ModelRuntime.create({
    modelsPath,
    // 复用 pi 的共享鉴权文件（~/.pi/agent/auth.json）
    authPath: join(getAgentDir(), "auth.json"),
  });
  applyRuntimeModelMetadata({ getAll: () => [...modelRuntime.getModels()], registerProvider: (id, config) => modelRuntime.registerProvider(id, config) }, cfg);

  const available = await modelRuntime.getAvailable();
  const providerCfg = cfg.providers.find((p) => p.id === cfg.model.provider);

  const requestedModel = options.model?.trim();
  let model = requestedModel
    ? available.find((m) => `${m.provider}/${m.id}` === requestedModel || m.id === requestedModel || m.name === requestedModel)
    : available.find((m) => m.provider === cfg.model.provider && m.id === cfg.model.chat);

  if (!model) {
    const providerAvailable = available.filter((m) => m.provider === cfg.model.provider);
    model = providerAvailable[0];
    if (!model) {
      const base = cfg.model.chat.replace(/-free$/, "");
      model =
        available.find((m) => m.id === cfg.model.chat) ??
        available.find((m) => m.id === `${base}-pro`) ??
        available.find((m) => m.id.startsWith(base)) ??
        available.find((m) => m.id === `${base}-free`);
    }
    if (!model) model = available[0];
  }

  if (!model) {
    throw new Error("没有可用模型。请检查 API Key 或稍后重试（opencode 免费额度可能限流）。");
  }

  // pi 原生负责摘要、切分、会话落盘和溢出重试；Dito 只把 laozhou 的
  // 窗口水位和固定尾部策略换算成 pi 的 token 预算，避免写入全局设置。
  const settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
  const compaction = resolveCompactionBudget(model, cfg.contextCompaction);

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    extensionFactories: [makeExtensionFactory(options.skipPluginIds, settingsManager, cfg), ...(options.extraExtensions ?? [])],
    systemPrompt: options.systemPrompt ?? buildDitoSystemPrompt(),
  });
  await resourceLoader.reload();
  // resourceLoader.reload() refreshes settings from disk, so apply the Dito
  // runtime override afterwards and keep the user's global settings untouched.
  settingsManager.applyOverrides({
    compaction: {
      enabled: compaction.enabled,
      reserveTokens: compaction.reserveTokens,
      keepRecentTokens: compaction.keepRecentTokens,
    },
  });

  const sessionManager = resolveSessionManager(!!options.fresh, options.sessionFile, options.sessionsDir, options.ephemeral);

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "minimal",
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  return {
    session: session as unknown as TuiSession,
    modelName: model.name || model.id,
    providerId: model.provider,
    modelId: model.id,
  };
}

/** 会话 JSONL 里的单条对话消息（user/assistant，空文本已剔除） */
export interface SessionTurn {
  role: "user" | "assistant";
  text: string;
  ts?: string;
}

/** 解析会话 JSONL 为对话消息列表（只保留 user/assistant 的文本部分，取最后 limit 条）。
 *  手机频道等远端用它做历史回放，无需打开完整会话。 */
export function parseSessionTurns(file: string, limit = 200): SessionTurn[] {
  const turns: SessionTurn[] = [];
  try {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string };
        if (e.type !== "message" || !e.message?.role) continue;
        if (e.message.role !== "user" && e.message.role !== "assistant") continue;
        const content = e.message.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content
            .map((c) => ((c as { type?: string; text?: string }).type === "text" ? (c as { text?: string }).text ?? "" : ""))
            .join("\n");
        }
        text = text.trim();
        if (!text) continue;
        turns.push({ role: e.message.role, text, ts: e.timestamp });
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    return [];
  }
  return turns.slice(-limit);
}

/** 模型回退的详细原因（用于在 Web UI 顶部提示）。 */
export async function describeModelSelection(): Promise<{ modelName: string; providerId: string; modelId: string; fallbackNotice: string | null }> {
  const cfg = loadConfig();
  const provider = cfg.providers.find((p) => p.id === cfg.model.provider);
  if (provider) await refreshProviderModelMetadata(provider);
  writeModelsJson(cfg);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: join(DITO_DIR, "models.json"),
    authPath: join(getAgentDir(), "auth.json"),
  });
  const available = await modelRuntime.getAvailable();
  const configuredModel = available.find((m) => m.provider === cfg.model.provider && m.id === cfg.model.chat);
  let notice: string | null = null;
  let model = configuredModel;
  if (!model) {
    const providerAvailable = available.filter((m) => m.provider === cfg.model.provider);
    model = providerAvailable[0];
    if (!model) {
      const base = cfg.model.chat.replace(/-free$/, "");
      model =
        available.find((m) => m.id === cfg.model.chat) ??
        available.find((m) => m.id === `${base}-pro`) ??
        available.find((m) => m.id.startsWith(base)) ??
        available.find((m) => m.id === `${base}-free`);
    }
    if (!model) model = available[0];
    const providerCfg = cfg.providers.find((p) => p.id === cfg.model.provider);
    if (providerAvailable.length === 0 && providerCfg) {
      const envMatch = providerCfg.apiKey.match(/\$\{?([A-Z0-9_]+)\}?/);
      notice = envMatch
        ? `供应商「${providerCfg.name}」需要 API Key，但环境变量 ${envMatch[1]} 未设置`
        : `供应商「${providerCfg.name}」无可用模型（可能未鉴权）`;
    } else {
      notice = `模型「${cfg.model.chat}」在供应商「${providerCfg?.name || cfg.model.provider}」中不可用`;
    }
    if (notice && model) notice += `，改用 ${model.provider}/${model.name || model.id}`;
  }
  return {
    modelName: model?.name || model?.id || "",
    providerId: model?.provider || "",
    modelId: model?.id || "",
    fallbackNotice: notice,
  };
}

// ── 频道聊天会话（QQ / Matrix）───────────────────────────────────

interface ChannelIndex {
  [chatKey: string]: string;
}

/**
 * 按聊天 key 复用或新建一个频道会话。
 * 映射关系（聊天 key → 会话文件）持久化在 indexFile，进程重启后能接着聊。
 * forceNew=true（/whatnew 开新对话）：丢弃旧映射重开全新会话，旧会话文件保留作历史。
 */
export async function openChannelSession(
  indexFile: string,
  chatKey: string,
  extraExtensions?: ((pi: ExtensionAPI) => void)[],
  sessionOptions?: CreateSessionOptions,
  forceNew = false,
): Promise<SessionBundle> {
  let index: ChannelIndex = {};
  try {
    index = JSON.parse(readFileSync(indexFile, "utf-8")) as ChannelIndex;
  } catch {
    /* 首次使用或文件损坏，从空映射开始 */
  }
  const known = forceNew ? undefined : index[chatKey];
  if (known) {
    try {
      return await createSession({ sessionFile: known, extraExtensions, ...sessionOptions });
    } catch (err) {
      console.error(`[dito] 会话文件打开失败（${known}），改开新会话：`, (err as Error).message);
    }
  }
  if (forceNew && index[chatKey]) {
    delete index[chatKey];
    mkdirSync(dirname(indexFile), { recursive: true });
    writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf-8");
  }
  const created = await createSession({ fresh: true, extraExtensions, ...sessionOptions });
  const file = created.session.sessionFile;
  if (file) {
    index[chatKey] = file;
    mkdirSync(dirname(indexFile), { recursive: true });
    writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf-8");
  }
  return created;
}
