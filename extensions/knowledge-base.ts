/**
 * Dito 知识库：SQLite 存储 + 中文友好关键词检索。
 *
 * 数据目录：~/.pi/agent/dito/kb.db
 * 首次初始化时把包内置的 kb/*.md 导入为默认知识库。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { openDatabase } from "./db.js";
import { ditoDataDir, ROOT_DIR } from "./util.js";
import { countOccurrences, snippetAround, tokenize } from "./text.js";

interface KbEntry {
  id: number;
  name: string;
  title: string;
  content: string;
  source: string;
}

function kbDbPath(): string {
  return join(ditoDataDir(), "kb.db");
}

export class KnowledgeBase {
  private db: ReturnType<typeof openDatabase>;

  constructor() {
    this.db = openDatabase(kbDbPath());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.seedDefaults();
  }

  private seedDefaults(): void {
    const count = this.db.get("SELECT COUNT(*) AS c FROM kb_entries") as { c: number };
    if (count.c > 0) return;
    const kbDir = join(ROOT_DIR, "kb");
    if (!existsSync(kbDir)) return;
    const files = collectMarkdown(kbDir);
    const insertSql =
      "INSERT OR IGNORE INTO kb_entries (name, title, content, source, created_at, updated_at) VALUES (?, ?, ?, 'default', ?, ?)";
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      for (const file of files) {
        const name = file.replace(kbDir.replace(/\/+$/, "") + "/", "");
        const title = basename(name, ".md");
        const content = readFileSync(file, "utf-8");
        this.db.run(insertSql, name, title, content, now, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  search(query: string, maxResults: number): { ok: boolean; results: unknown[] } {
    const q = query.trim();
    if (!q) return { ok: true, results: [] };
    const tokens = tokenize(q);
    const phrase = q.toLowerCase();
    const rows = this.db.all("SELECT id, name, title, content, source FROM kb_entries") as KbEntry[];
    const scored: { entry: KbEntry; score: number; snippet: string }[] = [];
    for (const entry of rows) {
      const contentLower = entry.content.toLowerCase();
      const nameLower = entry.name.toLowerCase();
      const titleLower = entry.title.toLowerCase();
      let score = 0;
      const matched = new Set<string>();
      if (phrase.length > 1 && contentLower.includes(phrase)) {
        score += 90;
        matched.add(phrase);
      }
      if (phrase.length > 1 && (nameLower.includes(phrase) || titleLower.includes(phrase))) {
        score += 140;
      }
      for (const token of tokens) {
        const inContent = countOccurrences(contentLower, token);
        if (inContent > 0) {
          score += 20 + Math.min(inContent, 10) * 2;
          matched.add(token);
        }
        if (nameLower.includes(token) || titleLower.includes(token)) {
          score += 45;
          matched.add(token);
        }
      }
      if (tokens.length > 0) {
        score += (matched.size / tokens.length) * 55;
      }
      if (score <= 0) continue;
      scored.push({ entry, score, snippet: snippetAround(entry.content, tokens) });
    }
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, maxResults).map(({ entry, score, snippet }) => ({
      id: entry.id,
      name: entry.name,
      title: entry.title,
      source: entry.source,
      score: Math.round(score * 10) / 10,
      snippet,
    }));
    return { ok: true, results };
  }

  list(keyword: string): { ok: boolean; results: unknown[] } {
    const kw = keyword.trim().toLowerCase();
    const rows = this.db.all("SELECT id, name, title, source FROM kb_entries ORDER BY name") as KbEntry[];
    const results = rows
      .filter((r) => !kw || r.name.toLowerCase().includes(kw) || r.title.toLowerCase().includes(kw))
      .map((r) => ({ id: r.id, name: r.name, title: r.title, source: r.source }));
    return { ok: true, results };
  }

  read(entry: string, startLine: number, maxLines: number): string {
    const row = this.resolve(entry);
    if (!row) return `未找到知识库条目：${entry}`;
    const lines = row.content.split("\n");
    const start = Math.max(1, startLine);
    const total = lines.length;
    const selected = lines.slice(start - 1, start - 1 + maxLines);
    const end = Math.min(total, start - 1 + selected.length);
    let out = `=== ${row.name} | ${row.title} | 第 ${start}-${end} 行 / 共 ${total} 行 ===\n${selected.join("\n")}`;
    if (end < total) out += `\n\n... 还有 ${total - end} 行，用 start_line=${end + 1} 继续读`;
    return out;
  }

  upload(content: string, title: string, name?: string): string {
    const now = Date.now();
    if (!name) {
      const slug = (title || "知识笔记").replace(/[\\/:*?"<>|]/g, "-").trim();
      const date = new Date().toISOString().slice(0, 10);
      name = `chat_uploads/${date}/${slug}.md`;
    }
    const body = `# ${title || name}\n\n> 来源：用户要求保存到本地知识库\n> 上传时间：${new Date().toLocaleString("zh-CN")}\n\n${content}`;
    this.db.run(
      `INSERT INTO kb_entries (name, title, content, source, created_at, updated_at)
       VALUES (?, ?, ?, 'user', ?, ?)
       ON CONFLICT(name) DO UPDATE SET title=excluded.title, content=excluded.content, source='user', updated_at=excluded.updated_at`,
      name,
      title || name,
      body,
      now,
      now,
    );
    return `已保存到知识库：${name}`;
  }

  remove(entry: string): string {
    const row = this.resolve(entry);
    if (!row) return `未找到知识库条目：${entry}`;
    this.db.run("DELETE FROM kb_entries WHERE id=?", row.id);
    return `已删除知识库条目：${row.name}`;
  }

  stats(): string {
    const { c } = this.db.get("SELECT COUNT(*) AS c FROM kb_entries") as { c: number };
    const bySource = this.db.all("SELECT source, COUNT(*) AS c FROM kb_entries GROUP BY source") as {
      source: string;
      c: number;
    }[];
    return JSON.stringify({ ok: true, total: c, by_source: bySource }, null, 2);
  }

  private resolve(entry: string): KbEntry | undefined {
    const trimmed = entry.trim();
    let row: KbEntry | undefined;
    if (/^\d+$/.test(trimmed)) {
      row = this.db.get("SELECT id, name, title, content, source FROM kb_entries WHERE id=?", Number(trimmed)) as KbEntry;
    } else {
      row = this.db.get("SELECT id, name, title, content, source FROM kb_entries WHERE name=?", trimmed) as KbEntry;
      if (!row) {
        // 后缀匹配，容忍省略目录前缀
        row = this.db.get(
          "SELECT id, name, title, content, source FROM kb_entries WHERE name LIKE ? ORDER BY name LIMIT 1",
          `%${trimmed}`,
        ) as KbEntry;
      }
    }
    return row;
  }
}

function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

export default function knowledgeBaseExtension(pi: ExtensionAPI): void {
  const kb = new KnowledgeBase();

  pi.registerTool({
    name: "search_knowledge_base",
    label: "搜索知识库",
    description: "在本地知识库中检索，返回条目名、来源与片段。知识库内有大量经过验证的桌面端 Linux / Arch Linux 解决方案，回答此类问题时优先检索。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词或用户问题" }),
      max_results: Type.Optional(Type.Integer({ description: "最多返回条数，默认 5" })),
    }),
    async execute(_id, params) {
      const { ok, results } = kb.search(params.query, params.max_results ?? 5);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok, total_matches: results.length, results }, null, 2) }],
        details: { ok, count: results.length },
      };
    },
  });

  pi.registerTool({
    name: "read_knowledge_base",
    label: "读取知识库",
    description: "按条目 id 或名称/相对路径读取知识库条目全文（分页）。优先用 search_knowledge_base 返回的 name 或 id。",
    parameters: Type.Object({
      entry: Type.String({ description: "条目 id（数字）或名称/相对路径，如「2. Arch Linux安装与配置相关/怎么安装中文输入法.md」" }),
      start_line: Type.Optional(Type.Integer({ description: "起始行号，默认 1" })),
      max_lines: Type.Optional(Type.Integer({ description: "最多读取行数，默认 200" })),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: kb.read(params.entry, params.start_line ?? 1, params.max_lines ?? 200) }] };
    },
  });

  pi.registerTool({
    name: "upload_to_knowledge_base",
    label: "写入知识库",
    description: "新建或整体覆盖一条知识库条目。修改已有条目请先 read 再传完整 content。",
    parameters: Type.Object({
      content: Type.String({ description: "要保存的完整 Markdown 文本" }),
      title: Type.Optional(Type.String({ description: "标题，默认取文件名" })),
      name: Type.Optional(Type.String({ description: "可选：知识库相对路径，如「我的笔记/xxx.md」" })),
    }),
    async execute(_id, params) {
      const text = kb.upload(params.content, params.title ?? "", params.name);
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "list_knowledge_base",
    label: "列出知识库",
    description: "列出知识库条目（可按关键词过滤名称），仅返回 id 与名称，不返回正文。",
    parameters: Type.Object({
      keyword: Type.Optional(Type.String({ description: "按名称/标题过滤的关键词" })),
    }),
    async execute(_id, params) {
      const { ok, results } = kb.list(params.keyword ?? "");
      return { content: [{ type: "text", text: JSON.stringify({ ok, total: results.length, results }, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "remove_knowledge_base",
    label: "删除知识库条目",
    description: "按条目 id 或名称删除一条知识库条目。仅在用户明确要求删除时使用。",
    parameters: Type.Object({
      entry: Type.String({ description: "条目 id（数字）或名称/相对路径" }),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: kb.remove(params.entry) }] };
    },
  });

  pi.registerCommand("kb-stats", {
    description: "查看知识库统计",
    handler: async (_args, ctx) => {
      ctx.ui.notify(kb.stats(), "info");
    },
  });
}
