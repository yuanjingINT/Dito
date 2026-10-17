import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { boundPayload, withToolBudget } from "../extensions/tool-budget.js";

test("provider tools are capped while discovery, ordinary tools and original definitions remain available", () => {
  for (const flat of [false, true]) {
    const def = (name) => flat ? { name, input_schema: {} } : { type: "function", function: { name, parameters: {} } };
    const tools = [...Array.from({ length: 200 }, (_, i) => def(`snowluma_${i}`)), def("bash"), def("mcp_echo"), def("tool_search"), def("tool_call")];
    const original = { model: "fixture", tools };
    const bounded = boundPayload(original);
    assert.equal(bounded.tools.length, 128);
    assert.equal(original.tools.length, 204);
    assert.ok(bounded.tools.some((tool) => (tool.name ?? tool.function.name) === "mcp_echo"));
    assert.ok(bounded.tools.some((tool) => (tool.name ?? tool.function.name) === "tool_call"));
  }
});

test("overflow calls validate arguments and retain active-tool and permission hooks", async () => {
  const tools = new Map(), handlers = new Map();
  let active, executed = 0;
  const api = { registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler), getActiveTools: () => active ?? [...tools.keys()] };
  const factories = withToolBudget([(pi) => {
    pi.registerTool({ name: "snowluma_overflow", description: "fixture", parameters: Type.Object({ value: Type.Integer() }),
      async execute(_id, args) { executed++; return { content: [{ type: "text", text: String(args.value) }] }; } });
    pi.on("tool_call", (event) => event.input.value === -1 ? { block: true, reason: "blocked fixture" } : undefined);
  }]);
  for (const factory of factories) factory(api);
  const search = await tools.get("tool_search").execute("id", { query: "overflow" });
  assert.equal(JSON.parse(search.content[0].text).tools[0].name, "snowluma_overflow");
  const call = (arguments_) => tools.get("tool_call").execute("id", { name: "snowluma_overflow", arguments: arguments_ }, undefined, undefined, {});
  assert.equal((await call({ value: 7 })).content[0].text, "7");
  await assert.rejects(call({ value: "invalid" }));
  assert.equal((await call({ value: -1 })).isError, true);
  active = ["tool_search", "tool_call"];
  assert.equal((await call({ value: 8 })).isError, true);
  assert.equal(executed, 1);
  assert.equal(JSON.parse((await tools.get("tool_search").execute("id", { query: "overflow" })).content[0].text).total, 0);
});

test("nested Google declarations and Bedrock tool specs obey the same limit", () => {
  const definitions = [...Array.from({ length: 200 }, (_, i) => ({ name: `snowluma_${i}` })), { name: "tool_search" }, { name: "tool_call" }];
  const google = boundPayload({ config: { temperature: 0.5, tools: [{ functionDeclarations: definitions }] } });
  assert.equal(google.config.temperature, 0.5);
  assert.equal(google.config.tools[0].functionDeclarations.length, 128);
  assert.ok(google.config.tools[0].functionDeclarations.some((item) => item.name === "tool_call"));
  const bedrock = boundPayload({ toolConfig: { tools: definitions.map((tool) => ({ toolSpec: tool })) } });
  assert.equal(bedrock.toolConfig.tools.length, 128);
  assert.ok(bedrock.toolConfig.tools.some((item) => item.toolSpec.name === "tool_search"));
});
