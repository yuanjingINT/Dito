import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSubagentConfig } from "../extensions/subagent-config.js";
import { chooseSubagentModel, discoverSubagentProfiles, inferWorkType } from "../extensions/subagent.js";

const models = [
  {
    provider: "free", id: "fast", name: "Fast", input: ["text"], reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_000,
  },
  {
    provider: "paid", id: "pro", name: "Pro", input: ["text"], reasoning: true,
    cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 64_000,
  },
];

test("subagent config clamps the hard limit to 100", () => {
  const config = resolveSubagentConfig({ maxAgents: 999, maxConcurrency: 999 });
  assert.equal(config.maxAgents, 100);
  assert.equal(config.maxConcurrency, 100);
});

test("subagent routing uses work type, price and budget", () => {
  assert.equal(inferWorkType("总结这段日志"), "quick");
  assert.equal(inferWorkType("修复登录 bug"), "coding");
  assert.equal(chooseSubagentModel(models as any, "总结这段日志").model?.id, "fast");
  assert.equal(chooseSubagentModel(models as any, "修复登录 bug").model?.id, "pro");
  assert.equal(chooseSubagentModel(models as any, "修复登录 bug", "coding", 0.001).model?.id, "fast");
});

test("built-in profiles are available without user agent files", () => {
  const names = discoverSubagentProfiles(process.cwd()).map((profile) => profile.name);
  assert.deepEqual(names.slice(0, 4), ["scout", "planner", "reviewer", "worker"]);
});
