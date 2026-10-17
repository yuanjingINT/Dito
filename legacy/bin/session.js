import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import { buildDitoSystemPrompt } from "../extensions/persona.js";
import { withToolBudget } from "../extensions/tool-budget.js";
import { setMemoryScope } from "../extensions/memory.js";
import { setKbScope } from "../extensions/knowledge-base.js";
import { bootDitoPlugins } from "../extensions/plugin-kernel.js";
import { DITO_PLUGINS } from "../extensions/plugins/index.js";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { applyRuntimeModelMetadata, isPiBuiltinProvider } from "../extensions/provider.js";
import { loadConfig, refreshProviderModelMetadata, resolveApiKey } from "../extensions/util.js";
import { registerContextCompaction, resolveCompactionBudget, resolveContextWindow } from "../extensions/context-compaction.js";
const DITO_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "dito");
const DITO_SESSIONS_DIR = join(DITO_DIR, "sessions");
function findMostRecentSessionFile(dir) {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    files.sort((a, b) => statSync(join(dir, b)).mtime.getTime() - statSync(join(dir, a)).mtime.getTime());
    return join(dir, files[0]);
  } catch {
    return null;
  }
}
function summarizeSessionFile(path) {
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
          const head = JSON.parse(line);
          if (head.timestamp) startedAt = Date.parse(head.timestamp) || startedAt;
        } catch {
        }
        continue;
      }
      if (!line.includes(`"type":"message"`)) continue;
      const isUser = line.includes(`"role":"user"`);
      const isAssistant = line.includes(`"role":"assistant"`);
      if (!isUser && !isAssistant) continue;
      messageCount++;
      if (isUser && !preview) {
        try {
          const entry = JSON.parse(line);
          const content = entry.message?.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b?.type === "image" ? "[图片]" : b?.type === "text" ? b.text ?? "" : "").join(" ") : "";
          preview = text.replace(/\s+/g, " ").trim().slice(0, 60);
        } catch {
        }
      }
    }
    return { path, startedAt, messageCount, preview };
  } catch {
    return null;
  }
}
function listSessions() {
  try {
    const files = readdirSync(DITO_SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));
    const summaries = files.map((f) => summarizeSessionFile(join(DITO_SESSIONS_DIR, f))).filter((s) => s !== null);
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries;
  } catch {
    return [];
  }
}
function resolveSessionManager(fresh, sessionFile, sessionsDir, ephemeral = false) {
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
function ditoExtensions(pi) {
  bootDitoPlugins(pi, DITO_PLUGINS);
}
function makeExtensionFactory(skipPluginIds, settingsManager, cfg) {
  return (pi) => {
    bootDitoPlugins(pi, DITO_PLUGINS.filter((p) => !skipPluginIds?.includes(p.id)));
    if (settingsManager && cfg) registerContextCompaction(pi, settingsManager, cfg.contextCompaction);
  };
}
function buildModelsJson(disableThinking = false, cfg = loadConfig()) {
  const providers = {};
  for (const p of cfg.providers) {
    if (isPiBuiltinProvider(p.id)) {
      const entry2 = { name: p.name || p.id };
      const key = resolveApiKey(p.apiKey).trim();
      if (key) entry2.apiKey = key;
      let builtinIds = /* @__PURE__ */ new Set();
      try {
        const builtinModels = getBuiltinModels(p.id);
        builtinIds = new Set(builtinModels.map((m) => m.id));
        const customModels = p.models.filter((m) => !builtinIds.has(m.id));
        if (customModels.length > 0) {
          entry2.models = customModels.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            reasoning: m.reasoning,
            input: m.input,
            ...Number.isFinite(resolveContextWindow(m.contextWindow)) ? { contextWindow: m.contextWindow } : {},
            maxTokens: m.maxTokens || 16384,
            ...m.api ? { api: m.api } : {},
            ...m.baseUrl ? { baseUrl: m.baseUrl } : {},
            ...m.cost ? { cost: m.cost } : {}
          }));
        }
      } catch {
      }
      if (disableThinking && p.id === cfg.model.provider) {
        const none = { minimal: "none", low: "none", medium: "none", high: "none" };
        const overrides = {};
        try {
          for (const m of getBuiltinModels(p.id)) {
            if (m.reasoning) overrides[m.id] = { thinkingLevelMap: none };
          }
        } catch {
        }
        for (const m of p.models) if (m.reasoning) overrides[m.id] = { thinkingLevelMap: none };
        if (Object.keys(overrides).length > 0) entry2.modelOverrides = overrides;
      }
      if (Object.keys(entry2).some((key2) => key2 !== "name")) providers[p.id] = entry2;
      continue;
    }
    const resolvedKey = resolveApiKey(p.apiKey);
    const entry = {
      baseUrl: p.baseUrl,
      apiKey: resolvedKey === "" ? " " : resolvedKey,
      api: p.api || "openai-completions",
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        reasoning: m.reasoning,
        input: m.input,
        ...Number.isFinite(resolveContextWindow(m.contextWindow)) ? { contextWindow: m.contextWindow } : {},
        maxTokens: m.maxTokens || 16384,
        ...m.api ? { api: m.api } : {},
        ...m.baseUrl ? { baseUrl: m.baseUrl } : {},
        ...m.cost ? { cost: m.cost } : {}
      }))
    };
    if (disableThinking && p.id === cfg.model.provider) {
      const none = { minimal: "none", low: "none", medium: "none", high: "none" };
      const overrides = {};
      for (const m of p.models) if (m.reasoning) overrides[m.id] = { thinkingLevelMap: none };
      if (Object.keys(overrides).length > 0) entry.modelOverrides = overrides;
    }
    providers[p.id] = entry;
  }
  return JSON.stringify({ providers }, null, 2);
}
function writeModelsJson(cfg = loadConfig()) {
  mkdirSync(DITO_DIR, { recursive: true });
  writeFileSync(join(DITO_DIR, "models.json"), buildModelsJson(false, cfg));
}
let createQueue = Promise.resolve();
async function createSession(options = {}) {
  const queued = createQueue.then(() => runCreate(options), () => runCreate(options));
  createQueue = queued.catch(() => {
  });
  return queued;
}
async function runCreate(options) {
  setMemoryScope(options.memoryScope);
  setKbScope(options.memoryScope);
  try {
    return await createSessionInner(options);
  } finally {
    setMemoryScope(void 0);
    setKbScope(void 0);
  }
}
async function createSessionInner(options) {
  const cfg = loadConfig();
  const requestedProvider = options.model?.split("/")[0];
  await Promise.all(cfg.providers.filter((p) => p.id === cfg.model.provider || p.id === requestedProvider).map(refreshProviderModelMetadata));
  writeModelsJson(cfg);
  let modelsPath = join(DITO_DIR, "models.json");
  if (options.disableThinking) {
    modelsPath = join(DITO_DIR, "models-channel.json");
    writeFileSync(modelsPath, buildModelsJson(true, cfg));
  }
  const modelRuntime = await ModelRuntime.create({
    modelsPath,
    // 复用 pi 的共享鉴权文件（~/.pi/agent/auth.json）
    authPath: join(getAgentDir(), "auth.json")
  });
  applyRuntimeModelMetadata({ getAll: () => [...modelRuntime.getModels()], registerProvider: (id, config) => modelRuntime.registerProvider(id, config) }, cfg);
  const available = await modelRuntime.getAvailable();
  const providerCfg = cfg.providers.find((p) => p.id === cfg.model.provider);
  const requestedModel = options.model?.trim();
  let model = requestedModel ? available.find((m) => `${m.provider}/${m.id}` === requestedModel || m.id === requestedModel || m.name === requestedModel) : available.find((m) => m.provider === cfg.model.provider && m.id === cfg.model.chat);
  if (!model) {
    const providerAvailable = available.filter((m) => m.provider === cfg.model.provider);
    model = providerAvailable[0];
    if (!model) {
      const base = cfg.model.chat.replace(/-free$/, "");
      model = available.find((m) => m.id === cfg.model.chat) ?? available.find((m) => m.id === `${base}-pro`) ?? available.find((m) => m.id.startsWith(base)) ?? available.find((m) => m.id === `${base}-free`);
    }
    if (!model) model = available[0];
  }
  if (!model) {
    throw new Error("没有可用模型。请检查 API Key 或稍后重试（opencode 免费额度可能限流）。");
  }
  const settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
  const compaction = resolveCompactionBudget(model, cfg.contextCompaction);
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    extensionFactories: withToolBudget([makeExtensionFactory(options.skipPluginIds, settingsManager, cfg), ...options.extraExtensions ?? []]),
    systemPrompt: options.systemPrompt ?? buildDitoSystemPrompt()
  });
  await resourceLoader.reload();
  settingsManager.applyOverrides({
    compaction: {
      enabled: compaction.enabled,
      reserveTokens: compaction.reserveTokens,
      keepRecentTokens: compaction.keepRecentTokens
    }
  });
  const sessionManager = resolveSessionManager(!!options.fresh, options.sessionFile, options.sessionsDir, options.ephemeral);
  const { session } = await createAgentSession({
    model,
    thinkingLevel: "minimal",
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager
  });
  return {
    session,
    modelName: model.name || model.id,
    providerId: model.provider,
    modelId: model.id
  };
}
function parseSessionTurns(file, limit = 200) {
  const turns = [];
  try {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type !== "message" || !e.message?.role) continue;
        if (e.message.role !== "user" && e.message.role !== "assistant") continue;
        const content = e.message.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content.map((c) => c.type === "text" ? c.text ?? "" : "").join("\n");
        }
        text = text.trim();
        if (!text) continue;
        turns.push({ role: e.message.role, text, ts: e.timestamp });
      } catch {
      }
    }
  } catch {
    return [];
  }
  return turns.slice(-limit);
}
async function describeModelSelection() {
  const cfg = loadConfig();
  const provider = cfg.providers.find((p) => p.id === cfg.model.provider);
  if (provider) await refreshProviderModelMetadata(provider);
  writeModelsJson(cfg);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: join(DITO_DIR, "models.json"),
    authPath: join(getAgentDir(), "auth.json")
  });
  const available = await modelRuntime.getAvailable();
  const configuredModel = available.find((m) => m.provider === cfg.model.provider && m.id === cfg.model.chat);
  let notice = null;
  let model = configuredModel;
  if (!model) {
    const providerAvailable = available.filter((m) => m.provider === cfg.model.provider);
    model = providerAvailable[0];
    if (!model) {
      const base = cfg.model.chat.replace(/-free$/, "");
      model = available.find((m) => m.id === cfg.model.chat) ?? available.find((m) => m.id === `${base}-pro`) ?? available.find((m) => m.id.startsWith(base)) ?? available.find((m) => m.id === `${base}-free`);
    }
    if (!model) model = available[0];
    const providerCfg = cfg.providers.find((p) => p.id === cfg.model.provider);
    if (providerAvailable.length === 0 && providerCfg) {
      const envMatch = providerCfg.apiKey.match(/\$\{?([A-Z0-9_]+)\}?/);
      notice = envMatch ? `供应商「${providerCfg.name}」需要 API Key，但环境变量 ${envMatch[1]} 未设置` : `供应商「${providerCfg.name}」无可用模型（可能未鉴权）`;
    } else {
      notice = `模型「${cfg.model.chat}」在供应商「${providerCfg?.name || cfg.model.provider}」中不可用`;
    }
    if (notice && model) notice += `，改用 ${model.provider}/${model.name || model.id}`;
  }
  return {
    modelName: model?.name || model?.id || "",
    providerId: model?.provider || "",
    modelId: model?.id || "",
    fallbackNotice: notice
  };
}
async function openChannelSession(indexFile, chatKey, extraExtensions, sessionOptions, forceNew = false) {
  let index = {};
  try {
    index = JSON.parse(readFileSync(indexFile, "utf-8"));
  } catch {
  }
  const known = forceNew ? void 0 : index[chatKey];
  if (known) {
    try {
      return await createSession({ sessionFile: known, extraExtensions, ...sessionOptions });
    } catch (err) {
      console.error(`[dito] 会话文件打开失败（${known}），改开新会话：`, err.message);
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
export {
  buildModelsJson,
  createSession,
  describeModelSelection,
  ditoExtensions,
  listSessions,
  openChannelSession,
  parseSessionTurns,
  writeModelsJson
};
