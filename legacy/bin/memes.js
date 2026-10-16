import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, providerRequestHeaders } from "../extensions/util.js";
import { detectImageMime, toVisionImage } from "../extensions/image.js";
const IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;
class MemeStore {
  dir;
  index = [];
  loaded = false;
  lastMtime = 0;
  constructor(dir) {
    this.dir = dir;
  }
  load() {
    if (this.loaded) return;
    const idx = join(this.dir, "memes.json");
    try {
      if (existsSync(idx)) {
        this.lastMtime = statSync(idx).mtimeMs;
        this.index = JSON.parse(readFileSync(idx, "utf-8"));
      }
    } catch {
      this.index = [];
    }
    this.loaded = true;
  }
  /** qqadmin 后台改动 memes.json 后重读，避免本进程旧索引覆盖外部修改 */
  reloadIfChanged() {
    if (!this.loaded) {
      this.load();
      return;
    }
    const idx = join(this.dir, "memes.json");
    try {
      if (!existsSync(idx)) return;
      const mtime = statSync(idx).mtimeMs;
      if (mtime === this.lastMtime) return;
      this.lastMtime = mtime;
      this.index = JSON.parse(readFileSync(idx, "utf-8"));
    } catch {
    }
  }
  save() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "memes.json"), JSON.stringify(this.index, null, 1), "utf-8");
  }
  get count() {
    this.load();
    return this.index.length;
  }
  list() {
    this.load();
    return [...this.index];
  }
  /** 入库：图片 buffer + 视觉分析结果；按内容 md5 去重。返回入库条目（重复返回已有条目） */
  add(buf, ext, analysis, source) {
    this.load();
    const hash = createHash("md5").update(buf).digest("hex").slice(0, 12);
    const dup = this.index.find((e) => e.id === hash);
    if (dup) return dup;
    const file = `${hash}${ext || ".png"}`;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, file), buf);
    const entry = {
      id: hash,
      file,
      emotion: analysis.emotion || "未知",
      tags: analysis.tags ?? [],
      desc: analysis.desc || "",
      source,
      addedAt: Date.now()
    };
    this.index.push(entry);
    this.save();
    return entry;
  }
  /** 按情绪 + 内容关键词挑一张；不带条件 = 全库随机；有条件但无匹配时也全库随机兜底 */
  pick(emotion, query) {
    this.reloadIfChanged();
    if (this.index.length === 0) return null;
    const available = this.index.filter((e) => existsSync(join(this.dir, e.file)));
    if (available.length === 0) return null;
    const emo = (emotion ?? "").trim();
    const q = (query ?? "").trim().toLowerCase();
    if (!emo && !q) return available[Math.floor(Math.random() * available.length)];
    const scored = available.map((e) => {
      let score = 0;
      if (emo && e.emotion.includes(emo)) score += 10;
      if (q) {
        if (e.desc.toLowerCase().includes(q)) score += 6;
        for (const tag of e.tags) if (q.includes(tag.toLowerCase()) || tag.toLowerCase().includes(q)) score += 4;
      }
      return { e, score };
    });
    const best = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    if (best.length === 0) return available[Math.floor(Math.random() * available.length)];
    return best[Math.floor(Math.random() * Math.min(best.length, 3))].e;
  }
  filePath(entry) {
    return join(this.dir, entry.file);
  }
}
function visionEndpoint() {
  const cfg = loadConfig();
  const visionId = cfg.model.vision;
  if (!visionId) return null;
  for (const p of cfg.providers) {
    if (p.models.some((x) => x.id === visionId)) return { provider: p, model: visionId };
  }
  return null;
}
const ANALYZE_PROMPT = `分析这张图片，严格输出一行 JSON（不要输出其他内容）：
{"meme": true/false, "emotion": "主情绪", "tags": ["标签1", "标签2"], "desc": "≤20字的内容描述"}
规则：
- meme：表情包/梗图/漫画面孔/带字搞笑图 = true；真人照片、截图、文档、风景 = false
- emotion 从这些里选一个：开心、搞笑、生气、难过、无语、惊讶、疑惑、鄙视、害怕、无奈、装酷、委屈、认可、疑问
- tags 是 2-4 个内容关键词（画面里的事物/文字主题）`;
async function analyzeImage(buf, mime) {
  const ep = visionEndpoint();
  if (!ep) return null;
  const img = toVisionImage(buf, mime);
  if (img.mime === "image/gif") console.error("[dito qq] GIF 首帧解析失败，按原格式尝试识别");
  const b64 = `data:${img.mime};base64,${img.buf.toString("base64")}`;
  try {
    const res = await fetch(`${ep.provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: providerRequestHeaders(ep.provider),
      body: JSON.stringify({
        model: ep.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: ANALYZE_PROMPT },
              { type: "image_url", image_url: { url: b64 } }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(6e4)
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}（模型 ${ep.model}）${raw.replace(/\s+/g, " ").slice(0, 160)}`);
    let text = "";
    try {
      const data = JSON.parse(raw);
      const content = data.choices?.[0]?.message?.content;
      text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "").join("") : "";
    } catch {
      return null;
    }
    const jsonText = /\{[\s\S]*\}/.exec(text)?.[0];
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    return {
      meme: parsed.meme === true,
      emotion: typeof parsed.emotion === "string" ? parsed.emotion : "未知",
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === "string").slice(0, 4) : [],
      desc: typeof parsed.desc === "string" ? parsed.desc : ""
    };
  } catch (err) {
    console.error("[dito qq] 视觉分析失败：", err.message);
    return null;
  }
}
async function downloadImage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQ/9.9" },
      signal: AbortSignal.timeout(2e4)
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > IMAGE_LIMIT_BYTES) return null;
    const headerMime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const mime = detectImageMime(buf) ?? (headerMime.startsWith("image/") ? headerMime : "");
    const ext = mime === "image/gif" ? ".gif" : mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : mime === "image/bmp" ? ".bmp" : ".png";
    return { buf, ext, mime: mime || "image/png" };
  } catch {
    return null;
  }
}
export {
  MemeStore,
  analyzeImage,
  downloadImage
};
