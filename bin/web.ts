/**
 * Dito Web UI 服务端。
 *
 * 依赖零第三方运行时包：只使用 Node 内置 http / fs / url。
 * - 静态资源服务（web-ui/）
 * - REST API：配置读写、人设/身份、模型刷新、知识库、记忆
 * - 对话流：SSE（Server-Sent Events）+ POST /api/chat
 *
 * 用法：dito web [--port 3877]
 */
import http from "node:http";
import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { loadConfig, saveConfig, listFiles, readPersona, readIdentity, PERSONAS_DIR, IDENTITIES_DIR, fetchModelList, applyFetchedModels, backfillPresetModels, type DitoConfig } from "../extensions/util.js";
import { isPluginEnabled, pluginConfig } from "../extensions/plugin-kernel.js";
import { DITO_PLUGINS } from "../extensions/plugins/index.js";
import { hasPromptBundle } from "../extensions/prompt-crypto.js";
import { KnowledgeBase } from "../extensions/knowledge-base.js";
import { MemoryStore } from "../extensions/memory.js";
import { setMode, getMode, MODE_DEFS, readOnlyTools, MODE_ORDER, type DitoMode } from "../extensions/mode.js";
import { createSession, describeModelSelection, type TuiSession } from "./session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_UI_DIR = join(__dirname, "..", "web-ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function parsePort(args: string[]): number {
  const env = Number(process.env.DITO_WEB_PORT);
  if (Number.isFinite(env) && env >= 0 && (process.env.DITO_WEB_PORT || "").trim() !== "") return env;
  const flagIdx = args.findIndex((a) => a === "--port" || a === "-p");
  if (flagIdx >= 0 && Number(args[flagIdx + 1]) >= 0) return Number(args[flagIdx + 1]);
  return 3877;
}

// ── 会话状态 ────────────────────────────────────────────────────
let session: TuiSession | null = null;
let sessionModelName = "";
let standardTools: string[] = [];
const sseClients = new Set<http.ServerResponse>();

function applyMode(mode: DitoMode): void {
  setMode(mode);
  if (session) {
    if (mode === "chat") session.setActiveToolsByName([]);
    else if (mode === "plan") session.setActiveToolsByName(readOnlyTools());
    else session.setActiveToolsByName(standardTools);
    session.setThinkingLevel(MODE_DEFS[mode].thinkingLevel);
  }
}

async function ensureSession(fresh = false): Promise<void> {
  if (session && !fresh) return;
  if (session) { try { session.dispose(); } catch { /* noop */ } }
  const created = await createSession({ fresh });
  session = created.session;
  sessionModelName = created.modelName;
  standardTools = session.getActiveToolNames();
  applyMode(getMode());
}

function broadcast(obj: unknown): void {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { /* ignore */ }
  }
}

// 把 pi 会话事件翻译成 Web UI 事件
function subscribeSessionEvents(): void {
  if (!session) return;
  const seenCalls = new Set<string>();
  session.subscribe((event) => {
    const e = event as {
      type: string;
      assistantMessageEvent?: { type: string; delta?: string };
      toolName?: string;
      toolCallId?: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
      message?: { role?: string; stopReason?: string; errorMessage?: string };
    };
    const ame = e.assistantMessageEvent;

    if (e.type === "message_update" && ame) {
      if (ame.type === "thinking_start") broadcast({ type: "thinking_start" });
      else if (ame.type === "thinking_delta") broadcast({ type: "thinking_delta", delta: ame.delta });
      else if (ame.type === "thinking_end") broadcast({ type: "thinking_end" });
      else if (ame.type === "text_delta") broadcast({ type: "text_delta", delta: ame.delta });
      return;
    }
    if (e.type === "tool_execution_start" && e.toolName) {
      if (e.toolCallId && seenCalls.has(e.toolCallId)) return;
      if (e.toolCallId) seenCalls.add(e.toolCallId);
      broadcast({ type: "tool_start", toolName: e.toolName, args: e.args });
      return;
    }
    if (e.type === "tool_execution_end" && e.toolName) {
      broadcast({ type: "tool_end", toolName: e.toolName, isError: !!e.isError, result: e.result });
      return;
    }
    if (e.type === "message_end" && e.message?.role === "assistant" && e.message.stopReason === "error") {
      const msg = e.message.errorMessage || "";
      broadcast({
        type: "error",
        message: /429|rate limit|限流/i.test(msg) ? "opencode 免费额度限流，请稍后重试。" : msg,
      });
      return;
    }
    if (e.type === "agent_end") {
      broadcast({ type: "done" });
      return;
    }
  });
}

