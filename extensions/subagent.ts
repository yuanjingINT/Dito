/**
 * Dito 子代理调度器。
 *
 * 子代理运行在独立的临时 pi 会话和 Node 进程中。主代理只负责拆分任务、按任务类型和模型价格
 * 选择模型，并在最后把子代理结果合并回当前上下文。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveSubagentConfig, type SubagentConfig } from "./subagent-config.js";

export type WorkType = "auto" | "quick" | "standard" | "coding" | "review" | "research" | "complex";
export type AgentSource = "builtin" | "user" | "project";

export interface AgentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  source: AgentSource;
}

export interface ModelChoice {
  model?: Model<any>;
  estimatedCostUsd: number;
  reason: string;
}

export interface SubagentTaskInput {
  agent?: string;
  task: string;
  workType?: WorkType;
  model?: string;
  budgetUsd?: number;
  cwd?: string;
}

const WORK_TYPES = ["auto", "quick", "standard", "coding", "review", "research", "complex"] as const;
const HARD_MAX_AGENTS = 100;
const DEFAULT_OUTPUT_CAP = 48 * 1024;
const EXPECTED_INPUT_TOKENS = 12_000;
const EXPECTED_OUTPUT_TOKENS = 4_000;

const BUILTIN_PROFILES: AgentProfile[] = [
  {
    name: "scout",
    description: "快速检索代码、文件和事实，输出压缩后的调查结果。",
    source: "builtin",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: "你是侦察子代理。快速查找与任务相关的文件、接口和事实，输出结构化发现，不修改文件。",
  },
  {
    name: "planner",
    description: "根据调查结果拆解实现计划。",
    source: "builtin",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: "你是规划子代理。分析任务和已有代码，给出具体、可执行的步骤和风险，不修改文件。",
  },
  {
    name: "reviewer",
    description: "检查实现的正确性、安全性和可维护性。",
    source: "builtin",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: "你是审查子代理。检查代码问题、边界条件、安全风险和回归风险，按严重程度给出结论。",
  },
  {
    name: "worker",
    description: "执行完整的实现、修复和验证任务。",
    source: "builtin",
    systemPrompt: "你是执行子代理。独立完成分配的任务，必要时读取和修改工作区，最后汇报改动和验证结果。",
  },
];

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function nearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function loadProfilesFromDir(dir: string, source: "user" | "project"): AgentProfile[] {
  if (!isDirectory(dir)) return [];
  const profiles: AgentProfile[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return profiles; }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      const parsed = parseFrontmatter<Record<string, string>>(readFileSync(path, "utf8"));
      if (!parsed.frontmatter.name || !parsed.frontmatter.description) continue;
      profiles.push({
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        systemPrompt: parsed.body,
        source,
        model: parsed.frontmatter.model?.trim() || undefined,
        tools: parsed.frontmatter.tools?.split(",").map((tool) => tool.trim()).filter(Boolean),
      });
    } catch {
      /* 单个 agent 定义损坏不影响其它 agent。 */
    }
  }
  return profiles;
}

export function discoverSubagentProfiles(cwd: string, scope: "user" | "project" | "both" = "user"): AgentProfile[] {
  const profiles = new Map<string, AgentProfile>(BUILTIN_PROFILES.map((profile) => [profile.name, profile]));
  if (scope !== "project") {
    for (const profile of loadProfilesFromDir(join(getAgentDir(), "agents"), "user")) profiles.set(profile.name, profile);
  }
  if (scope !== "user") {
    const projectDir = nearestProjectAgentsDir(cwd);
    if (projectDir) for (const profile of loadProfilesFromDir(projectDir, "project")) profiles.set(profile.name, profile);
  }
  return [...profiles.values()];
}

export function inferWorkType(task: string, requested: WorkType = "auto"): Exclude<WorkType, "auto"> {
  if (requested !== "auto") return requested;
  const text = task.toLowerCase();
  if (/(review|审查|检查|audit|安全|回归)/i.test(text)) return "review";
  if (/(代码|编码|实现|修复|重构|编程|bug|debug|implement|refactor|fix)/i.test(text)) return "coding";
  if (/(研究|调研|调查|比较|资料|research|investigate|分析)/i.test(text)) return "research";
  if (/(架构|设计|复杂|多步骤|综合|architecture|complex)/i.test(text)) return "complex";
  if (/(总结|提取|查找|列出|格式化|快速|summarize|lookup|list|quick)/i.test(text)) return "quick";
  return "standard";
}

function modelCostUsd(model: Model<any>): number {
  const cost = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return Math.max(0, (cost.input * EXPECTED_INPUT_TOKENS + cost.output * EXPECTED_OUTPUT_TOKENS) / 1_000_000);
}

