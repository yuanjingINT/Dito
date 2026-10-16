import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "./util.js";
const MODE_ORDER = ["chat", "standard", "plan"];
const MODE_DEFS = {
  chat: {
    id: "chat",
    label: "闲聊",
    color: "\x1B[32m",
    hint: "轻松聊天 · 不调用工具",
    thinkingLevel: "off"
  },
  standard: {
    id: "standard",
    label: "标准",
    color: "\x1B[36m",
    hint: "完整助手 · 全部工具",
    thinkingLevel: "minimal"
  },
  plan: {
    id: "plan",
    label: "计划",
    color: "\x1B[35m",
    hint: "只读探索 · 产出计划",
    thinkingLevel: "high"
  }
};
let currentMode = "standard";
function getMode() {
  return currentMode;
}
function setMode(mode) {
  currentMode = mode;
  return mode;
}
function nextMode(mode) {
  const i = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(i + 1) % MODE_ORDER.length];
}
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
  "ask_question"
];
function readOnlyTools() {
  return [...READONLY_TOOLS];
}
function readPlanSkill() {
  const p = join(ROOT_DIR, "skills", "plan-mode", "SKILL.md");
  if (!existsSync(p)) return "";
  const raw = readFileSync(p, "utf-8");
  const m = raw.match(/^---\n[\s\S]*?\n---\n*/);
  return (m ? raw.slice(m[0].length) : raw).trim();
}
function formatTools(tools) {
  if (tools.length === 0) return "（当前未启用额外工具）";
  return tools.map((t) => `- \`${t}\``).join("\n");
}
function buildModePrompt(mode, tools = []) {
  switch (mode) {
    case "chat":
      return [
        "# Dito 运行模式：闲聊",
        "你当前处于「闲聊」模式，就是蒂特和朋友唠嗑。放轻松，自然、简短、有温度地聊：",
        "- 不要调用任何工具：不读写文件、不执行命令、不联网搜索、不查知识库或记忆。",
        "- 用口语化中文；按人设里的说话方式（每句不超过30字、结尾不加句号、玩梗调侃、不 emoji、不动作描写）。",
        "- 除非用户明确要求，否则不要长篇大论、不要总结汇报。"
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
        "- 未明确指示时禁止安装软件、卸载软件和移除文件。"
      ].join("\n");
    case "plan":
      return [
        "# Dito 运行模式：计划",
        "你当前处于「计划」模式：只做只读探索，产出决策完整的计划并提交用户审批；在获得批准前不得执行任何修改性操作。",
        "",
        "当前可用的只读工具：",
        formatTools(tools),
        "",
        readPlanSkill()
      ].filter(Boolean).join("\n\n");
    default:
      return "";
  }
}
function modeExtension(pi) {
  pi.on("before_agent_start", (event) => {
    const mode = getMode();
    const tools = event.systemPromptOptions.selectedTools ?? [];
    const effectiveTools = mode === "plan" && tools.length === 0 ? readOnlyTools() : tools;
    const text = buildModePrompt(mode, effectiveTools);
    if (!text) return void 0;
    const marker = "# Dito 运行模式";
    if (event.systemPrompt.includes(marker)) return void 0;
    return { systemPrompt: `${event.systemPrompt}

${text}` };
  });
  pi.registerCommand("mode", {
    description: "切换运行模式：/mode [chat|standard|plan]（或 /chat /standard /plan）",
    handler: async (args, ctx) => {
      const alias = {
        chat: "chat",
        standard: "standard",
        plan: "plan",
        闲聊: "chat",
        标准: "standard",
        计划: "plan"
      };
      const target = alias[args.trim().toLowerCase()];
      if (target) {
        setMode(target);
        ctx.ui.notify(`已切换模式：${MODE_DEFS[target].label}`, "info");
        return;
      }
      ctx.ui.notify("用法：/mode chat | standard | plan", "info");
    }
  });
}
export {
  MODE_DEFS,
  MODE_ORDER,
  modeExtension as default,
  getMode,
  nextMode,
  readOnlyTools,
  setMode
};
