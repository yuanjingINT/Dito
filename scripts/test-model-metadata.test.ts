import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { cachedModelInfo, fetchEndpointModels, parseModelInfo, tokenLimit } from "../extensions/model-metadata.js";
import { registerContextCompaction, resolveCompactionBudget, resolveContextWindow } from "../extensions/context-compaction.js";
import { applyRuntimeModelMetadata, modelContextFields, registerProviders } from "../extensions/provider.js";
import { applyFetchedModels, defaultConfig, fetchModelList, refreshProviderModelMetadata, saveConfig, type ProviderConfig } from "../extensions/util.js";
import { buildModelsJson } from "../bin/session.js";

const root = mkdtempSync(join(tmpdir(), "dito-model-metadata-test-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
after(() => { if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir; rmSync(root, { recursive: true, force: true }); });
function provider(id: string): ProviderConfig {
  return { id, name: id, baseUrl: `https://${id}.example/v1`, api: "openai-completions", apiKey: "test-key", models: [{ id: "model", reasoning: true, input: ["text"], maxTokens: 1000 }] };
}
function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }); }

test("parses context and output limits from API formats without inferring them from model names", () => {
  const examples = [
    { id: "m", context_length: 54321, top_provider: { max_completion_tokens: 4321 } },
    { id: "m", context_window: "54321", max_output_tokens: "4321" },
    { id: "m", contextWindow: 54321, maxTokens: 4321 },
    { id: "m", limit: { context: 54321, output: 4321 } },
    { id: "m", inputTokenLimit: 54321, outputTokenLimit: 4321 },
  ];
  for (const example of examples) {
    assert.equal(parseModelInfo(example)?.contextWindow, 54321);
    assert.equal(parseModelInfo(example)?.maxTokens, 4321);
  }
  assert.equal(parseModelInfo({ id: "m-128k" })?.contextWindow, undefined);
  for (const value of [0, -1, Infinity, NaN, "bad", "", true, 0.5]) assert.equal(tokenLimit(value), undefined);
  assert.equal(parseModelInfo(null), undefined);
});

test("provider API context wins over old config and metadata survives model merging", async (t) => {
  const p = provider("api-metadata");
  p.models[0].contextWindow = 10000;
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    assert.equal(String(url), `${p.baseUrl}/models`);
    assert.equal(init.headers.Authorization, "Bearer test-key");
    return json({ data: [{ id: "model", name: "Live model", context_length: 98765, max_output_tokens: 7000 }] });
  });
  const list = await fetchModelList(p);
  assert.equal(applyFetchedModels(p, list), true);
  assert.equal(p.models[0].contextWindow, 98765);
  assert.equal(p.models[0].maxTokens, 7000);
  assert.equal(p.models[0].reasoning, true, "missing metadata retains configured capabilities");
  assert.equal(p.models[0].name, "Live model");
  assert.equal(modelContextFields(p, { id: "model", maxTokens: 1000 }).contextWindow, 98765);
});

test("missing endpoint limits use provider-specific live catalog data without sharing credentials", async (t) => {
  const p = provider("catalog-metadata");
  const dir = join(root, "catalog-fallback");
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    calls.push(String(url));
    if (String(url).endsWith("/models")) return json({ data: [{ id: "model" }] });
    assert.equal(String(url), "https://models.dev/api.json");
    assert.equal(init.headers, undefined, "catalog requests never receive the provider key");
    return json({ [p.id]: { models: { model: { id: "model", limit: { context: 76543, output: 2048 } } } }, unrelated: { models: { model: { id: "model", limit: { context: 999999 } } } } });
  });
  const list = await fetchEndpointModels(p, dir);
  assert.equal(list[0].contextWindow, 76543);
  assert.equal(cachedModelInfo(p, "model", dir)?.contextWindow, 76543);
  await fetchEndpointModels(p, dir);
  assert.equal(calls.length, 2, "both endpoint and catalog are cached");
  for (const name of readdirSync(dir)) assert.ok(!readFileSync(join(dir, name), "utf8").includes("test-key"));
  const freshModule = await import(`${new URL("../extensions/model-metadata.ts", import.meta.url)}?fresh-cache-read`);
  assert.equal(freshModule.cachedModelInfo(p, "model", dir)?.contextWindow, 76543, "a fresh cache instance restores persisted API/catalog metadata");
});

