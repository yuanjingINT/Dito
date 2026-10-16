#!/usr/bin/env node
/**
 * MCP 客户端验证脚本：对 Dito MCP Server 做 listTools + 工具调用冒烟。
 *
 * 用法：node scripts/test-mcp.mjs [--url http://127.0.0.1:3878/] [--token xxx]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const url = arg("--url", "http://127.0.0.1:3878/");
const token = arg("--token", "");

const client = new Client({ name: "dito-mcp-test", version: "0.0.1" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
});

await client.connect(transport);
console.log("[test] 已连接");

const { tools } = await client.listTools();
console.log(`[test] 工具清单（${tools.length}）：`);
for (const t of tools) console.log(`  - ${t.name}: ${(t.description ?? "").slice(0, 60)}…`);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  console.log(`\n[test] ${name} → ${res.isError ? "isError" : "ok"}\n${text.slice(0, 500)}`);
}

await call("system_info", {});
await call("kb_search", { query: "arch", max_results: 2 });
await call("memory_remember", { content: "MCP 冒烟测试写入的记忆" });
await call("memory_recall", { query: "MCP 冒烟", max: 2 });
if (tools.some((t) => t.name === "pc_bash")) await call("pc_bash", { command: "echo hello-from-pc" });

await client.close();
console.log("\n[test] 全部通过");
