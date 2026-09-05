/**
 * Dito 记忆：SQLite 存储「知识点（facts）」与「经历/日记（episodes）」。
 *
 * - 自动记忆：每次任务完成（agent_end）后把「用户消息 + 助手最终回复」写入短日记，内容带本机系统时间。
 * - 工具：remember_fact / recall_memories / recall_past_events。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { openDatabase } from "./db.js";
import { ditoDataDir, loadConfig } from "./util.js";
import { countOccurrences, snippetAround, tokenize } from "./text.js";

interface MemoryRow {
  id: number;
  content: string;
  source: string;
  kind: string;
  created_at: number;
}

/**
 * 记忆库 scope：频道会话为每个聊天设置独立 scope（每个聊天一个 memory-<scope>.db），
 * 终端不设 scope 用全局 memory.db——不同聊天之间的记忆互相隔离。
 */
let memoryScope: string | undefined;
export function setMemoryScope(scope?: string): void {
  memoryScope = scope ? scope.replace(/[^a-zA-Z0-9_-]/g, "_") : undefined;
}

function memoryDbPath(): string {
  return memoryScope
    ? join(ditoDataDir(), `memory-${memoryScope}.db`)
    : join(ditoDataDir(), "memory.db");
}

function extractText(message: { role: string; content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: string; text: string } => {
      return !!block && typeof block === "object" && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

/** 本机系统时间，可读格式：2025-08-16 18:50:23 周六 (UTC+8) */
function formatSystemTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const tz = -d.getTimezoneOffset() / 60;
  const tzStr = `UTC${tz >= 0 ? "+" : ""}${tz}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${weekdays[d.getDay()]} (${tzStr})`;
}

export class MemoryStore {
  private db: ReturnType<typeof openDatabase>;

  constructor() {
    this.db = openDatabase(memoryDbPath());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        source TEXT DEFAULT 'user',
        confidence REAL DEFAULT 1.0,
        recall_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        user_message TEXT NOT NULL DEFAULT '',
        assistant_message TEXT NOT NULL DEFAULT '',
        retention TEXT NOT NULL DEFAULT 'short_term',
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );
    `);
  }

  rememberFact(content: string, source: string): string {
    const now = Date.now();
    this.db.run(
      `INSERT INTO facts (content, source, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      content.trim(),
      source.trim() || "user",
      now,
      now,
    );
    return `记下了：${content.trim()}`;
  }

  rememberEpisode(user: string, assistant: string): void {
    const now = Date.now();
    const expires = now + 7 * 24 * 3600 * 1000; // 短日记保留 7 天
    const content = `[系统时间 ${formatSystemTime(new Date(now))}]\n用户：${user}\nDito：${assistant}`;
    this.db.run(
      `INSERT INTO episodes (content, user_message, assistant_message, retention, created_at, expires_at)
       VALUES (?, ?, ?, 'short_term', ?, ?)`,
      content,
      user,
      assistant,
      now,
      expires,
    );
  }

  recall(query: string, max: number): { ok: boolean; results: unknown[] } {
    const tokens = tokenize(query);
    const phrase = query.toLowerCase();
    const facts = this.db.all("SELECT id, content, source, created_at FROM facts") as MemoryRow[];
    const episodes = this.db.all(
      "SELECT id, content, 'diary' AS source, created_at FROM episodes WHERE expires_at > ? OR expires_at IS NULL",
      Date.now(),
    ) as MemoryRow[];

    const hits: { id: number; kind: string; source: string; score: number; snippet: string; timestamp: string }[] = [];
    for (const row of facts) hits.push(this.scoreRow(row, "fact", phrase, tokens));
    for (const row of episodes) hits.push(this.scoreRow(row, "episode", phrase, tokens));

    hits.sort((a, b) => b.score - a.score);
    const results = hits.slice(0, max).map((h) => ({
      id: h.id,
      kind: h.kind,
      source: h.source,
      score: Math.round(h.score * 10) / 10,
      snippet: h.snippet,
      timestamp: h.timestamp,
    }));
    return { ok: true, results };
  }

  recallEvents(query: string, max: number): { ok: boolean; results: unknown[] } {
    const all = this.recall(query, 100);
    const events = (all.results as { kind: string }[]).filter((r) => r.kind === "episode").slice(0, max);
    return { ok: true, results: events };
  }

  private scoreRow(
    row: MemoryRow,
    kind: string,
    phrase: string,
    tokens: string[],
  ): { id: number; kind: string; source: string; score: number; snippet: string; timestamp: string } {
    const contentLower = row.content.toLowerCase();
    let score = 0;
    const matched = new Set<string>();
    if (phrase.length > 1 && contentLower.includes(phrase)) {
      score += 90;
      matched.add(phrase);
    }
    for (const token of tokens) {
      const n = countOccurrences(contentLower, token);
      if (n > 0) {
        score += 20 + Math.min(n, 10) * 2;
        matched.add(token);
      }
    }
    if (tokens.length > 0) score += (matched.size / tokens.length) * 55;
    return {
      id: row.id,
      kind,
      source: row.source,
      score,
      snippet: snippetAround(row.content, tokens, 80),
      timestamp: new Date(row.created_at).toISOString(),
    };
  }

  stats(): string {
    const facts = this.db.get("SELECT COUNT(*) AS c FROM facts") as { c: number };
    const episodes = this.db.get("SELECT COUNT(*) AS c FROM episodes") as { c: number };
    return JSON.stringify({ ok: true, facts: facts.c, episodes: episodes.c }, null, 2);
  }

  clear(): string {
    this.db.exec("DELETE FROM facts; DELETE FROM episodes;");
    return "记忆已经清空了";
  }
}

