const MAX_CONCURRENT_TASKS = 8;
class TaskSemaphore {
  active = 0;
  waiters = [];
  async run(fn) {
    if (this.active >= MAX_CONCURRENT_TASKS) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
  get pending() {
    return this.active;
  }
}
const taskSlots = new TaskSemaphore();
function runWithTaskSlot(fn) {
  return taskSlots.run(fn);
}
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "../extensions/util.js";
const SNOWLUMA_ACTIONS = JSON.parse(
  readFileSync(join(ROOT_DIR, "extensions", "snowluma-actions.json"), "utf-8")
);
const SNOWLUMA_READ_ONLY = new Map(SNOWLUMA_ACTIONS.map((a) => [a.tool, a.readOnly]));
const NON_OWNER_BLOCKED_TOOLS = /* @__PURE__ */ new Set([
  "bash",
  "write",
  "edit",
  "read",
  "get_system_info",
  "remove_knowledge_base",
  "upload_to_knowledge_base",
  "qq_qzone_post"
]);
const NON_OWNER_BLOCKED_ACTIONS = /* @__PURE__ */ new Set([
  "get_cookies",
  "get_credentials",
  "get_csrf_token",
  "get_clientkey",
  "get_rkey",
  "nc_get_rkey"
]);
const NON_OWNER_CURATED_TOOLS = /* @__PURE__ */ new Set(["qq_react", "qq_poke", "qq_send_like", "qq_affinity", "qq_meme_send", "qq_meme_list"]);
function isToolAllowedForNonOwner(name) {
  if (NON_OWNER_BLOCKED_TOOLS.has(name)) return false;
  if (NON_OWNER_CURATED_TOOLS.has(name)) return true;
  if (name.startsWith("snowluma_")) {
    const action = name.slice("snowluma_".length);
    if (NON_OWNER_BLOCKED_ACTIONS.has(action)) return false;
    return SNOWLUMA_READ_ONLY.get(action) === true;
  }
  return true;
}
function applySessionToolPolicy(session, owner, label) {
  if (owner) return;
  const all = session.getActiveToolNames();
  const allowed = all.filter(isToolAllowedForNonOwner);
  session.setActiveToolsByName(allowed);
  console.log(`[${label}] 非主人会话，已限制工具：${all.length} → ${allowed.length}（屏蔽 bash/文件读写/凭据/状态修改，保留搜索/知识库/记忆/娱乐）`);
}
function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();
}
function makeChannelChat(session, send, label) {
  let buf = "";
  let lastReply = "";
  let chain = Promise.resolve();
  session.subscribe((event) => {
    const e = event;
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      buf += e.assistantMessageEvent.delta ?? "";
      return;
    }
    if (e.type === "message_start" && e.message?.role === "assistant") {
      buf = "";
      return;
    }
    if (e.type === "message_end" && e.message?.role === "assistant") {
      if (e.message.stopReason === "error") {
        console.error(`[${label}] 模型错误：${e.message.errorMessage ?? "(无信息)"}`);
        buf = "";
        return;
      }
      const text = buf.trim();
      buf = "";
      if (text) lastReply = text;
      return;
    }
    if (e.type === "agent_end") {
      const reply = stripThinkTags(lastReply);
      lastReply = "";
      buf = "";
      if (!reply) return;
      chain = chain.then(() => send(reply)).catch((err) => console.error(`[${label}] 回复发送失败：`, err.message));
    }
  });
  return { session };
}
export {
  applySessionToolPolicy,
  makeChannelChat,
  runWithTaskSlot
};
