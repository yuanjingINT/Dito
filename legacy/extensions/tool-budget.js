import { Type } from "typebox";
import { validateToolArguments } from "@earendil-works/pi-ai";
const LIMIT = 128;
const nameOf = (tool) => tool.function?.name ?? tool.toolSpec?.name ?? tool.name ?? "";
function bounded(tools) {
  if (!Array.isArray(tools) || tools.length <= LIMIT) return tools;
  const rank = (tool) => ["tool_search", "tool_call"].includes(nameOf(tool)) ? 0
    : nameOf(tool).startsWith("snowluma_") ? 2 : 1;
  return tools.map((tool, index) => ({ tool, index }))
    .sort((a, b) => rank(a.tool) - rank(b.tool) || a.index - b.index).slice(0, LIMIT).map(({ tool }) => tool);
}
function boundedGroups(tools) {
  if (!Array.isArray(tools)) return tools;
  const declarations = tools.flatMap((tool) => tool.functionDeclarations ?? []);
  if (declarations.length <= LIMIT) return bounded(tools);
  const retained = new Set(bounded(declarations));
  return tools.map((tool) => tool.functionDeclarations
    ? { ...tool, functionDeclarations: tool.functionDeclarations.filter((item) => retained.has(item)) } : tool)
    .filter((tool) => !tool.functionDeclarations || tool.functionDeclarations.length);
}
export function boundPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  let result = payload;
  for (const key of ["config", "toolConfig"]) {
    const tools = payload[key]?.tools, replacement = boundedGroups(tools);
    if (replacement !== tools) result = { ...result, [key]: { ...payload[key], tools: replacement } };
  }
  const replacement = boundedGroups(payload.tools);
  if (replacement !== payload.tools) result = { ...result, tools: replacement };
  return result;
}
export function withToolBudget(factories) {
  const definitions = new Map(), hooks = { tool_call: [], tool_result: [] };
  const wrapped = factories.map((factory) => (pi) => factory({ ...pi,
    registerTool(tool) { definitions.set(tool.name, tool); pi.registerTool(tool); },
    on(event, handler) { if (hooks[event]) hooks[event].push(handler); pi.on(event, handler); }
  }));
  return [...wrapped, (pi) => {
    pi.on("before_provider_request", (event) => boundPayload(event.payload));
    const available = () => {
      const active = new Set(pi.getActiveTools());
      return [...definitions.values()].filter((tool) => active.has(tool.name));
    };
    pi.registerTool({ name: "tool_search", label: "搜索工具", description: "查询未直接列出的工具及完整参数，再通过 tool_call 调用。支持分页。",
      parameters: Type.Object({ query: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })) }),
      async execute(_id, args) {
        const query = (args.query ?? "").toLowerCase(), offset = args.offset ?? 0, limit = args.limit ?? 10;
        const matches = available().filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(query));
        return { content: [{ type: "text", text: JSON.stringify({ total: matches.length, offset,
          next_offset: offset + limit < matches.length ? offset + limit : null,
          tools: matches.slice(offset, offset + limit).map(({ name, description, parameters }) => ({ name, description, parameters })) }) }] };
      }
    });
    pi.registerTool({ name: "tool_call", label: "调用工具", description: "调用 tool_search 查到的工具，沿用原插件、身份、模式和权限检查。",
      parameters: Type.Object({ name: Type.String(), arguments: Type.Object({}, { additionalProperties: true }) }),
      executionMode: "sequential",
      async execute(id, args, signal, onUpdate, ctx) {
        const definition = available().find((tool) => tool.name === args.name);
        if (!definition || ["tool_call", "tool_search"].includes(args.name))
          return { isError: true, content: [{ type: "text", text: "该工具未启用或当前模式/身份无权调用" }] };
        const input = validateToolArguments(definition, { name: args.name, arguments: args.arguments });
        const event = { type: "tool_call", toolName: args.name, toolCallId: id, input };
        for (const hook of hooks.tool_call) {
          const outcome = await hook(event, ctx);
          if (outcome?.block) return { isError: true, content: [{ type: "text", text: outcome.reason || "权限门阻止工具" }] };
        }
        let result = await definition.execute(id, input, signal, onUpdate, ctx);
        for (const hook of hooks.tool_result) {
          const outcome = await hook({ type: "tool_result", toolName: args.name, toolCallId: id, input, ...result }, ctx);
          if (outcome) result = { ...result, ...outcome };
        }
        return result;
      }
    });
  }];
}