// ── REST 工具 ───────────────────────────────────────────────────
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) { reject(new Error("请求体过大")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("JSON 解析失败")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendText(res: http.ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

// ── KB 惰性单例（首次访问才建库，避免每次请求重建） ────────────────
let kbInstance: KnowledgeBase | null = null;
let memoryInstance: MemoryStore | null = null;
function kb(): KnowledgeBase { if (!kbInstance) kbInstance = new KnowledgeBase(); return kbInstance; }
function mem(): MemoryStore { if (!memoryInstance) memoryInstance = new MemoryStore(); return memoryInstance; }

// ── 静态文件 ────────────────────────────────────────────────────
function serveStatic(res: http.ServerResponse, pathname: string): void {
  let p = pathname === "/" ? "/index.html" : pathname;
  // 防止路径逃逸
  const target = join(WEB_UI_DIR, decodeURIComponent(p));
  if (!target.startsWith(WEB_UI_DIR)) { sendText(res, 403, "Forbidden"); return; }
  if (!existsSync(target) || !statSync(target).isFile()) {
    sendText(res, 404, "Not Found");
    return;
  }
  const ext = extname(target).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  if (target.endsWith(".json")) {
    res.end(readFileSync(target, "utf-8"));
  } else {
    createReadStream(target).pipe(res);
  }
}

// ── 路由 ────────────────────────────────────────────────────────
async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const method = req.method || "GET";
  const parts = pathname.split("/").filter(Boolean); // e.g. ["api","config"]

  try {
    // GET /api/config
    if (pathname === "/api/config" && method === "GET") {
      return sendJson(res, 200, loadConfig());
    }
    // PUT /api/config
    if (pathname === "/api/config" && method === "PUT") {
      const body = await readBody(req);
      const cfg = body as Record<string, unknown>;
      // 简单校验：必须有 providers 字段
      if (!Array.isArray(cfg.providers)) throw new Error("配置格式不正确：缺少 providers");
      saveConfig(cfg as unknown as DitoConfig);
      return sendJson(res, 200, { ok: true, path: join(homedir(), ".pi", "agent", "dito", "config.json") });
    }

    // GET /api/personas  /api/identities
    // 加密包启用时只返回名称，不向前端泄露提示词正文（Dito 后端仍可解密读取全部提示词）。
    if (pathname === "/api/personas" && method === "GET") {
      const names = listFiles(PERSONAS_DIR, ".md");
      if (hasPromptBundle()) return sendJson(res, 200, names.map((name) => ({ name })));
      return sendJson(res, 200, names.map((name) => ({ name, content: readPersona(name) })));
    }
    if (pathname === "/api/identities" && method === "GET") {
      const names = listFiles(IDENTITIES_DIR, ".md");
      if (hasPromptBundle()) return sendJson(res, 200, names.map((name) => ({ name })));
      return sendJson(res, 200, names.map((name) => ({ name, content: readIdentity(name) })));
    }

    // GET /api/plugins —— 插件清单（含启用状态，供 Web UI 配置页渲染）
    if (pathname === "/api/plugins" && method === "GET") {
      const cfg = loadConfig();
      return sendJson(res, 200, {
        kernel: "cordis-style",
        plugins: DITO_PLUGINS.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          icon: plugin.icon,
          version: plugin.version,
          enabled: isPluginEnabled(cfg, plugin),
          alwaysOn: plugin.alwaysOn ?? false,
          dependencies: plugin.dependencies ?? [],
          config: pluginConfig(cfg, plugin),
        })),
      });
    }

    // GET /api/status —— 当前模型信息
    if (pathname === "/api/status" && method === "GET") {
      const info = await describeModelSelection();
      return sendJson(res, 200, { ...info, mode: getMode() });
    }

    // POST /api/mode
    if (pathname === "/api/mode" && method === "POST") {
      const body = await readBody(req);
      const mode = String(body.mode || "standard") as DitoMode;
      if (!MODE_ORDER.includes(mode)) throw new Error("无效模式");
      applyMode(mode);
      return sendJson(res, 200, { ok: true, mode });
    }

    // POST /api/session/new
    if (pathname === "/api/session/new" && method === "POST") {
      await ensureSession(true);
      subscribeSessionEvents();
      return sendJson(res, 200, { ok: true, modelName: sessionModelName });
    }

    // GET /api/chat/stream —— SSE
    if (pathname === "/api/chat/stream" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "greeting" })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // POST /api/chat —— 触发一轮对话
    if (pathname === "/api/chat" && method === "POST") {
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) throw new Error("消息不能为空");
      await ensureSession(false);
      subscribeSessionEvents();
      broadcast({ type: "turn_start" });
      // 不 await 完成：让 SSE 实时推流，prompt 完成时会 broadcast done
      void session.prompt(text).catch((err) => {
        broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) });
        broadcast({ type: "done" });
      });
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/providers/:id/refresh-models
    if (parts[1] === "providers" && parts[3] === "refresh-models" && method === "POST") {
      const id = decodeURIComponent(parts[2]);
      const cfg = loadConfig();
      const p = cfg.providers.find((x) => x.id === id);
      if (!p) throw new Error("供应商不存在");
      let list: { id: string; name: string }[] = [];
      try { list = await fetchModelList(p); } catch { list = []; }
      if (p.apiKey.trim() === "") list = list.filter((m) => m.id.endsWith("-free"));
      // 合并而非替换：拉取失败（空列表）绝不清空现有模型，历史 bug 教训
      const updated = applyFetchedModels(p, list);
      if (!updated) backfillPresetModels(p);
      return sendJson(res, 200, { ok: updated || p.models.length > 0, updated, models: p.models });
    }

    // ── 知识库 ──────────────────────────────────────────────
    if (pathname === "/api/kb" && method === "GET") {
      const keyword = url.searchParams.get("keyword") || "";
      const stats = JSON.parse(kb().stats());
      const { results } = kb().list(keyword);
      return sendJson(res, 200, { stats, results });
    }
    if (pathname === "/api/kb" && method === "POST") {
      const body = await readBody(req);
      const title = String(body.title || "").trim();
      const content = String(body.content || "");
      if (!title) throw new Error("标题不能为空");
      const out = kb().upload(content, title);
      return sendJson(res, 200, { ok: true, message: out });
    }
    if (parts[1] === "kb" && parts[2] && method === "GET") {
      const id = decodeURIComponent(parts[2]);
      // 直接用底层列表匹配
      const { results } = kb().list("");
      const row = results.find((r) => String((r as { id: number }).id) === id);
      if (!row) return sendJson(res, 404, { error: "未找到" });
      // kb().read() 返回带页眉的纯文本；此处直接取数据库原始 content 更干净
      const raw = kb().read(id, 1, 10000);
      // 去掉「=== name | title | 第 x-y 行 / 共 n 行 ===」头
      const content = raw.replace(/^===.*===\n/, "");
      return sendJson(res, 200, { id, title: (row as { title: string }).title, name: (row as { name: string }).name, content });
    }
    if (parts[1] === "kb" && parts[2] && method === "DELETE") {
      const id = decodeURIComponent(parts[2]);
      const out = kb().remove(id);
      if (out.startsWith("未找到")) return sendJson(res, 404, { error: out });
      return sendJson(res, 200, { ok: true, message: out });
    }

    // ── 记忆 ─────────────────────────────────────────────────
    if (pathname === "/api/memory" && method === "GET") {
      const query = url.searchParams.get("query") || "";
      const stats = JSON.parse(mem().stats());
      const results = query ? mem().recall(query, 10).results : [];
      return sendJson(res, 200, { facts: stats.facts, episodes: stats.episodes, results });
    }
    if (pathname === "/api/memory" && method === "DELETE") {
      mem().clear();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "API not found" });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── 服务器 ────────────────────────────────────────────────────
