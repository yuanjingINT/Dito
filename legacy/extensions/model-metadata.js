import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const TTL = 6 * 60 * 60 * 1e3;
const memory = /* @__PURE__ */ new Map();
const pending = /* @__PURE__ */ new Map();
function tokenLimit(value) {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : void 0;
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function firstLimit(...values) {
  return values.map(tokenLimit).find((n) => n !== void 0);
}
function parseModelInfo(value) {
  const m = record(value);
  const id = m.id || m.model || m.name;
  if (typeof id !== "string" || !id.trim()) return void 0;
  const contextWindow = firstLimit(
    m.contextWindow,
    m.context_window,
    m.context_length,
    m.max_context_length,
    m.max_model_len,
    m.max_input_tokens,
    m.inputTokenLimit,
    m.limit?.context,
    m.limits?.context_window,
    m.top_provider?.context_length
  );
  const maxTokens = firstLimit(
    m.maxTokens,
    m.max_output_tokens,
    m.max_completion_tokens,
    m.outputTokenLimit,
    m.limit?.output,
    m.top_provider?.max_completion_tokens
  );
  const modalities = m.input || m.modalities?.input || m.architecture?.input_modalities;
  const input = Array.isArray(modalities) ? modalities.filter((item) => item === "text" || item === "image") : void 0;
  return {
    id,
    name: typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : id,
    ...contextWindow ? { contextWindow } : {},
    ...maxTokens ? { maxTokens } : {},
    ...typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {},
    ...input?.length ? { input } : {}
  };
}
function cachePath(dir, key) {
  return join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
}
function readCache(dir, key) {
  const path = cachePath(dir, key);
  if (memory.has(path)) return memory.get(path);
  try {
    const entry = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isFinite(entry.checkedAt)) return void 0;
    memory.set(path, entry);
    return entry;
  } catch {
    return void 0;
  }
}
function saveCache(dir, key, value) {
  const entry = { checkedAt: Date.now(), value };
  const path = cachePath(dir, key);
  memory.set(path, entry);
  try {
    mkdirSync(dir, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(entry), { mode: 384 });
    renameSync(temporary, path);
  } catch {
  }
}
async function cachedRequest(dir, key, request, options) {
  const cached = readCache(dir, key);
  if (!options.force && cached && Date.now() - cached.checkedAt < TTL) return cached.value;
  const path = cachePath(dir, key);
  if (pending.has(path)) return pending.get(path);
  const promise = (async () => {
    try {
      const value = await request();
      saveCache(dir, key, value);
      return value;
    } catch {
      return cached?.value;
    } finally {
      pending.delete(path);
    }
  })();
  pending.set(path, promise);
  return promise;
}
function endpointKey(p) {
  return JSON.stringify([p.id, p.baseUrl.replace(/\/+$/, ""), p.api, createHash("sha256").update(p.apiKey).digest("hex")]);
}
function headersFor(p) {
  if (!p.apiKey.trim()) return {};
  return p.api === "anthropic-messages" ? { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${p.apiKey}` };
}
async function jsonRequest(url, options, init = {}) {
  const timeout = AbortSignal.timeout(5e3);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) throw new Error(`Model metadata HTTP ${response.status}`);
  return response.json();
}
const CATALOG_KEY = "https://models.dev/api.json";
function catalogModels(p, catalog) {
  const data = record(catalog);
  const alias = p.id === "opencode-free" ? "opencode" : p.id;
  const provider = data[alias] || Object.values(data).find((entry) => {
    const api = record(entry).api;
    return typeof api === "string" && api.replace(/\/+$/, "") === p.baseUrl.replace(/\/+$/, "");
  });
  return Object.values(record(record(provider).models)).map(parseModelInfo).filter((m) => !!m);
}
function overlay(primary, fallback) {
  return {
    ...fallback,
    ...primary,
    ...primary.contextWindow ?? fallback?.contextWindow ? { contextWindow: primary.contextWindow ?? fallback?.contextWindow } : {},
    ...primary.maxTokens ?? fallback?.maxTokens ? { maxTokens: primary.maxTokens ?? fallback?.maxTokens } : {}
  };
}
function cachedModelInfo(p, id, dir) {
  const api = readCache(dir, endpointKey(p))?.value;
  const primary = Array.isArray(api) ? api.find((m) => record(m).id === id) : void 0;
  const fallback = catalogModels(p, readCache(dir, CATALOG_KEY)?.value).find((m) => m.id === id);
  return primary ? overlay(primary, fallback) : fallback;
}
async function fetchEndpointModels(p, dir, options = {}) {
  const base = p.baseUrl.trim().replace(/\/+$/, "");
  let api;
  if (base) api = await cachedRequest(dir, endpointKey(p), async () => {
    const json = record(await jsonRequest(`${base}/models`, options, { headers: headersFor(p) }));
    const entries = json.data ?? json.models;
    if (!Array.isArray(entries)) throw new Error("Invalid model list");
    const models = entries.map(parseModelInfo).filter((m) => !!m);
    if (models.length === 0) throw new Error("Empty model list");
    if (p.id === "ollama") {
      const root = base.replace(/\/(?:v1|api)$/, "");
      await Promise.all(models.filter((m) => !m.contextWindow).map(async (m) => {
        try {
          const details = record(await jsonRequest(`${root}/api/show`, options, {
            method: "POST",
            headers: { ...headersFor(p), "Content-Type": "application/json" },
            body: JSON.stringify({ model: m.id })
          }));
          const configured = typeof details.parameters === "string" ? /^\s*num_ctx\s+(\d+)\s*$/m.exec(details.parameters)?.[1] : void 0;
          m.contextWindow = firstLimit(configured, ...Object.entries(record(details.model_info)).filter(([key]) => key.endsWith(".context_length")).map(([, value]) => value));
        } catch {
        }
      }));
    }
    return models;
  }, options);
  const apiModels = Array.isArray(api) ? api : [];
  const requested = p.models?.map((m) => m.id) ?? apiModels.map((m) => m.id);
  if (requested.some((id) => !apiModels.find((m) => m.id === id)?.contextWindow) || apiModels.some((m) => !m.contextWindow)) {
    await cachedRequest(dir, CATALOG_KEY, () => jsonRequest(CATALOG_KEY, options), options);
  }
  const fallback = catalogModels(p, readCache(dir, CATALOG_KEY)?.value);
  if (apiModels.length) return apiModels.map((m) => overlay(m, fallback.find((f) => f.id === m.id)));
  return fallback.filter((m) => requested.includes(m.id));
}
export {
  cachedModelInfo,
  fetchEndpointModels,
  parseModelInfo,
  tokenLimit
};
