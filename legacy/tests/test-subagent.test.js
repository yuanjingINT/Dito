import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveSubagentConfig } from "../extensions/subagent-config.js";
import subagentExtension, { applySubagentEvent, chooseSubagentModel, discoverSubagentProfiles, inferWorkType } from "../extensions/subagent.js";
const models = [
  {
    provider: "free",
    id: "fast",
    name: "Fast",
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128e3,
    maxTokens: 8e3
  },
  {
    provider: "paid",
    id: "pro",
    name: "Pro",
    input: ["text"],
    reasoning: true,
    cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1e6,
    maxTokens: 64e3
  }
];
test("subagent config clamps the hard limit to 100", () => {
  const config = resolveSubagentConfig({ maxAgents: 999, maxConcurrency: 999 });
  assert.equal(config.maxAgents, 100);
  assert.equal(config.maxConcurrency, 100);
});
test("subagent routing uses work type, price and budget", () => {
  assert.equal(inferWorkType("总结这段日志"), "quick");
  assert.equal(inferWorkType("修复登录 bug"), "coding");
  assert.equal(chooseSubagentModel(models, "总结这段日志").model?.id, "fast");
  assert.equal(chooseSubagentModel(models, "修复登录 bug").model?.id, "pro");
  assert.equal(chooseSubagentModel(models, "修复登录 bug", "coding", 1e-3).model?.id, "fast");
  assert.equal(chooseSubagentModel([models[0], { ...models[0], id: "unknown", contextWindow: Infinity }], "调查 API", "research").model?.id, "fast", "unknown context is not ranked as infinite model capacity");
});
test("built-in profiles are available without user agent files", () => {
  const names = discoverSubagentProfiles(process.cwd()).map((profile) => profile.name);
  assert.deepEqual(names.slice(0, 4), ["scout", "planner", "reviewer", "worker"]);
});
function resultFor(task = "test") {
  return {
    agent: "worker",
    model: "test/model",
    task,
    output: "",
    state: "running",
    toolCalls: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    estimatedCostUsd: 0,
    routeReason: "test"
  };
}
function makeTool(worker, config = {}) {
  let tool;
  let resultHook;
  subagentExtension({
    registerTool: (definition) => {
      tool = definition;
    },
    on: (event, handler) => {
      assert.equal(event, "tool_result");
      resultHook = handler;
    }
  }, config, worker);
  assert.equal(tool.name, "subagent");
  const ctx = { cwd: process.cwd(), hasUI: false, modelRegistry: { getAvailable: () => models } };
  return async (params, updates, signal) => {
    const result = await tool.execute("test", params, signal, (update) => updates.push(update), ctx);
    const intercepted = await resultHook({ toolName: "subagent", ...result, isError: false });
    return { ...result, isError: intercepted?.isError ?? false };
  };
}
test("worker events update text, model, tool activity and usage without exposing thinking", () => {
  const result = resultFor();
  assert.equal(applySubagentEvent(result, { type: "subagent_start", model: "selected/model" }), true);
  assert.equal(result.model, "selected/model");
  assert.equal(applySubagentEvent(result, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private-thinking" } }), false);
  applySubagentEvent(result, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
  assert.equal(result.output, "partial");
  applySubagentEvent(result, { type: "tool_execution_start", toolName: "read" });
  assert.equal(result.currentTool, "read");
  assert.equal(result.toolCalls, 1);
  applySubagentEvent(result, { type: "tool_execution_end", toolName: "read" });
  assert.equal(result.currentTool, void 0);
  applySubagentEvent(result, { type: "message_end", message: {
    role: "assistant",
    content: [{ type: "thinking", thinking: "private-thinking" }, { type: "text", text: "final" }],
    usage: { input: 10, output: 5, cost: { total: 0.01 } }
  } });
  assert.equal(result.output, "final");
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.cost, 0.01);
  applySubagentEvent(result, { type: "message_start", message: { role: "assistant" } });
  applySubagentEvent(result, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "next" } });
  assert.equal(result.output, "next", "a new assistant message replaces earlier output");
  applySubagentEvent(result, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" } });
  assert.equal(result.error, "provider failed");
});
test("single subagent publishes queued, running and completed tool snapshots", async () => {
  const execute = makeTool(async (profile, task, model, reason, cwd, signal, onProgress) => {
    const result2 = resultFor(task.task);
    result2.agent = profile.name;
    result2.model = `${model?.provider}/${model?.id}`;
    result2.currentTool = "read";
    result2.toolCalls = 1;
    onProgress?.(result2);
    result2.output = "public-result";
    result2.currentTool = void 0;
    result2.state = "done";
    onProgress?.(result2);
    return result2;
  });
  const updates = [];
  const result = await execute({ task: "总结日志" }, updates);
  assert.equal(updates[0].details.results[0].state, "queued");
  assert.ok(updates.some((update) => update.details.results[0].currentTool === "read"));
  assert.equal(updates[0].details.results[0].toolCalls, 0, "earlier snapshots do not change in place");
  assert.match(result.content[0].text, /完成 1\/1/);
  assert.match(result.content[0].text, /scout · 完成/);
  assert.match(result.content[0].text, /free\/fast/);
  assert.match(result.content[0].text, /public-result/);
  assert.equal(result.isError, false);
});
test("parallel subagent snapshots keep every task's progress and respect concurrency", async () => {
  let running = 0;
  let maxRunning = 0;
  const execute = makeTool(async (profile, task, model, reason, cwd, signal, onProgress) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    const result2 = resultFor(task.task);
    result2.output = `live-${task.task}`;
    onProgress?.(result2);
    await new Promise((resolve) => setTimeout(resolve, 1));
    result2.output = `done-${task.task}`;
    result2.state = "done";
    onProgress?.(result2);
    running--;
    return result2;
  }, { maxConcurrency: 1 });
  const updates = [];
  const result = await execute({ tasks: [{ task: "first" }, { task: "second" }] }, updates);
  assert.equal(maxRunning, 1);
  assert.ok(updates.every((update) => update.details.mode === "parallel" && update.details.results.length === 2));
  const mixed = updates.find((update) => update.details.results[0].state === "done" && update.details.results[1].state === "running");
  assert.ok(mixed, "finished tasks remain visible while another task is running");
  assert.match(mixed.content[0].text, /done-first/);
  assert.match(mixed.content[0].text, /second/);
  assert.match(result.content[0].text, /完成 2\/2/);
  assert.match(result.content[0].text, /done-first/);
  assert.match(result.content[0].text, /done-second/);
});
test("chain progress preserves resolved tasks, results and unstarted steps after a failure", async () => {
  const received = [];
  const execute = makeTool(async (profile, task, model, reason, cwd, signal, onProgress) => {
    received.push(task.task);
    const result2 = resultFor(task.task);
    result2.output = received.length === 1 ? "previous-result" : "failed-output";
    result2.state = received.length === 1 ? "done" : "error";
    if (result2.state === "error") result2.error = "worker failed";
    onProgress?.(result2);
    return result2;
  });
  const updates = [];
  const result = await execute({ chain: [{ task: "first" }, { task: "use {previous}" }, { task: "never" }] }, updates);
  assert.deepEqual(received, ["first", "use previous-result"]);
  assert.deepEqual(result.details.results.map((item) => item.state), ["done", "error", "skipped"]);
  assert.match(result.content[0].text, /previous-result/);
  assert.match(result.content[0].text, /worker failed/);
  assert.equal(result.isError, true);
});
test("cancelled tasks do not start workers and rejected workers produce visible failures", async () => {
  let calls = 0;
  const execute = makeTool(async () => {
    calls++;
    throw new Error("worker startup failed");
  });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await execute({ tasks: [{ task: "first" }, { task: "second" }] }, [], controller.signal);
  assert.equal(calls, 0);
  assert.ok(cancelled.details.results.every((result) => result.state === "cancelled"));
  assert.equal(cancelled.isError, true);
  const failure = await execute({ task: "retry" }, []);
  assert.equal(calls, 1, "previous reservations have been released");
  assert.equal(failure.details.results[0].state, "error");
  assert.match(failure.content[0].text, /worker startup failed/);
  assert.equal(failure.isError, true);
});
test("real pi session emits subagent tool progress and persists failures with task details", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "dito-subagent-test-"));
  let session;
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: scratch,
      agentDir: scratch,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => subagentExtension(pi, {}, async (profile, task, model2, reason, cwd, signal, onProgress) => {
          const result = resultFor(task.task);
          onProgress?.(result);
          result.state = task.task === "first" ? "done" : "error";
          result.output = `${task.task}-result`;
          if (result.state === "error") result.error = "test-worker-failed";
          return result;
        }),
        (pi) => pi.registerProvider("dito-subagent-test", {
          baseUrl: "http://127.0.0.1:1/unreachable",
          apiKey: "offline-test",
          api: "openai-completions",
          models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 32e3, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple: (model2, context) => {
            const stream = createAssistantMessageEventStream();
            const answered = context.messages.some((message2) => message2.role === "toolResult");
            const message = {
              role: "assistant",
              api: model2.api,
              provider: model2.provider,
              model: model2.id,
              timestamp: Date.now(),
              content: answered ? [{ type: "text", text: "finished" }] : [{ type: "toolCall", id: "subagent-1", name: "subagent", arguments: { tasks: [{ task: "first" }, { task: "second" }] } }],
              stopReason: answered ? "stop" : "toolUse",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
            };
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end();
            return stream;
          }
        })
      ]
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(scratch, "auth.json"), modelsPath: null, modelsStorePath: join(scratch, "models-store.json"), refreshOnCreate: false });
    ({ session } = await createAgentSession({
      cwd: scratch,
      agentDir: scratch,
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(scratch),
      noTools: "builtin",
      model: modelRuntime.getModels()[0]
    }));
    const model = modelRuntime.getModel("dito-subagent-test", "offline");
    assert.ok(model);
    await session.setModel(model);
    const events = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("delegate test tasks");
    const updates = events.filter((event) => event.type === "tool_execution_update");
    assert.ok(updates.length >= 3);
    assert.ok(updates.every((event) => event.toolName === "subagent" && event.partialResult.details.results.length === 2));
    const completed = events.find((event) => event.type === "tool_execution_end");
    assert.equal(completed.isError, true, "pi's actual result hook marks the call as failed");
    const saved = session.messages.find((message) => message.role === "toolResult");
    assert.equal(saved.isError, true);
    assert.deepEqual(saved.details.results.map((result) => result.state), ["done", "error"]);
    assert.match(saved.content[0].text, /first-result/);
    assert.match(saved.content[0].text, /test-worker-failed/);
  } finally {
    session?.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
});
