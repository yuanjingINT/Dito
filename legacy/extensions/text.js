function tokenize(text) {
  const tokens = /* @__PURE__ */ new Set();
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
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += Math.max(1, needle.length);
  }
  return count;
}
function snippetAround(content, tokens, context = 60) {
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
export {
  countOccurrences,
  snippetAround,
  tokenize
};
