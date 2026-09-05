/**
 * Dito 联网搜索：web_search + web_fetch。
 *
 * 无 key 时用 DuckDuckGo HTML（Yahoo 兜底）；配置了 Tavily / Exa / SearXNG 则优先。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveApiKey } from "./util.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

function htmlUnescape(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(s: string): string {
  return htmlUnescape(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function dedupeKey(url: string): string {
  const lower = url.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const q = lower.indexOf("?");
  return q === -1 ? lower : lower.slice(0, q);
}

function isAllowed(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://")) {
    const host = lower.replace(/^https?:\/\//, "").split("/")[0];
    if (
      host.endsWith("duckduckgo.com") ||
      host === "r.search.yahoo.com" ||
      host === "search.yahoo.com" ||
      host === "googleadservices.com" ||
      host === "ad.doubleclick.net" ||
      host.endsWith(".doubleclick.net")
    ) {
      return false;
    }
  }
  return true;
}

function unwrapDdgUrl(url: string): string {
  const u = url.trim();
  const q = u.indexOf("?");
  if (q === -1) return u;
  for (const pair of u.slice(q + 1).split("&")) {
    if (pair.startsWith("uddg=")) {
      try {
        return decodeURIComponent(pair.slice(5));
      } catch {
        return pair.slice(5);
      }
    }
  }
  return u;
}

async function ddgSearch(query: string, max: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } });
  if (!resp.ok) return [];
  const html = await resp.text();
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let rest = html;
  while (results.length < max) {
    const idx = rest.indexOf("result__a");
    if (idx === -1) break;
    rest = rest.slice(idx);
    const hrefIdx = rest.indexOf('href="');
    if (hrefIdx === -1) break;
    const hrefStart = hrefIdx + 6;
    const hrefEnd = rest.indexOf('"', hrefStart);
    if (hrefEnd === -1) break;
    const rawUrl = unwrapDdgUrl(htmlUnescape(rest.slice(hrefStart, hrefEnd)));
    const tagEnd = rest.indexOf(">", hrefEnd);
    if (tagEnd === -1) break;
    const titleStart = tagEnd + 1;
    const titleEnd = rest.indexOf("</a>", titleStart);
    if (titleEnd === -1) break;
    const title = stripHtml(rest.slice(titleStart, titleEnd));
    let snippet = "";
    const snipIdx = rest.indexOf("result__snippet", titleEnd);
    if (snipIdx !== -1) {
      const snipRest = rest.slice(snipIdx);
      const openEnd = snipRest.indexOf(">");
      if (openEnd !== -1) {
        const close = snipRest.indexOf("</", openEnd + 1);
        if (close !== -1) snippet = stripHtml(snipRest.slice(openEnd + 1, close));
      }
    }
    if (title && rawUrl && isAllowed(rawUrl)) {
      const key = dedupeKey(rawUrl);
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ title, url: rawUrl, snippet, source: "DuckDuckGo" });
      }
    }
    rest = rest.slice(titleEnd);
  }
  return results;
}

async function yahooSearch(query: string, max: number): Promise<SearchResult[]> {
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } });
  if (!resp.ok) return [];
  const html = await resp.text();
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let rest = html;
  while (results.length < max) {
    const idx = rest.indexOf('class="dd algo');
    if (idx === -1) break;
    rest = rest.slice(idx);
    const hrefIdx = rest.indexOf('href="');
    if (hrefIdx === -1) break;
    const hrefStart = hrefIdx + 6;
    const hrefEnd = rest.indexOf('"', hrefStart);
    if (hrefEnd === -1) break;
    const rawUrl = htmlUnescape(rest.slice(hrefStart, hrefEnd));
    const tagEnd = rest.indexOf(">", hrefEnd);
    if (tagEnd === -1) break;
    const titleStart = tagEnd + 1;
    const titleEnd = rest.indexOf("</a>", titleStart);
    if (titleEnd === -1) break;
    const title = stripHtml(rest.slice(titleStart, titleEnd));
    let snippet = "";
    const body = rest.slice(titleEnd);
    const m = body.match(/class="compText[^"]*"[^>]*>([\s\S]*?)<\//);
    if (m) snippet = stripHtml(m[1]);
    if (title && rawUrl && isAllowed(rawUrl)) {
      const key = dedupeKey(rawUrl);
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ title, url: rawUrl, snippet, source: "Yahoo" });
      }
    }
    rest = rest.slice(titleEnd);
  }
  return results;
}

/** 解开 Bing 的跳转链接（https://www.bing.com/ck/a?...&u=a1<base64url>）。 */
function unwrapBingUrl(url: string): string {
  const u = url.trim();
  if (!u) return u;
  const m = u.match(/[?&]u=(a1|a2)([^&]+)/);
  if (!m) return u;
  try {
    return Buffer.from(m[2], "base64url").toString("utf-8");
  } catch {
    return u;
  }
}