test("Ollama obtains its configured context through /api/show", async (t) => {
  const p = provider("ollama");
  p.apiKey = "";
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    urls.push(String(url));
    assert.deepEqual(init.headers.Authorization, undefined);
    if (String(url).endsWith("/models")) return json({ data: [{ id: "model" }] });
    assert.equal(String(url), "https://ollama.example/api/show");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { model: "model" });
    return json({ parameters: "num_ctx 12288\nstop hello", model_info: { "llama.context_length": 131072 } });
  });
  const list = await fetchEndpointModels(p, join(root, "ollama"));
  assert.equal(list[0].contextWindow, 12288, "configured serving context takes precedence over architecture capacity");
  assert.equal(urls.length, 2);
});

test("outages retain successful metadata and API refresh can update cached windows", async (t) => {
  const p = provider("refresh-metadata");
  const dir = join(root, "refresh");
  let mode = "initial";
  t.mock.method(globalThis, "fetch", async () => {
    if (mode === "offline") throw new Error("offline");
    return json({ data: [{ id: "model", context_length: mode === "updated" ? 65432 : 45678 }] });
  });
  assert.equal((await fetchEndpointModels(p, dir))[0].contextWindow, 45678);
  mode = "offline";
  assert.equal((await fetchEndpointModels(p, dir, { force: true }))[0].contextWindow, 45678);
  mode = "updated";
  assert.equal((await fetchEndpointModels(p, dir, { force: true }))[0].contextWindow, 65432);
  assert.equal(cachedModelInfo(p, "model", dir)?.contextWindow, 65432);
});

test("unknown models stay unknown, are not serialized as null, and do not use a fabricated compaction threshold", async (t) => {
  const p = provider("unknown-metadata");
  t.mock.method(globalThis, "fetch", async (url: any) => String(url).endsWith("/models") ? json({ data: [{ id: "model" }] }) : json({}));
  const list = await fetchModelList(p);
  applyFetchedModels(p, list);
  assert.equal(p.models[0].contextWindow, undefined);
  assert.equal(resolveContextWindow(undefined), Infinity);
  const budget = resolveCompactionBudget({});
  assert.equal(budget.thresholdTokens, Infinity);
  assert.equal(budget.enabled, true, "actual overflow recovery remains available");
  assert.ok(Number.isFinite(budget.reserveTokens));
  const cfg = defaultConfig();
  cfg.providers = [p];
  const parsed = JSON.parse(buildModelsJson(false, cfg));
  assert.ok(!("contextWindow" in parsed.providers[p.id].models[0]));
  assert.ok(defaultConfig().providers.every((provider) => provider.models.every((model) => model.contextWindow === undefined)));
});

test("model endpoint overrides fetch limits from their own endpoints", async (t) => {
  const p = provider("endpoint-metadata");
  p.models.push({ id: "second", baseUrl: "https://alternate.example/v1", api: "anthropic-messages", reasoning: false, input: ["text"], maxTokens: 1000 });
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    if (String(url).startsWith(p.baseUrl)) return json({ data: [{ id: "model", context_window: 77777 }] });
    assert.equal(init.headers["x-api-key"], "test-key");
    assert.equal(init.headers["anthropic-version"], "2023-06-01");
    return json({ data: [{ id: "second", context_window: 33333 }] });
  });
  await refreshProviderModelMetadata(p);
  assert.deepEqual(p.models.map((m) => m.contextWindow), [77777, 33333]);
});

