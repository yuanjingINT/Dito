/**
 * Dito 运行模式：闲聊 / 标准 / 计划。
 *
 * - 闲聊 (chat)：纯聊天，不调用任何工具，关闭思考，回复轻快口语化。
 * - 标准 (standard)：完整助手，保留默认工具（读写文件、命令、知识库、记忆、联网）。
 * - 计划 (plan)：只读探索并产出决策完整的计划，提交审批前不执行修改（融合 plan-mode 技能）。
 *
 * 模式状态为进程内共享：bin/dito.ts 的 Tab 切换与扩展的 before_agent_start
 * 注入读取同一份状态，因此切换即时生效。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ROOT_DIR } from "./util.js";

export type DitoMode = "chat" | "standard" | "plan";

export interface ModeDef {
  id: DitoMode;
  label: string;
  color: string;
  hint: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
}

export const MODE_ORDER: DitoMode[] = ["chat", "standard", "plan"];

export const MODE_DEFS: Record<DitoMode, ModeDef> = {
  chat: {
    id: "chat",
    label: "闲聊",
    color: "\x1b[32m",
    hint: "轻松聊天 · 不调用工具",
    thinkingLevel: "off",
  },
  standard: {
    id: "standard",
    label: "标准",
    color: "\x1b[36m",
    hint: "完整助手 · 全部工具",
    thinkingLevel: "minimal",
  },
  plan: {
    id: "plan",
    label: "计划",
    color: "\x1b[35m",
    hint: "只读探索 · 产出计划",
    thinkingLevel: "high",
  },
};

let currentMode: DitoMode = "standard";

export function getMode(): DitoMode {
  return currentMode;
}

export function setMode(mode: DitoMode): DitoMode {
  currentMode = mode;
  return mode;
}

export function nextMode(mode: DitoMode): DitoMode {
  const i = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(i + 1) % MODE_ORDER.length];
}

/** 计划模式允许的只读工具集（其余工具全部禁用，保证不产生修改）。 */
const READONLY_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "search_knowledge_base",
  "read_knowledge_base",
  "list_knowledge_base",
  "recall_memories",
  "recall_past_events",
  "web_search",
  "web_fetch",
  "ask_question",
];

export function readOnlyTools(): string[] {
  return [...READONLY_TOOLS];
}

// ── 模式系统提示词 ──────────────────────────────────────────────

function readPlanSkill(): string {
  const p = join(ROOT_DIR, "skills", "plan-mode", "SKILL.md");
  if (!existsSync(p)) return "";
  const raw = readFileSync(p, "utf-8");
  // 去掉 YAML frontmatter
  const m = raw.match(/^---\n[\s\S]*?\n---\n*/);
  return (m ? raw.slice(m[0].length) : raw).trim();
}

function formatTools(tools: string[]): string {
  if (tools.length === 0) return "（当前未启用额外工具）";
  return tools.map((t) => `- \`${t}\``).join("\n");
}

function buildModePrompt(mode: DitoMode, tools: string[] = []): string {
  switch (mode) {
    case "chat":
      return [
        "# Dito 运行模式：闲聊",
        "你当前处于「闲聊」模式，就是蒂特和朋友唠嗑。放轻松，自然、简短、有温度地聊：",
        "- 不要调用任何工具：不读写文件、不执行命令、不联网搜索、不查知识库或记忆。",
        "- 用口语化中文；按人设里的说话方式（每句不超过30字、结尾不加句号、玩梗调侃、不 emoji、不动作描写）。",
        "- 除非用户明确要求，否则不要长篇大论、不要总结汇报。",
      ].join("\n");
    case "standard":
      return [
        "# Dito 运行模式：标准",
        "你当前处于「标准」模式：完整助手，可以根据任务使用当前已启用的工具。",
        "",
        "当前可用工具：",
        tools.length > 0 ? formatTools(tools) : "当前可用工具由会话动态提供，请只调用真实存在的工具。",
        "",
        "工作规则：",
        "- 根据任务按需调用工具，优先使用知识库、记忆、网络搜索、文件读写和命令执行。",
        "- 只调用上面列出的工具；不要假装调用不存在的工具。",
        "- 遵守主提示词「工作」部分：先明确问题，能查就查，把握不足要说明不确定点，重要操作先与用户确认。",
        "- 未明确指示时禁止安装软件、卸载软件和移除文件。",
      ].join("\n");
    case "plan":
      return [
        "# Dito 运行模式：计划",
        "你当前处于「计划」模式：只做只读探索，产出决策完整的计划并提交用户审批；在获得批准前不得执行任何修改性操作。",
        "",
        "当前可用的只读工具：",
        formatTools(tools),
        "",
        readPlanSkill(),
      ]
        .filter(Boolean)
        .join("\n\n");
    default:
      return "";
  }
}

export default function modeExtension(pi: ExtensionAPI): void {
  // 每轮根据当前模式把「运行模式」追加到系统提示词
  pi.on("before_agent_start", (event) => {
    const mode = getMode();
    const tools = event.systemPromptOptions.selectedTools ?? [];
    // 计划模式即使事件没带上工具列表，也保证给出只读工具集。
    const effectiveTools = mode === "plan" && tools.length === 0 ? readOnlyTools() : tools;
    const text = buildModePrompt(mode, effectiveTools);
    if (!text) return undefined;
    const marker = "# Dito 运行模式";
    // 幂等：避免同一轮被多次注入
    if (event.systemPrompt.includes(marker)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
  });

  pi.registerCommand("mode", {
    description: "切换运行模式：/mode [chat|standard|plan]（或 /chat /standard /plan）",
    handler: async (args, ctx) => {
      const alias: Record<string, DitoMode> = {
        chat: "chat",
        standard: "standard",
        plan: "plan",
        闲聊: "chat",
        标准: "standard",
        计划: "plan",
      };
      const target = alias[args.trim().toLowerCase()];
      if (target) {
        setMode(target);
        ctx.ui.notify(`已切换模式：${MODE_DEFS[target].label}`, "info");
        return;
      }
      ctx.ui.notify("用法：/mode chat | standard | plan", "info");
    },
  });
}