/** Bing 网页搜索（国内可达，DuckDuckGo/Yahoo 被墙时兜底）。 */
async function bingSearch(query: string, max: number): Promise<SearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`;
  const resp = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } });
  if (!resp.ok) return [];
  const html = await resp.text();
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let rest = html;
  while (results.length < max) {
    const idx = rest.indexOf('<li class="b_algo"');
    if (idx === -1) break;
    rest = rest.slice(idx);
    const liEnd = rest.indexOf("</li>", 10);
    const block = liEnd === -1 ? rest : rest.slice(0, liEnd);

    const h2Idx = block.indexOf("<h2");
    const hrefIdx = block.indexOf('href="', h2Idx);
    if (hrefIdx === -1) { rest = rest.slice(10); continue; }
    const hrefStart = hrefIdx + 6;
    const hrefEnd = block.indexOf('"', hrefStart);
    if (hrefEnd === -1) { rest = rest.slice(10); continue; }
    const rawUrl = unwrapBingUrl(htmlUnescape(block.slice(hrefStart, hrefEnd)));
    const gtIdx = block.indexOf(">", hrefEnd);
    const titleEnd = block.indexOf("</a>", gtIdx);
    if (gtIdx === -1 || titleEnd === -1) { rest = rest.slice(10); continue; }
    const title = stripHtml(block.slice(gtIdx + 1, titleEnd));

    let snippet = "";
    const capIdx = block.indexOf('class="b_caption"');
    if (capIdx !== -1) {
      const cap = block.slice(capIdx);
      const pIdx = cap.indexOf("<p");
      if (pIdx !== -1) {
        const pOpenEnd = cap.indexOf(">", pIdx);
        const pClose = cap.indexOf("</p>", pOpenEnd);
        if (pOpenEnd !== -1 && pClose !== -1) snippet = stripHtml(cap.slice(pOpenEnd + 1, pClose));
      }
    }

    if (title && rawUrl && isAllowed(rawUrl)) {
      const key = dedupeKey(rawUrl);
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ title, url: rawUrl, snippet, source: "Bing" });
      }
    }
    rest = liEnd === -1 ? "" : rest.slice(liEnd);
  }
  return results;
}

async function tavilySearch(query: string, max: number, keys: string[]): Promise<SearchResult[]> {
  const key = resolveApiKey(keys[0] || "");
  if (!key) return [];
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: Math.min(max, 10), search_depth: "basic", include_answer: false }),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { results?: { title: string; url: string; content?: string }[] };
  return (data.results ?? []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: (r.content || "").slice(0, 400),
    source: "Tavily",
  }));
}

// 参照 deepseek-harness：Exa 用 highlights 高亮摘要 + type 检索模式
async function exaSearch(query: string, max: number, keys: string[]): Promise<SearchResult[]> {
  const key = resolveApiKey(keys[0] || "");
  if (!key) return [];
  const resp = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: Math.min(max, 10),
      highlightsPerUrl: 2,
      contents: { text: true, highlights: true },
    }),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as {
    results?: { title?: string; url?: string; publishedDate?: string; text?: string; highlights?: string[] }[];
  };
  return (data.results ?? []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: (r.highlights?.[0] ?? r.text ?? "").slice(0, 400),
    source: "Exa",
  }));
}

// laozhou：Firecrawl 搜索
async function firecrawlSearch(query: string, max: number, keys: string[]): Promise<SearchResult[]> {
  const key = resolveApiKey(keys[0] || "");
  if (!key) return [];
  const resp = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, limit: Math.min(max, 10), sources: [{ type: "web" }], scrapeOptions: { formats: [{ type: "markdown" }], onlyMainContent: true } }),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as {
    data?: { web?: { results?: { title?: string; url?: string; markdown?: string }[] } };
    success?: boolean;
  };
  const arr = data.data?.web?.results ?? (data as { data?: { title?: string; url?: string; markdown?: string }[] }).data ?? [];
  return arr.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: (r.markdown ?? "").slice(0, 400),
    source: "Firecrawl",
  }));
}

// laozhou：AnySearch 搜索
async function anysearchSearch(query: string, max: number, keys: string[]): Promise<SearchResult[]> {
  const key = resolveApiKey(keys[0] || "");
  if (!key) return [];
  const resp = await fetch("https://api.anysearch.com/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: Math.min(max, 20) }),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { results?: { title?: string; url?: string; snippet?: string; content?: string }[] };
  const arr = data.results ?? [];
  return arr.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: (r.snippet ?? r.content ?? "").slice(0, 400),
    source: "AnySearch",
  }));
}

// deepseek-harness：Perplexity 在线搜索（返回合成回答 + 引用）
async function perplexitySearch(query: string, max: number, key: string): Promise<SearchResult[]> {
  const k = resolveApiKey(key);
  if (!k) return [];
  const resp = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
    body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: query }] }),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
    citations?: string[];
  };
  const answer = data.choices?.[0]?.message?.content?.trim() ?? "";
  const citations = data.citations ?? [];
  if (!answer && citations.length === 0) return [];
  const results: SearchResult[] = [];
  if (answer) results.push({ title: "Perplexity 回答", url: citations[0] ?? "", snippet: answer.slice(0, 800), source: "Perplexity" });
  for (let i = 0; i < Math.min(citations.length, max); i++) {
    results.push({ title: `参考 ${i + 1}`, url: citations[i], snippet: "", source: "Perplexity" });
  }
  return results;
}

async function searxngSearch(query: string, max: number, baseUrl: string): Promise<SearchResult[]> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return [];
  const resp = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? []).slice(0, max).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: (r.content || "").slice(0, 400),
    source: "SearXNG",
  }));
}

async function doSearch(query: string, max: number, provider?: string): Promise<string> {
  const config = loadConfig();
  const ws = config.plugins.web_search;
  const errors: string[] = [];

  const tryProviders: string[] = [];
  if (provider && provider !== "auto") {
    tryProviders.push(provider);
  } else {
    if (ws.tavilyKeys?.length) tryProviders.push("tavily");
    if (ws.firecrawlKeys?.length) tryProviders.push("firecrawl");
    if (ws.anysearchKeys?.length) tryProviders.push("anysearch");
    if (ws.exaKeys?.length) tryProviders.push("exa");
    if (ws.perplexityKey) tryProviders.push("perplexity");
    if (ws.searxngUrl) tryProviders.push("searxng");
    tryProviders.push("duckduckgo");
    tryProviders.push("bing");
  }

  for (const name of tryProviders) {
    let results: SearchResult[] = [];
    try {
      switch (name) {
        case "tavily":
          results = await tavilySearch(query, max, ws.tavilyKeys ?? []);
          break;
        case "firecrawl":
          results = await firecrawlSearch(query, max, ws.firecrawlKeys ?? []);
          break;
        case "anysearch":
          results = await anysearchSearch(query, max, ws.anysearchKeys ?? []);
          break;
        case "exa":
          results = await exaSearch(query, max, ws.exaKeys ?? []);
          break;
        case "perplexity":
          results = await perplexitySearch(query, max, ws.perplexityKey);
          break;
        case "searxng":
          results = await searxngSearch(query, max, ws.searxngUrl);
          break;
        case "duckduckgo":
        default:
          results = await ddgSearch(query, max);
          if (results.length === 0) results = await yahooSearch(query, max);
          break;
        case "bing":
          results = await bingSearch(query, max);
          break;
      }
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
    if (results.length > 0) {
      const lines = [`## 搜索结果：${query}`, `**来源**：${results[0].source}\n`];
      results.forEach((r, i) => {
        lines.push(`### ${i + 1}. ${r.title}`);
        lines.push(`**URL**：${r.url}`);
        if (r.snippet) lines.push(`**摘要**：${r.snippet.slice(0, 400)}`);
        lines.push("");
      });
      return lines.join("\n");
    }
  }

  return `搜索失败：${errors.length ? errors.join("；") : "无可用搜索源"}`;
}