test("pi runtime keeps native auth and compatibility while using API limits, including after refresh", async (t) => {
  const p = provider("openai");
  p.models[0].id = "gpt-4";
  t.mock.method(globalThis, "fetch", async (url: any) => String(url).endsWith("/models") ? json({ data: [{ id: "gpt-4", context_length: 77777, max_output_tokens: 2000 }] }) : json({}));
  await refreshProviderModelMetadata(p);
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(root, "runtime-auth.json"), refreshOnCreate: false });
  const before = runtime.getModel("openai", "gpt-4");
  assert.ok(before);
  const auth = runtime.getProvider("openai")?.auth;
  const cfg = defaultConfig();
  cfg.providers = [p];
  applyRuntimeModelMetadata({ getAll: () => [...runtime.getModels()], registerProvider: (id, config) => runtime.registerProvider(id, config) }, cfg);
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel("openai", "gpt-4");
  assert.equal(model?.contextWindow, 77777);
  assert.equal(model?.maxTokens, 2000);
  assert.deepEqual(model?.compat, before.compat);
  const currentAuth = runtime.getProvider("openai")?.auth;
  assert.equal(currentAuth?.apiKey?.name, auth?.apiKey?.name);
  const authInput = { credential: { type: "api_key" as const, key: "native-test-key" }, ctx: { env: async () => undefined }, signal: new AbortController().signal };
  const currentResolution = await currentAuth?.apiKey?.resolve(authInput as any);
  const originalResolution = await auth?.apiKey?.resolve(authInput as any);
  assert.equal(currentResolution?.auth.apiKey, originalResolution?.auth.apiKey);
  assert.equal(currentResolution?.source, originalResolution?.source);
  assert.deepEqual(currentResolution?.auth.headers, originalResolution?.auth.headers);
  assert.equal(currentAuth?.apiKey?.login, auth?.apiKey?.login);
  assert.equal(currentAuth?.oauth, auth?.oauth);
  const unknown = runtime.getModels("openai").find((model) => model.id !== "gpt-4");
  assert.equal(unknown?.contextWindow, Infinity, "SDK static windows do not masquerade as discovered metadata");
  assert.equal(resolveCompactionBudget(model!).thresholdTokens, Math.floor(77777 * 0.8));
});

test("real model selection refreshes API context, usage and compaction budgets together", async (t) => {
  const p = provider("session-metadata");
  p.apiKey = "";
  p.models.push({ id: "second", reasoning: false, input: ["text"], maxTokens: 1000 });
  const cfg = defaultConfig();
  cfg.providers = [p];
  cfg.model = { provider: p.id, chat: "model", vision: "model" };
  saveConfig(cfg);
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    if (String(url) !== `${p.baseUrl}/models`) return String(url).endsWith("/models") ? json({ data: [] }) : json({});
    assert.equal(init.headers.Authorization, "Bearer test-key", "metadata lookup uses SDK-managed credentials");
    return json({ data: [{ id: "model", context_length: 50000 }, { id: "second", context_length: 90000 }] });
  });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => { registerProviders(pi); registerContextCompaction(pi, settingsManager, cfg.contextCompaction); }],
  });
  await resourceLoader.reload();
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(root, "session-auth.json"), refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader, modelRuntime: runtime, sessionManager: SessionManager.inMemory(root), noTools: "builtin", model: runtime.getModels()[0] });
  try {
    await runtime.setRuntimeApiKey(p.id, "test-key");
    const first = runtime.getModel(p.id, "model");
    assert.ok(first);
    await session.setModel(first);
    assert.equal(session.model?.contextWindow, 50000);
    assert.equal(session.getContextUsage()?.contextWindow, 50000);
    assert.equal(settingsManager.getCompactionSettings().reserveTokens, 10000);
    const second = runtime.getModel(p.id, "second");
    assert.ok(second);
    await session.setModel(second);
    assert.equal(session.model?.contextWindow, 90000);
    assert.equal(session.getContextUsage()?.contextWindow, 90000);
    assert.equal(settingsManager.getCompactionSettings().reserveTokens, 18000);
  } finally { session.dispose(); }
});
