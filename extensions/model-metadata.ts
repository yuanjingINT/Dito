/** Fetch model limits from provider APIs and the live models.dev catalog. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
}
export interface ModelEndpoint {
  id: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models?: { id: string }[];
}
interface CacheEntry { checkedAt: number; value: unknown; }
interface FetchOptions { force?: boolean; signal?: AbortSignal; }
const TTL = 6 * 60 * 60 * 1000;
const memory = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<unknown>>();

export function tokenLimit(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function firstLimit(...values: unknown[]): number | undefined {
  return values.map(tokenLimit).find((n) => n !== undefined);
}
export function parseModelInfo(value: unknown): ModelInfo | undefined {
  const m = record(value);
  const id = m.id || m.model || m.name;
  if (typeof id !== "string" || !id.trim()) return undefined;
  const contextWindow = firstLimit(m.contextWindow, m.context_window, m.context_length, m.max_context_length,
    m.max_model_len, m.max_input_tokens, m.inputTokenLimit, m.limit?.context, m.limits?.context_window, m.top_provider?.context_length);
  const maxTokens = firstLimit(m.maxTokens, m.max_output_tokens, m.max_completion_tokens, m.outputTokenLimit,
    m.limit?.output, m.top_provider?.max_completion_tokens);
  const modalities = m.input || m.modalities?.input || m.architecture?.input_modalities;
  const input = Array.isArray(modalities) ? modalities.filter((item): item is "text" | "image" => item === "text" || item === "image") : undefined;
  return {
    id, name: typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : id,
    ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}),
    ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}), ...(input?.length ? { input } : {}),
  };
}
function cachePath(dir: string, key: string): string { return join(dir, `${createHash("sha256").update(key).digest("hex")}.json`); }
function readCache(dir: string, key: string): CacheEntry | undefined {
  const path = cachePath(dir, key);
  if (memory.has(path)) return memory.get(path);
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
    if (!Number.isFinite(entry.checkedAt)) return undefined;
    memory.set(path, entry);
    return entry;
  } catch { return undefined; }
}
function saveCache(dir: string, key: string, value: unknown): void {
  const entry = { checkedAt: Date.now(), value };
  const path = cachePath(dir, key);
  memory.set(path, entry);
  try {
    mkdirSync(dir, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
    renameSync(temporary, path);
  } catch { /* An unwritable cache must not prevent model use. */ }
}
async function cachedRequest(dir: string, key: string, request: () => Promise<unknown>, options: FetchOptions): Promise<unknown> {
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
      // Keep the last successful metadata during outages, including across restarts.
      return cached?.value;
    } finally { pending.delete(path); }
  })();
  pending.set(path, promise);
  return promise;
}
function endpointKey(p: ModelEndpoint): string {
  return JSON.stringify([p.id, p.baseUrl.replace(/\/+$/, ""), p.api, createHash("sha256").update(p.apiKey).digest("hex")]);
}
function headersFor(p: ModelEndpoint): Record<string, string> {
  if (!p.apiKey.trim()) return {};
  return p.api === "anthropic-messages"
    ? { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${p.apiKey}` };
}
async function jsonRequest(url: string, options: FetchOptions, init: RequestInit = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(5000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) throw new Error(`Model metadata HTTP ${response.status}`);
  return response.json();
}

const CATALOG_KEY = "https://models.dev/api.json";
function catalogModels(p: ModelEndpoint, catalog: unknown): ModelInfo[] {
  const data = record(catalog);
  const alias = p.id === "opencode-free" ? "opencode" : p.id;
  // Match provider identity or its exact endpoint; do not borrow limits from an unrelated relay.
  const provider = data[alias] || Object.values(data).find((entry) => {
    const api = record(entry).api;
    return typeof api === "string" && api.replace(/\/+$/, "") === p.baseUrl.replace(/\/+$/, "");
  });
  return Object.values(record(record(provider).models)).map(parseModelInfo).filter((m): m is ModelInfo => !!m);
}
function overlay(primary: ModelInfo, fallback?: ModelInfo): ModelInfo {
  return { ...fallback, ...primary,
    ...(primary.contextWindow ?? fallback?.contextWindow ? { contextWindow: primary.contextWindow ?? fallback?.contextWindow } : {}),
    ...(primary.maxTokens ?? fallback?.maxTokens ? { maxTokens: primary.maxTokens ?? fallback?.maxTokens } : {}),
  };
}
export function cachedModelInfo(p: ModelEndpoint, id: string, dir: string): ModelInfo | undefined {
  const api = readCache(dir, endpointKey(p))?.value;
  const primary = Array.isArray(api) ? api.find((m) => record(m).id === id) as ModelInfo | undefined : undefined;
  const fallback = catalogModels(p, readCache(dir, CATALOG_KEY)?.value).find((m) => m.id === id);
  return primary ? overlay(primary, fallback) : fallback;
}

export async function fetchEndpointModels(p: ModelEndpoint, dir: string, options: FetchOptions = {}): Promise<ModelInfo[]> {
  const base = p.baseUrl.trim().replace(/\/+$/, "");
  let api: unknown;
  if (base) api = await cachedRequest(dir, endpointKey(p), async () => {
    const json = record(await jsonRequest(`${base}/models`, options, { headers: headersFor(p) }));
    const entries = json.data ?? json.models;
    if (!Array.isArray(entries)) throw new Error("Invalid model list");
    const models = entries.map(parseModelInfo).filter((m): m is ModelInfo => !!m);
    if (models.length === 0) throw new Error("Empty model list");
    if (p.id === "ollama") {
      const root = base.replace(/\/(?:v1|api)$/, "");
      // Ollama's OpenAI-compatible /models omits limits; /api/show supplies them.
      await Promise.all(models.filter((m) => !m.contextWindow).map(async (m) => {
        try {
          const details = record(await jsonRequest(`${root}/api/show`, options, {
            method: "POST", headers: { ...headersFor(p), "Content-Type": "application/json" }, body: JSON.stringify({ model: m.id }),
          }));
          const configured = typeof details.parameters === "string" ? /^\s*num_ctx\s+(\d+)\s*$/m.exec(details.parameters)?.[1] : undefined;
          m.contextWindow = firstLimit(configured, ...Object.entries(record(details.model_info)).filter(([key]) => key.endsWith(".context_length")).map(([, value]) => value));
        } catch { /* Catalog/cache may still supply metadata. */ }
      }));
    }
    return models;
  }, options);
  const apiModels = Array.isArray(api) ? api as ModelInfo[] : [];
  const requested = p.models?.map((m) => m.id) ?? apiModels.map((m) => m.id);
  if (requested.some((id) => !apiModels.find((m) => m.id === id)?.contextWindow) || apiModels.some((m) => !m.contextWindow)) {
    await cachedRequest(dir, CATALOG_KEY, () => jsonRequest(CATALOG_KEY, options), options);
  }
  const fallback = catalogModels(p, readCache(dir, CATALOG_KEY)?.value);
  if (apiModels.length) return apiModels.map((m) => overlay(m, fallback.find((f) => f.id === m.id)));
  // If a provider is unavailable, retain its configured model list; a public
  // catalog does not prove a particular account can use newly listed models.
  return fallback.filter((m) => requested.includes(m.id));
}
