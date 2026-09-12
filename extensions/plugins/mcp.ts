/**
 * 插件：MCP Client（双向 MCP 的「接入」侧）。
 *
 * 按配置连接外部 MCP 服务器（stdio 子进程 / streamable HTTP），把远端工具
 * 以 `mcp_<服务器>_<工具>` 命名注册进 Dito 会话，与内置工具同等参与对话；
 * 受现有 tool_call 权限门覆盖。
 *
 * 配置（dito config →「MCP 服务」→ 外部 MCP 服务器）：
 *   { name, transport: "stdio"|"http", command, args, env, url, headers, enabled }
 *
 * 服务端（把 Dito 工具暴露出去）见 bin/mcp-server.ts。
 * 许可证 GPL-3.0-only，见仓库 LICENSE。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { loadConfig, type McpClientConfig } from "../util.js";
import type { DitoPlugin } from "../plugin-kernel.js";

/** 工具名只允许字母数字下划线连字符 */
function sanitizeToolName(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/[^a-zA-Z0-9_-]+/g, "_"))
    .join("_")
    .replace(/^_+|_+$/g, "");
}

const CONNECT_TIMEOUT_MS = 15_000;

/** 模块级连接缓存：同一外部服务器只连一次，多会话（含会话重建）共享 */
const clientCache = new Map<string, { client: InstanceType<typeof Client>; tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>();

async function getClient(cfg: McpClientConfig): Promise<{ client: InstanceType<typeof Client>; tools: Array<{ name: string; description?: string; inputSchema?: unknown }> } | null> {
  const key = JSON.stringify([cfg.name, cfg.transport, cfg.command, cfg.args, cfg.url]);
  const hit = clientCache.get(key);
  if (hit) return hit;
  const client = new Client({ name: "dito", version: "0.2.0" });
  try {
    const transport =
      cfg.transport === "http"
        ? new StreamableHTTPClientTransport(new URL(cfg.url ?? ""), {
            requestInit: { headers: cfg.headers ?? {} },
          })
        : new StdioClientTransport({
            command: cfg.command ?? "",
            args: cfg.args ?? [],
            env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
          });
    await withTimeout(client.connect(transport), cfg.name);
    const listed = await withTimeout(client.listTools(), cfg.name);
    const tools = listed.tools as Array<{ name: string; description?: string; inputSchema?: unknown }>;
    const entry = { client, tools };
    clientCache.set(key, entry);
    return entry;
  } catch (err) {
    console.error(`[mcp] 接入外部服务器「${cfg.name}」失败：${(err as Error).message}`);
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`)), CONNECT_TIMEOUT_MS)),
  ]);
}

async function connectAndRegister(pi: ExtensionAPI, cfg: McpClientConfig): Promise<void> {
  const shared = await getClient(cfg);
  if (!shared) return;
  const { client, tools } = shared;

  let registered = 0;
  for (const tool of tools) {
    const toolName = sanitizeToolName("mcp", cfg.name, tool.name);
    try {
      pi.registerTool({
        name: toolName,
        label: tool.name.slice(0, 24),
        description: `[MCP/${cfg.name}] ${tool.description ?? tool.name}`,
        parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
        async execute(_id, params) {
          try {
            const res = await client.callTool({
              name: tool.name,
              arguments: (params ?? {}) as Record<string, unknown>,
            });
            const text = (res.content ?? [])
              .map((c) => {
                const anyC = c as { type?: string; text?: string };
                return anyC.type === "text" ? (anyC.text ?? "") : JSON.stringify(c);
              })
              .join("\n");
            return { content: [{ type: "text", text: text.slice(0, 16000) || "(空结果)" }] };
          } catch (err) {
            return {
              content: [{ type: "text", text: `MCP 工具 ${tool.name} 调用失败：${(err as Error).message}` }],
            };
          }
        },
      });
      registered++;
    } catch (err) {
      // 会话重建后旧 ctx 变 stale：新 runner 会重新注册，这里静默跳过
      if (!String((err as Error).message).includes("stale")) {
        console.error(`[mcp] 注册工具 ${toolName} 失败：${(err as Error).message}`);
      }
    }
  }
  if (registered > 0) {
    console.log(`[mcp] 已接入外部服务器「${cfg.name}」：${registered} 个工具（mcp_${sanitizeToolName(cfg.name)}_*）`);
  }
}

export const mcpClientPlugin: DitoPlugin = {
  id: "mcp",
  name: "MCP 接入",
  description: "接入外部 MCP 服务器，把远端工具注册进对话（mcp_* 工具）。",
  icon: "mcp",
  version: "1.0.0",
  apply(ctx) {
    const cfg = loadConfig();
    if (!cfg.plugins.mcp?.enabled) return;
    const connects: Promise<void>[] = [];
    for (const clientCfg of cfg.plugins.mcp.clients ?? []) {
      if (clientCfg.enabled === false) continue;
      connects.push(connectAndRegister(ctx.pi, clientCfg));
    }
    if (connects.length > 0) {
      const ready = Promise.allSettled(connects).then(() => undefined);
      // 首轮对话前等外部服务器接入完成，避免工具注册晚于 agent 的工具快照
      ctx.pi.on("before_agent_start", async () => {
        await ready;
        return undefined;
      });
    }
  },
};

export default mcpClientPlugin;
