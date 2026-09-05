/**
 * 表情包库：自动"偷"来的表情包都存在这里。
 *
 * 每张入库前先由视觉模型识别——情绪 + 内容标签，检索时按情绪/内容匹配。
 * 图片本体存 ~/.pi/agent/dito/memes/，索引在 memes.json。
 * 发送用 base64 段（SnowLuma 在容器里，宿主机路径 file:// 对它无效）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveApiKey } from "../extensions/util.js";

export interface MemeEntry {
  id: string;
  /** 图片文件名（相对 memes 目录） */
  file: string;
  /** 主情绪（如 开心/搞笑/无语/生气/难过/惊讶/疑惑/装酷/无奈/认可） */
  emotion: string;
  /** 内容标签 */
  tags: string[];
  /** 一句话描述 */
  desc: string;
  /** 来源：群号或私聊 QQ */
  source: string;
  addedAt: number;
}

export interface MemeAnalysis {
  meme: boolean;
  emotion: string;
  tags: string[];
  desc: string;
}

const IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;

export class MemeStore {
  readonly dir: string;
  private index: MemeEntry[] = [];
  private loaded = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  private load(): void {
    if (this.loaded) return;
    const idx = join(this.dir, "memes.json");
    try {
      if (existsSync(idx)) this.index = JSON.parse(readFileSync(idx, "utf-8")) as MemeEntry[];
    } catch {
      this.index = [];
    }
    this.loaded = true;
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "memes.json"), JSON.stringify(this.index, null, 1), "utf-8");
  }

  get count(): number {
    this.load();
    return this.index.length;
  }

  list(): MemeEntry[] {
    this.load();
    return [...this.index];
  }

  /** 入库：图片 buffer + 视觉分析结果；按内容 md5 去重。返回入库条目（重复返回已有条目） */
  add(buf: Buffer, ext: string, analysis: MemeAnalysis, source: string): MemeEntry {
    this.load();
    const hash = createHash("md5").update(buf).digest("hex").slice(0, 12);
    const dup = this.index.find((e) => e.id === hash);
    if (dup) return dup;
    const file = `${hash}${ext || ".png"}`;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, file), buf);
    const entry: MemeEntry = {
      id: hash,
      file,
      emotion: analysis.emotion || "未知",
      tags: analysis.tags ?? [],
      desc: analysis.desc || "",
      source,
      addedAt: Date.now(),
    };
    this.index.push(entry);
    this.save();
    return entry;
  }

  /** 按情绪 + 内容关键词挑一张；不带条件 = 全库随机；有条件但无匹配时也全库随机兜底 */
  pick(emotion?: string, query?: string): MemeEntry | null {
    this.load();
    if (this.index.length === 0) return null;
    const emo = (emotion ?? "").trim();
    const q = (query ?? "").trim().toLowerCase();
    if (!emo && !q) return this.index[Math.floor(Math.random() * this.index.length)];
    const scored = this.index.map((e) => {
      let score = 0;
      if (emo && e.emotion.includes(emo)) score += 10;
      if (q) {
        if (e.desc.toLowerCase().includes(q)) score += 6;
        for (const tag of e.tags) if (q.includes(tag.toLowerCase()) || tag.toLowerCase().includes(q)) score += 4;
      }
      return { e, score };
    });
    const best = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    if (best.length === 0) return this.index[Math.floor(Math.random() * this.index.length)];
    return best[Math.floor(Math.random() * Math.min(best.length, 3))].e;
  }

  filePath(entry: MemeEntry): string {
    return join(this.dir, entry.file);
  }
}

/** 从 dito 配置里找到视觉模型的调用凭据 */
function visionEndpoint(): { baseUrl: string; apiKey: string; model: string } | null {
  const cfg = loadConfig();
  const visionId = cfg.model.vision;
  if (!visionId) return null;
  for (const p of cfg.providers) {
    const m = p.models.find((x) => x.id === visionId);
    if (m) {
      const apiKey = resolveApiKey(p.apiKey);
      if (!apiKey) return null;
      return { baseUrl: p.baseUrl.replace(/\/+$/, ""), apiKey, model: visionId };
    }
  }
  return null;
}

const ANALYZE_PROMPT = `分析这张图片，严格输出一行 JSON（不要输出其他内容）：
{"meme": true/false, "emotion": "主情绪", "tags": ["标签1", "标签2"], "desc": "≤20字的内容描述"}
规则：
- meme：表情包/梗图/漫画面孔/带字搞笑图 = true；真人照片、截图、文档、风景 = false
- emotion 从这些里选一个：开心、搞笑、生气、难过、无语、惊讶、疑惑、鄙视、害怕、无奈、装酷、委屈、认可、疑问
- tags 是 2-4 个内容关键词（画面里的事物/文字主题）`;

/** 用配置的视觉模型分析图片（识别是否表情包 + 情绪 + 内容） */
export async function analyzeImage(buf: Buffer, mime: string): Promise<MemeAnalysis | null> {
  const ep = visionEndpoint();
  if (!ep) return null;
  const b64 = `data:${mime || "image/png"};base64,${buf.toString("base64")}`;
  try {
    const res = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({
        model: ep.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: ANALYZE_PROMPT },
              { type: "image_url", image_url: { url: b64 } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? "";
    const jsonText = /\{[\s\S]*\}/.exec(text)?.[0];
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText) as Partial<MemeAnalysis>;
    return {
      meme: parsed.meme === true,
      emotion: typeof parsed.emotion === "string" ? parsed.emotion : "未知",
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === "string").slice(0, 4) : [],
      desc: typeof parsed.desc === "string" ? parsed.desc : "",
    };
  } catch (err) {
    console.error("[dito qq] 视觉分析失败：", (err as Error).message);
    return null;
  }
}

/** 下载图片（带大小限制），返回 buffer + 扩展名猜测 */
export async function downloadImage(url: string): Promise<{ buf: Buffer; ext: string; mime: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQ/9.9" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > IMAGE_LIMIT_BYTES) return null;
    const mime = res.headers.get("content-type") ?? "";
    const ext = mime.includes("gif") ? ".gif" : mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : mime.includes("webp") ? ".webp" : ".png";
    return { buf, ext, mime: mime || "image/png" };
  } catch {
    return null;
  }
}
