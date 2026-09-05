/**
 * Dito 中文检索通用工具：分词、计数、片段抽取。
 */

/** ASCII 单词 + 中文整段 + 中文二元组 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_+#.%-]+/g)) {
    if (m[0].length > 1) tokens.add(m[0]);
  }
  for (const run of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const chars = [...run[0]];
    if (chars.length > 1) tokens.add(run[0]);
    for (let i = 0; i + 1 < chars.length; i++) {
      tokens.add(chars[i] + chars[i + 1]);
    }
  }
  return [...tokens];
}

export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += Math.max(1, needle.length);
  }
  return count;
}

/** 抽取命中最靠前的 token 附近上下文片段 */
export function snippetAround(content: string, tokens: string[], context = 60): string {
  const lower = content.toLowerCase();
  for (const token of tokens) {
    const pos = lower.indexOf(token);
    if (pos >= 0) {
      const start = Math.max(0, pos - context);
      const end = Math.min(content.length, pos + token.length + context);
      const pre = start > 0 ? "…" : "";
      const post = end < content.length ? "…" : "";
      return pre + content.slice(start, end).replace(/\s+/g, " ").trim() + post;
    }
  }
  return content.slice(0, context * 2).replace(/\s+/g, " ").trim();
}
