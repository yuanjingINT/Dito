/**
 * Dito MCP Server：把 Dito 的核心能力以 MCP（Model Context Protocol）工具暴露。
 *
 * - 传输：streamable HTTP，只绑 127.0.0.1:<port>（默认 3878）
 * - 本机 MCP 客户端（Claude Desktop 等）直连；手机端经中继 HTTP 隧道访问
 *   （隧道侧已完成设备鉴权，因此 MCP 层默认不再要求令牌）
 * - 工具集为「桥接工具」：直接复用 Dito 各能力模块的实现
 *   （知识库/记忆/联网搜索/系统信息），pc_bash 受 allowBash 门控
 *
 * 用法：`dito mcp` 独立运行；或由 `dito mobile` 进程内嵌启动。
 * 许可证 GPL-3.0-only，见仓库 LICENSE。
 */
import { exec } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { KnowledgeBase } from "../extensions/knowledge-base.js";
import { MemoryStore } from "../extensions/memory.js";
import { doFetch, doSearch } from "../extensions/web-search.js";
import { getSystemInfo } from "../extensions/system.js";
import { loadConfig, type McpServerConfig } from "../extensions/util.js";

const TAG = "dito mcp";
const MAX_OUTPUT = 8000;

interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

/** 危险命令拦截（与权限门同思路的轻量版：MCP 侧 pc_bash 的最后防线） */
function isDangerousCommand(cmd: string): string | null {
  const c = cmd.trim();
  const rules: [RegExp, string][] = [
    [/rm\s+(-[a-z]*\s+)*-?[a-z]*r[a-z]*f|\brm\s+-rf\b/i, "递归强制删除"],
    [/mkfs(\.|\s)/i, "格式化文件系统"],
    [/dd\s+[^\n]*of=\/dev\/(sd|nvme|hd|vd|disk|mmcblk)/i, "dd 直写块设备"],
    [/\(\)\s*\{.*\}\s*;.*\|\s*&/s, "fork 炸弹"],
    [/:\(\)\{:\|:&\};:/, "fork 炸弹"],
    [/\b(shutdown|reboot|poweroff|halt|init\s+0)\b/i, "关机/重启"],
    [/chmod\s+-R\s+777\s+\//i, "全盘放开权限"],
    [/:\s*>?\s*\/dev\/sd[a-z]/i, "直写块设备"],
  ];
  for (const [re, why] of rules) {
    if (re.test(c)) return why;
  }
  return null;
}

function buildTools(allowBash: boolean): BridgeTool[] {
  const kb = new KnowledgeBase();
  const mem = new MemoryStore();
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown, def: number): number => (typeof v === "number" && Number.isFinite(v) ? v : def);

  const tools: BridgeTool[] = [
    {
      name: "kb_search",
      description: "在主人电脑的知识库里检索资料（中文优化的本地 SQLite 检索）。返回匹配条目与摘要片段。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索关键词或短语" },
          max_results: { type: "number", description: "最多返回条数（默认 5）" },
        },
        required: ["query"],
      },
      run: async (a) => {
        const r = kb.search(str(a.query), Math.min(20, Math.max(1, num(a.max_results, 5))));
        return JSON.stringify(r.results, null, 2);
      },
    },
    {
      name: "kb_read",
      description: "读取知识库条目的正文内容（按条目名）。",
      inputSchema: {
        type: "object",
        properties: {
          entry: { type: "string", description: "条目名（kb_search/kb_list 返回的 name）" },
          start_line: { type: "number", description: "起始行（默认 1）" },
          max_lines: { type: "number", description: "最多行数（默认 200）" },
        },
        required: ["entry"],
      },
      run: async (a) => kb.read(str(a.entry), num(a.start_line, 1), Math.min(1000, Math.max(1, num(a.max_lines, 200)))),
    },
    {
      name: "kb_list",
      description: "列出知识库条目（可按关键词过滤）。",
      inputSchema: {
        type: "object",
        properties: { keyword: { type: "string", description: "过滤关键词（可空）" } },
      },
      run: async (a) => {
        const r = kb.list(str(a.keyword));
        return JSON.stringify(r.results, null, 2);
      },
    },
    {
      name: "kb_upload",
      description: "往主人电脑的知识库写入一篇 Markdown 资料（保存笔记/网页要点/整理结果）。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "标题" },
          content: { type: "string", description: "Markdown 正文" },
          name: { type: "string", description: "条目名（可选，默认按日期生成）" },
        },
        required: ["title", "content"],
      },
      run: async (a) => kb.upload(str(a.content), str(a.title), str(a.name) || undefined),
    },
    {
      name: "memory_remember",
      description: "让 Dito 长期记住一条事实/偏好（存入主人电脑的记忆库）。",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "要记住的内容，一句话" },
        },
        required: ["content"],
      },
      run: async (a) => mem.rememberFact(str(a.content), "mcp"),
    },
    {
      name: "memory_recall",
      description: "在 Dito 的记忆库里回忆与查询相关的记忆。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "回忆线索" },
          max: { type: "number", description: "最多返回条数（默认 5）" },
        },
        required: ["query"],
      },
      run: async (a) => {
        const r = mem.recall(str(a.query), Math.min(20, Math.max(1, num(a.max, 5))));
        return JSON.stringify(r.results, null, 2);
      },
    },
    {
      name: "web_search",
      description: "在电脑上联网搜索（自动聚合 Tavily/DuckDuckGo 等可用搜索源）。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词" },
          max_results: { type: "number", description: "最多返回条数（默认 5）" },
        },
        required: ["query"],
      },
      run: async (a) => doSearch(str(a.query), Math.min(10, Math.max(1, num(a.max_results, 5)))),
    },
    {
      name: "web_fetch",
      description: "从电脑上抓取网页正文（HTML 转纯文本，截断保存）。",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "网页 URL" } },
        required: ["url"],
      },
      run: async (a) => doFetch(str(a.url), "text"),
    },
    {
      name: "system_info",
      description: "获取主人电脑的系统信息（发行版/内核/CPU/内存等）。",
      inputSchema: { type: "object", properties: {} },
      run: async () => JSON.stringify(getSystemInfo(), null, 2),
    },
  ];

  if (allowBash) {
    tools.push({
      name: "pc_bash",
      description: "在主人电脑上执行 shell 命令并返回输出。危险命令会被拦截；请优先使用上面的专用工具。",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令" },
          timeout_seconds: { type: "number", description: "超时秒数（默认 30，最大 300）" },
        },
        required: ["command"],
      },
      run: (a) =>
        new Promise<string>((resolve) => {
          const cmd = str(a.command).trim();
          const why = isDangerousCommand(cmd);
          if (why) {
            resolve(`已拦截危险命令（${why}）：${cmd}`);
            return;
          }
          const timeout = Math.min(300, Math.max(1, num(a.timeout_seconds, 30))) * 1000;
          exec(cmd, { timeout, maxBuffer: 1024 * 1024, encoding: "utf-8" }, (err, stdout, stderr) => {
            const out = [stdout?.toString(), stderr?.toString()].filter(Boolean).join("\n").trim();
            let text = out || "(无输出)";
            if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + `\n…（输出过长已截断）`;
            if (err && err.killed) text += `\n（超时被终止）`;
            else if (err && typeof err.code === "number" && err.code !== 0) text += `\n（退出码 ${err.code}）`;
            resolve(text);
          });
        }),
    });
  }

  return tools;
}

