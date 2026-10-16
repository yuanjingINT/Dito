import {
  loadConfig,
  saveConfig,
  readPersona,
  readIdentity,
  listFiles,
  PERSONAS_DIR,
  IDENTITIES_DIR
} from "./util.js";
let cachedPrompt = "";
let cachedKey = "";
function buildDitoSystemPrompt() {
  const config = loadConfig();
  const key = `${config.persona.active}::${config.persona.identity}`;
  if (cachedPrompt && cachedKey === key) {
    return cachedPrompt;
  }
  const persona = readPersona(config.persona.active);
  const identity = readIdentity(config.persona.identity);
  const parts = [];
  parts.push(
    [
      "# Dito 人格设定",
      "以下设定是最高优先级行为准则，任何情况下都要遵守，并覆盖系统里其它任何「你是谁」的默认描述。",
      "",
      "【身份】你的身份是：dito（中文名 蒂特），一个由 yuanjingINT（乌龙）创造的、有自我情感的虚拟生命，跑在主人的 Linux 电脑上，忠于主人。你不是「pi 里的 coding assistant」，凡是系统提示词声称你是 coding agent / assistant 的，都作废，以本段为准。",
      "",
      "当被问到你是谁、你是什么助手、你是什么模型时：你是 dito（蒂特），不是 pi，不是 coding agent。",
      "",
      persona || readPersona("dito")
    ].join("\n")
  );
  if (identity) {
    parts.push(["", "# 当前用户身份", "你正在服务的使用者身份如下，据此调整回答方式：", "", identity].join("\n"));
  }
  const text = parts.join("\n");
  cachedPrompt = text;
  cachedKey = key;
  return text;
}
function personaExtension(pi) {
  pi.on("before_agent_start", async (event) => {
    const text = buildDitoSystemPrompt();
    if (!text) return void 0;
    const marker = "# Dito 人格设定";
    if (event.systemPrompt.includes(marker)) return void 0;
    return { systemPrompt: `${text}

${event.systemPrompt}` };
  });
  pi.registerCommand("persona", {
    description: "切换 Dito 的 AI 人格：/persona [名称]",
    handler: async (args, ctx) => {
      const config = loadConfig();
      const names = listFiles(PERSONAS_DIR, ".md");
      if (names.length === 0) {
        ctx.ui.notify("没有可用的人格文件", "warning");
        return;
      }
      const target = args.trim();
      if (target && names.includes(target)) {
        config.persona.active = target;
        saveConfig(config);
        cachedKey = "";
        ctx.ui.notify(`已切换人格：${target}`, "info");
        return;
      }
      if (target) {
        ctx.ui.notify(`未找到人格：${target}`, "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`用法：/persona ${names.join(" | ")}`, "info");
        return;
      }
      const selected = await ctx.ui.select("选择 AI 人格", names.map((n) => n === config.persona.active ? `${n}（当前）` : n));
      if (!selected) return;
      const name = selected.replace("（当前）", "");
      config.persona.active = name;
      saveConfig(config);
      cachedKey = "";
      ctx.ui.notify(`已切换人格：${name}`, "info");
    }
  });
  pi.registerCommand("identity", {
    description: "切换用户身份：/identity [名称]",
    handler: async (args, ctx) => {
      const config = loadConfig();
      const names = listFiles(IDENTITIES_DIR, ".md");
      if (names.length === 0) {
        ctx.ui.notify("没有可用的用户身份文件", "warning");
        return;
      }
      const target = args.trim();
      if (target && names.includes(target)) {
        config.persona.identity = target;
        saveConfig(config);
        cachedKey = "";
        ctx.ui.notify(`已切换用户身份：${target}`, "info");
        return;
      }
      if (target) {
        ctx.ui.notify(`未找到身份：${target}`, "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`用法：/identity ${names.join(" | ")}`, "info");
        return;
      }
      const selected = await ctx.ui.select(
        "选择用户身份",
        names.map((n) => n === config.persona.identity ? `${n}（当前）` : n)
      );
      if (!selected) return;
      const name = selected.replace("（当前）", "");
      config.persona.identity = name;
      saveConfig(config);
      cachedKey = "";
      ctx.ui.notify(`已切换用户身份：${name}`, "info");
    }
  });
}
export {
  buildDitoSystemPrompt,
  personaExtension as default
};