export async function runWebServer(port = parsePort(process.argv.slice(2))): Promise<void> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return handleApi(req, res, pathname).catch((err) => {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    }
    return serveStatic(res, pathname);
  });

  return new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", async () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      // 预热：描述模型选择（不建立会话），失败不阻塞
      let modelPreview = "未选";
      try {
        const info = await describeModelSelection();
        modelPreview = info.modelName || "无可用模型";
      } catch { /* ignore */ }

      console.log("");
      console.log("  🫧 Dito Web UI 已启动");
      console.log("");
      console.log(`  ➜  本地地址：  http://127.0.0.1:${actualPort}`);
      console.log(`  ➜  模型：      ${modelPreview}`);
      console.log(`  ➜  配置目录：  ~/.pi/agent/dito/`);
      console.log("");
      console.log("  按 Ctrl+C 退出。其他终端也可用 `dito web --port 端口` 指定端口。");
      console.log(`DITO_WEB_ACTUAL_PORT=${actualPort}`);
      console.log("");
      resolve();
    });
  });
}

// 直接运行（打包/开发用）：node/tsx 直接执行本文件时启动
const entry = process.argv[1] ? `file://${process.argv[1].replace(/\\/g, "/")}` : "";
if (entry && import.meta.url === entry) {
  runWebServer().catch((err) => {
    console.error("[Dito Web] 启动失败：", err);
    process.exit(1);
  });
}
