#!/usr/bin/env node
/**
 * Mock MCP 服务器（stdio）：验证桌面端 MCP Client 接入链路。
 * 提供两个工具：echo（回声）、roll（掷骰子）。
 *
 * 用法（配到 plugins.mcp.clients）：
 *   { name: "local_echo", transport: "stdio", command: "node", args: ["<abs>/mock-mcp-server.mjs"], enabled: true }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "mock-echo", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "原样返回 message 参数，用于链路验证",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "要回声的文本" } },
        required: ["message"],
      },
    },
    {
      name: "roll",
      description: "掷一个 N 面骰子，返回点数",
      inputSchema: {
        type: "object",
        properties: { sides: { type: "number", description: "骰子面数，默认 6" } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "echo") {
    return { content: [{ type: "text", text: `echo: ${args?.message ?? ""}` }] };
  }
  if (name === "roll") {
    const sides = Number(args?.sides) || 6;
    return { content: [{ type: "text", text: `骰到了 ${1 + Math.floor(Math.random() * sides)} 点（d${sides}）` }] };
  }
  return { content: [{ type: "text", text: `未知工具 ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
