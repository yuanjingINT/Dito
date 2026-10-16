import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
class Affinity {
  constructor(file, def = 50, min = 0, max = 100) {
    this.file = file;
    this.def = def;
    this.min = min;
    this.max = max;
  }
  file;
  def;
  min;
  max;
  data = {};
  loaded = false;
  lastMtime = 0;
  load() {
    if (this.loaded) return;
    try {
      if (existsSync(this.file)) {
        this.lastMtime = statSync(this.file).mtimeMs;
        const raw = JSON.parse(readFileSync(this.file, "utf-8"));
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "number" && Number.isFinite(v)) this.data[k] = v;
        }
      }
    } catch {
    }
    this.loaded = true;
  }
  /**
   * 外部（如 qqadmin 后台）改了文件时重读内存表，避免本进程随后的
   * adjust/set 用旧数据覆盖外部修改。每次消息处理入口调用。
   */
  reloadIfChanged() {
    if (!this.loaded) {
      this.load();
      return;
    }
    try {
      if (!existsSync(this.file)) return;
      const mtime = statSync(this.file).mtimeMs;
      if (mtime === this.lastMtime) return;
      this.lastMtime = mtime;
      const raw = JSON.parse(readFileSync(this.file, "utf-8"));
      const next = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "number" && Number.isFinite(v)) next[k] = v;
      }
      this.data = next;
    } catch {
    }
  }
  /** 全表快照（后台展示用） */
  all() {
    this.reloadIfChanged();
    return { ...this.data };
  }
  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 1), "utf-8");
    } catch (err) {
      console.error("[dito qq] 好感度保存失败：", err.message);
    }
  }
  clamp(v) {
    return Math.max(this.min, Math.min(this.max, Math.round(v)));
  }
  get(key) {
    this.load();
    const v = this.data[key];
    return this.clamp(typeof v === "number" ? v : this.def);
  }
  /** 加减分并落盘，返回新分数 */
  adjust(key, delta) {
    this.load();
    const next = this.clamp(this.get(key) + delta);
    this.data[key] = next;
    this.save();
    return next;
  }
  set(key, value) {
    this.load();
    this.data[key] = this.clamp(value);
    this.save();
    return this.data[key];
  }
}
export {
  Affinity
};