async function doFetch(url: string, format: string): Promise<string> {
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) return `抓取失败：HTTP ${resp.status}`;
  const ct = resp.headers.get("content-type") || "";
  const text = await resp.text();
  if (format === "text" || format === "markdown") {
    return stripHtml(text).slice(0, 20000);
  }
  return text.slice(0, 50000);
}

export default function webSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "联网搜索",
    description: "搜索互联网，返回标题、URL 与摘要。无配置时走 DuckDuckGo。遇到不确定、需要最新信息时使用。",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      max_results: Type.Optional(Type.Integer({ description: "最多返回条数，默认 5" })),
      provider: Type.Optional(Type.String({ description: "搜索源：auto / tavily / firecrawl / anysearch / exa / perplexity / searxng / duckduckgo / bing" })),
    }),
    async execute(_id, params) {
      const text = await doSearch(params.query, params.max_results ?? 5, params.provider);
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "抓取网页",
    description: "抓取已知 URL 并转成纯文本/markdown，用于打开具体网页读取内容（不搜索）。",
    parameters: Type.Object({
      url: Type.String({ description: "完整的 http/https 网址" }),
      format: Type.Optional(Type.String({ description: "text / markdown / html，默认 text" })),
    }),
    async execute(_id, params) {
      const text = await doFetch(params.url, params.format ?? "text");
      return { content: [{ type: "text", text }] };
    },
  });
}