function modelQuality(model: Model<any>): number {
  const context = Math.log2(Math.max(1, model.contextWindow || 1));
  const output = Math.log2(Math.max(1, model.maxTokens || 1));
  const reasoning = model.reasoning ? 3 : 0;
  const name = `${model.name} ${model.id}`.toLowerCase();
  const specialist = /(pro|max|opus|sonnet|reason|coder|code|旗舰|推理)/.test(name) ? 1.5 : 0;
  return reasoning + context / 10 + output / 10 + specialist;
}

function exactModel(models: Model<any>[], requested?: string): Model<any> | undefined {
  const value = requested?.trim();
  if (!value) return undefined;
  return models.find((model) =>
    `${model.provider}/${model.id}` === value || model.id === value || model.name === value,
  );
}

/** 根据任务难度、价格和预算自动选择可用模型。 */
export function chooseSubagentModel(
  models: Model<any>[],
  task: string,
  workType: WorkType = "auto",
  budgetUsd = 0,
  requestedModel?: string,
): ModelChoice {
  const textModels = models.filter((model) => model.input?.includes("text"));
  const explicit = exactModel(textModels, requestedModel);
  if (explicit) {
    return { model: explicit, estimatedCostUsd: modelCostUsd(explicit), reason: "使用任务明确指定的模型" };
  }
  if (textModels.length === 0) return { estimatedCostUsd: 0, reason: "当前模型目录没有可用的文本模型" };

  const type = inferWorkType(task, workType);
  const affordable = budgetUsd > 0 ? textModels.filter((model) => modelCostUsd(model) <= budgetUsd) : textModels;
  const candidates = affordable.length > 0 ? affordable : [...textModels].sort((a, b) => modelCostUsd(a) - modelCostUsd(b)).slice(0, 1);
  let selected: Model<any>;
  if (type === "quick") {
    selected = [...candidates].sort((a, b) => modelCostUsd(a) - modelCostUsd(b) || modelQuality(b) - modelQuality(a))[0];
  } else if (type === "complex" || type === "coding" || type === "research") {
    selected = [...candidates].sort((a, b) => modelQuality(b) - modelQuality(a) || modelCostUsd(a) - modelCostUsd(b))[0];
  } else {
    selected = [...candidates].sort((a, b) => {
      const aRatio = modelCostUsd(a) / Math.max(1, modelQuality(a));
      const bRatio = modelCostUsd(b) / Math.max(1, modelQuality(b));
      return aRatio - bRatio || modelQuality(b) - modelQuality(a);
    })[0];
  }
  const budgetNote = budgetUsd > 0 ? `，预算 ${budgetUsd.toFixed(4)} USD` : "，未设置预算上限";
  return {
    model: selected,
    estimatedCostUsd: modelCostUsd(selected),
    reason: `${type}任务按价格/能力策略选择${budgetNote}`,
  };
}

interface WorkerPayload {
  task: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
}

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface AgentResult {
  agent: string;
  model?: string;
  task: string;
  output: string;
  error?: string;
  usage: UsageStats;
  estimatedCostUsd: number;
  routeReason: string;
}

interface ToolUpdate {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

type UpdateCallback = (update: ToolUpdate) => void;

function textFromMessage(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("");
}

function usageFromMessage(message: any, usage: UsageStats): void {
  if (message?.role !== "assistant" || !message.usage) return;
  usage.turns++;
  usage.input += message.usage.input || 0;
  usage.output += message.usage.output || 0;
  usage.cacheRead += message.usage.cacheRead || 0;
  usage.cacheWrite += message.usage.cacheWrite || 0;
  usage.cost += message.usage.cost?.total || 0;
}

function capOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= DEFAULT_OUTPUT_CAP) return text;
  let result = text.slice(0, DEFAULT_OUTPUT_CAP);
  while (Buffer.byteLength(result, "utf8") > DEFAULT_OUTPUT_CAP) result = result.slice(0, -1);
  return `${result}\n\n[子代理输出已截断]`;
}