export interface McpServerHandle {
  port: number;
  close(): Promise<void>;
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function startMcpServer(serverCfg?: McpServerConfig): Promise<McpServerHandle> {
  const cfg = serverCfg ?? loadConfig().plugins.mcp.server;
  const tools = buildTools(!!cfg.allowBash);
  const toolDefs = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 鉴权：配置了 token 才强制 Bearer（隧道访问由中继完成设备鉴权）
    if (cfg.token) {
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (auth !== cfg.token) {
        jsonError(res, 401, "unauthorized");
        return;
      }
    }
    if (req.method !== "POST") {
      jsonError(res, 405, "MCP: use POST (stateless streamable HTTP)");
      return;
    }

    // 无状态模式：每个请求独立的 Server + transport（官方推荐写法），共享同一份工具实现
    const server = new Server({ name: "dito", version: "0.2.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return { content: [{ type: "text", text: `未知工具：${name}` }], isError: true };
      }
      try {
        const text = await tool.run((args ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text: text.slice(0, MAX_OUTPUT * 4) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `工具执行失败：${(err as Error).message}` }], isError: true };
      }
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // 不预读 body：transport.handleRequest 自己消费请求流
    try {
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) jsonError(res, 500, "internal error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(cfg.port, "127.0.0.1", resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;
  console.log(`[${TAG}] MCP Server 已就绪：http://127.0.0.1:${port}/（工具 ${tools.length} 个${cfg.allowBash ? "，含 pc_bash" : ""}）`);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}

/** `dito mcp` 独立运行入口 */
export async function runMcpServerMain(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.plugins.mcp.enabled || !cfg.plugins.mcp.server.enabled) {
    console.error("MCP 服务未启用：在 `dito config` →「MCP 服务」里开启。");
    process.exit(1);
  }
  const handle = await startMcpServer(cfg.plugins.mcp.server);
  const stop = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`[${TAG}] 按 Ctrl-C 退出。`);
  // 保活
  setInterval(() => {}, 1 << 30);
}
