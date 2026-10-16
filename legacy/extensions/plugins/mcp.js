import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../util.js";
function sanitizeToolName(...parts) {
  return parts.map((p) => p.replace(/[^a-zA-Z0-9_-]+/g, "_")).join("_").replace(/^_+|_+$/g, "");
}
const CONNECT_TIMEOUT_MS = 15e3;
const clientCache = /* @__PURE__ */ new Map();
async function getClient(cfg) {
  const key = JSON.stringify([cfg.name, cfg.transport, cfg.command, cfg.args, cfg.url]);
  const hit = clientCache.get(key);
  if (hit) return hit;
  const client = new Client({ name: "dito", version: "0.2.0" });
  try {
    const transport = cfg.transport === "http" ? new StreamableHTTPClientTransport(new URL(cfg.url ?? ""), {
      requestInit: { headers: cfg.headers ?? {} }
    }) : new StdioClientTransport({
      command: cfg.command ?? "",
      args: cfg.args ?? [],
      env: { ...process.env, ...cfg.env ?? {} }
    });
    await withTimeout(client.connect(transport), cfg.name);
    const listed = await withTimeout(client.listTools(), cfg.name);
    const tools = listed.tools;
    const entry = { client, tools };
    clientCache.set(key, entry);
    return entry;
  } catch (err) {
    console.error(`[mcp] 接入外部服务器「${cfg.name}」失败：${err.message}`);
    return null;
  }
}
function withTimeout(p, what) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1e3}s）`)), CONNECT_TIMEOUT_MS))
  ]);
}
async function connectAndRegister(pi, cfg) {
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
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        async execute(_id, params) {
          try {
            const res = await client.callTool({
              name: tool.name,
              arguments: params ?? {}
            });
            const text = (res.content ?? []).map((c) => {
              const anyC = c;
              return anyC.type === "text" ? anyC.text ?? "" : JSON.stringify(c);
            }).join("\n");
            return { content: [{ type: "text", text: text.slice(0, 16e3) || "(空结果)" }] };
          } catch (err) {
            return {
              content: [{ type: "text", text: `MCP 工具 ${tool.name} 调用失败：${err.message}` }]
            };
          }
        }
      });
      registered++;
    } catch (err) {
      if (!String(err.message).includes("stale")) {
        console.error(`[mcp] 注册工具 ${toolName} 失败：${err.message}`);
      }
    }
  }
  if (registered > 0) {
    console.log(`[mcp] 已接入外部服务器「${cfg.name}」：${registered} 个工具（mcp_${sanitizeToolName(cfg.name)}_*）`);
  }
}
const mcpClientPlugin = {
  id: "mcp",
  name: "MCP 接入",
  description: "接入外部 MCP 服务器，把远端工具注册进对话（mcp_* 工具）。",
  icon: "mcp",
  version: "1.0.0",
  apply(ctx) {
    const cfg = loadConfig();
    if (!cfg.plugins.mcp?.enabled) return;
    const connects = [];
    for (const clientCfg of cfg.plugins.mcp.clients ?? []) {
      if (clientCfg.enabled === false) continue;
      connects.push(connectAndRegister(ctx.pi, clientCfg));
    }
    if (connects.length > 0) {
      const ready = Promise.allSettled(connects).then(() => void 0);
      ctx.pi.on("before_agent_start", async () => {
        await ready;
        return void 0;
      });
    }
  }
};
var stdin_default = mcpClientPlugin;
export {
  stdin_default as default,
  mcpClientPlugin
};