async function runWorker(
  profile: AgentProfile,
  task: SubagentTaskInput,
  model: Model<any> | undefined,
  routeReason: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: UpdateCallback | undefined,
): Promise<AgentResult> {
  const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  const tempDir = await mkdtemp(join(tmpdir(), "dito-subagent-"));
  const payloadPath = join(tempDir, "payload.json");
  const payload: WorkerPayload = {
    task: task.task,
    systemPrompt: profile.systemPrompt,
    model: model ? `${model.provider}/${model.id}` : undefined,
    tools: profile.tools,
  };
  await writeFile(payloadPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });

  const extensionRoot = dirname(fileURLToPath(import.meta.url));
  const projectRoot = dirname(extensionRoot);
  const workerPath = join(projectRoot, "bin", "subagent-worker.ts");
  const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const result: AgentResult = {
    agent: profile.name,
    model: model ? `${model.provider}/${model.id}` : undefined,
    task: task.task,
    output: "",
    usage,
    estimatedCostUsd: model ? modelCostUsd(model) : 0,
    routeReason,
  };
  let buffer = "";
  let aborted = false;
  const processLine = (line: string): void => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "message_end" && event.message) {
      usageFromMessage(event.message, usage);
      const output = textFromMessage(event.message);
      if (output) result.output = output;
      onUpdate?.({ content: [{ type: "text", text: result.output || "子代理正在工作…" }] });
    }
    if (event.type === "subagent_error") result.error = String(event.error || "子代理失败");
  };

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [tsxCli, workerPath, "--payload", payloadPath], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      child.stderr.on("data", (data) => { stderr += data.toString(); });
      child.on("error", (error) => {
        result.error = error.message;
        resolve(1);
      });
      child.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        if (!result.error && code !== 0) result.error = stderr.trim() || `子代理退出码 ${code ?? 1}`;
        resolve(code ?? 1);
      });
      const abort = () => {
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5000).unref();
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    if (aborted) result.error = "子代理已取消";
    if (exitCode !== 0 && !result.error) result.error = `子代理退出码 ${exitCode}`;
    result.output = capOutput(result.output || result.error || "（子代理没有返回文本）");
    return result;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<AgentResult>): Promise<AgentResult[]> {
  const results: AgentResult[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function modelLabel(model: Model<any> | undefined): string {
  return model ? `${model.provider}/${model.id}` : "主代理默认模型";
}

function chooseProfile(profiles: AgentProfile[], requested: string | undefined, workType: WorkType, task: string): AgentProfile {
  if (requested) {
    const found = profiles.find((profile) => profile.name === requested);
    if (found) return found;
  }
  const type = inferWorkType(task, workType);
  const preferred = type === "review" ? "reviewer" : type === "quick" || type === "research" ? "scout" : type === "complex" ? "planner" : "worker";
  return profiles.find((profile) => profile.name === preferred) ?? profiles[0];
}

function formatResult(result: AgentResult): string {
  const status = result.error ? `失败：${result.error}` : "完成";
  return `### ${result.agent} · ${status}\n模型：${result.model || "主代理默认模型"}\n预估单任务成本：$${result.estimatedCostUsd.toFixed(4)}\n${result.output}`;
}

const WorkTypeSchema = StringEnum(WORK_TYPES, { description: "任务类型；auto 会根据任务内容自动判断。", default: "auto" });
const TaskSchema = Type.Object({
  agent: Type.Optional(Type.String({ description: "子代理名称；留空时按任务类型选择 scout/planner/reviewer/worker。" })),
  task: Type.String({ description: "交给子代理的独立任务。" }),
  workType: Type.Optional(WorkTypeSchema),
  model: Type.Optional(Type.String({ description: "明确模型，支持 provider/model、模型 id 或名称。" })),
  budgetUsd: Type.Optional(Type.Number({ minimum: 0, description: "该任务估算预算（美元），0 或省略表示不设预算。" })),
  cwd: Type.Optional(Type.String({ description: "子代理工作目录。" })),
});

const SubagentSchema = Type.Object({
  agent: Type.Optional(Type.String({ description: "单任务子代理名称。" })),
  task: Type.Optional(Type.String({ description: "单任务内容；与 agent 一起使用，或单独使用以自动选择。" })),
  workType: Type.Optional(WorkTypeSchema),
  model: Type.Optional(Type.String({ description: "单任务明确模型。" })),
  budgetUsd: Type.Optional(Type.Number({ minimum: 0, description: "单任务预算（美元）。" })),
  tasks: Type.Optional(Type.Array(TaskSchema, { description: "并行任务，最多 100 个。" })),
  chain: Type.Optional(Type.Array(TaskSchema, { description: "串行任务，后一步可以使用 {previous}。最多 100 步。" })),
  agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { default: "user" })),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
});

let activeSubagents = 0;

