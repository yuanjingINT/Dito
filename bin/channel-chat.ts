/**
 * 频道聊天运行时（QQ / Matrix 共用）：
 * 每个聊天一个 pi 会话，订阅会话事件流，把 assistant 文本回发给对应聊天。
 */

// ── 全局任务并发：最多同时处理 8 个任务（跨聊天并行，同一聊天内 followUp 仍按序排队） ──
const MAX_CONCURRENT_TASKS = 8;

class TaskSemaphore {
  private active = 0;
  private waiters: (() => void)[] = [];

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_TASKS) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  get pending(): number {
    return this.active;
  }
}

const taskSlots = new TaskSemaphore();

/** 占一个任务槽执行；8 个槽满时排队等待 */
export function runWithTaskSlot<T>(fn: () => Promise<T>): Promise<T> {
  return taskSlots.run(fn);
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TuiSession } from "./session.js";

/** SnowLuma 动作目录快照（与 bin/qq.ts 共用同一份） */
interface SnowLumaAction {
  name: string;
  tool: string;
  readOnly: boolean;
}
const SNOWLUMA_ACTIONS: SnowLumaAction[] = JSON.parse(
  readFileSync(join(import.meta.dirname ?? ".", "..", "extensions", "snowluma-actions.json"), "utf-8"),
) as SnowLumaAction[];
const SNOWLUMA_READ_ONLY = new Map(SNOWLUMA_ACTIONS.map((a) => [a.tool, a.readOnly]));

/** 非主人会话直接禁止的本地工具：电脑控制、主机信息、删知识库、发空间 */
const NON_OWNER_BLOCKED_TOOLS = new Set([
  "bash", "write", "edit", "read",
  "get_system_info",
  "remove_knowledge_base",
  "upload_to_knowledge_base",
  "qq_qzone_post",
]);

/** 非主人会话禁止的 SnowLuma 动作：凭据窃取类（Cookie/token 是登录态，绝不外泄） */
const NON_OWNER_BLOCKED_ACTIONS = new Set([
  "get_cookies", "get_credentials", "get_csrf_token", "get_clientkey", "get_rkey", "nc_get_rkey",
]);

/** 非主人会话保留的精选 QQ 工具（娱乐互动，无风险） */
const NON_OWNER_CURATED_TOOLS = new Set(["qq_react", "qq_poke", "qq_send_like", "qq_affinity", "qq_meme_send", "qq_meme_list"]);

function isToolAllowedForNonOwner(name: string): boolean {
  if (NON_OWNER_BLOCKED_TOOLS.has(name)) return false;
  if (NON_OWNER_CURATED_TOOLS.has(name)) return true;
  if (name.startsWith("snowluma_")) {
    const action = name.slice("snowluma_".length);
    if (NON_OWNER_BLOCKED_ACTIONS.has(action)) return false;
    return SNOWLUMA_READ_ONLY.get(action) === true;
  }
  // 知识库（含写 md）、记忆、联网搜索、aur/copr 查询、提问工具等全部保留
  return true;
}

/**
 * 按会话身份应用工具策略：
 * - 主人会话：全量工具（含电脑控制）
 * - 非主人会话：屏蔽电脑控制/凭据/状态修改，保留上网搜索、知识库写 md、记忆与娱乐互动
 */
export function applySessionToolPolicy(session: TuiSession, owner: boolean, label: string): void {
  if (owner) return;
  const all = session.getActiveToolNames();
  const allowed = all.filter(isToolAllowedForNonOwner);
  session.setActiveToolsByName(allowed);
  console.log(`[${label}] 非主人会话，已限制工具：${all.length} → ${allowed.length}（屏蔽 bash/文件读写/凭据/状态修改，保留搜索/知识库/记忆/娱乐）`);
}

export interface ChannelChat {
  session: TuiSession;
}

/**
 * 包装会话：text_delta 聚成本轮回复，agent_end 时交给 send 发送。
 * 同一聊天的发送串行排队；任务进行中的新消息由 pi 的 followUp 队列承接。
 */
export function makeChannelChat(
  session: TuiSession,
  send: (reply: string) => Promise<void>,
  label: string,
): ChannelChat {
  let buf = "";
  let chain: Promise<void> = Promise.resolve();
  session.subscribe((event) => {
    const e = event as {
      type: string;
      assistantMessageEvent?: { type: string; delta?: string };
      message?: { role?: string; stopReason?: string; errorMessage?: string };
    };
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      buf += e.assistantMessageEvent.delta ?? "";
      return;
    }
    // 模型报错必须可见：否则错误轮无文本产出，频道表现为"静默不回话"
    if (e.type === "message_end" && e.message?.role === "assistant" && e.message.stopReason === "error") {
      console.error(`[${label}] 模型错误：${e.message.errorMessage ?? "(无信息)"}`);
      return;
    }
    if (e.type === "agent_end") {
      const reply = buf.trim();
      buf = "";
      if (!reply) return;
      chain = chain
        .then(() => send(reply))
        .catch((err) => console.error(`[${label}] 回复发送失败：`, (err as Error).message));
    }
  });
  return { session };
}
