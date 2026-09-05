/**
 * 插件：联网搜索。
 * web_search / web_fetch 工具；无 key 走 DuckDuckGo，可配 Tavily / Firecrawl / AnySearch / Exa / Perplexity / SearXNG。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import webSearchExtension from "../web-search.js";

export const webSearchPlugin: DitoPlugin = {
  id: "web_search",
  name: "联网搜索",
  description: "web_search 与 web_fetch 工具；无 key 自动走 DuckDuckGo，也支持多个搜索服务商。",
  icon: "search",
  version: "1.0.0",
  apply(ctx) {
    webSearchExtension(ctx.pi);
  },
};