export default function subagentExtension(pi: ExtensionAPI, rawConfig: unknown = {}): void {
  const config: SubagentConfig = resolveSubagentConfig(rawConfig);
  if (!config.enabled) return;

  pi.registerTool({
    name: "subagent",
    label: "子代理",
    description: "把独立工作委派给隔离上下文的子代理。支持单个、最多 100 个并行任务和串行链；会根据工作内容、模型价格、能力和预算自动选模。",
    parameters: SubagentSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as any;
      const scope = input.agentScope ?? "user";
      const profiles = discoverSubagentProfiles(ctx.cwd, scope);
      if ((scope === "project" || scope === "both") && input.confirmProjectAgents !== false && ctx.hasUI) {
        const requestedNames = new Set<string>();
        if (input.agent) requestedNames.add(input.agent);
        for (const item of [...(Array.isArray(input.tasks) ? input.tasks : []), ...(Array.isArray(input.chain) ? input.chain : [])]) {
          if (item?.agent) requestedNames.add(item.agent);
        }
        const projectNames = [...requestedNames]
          .map((name) => profiles.find((profile) => profile.name === name))
          .filter((profile): profile is AgentProfile => profile?.source === "project")
          .map((profile) => profile.name);
        if (projectNames.length > 0) {
          const ok = await ctx.ui.confirm(
            "运行项目级子代理？",
            `代理：${projectNames.join(", ")}\n目录：${join(ctx.cwd, CONFIG_DIR_NAME, "agents")}\n\n项目代理中的提示词和工具权限由项目文件定义。`,
          );
          if (!ok) return { content: [{ type: "text", text: "已取消运行项目级子代理。" }] };
        }
      }
      const models = ctx.modelRegistry.getAvailable();
      const single = input.task ? [{ ...input, task: input.task } as SubagentTaskInput] : [];
      const parallel = Array.isArray(input.tasks) ? input.tasks as SubagentTaskInput[] : [];
      const chain = Array.isArray(input.chain) ? input.chain as SubagentTaskInput[] : [];
      const modeCount = Number(single.length > 0) + Number(parallel.length > 0) + Number(chain.length > 0);
      if (modeCount !== 1) {
        return { content: [{ type: "text", text: "子代理参数错误：请提供 task、tasks 或 chain 中的一种。" }] };
      }
      if (parallel.length > HARD_MAX_AGENTS || chain.length > HARD_MAX_AGENTS) {
        return { content: [{ type: "text", text: `子代理数量超过硬上限：最多 ${HARD_MAX_AGENTS} 个。` }] };
      }
      const reservation = parallel.length > 0 ? parallel.length : 1;
      if (activeSubagents + reservation > config.maxAgents) {
        return { content: [{ type: "text", text: `当前已有 ${activeSubagents} 个子代理运行，配置上限为 ${config.maxAgents} 个。` }] };
      }
      activeSubagents += reservation;
      const makeAssignment = (item: SubagentTaskInput): { profile: AgentProfile; choice: ModelChoice; type: Exclude<WorkType, "auto"> } => {
        const type = inferWorkType(item.task, item.workType ?? "auto");
        const profile = chooseProfile(profiles, item.agent, item.workType ?? "auto", item.task);
        const budget = item.budgetUsd ?? config.defaultBudgetUsd;
        const choice = chooseSubagentModel(models, item.task, type, budget, item.model ?? profile.model);
        return { profile, choice, type };
      };
      try {
        if (parallel.length > 0) {
          const results = await mapWithConcurrency(parallel, config.maxConcurrency, async (item) => {
            const assignment = makeAssignment(item);
            return runWorker(assignment.profile, item, assignment.choice.model, `${assignment.choice.reason}；任务类型 ${assignment.type}；使用 ${modelLabel(assignment.choice.model)}`, item.cwd ?? ctx.cwd, signal, onUpdate);
          });
          const success = results.filter((result) => !result.error).length;
          return { content: [{ type: "text", text: `并行子代理完成：${success}/${results.length} 成功\n\n${results.map(formatResult).join("\n\n---\n\n")}` }], details: { mode: "parallel", results } };
        }

        if (chain.length > 0) {
          const results: AgentResult[] = [];
          let previous = "";
          for (const item of chain) {
            const task = { ...item, task: item.task.replace(/\{previous\}/g, previous) };
            const assignment = makeAssignment(task);
            const result = await runWorker(assignment.profile, task, assignment.choice.model, `${assignment.choice.reason}；任务类型 ${assignment.type}；使用 ${modelLabel(assignment.choice.model)}`, task.cwd ?? ctx.cwd, signal, onUpdate);
            results.push(result);
            if (result.error) return { content: [{ type: "text", text: `串行子代理在 ${result.agent} 处失败：${result.error}` }], details: { mode: "chain", results }, isError: true };
            previous = result.output;
          }
          return { content: [{ type: "text", text: previous || "（串行子代理没有返回文本）" }], details: { mode: "chain", results } };
        }

        const item = single[0];
        const assignment = makeAssignment(item);
        const result = await runWorker(assignment.profile, item, assignment.choice.model, `${assignment.choice.reason}；任务类型 ${assignment.type}；使用 ${modelLabel(assignment.choice.model)}`, item.cwd ?? ctx.cwd, signal, onUpdate);
        return { content: [{ type: "text", text: formatResult(result) }], details: { mode: "single", results: [result] }, ...(result.error ? { isError: true } : {}) };
      } finally {
        activeSubagents -= reservation;
      }
    },
  });
}
