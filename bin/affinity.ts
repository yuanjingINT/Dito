/**
 * 群聊好感度：每个群友一个分数（0-100，默认 50）。
 * 模型通过 qq_affinity 工具加减分；低于 20 的消息由频道直接忽略。
 * 存储为 JSON 文件（key = "群号:QQ号"），进程间共享、跨重启持久。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class Affinity {
  private data: Record<string, number> = {};
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly def = 50,
    private readonly min = 0,
    private readonly max = 100,
  ) {}

  private load(): void {
    if (this.loaded) return;
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Record<string, unknown>;
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "number" && Number.isFinite(v)) this.data[k] = v;
        }
      }
    } catch {
      /* 文件坏了就从空表开始 */
    }
    this.loaded = true;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 1), "utf-8");
    } catch (err) {
      console.error("[dito qq] 好感度保存失败：", (err as Error).message);
    }
  }

  private clamp(v: number): number {
    return Math.max(this.min, Math.min(this.max, Math.round(v)));
  }

  get(key: string): number {
    this.load();
    const v = this.data[key];
    return this.clamp(typeof v === "number" ? v : this.def);
  }

  /** 加减分并落盘，返回新分数 */
  adjust(key: string, delta: number): number {
    this.load();
    const next = this.clamp(this.get(key) + delta);
    this.data[key] = next;
    this.save();
    return next;
  }

  set(key: string, value: number): number {
    this.load();
    this.data[key] = this.clamp(value);
    this.save();
    return this.data[key];
  }
}