export default function memoryExtension(pi: ExtensionAPI): void {
  const memory = new MemoryStore();
  let lastRecorded = "";

  // 自动记忆：每次任务完成（agent_end）后，把「用户消息 + 助手最终回复」写入短日记，内容带系统时间。
  pi.on("agent_end", (event) => {
    if (!loadConfig().plugins.memory.autoDiary) return undefined;

    const messages = event.messages as { role: string; content?: unknown }[];
    let user = "";
    let assistant = "";
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = extractText(msg);
        if (text) user = text;
      } else if (msg.role === "assistant") {
        const text = extractText(msg);
        if (text) assistant = text;
      }
    }
    if (!user || !assistant) return undefined;

    // 去重：自动重试/延续导致的连续 agent_end 不重复记录同一轮。
    const key = `${user}\n${assistant}`;
    if (key === lastRecorded) return undefined;
    lastRecorded = key;

    memory.rememberEpisode(user, assistant);
    return undefined;
  });

  pi.registerTool({
    name: "remember_fact",
    label: "记住知识点",
    description: "把一条重要知识点/事实记入长期记忆。用于用户明确要求记住的内容、或对话中值得长期记住的信息。",
    parameters: Type.Object({
      content: Type.String({ description: "要记住的知识点内容，一句话表达清楚" }),
      source: Type.Optional(Type.String({ description: "来源说明，如「用户告知」「网络搜索」" })),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: memory.rememberFact(params.content, params.source ?? "") }] };
    },
  });

  pi.registerTool({
    name: "recall_memories",
    label: "回忆记忆",
    description: "按关键词检索记忆（知识点 + 历史对话/经历），返回相关片段。回答涉及用户之前说过的事情时先回忆。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词或用户问题" }),
      max_results: Type.Optional(Type.Integer({ description: "最多返回条数，默认 5" })),
    }),
    async execute(_id, params) {
      const { ok, results } = memory.recall(params.query, params.max_results ?? 5);
      return { content: [{ type: "text", text: JSON.stringify({ ok, total_matches: results.length, results }, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "recall_past_events",
    label: "回忆过往经历",
    description: "检索历史对话/发生过的事（仅经历，不含知识点）。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词" }),
      max_results: Type.Optional(Type.Integer({ description: "最多返回条数，默认 5" })),
    }),
    async execute(_id, params) {
      const { ok, results } = memory.recallEvents(params.query, params.max_results ?? 5);
      return { content: [{ type: "text", text: JSON.stringify({ ok, total_matches: results.length, results }, null, 2) }] };
    },
  });

  pi.registerCommand("memory-stats", {
    description: "查看记忆统计",
    handler: async (_args, ctx) => {
      ctx.ui.notify(memory.stats(), "info");
    },
  });

  pi.registerCommand("memory-clear", {
    description: "清空全部记忆",
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm("清空记忆", "要把我的记忆整个清掉吗？清完可回不来，想清楚再确认。");
      if (ok) ctx.ui.notify(memory.clear(), "info");
    },
  });
}
