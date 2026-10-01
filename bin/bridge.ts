/**
 * Dito 桥接频道：Matrix 房间与 QQ 群双向互联，使用纯 HTTP 与 OneBot v11。
 * 用法：dito bridge
 * 配置：user/bridge/config.json（以下群号、房间仅为模板）
 * {
 *   "enabled": true,
 *   "reply": true, "recall": true, "poke": true, "media": true,
 *   "notice": true, "noticeToQq": false,
 *   "maxImageBytes": 4194304, "noticeIntervalSec": 180,
 *   "links": [{
 *     "matrix": "!房间ID:服务器", "qq": 100000000, "direction": "both",
 *     "toMatrixPrefix": "[QQ]", "toQqPrefix": "[Matrix]", "maxPerMinute": 30
 *   }]
 * }
 * 功能选项也可写在单个 link 中，优先于顶层选项；旧配置缺省即启用默认值。
 * 运行数据只写入本机 user/bridge，配置、状态、对照表均支持环境变量覆盖。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { ditoUserDir, loadConfig } from "../extensions/util.js";
import type { MatrixChannelConfig, QqChannelConfig } from "../extensions/util.js";

type Direction = "both" | "toqq" | "tomatrix";
interface FeatureOptions {
  reply?: boolean; recall?: boolean; poke?: boolean; media?: boolean;
  notice?: boolean; noticeToQq?: boolean; maxImageBytes?: number; noticeIntervalSec?: number;
}
interface BridgeLink extends FeatureOptions {
  matrix: string; qq: number; direction?: Direction;
  toMatrixPrefix?: string; toQqPrefix?: string; maxPerMinute?: number;
}
interface BridgeConfig extends FeatureOptions { enabled?: boolean; links?: BridgeLink[]; }
interface ResolvedLink extends BridgeLink {
  reply: boolean; recall: boolean; poke: boolean; media: boolean;
  notice: boolean; noticeToQq: boolean; maxImageBytes: number; noticeIntervalSec: number;
}
export interface MessageSegment { type: string; data: Record<string, unknown>; }
export interface OneBotEvent {
  post_type?: string; message_type?: string; notice_type?: string; sub_type?: string;
  self_id?: number; group_id?: number; user_id?: number; message_id?: number;
  operator_id?: number; target_id?: number; action?: string; suffix?: string;
  raw_message?: string; message?: unknown;
  sender?: { user_id?: number; nickname?: string; card?: string };
}
export interface MatrixEvent {
  event_id?: string; type: string; sender?: string; state_key?: string; redacts?: string;
  content?: Record<string, unknown>; unsigned?: { redacted_because?: MatrixEvent };
}
interface SyncResponse {
  next_batch: string;
  rooms?: { join?: Record<string, { timeline?: { events?: MatrixEvent[] }; state?: { events?: MatrixEvent[] } }> };
}
interface NoticeState { initialized: boolean; ids: string[]; }
export interface BridgeState { since?: string; notices?: Record<string, NoticeState>; }
interface MapEntry { q: number; m: string; t: number; }
interface Member { user_id: number; card?: string; nickname?: string; role?: string; }
interface MediaData { bytes: Buffer; mime: string; }

const DATA_DIR = join(ditoUserDir(), "bridge");
const CONFIG_PATH = process.env.DITO_BRIDGE_CONFIG || join(DATA_DIR, "config.json");
const STATE_PATH = process.env.DITO_BRIDGE_STATE || join(DATA_DIR, "state.json");
const MAP_PATH = process.env.DITO_BRIDGE_MAP || join(DATA_DIR, "map.json");
const DEBUG = process.env.DITO_BRIDGE_DEBUG === "1";
const REPLAY = process.env.DITO_BRIDGE_REPLAY === "1";
const MAX_BODY = 800;
const MAP_LIMIT = 800;
const MAP_AGE = 3 * 24 * 60 * 60 * 1000;
const SAVE_INTERVAL = 5000;
const MEMBER_INTERVAL = 30 * 60 * 1000;
const DEFAULT_IMAGE_BYTES = 4 * 1024 * 1024;
const log = (...parts: unknown[]): void => console.log("[dito bridge]", ...parts);
let secrets: string[] = [];
function errorText(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[凭据已隐藏]");
  return text.replace(/(?:Bearer\s+\S+|(?:access_?token|cookie|rkey)\s*[=:]\s*[^\s,;]+)/gi, "[凭据已隐藏]").slice(0, 240);
}
export function clip(text: string): string {
  const suffix = "…（已截断）";
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY - suffix.length) + suffix : text;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function finiteId(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (value === "") return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}
function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
const CONFIG_TEMPLATE: BridgeConfig = {
  enabled: true, reply: true, recall: true, poke: true, media: true,
  notice: true, noticeToQq: false, maxImageBytes: DEFAULT_IMAGE_BYTES, noticeIntervalSec: 180,
  links: [{ matrix: "!房间ID:服务器", qq: 100000000, direction: "both", toMatrixPrefix: "[QQ]", toQqPrefix: "[Matrix]", maxPerMinute: 30 }],
};
function loadBridgeConfig(): BridgeConfig {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n", { mode: 0o600 });
    throw new Error(`还没有桥接配置，已生成模板：${CONFIG_PATH}`);
  }
  const cfg = object(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
  if (!Array.isArray(cfg.links)) throw new Error("桥接配置 links 必须是数组");
  return cfg as unknown as BridgeConfig;
}
function resolveLinks(config: BridgeConfig): ResolvedLink[] {
  const keys = new Set<string>();
  return (Array.isArray(config.links) ? config.links : []).flatMap((raw) => {
    const link = object(raw) as unknown as BridgeLink;
    if (typeof link.matrix !== "string" || !link.matrix.startsWith("!") || !Number.isSafeInteger(link.qq) || link.qq <= 0) {
      log("忽略无效的桥接房间或群号"); return [];
    }
    if (link.direction && !["both", "toqq", "tomatrix"].includes(link.direction)) { log("忽略无效的桥接方向"); return []; }
    const key = `${link.matrix}|${link.qq}`;
    if (keys.has(key)) { log("忽略重复的桥接连接：", key); return []; }
    keys.add(key);
    const options = { ...config, ...link };
    return [{ ...link, direction: link.direction ?? "both", maxPerMinute: positive(link.maxPerMinute, 30),
      reply: options.reply !== false, recall: options.recall !== false, poke: options.poke !== false,
      media: options.media !== false, notice: options.notice !== false, noticeToQq: options.noticeToQq === true,
      maxImageBytes: positive(options.maxImageBytes, DEFAULT_IMAGE_BYTES), noticeIntervalSec: positive(options.noticeIntervalSec, 180) }];
  });
}

// ── 状态与消息对照表：节流写盘，退出时强制刷新 ────────────────────
export class JsonStore<T> {
  readonly data: T;
  private dirty = false;
  private lastSave = 0;
  constructor(private readonly path: string, initial: T, validate: (raw: unknown) => T = (raw) => raw as T) {
    this.data = initial;
    try { if (existsSync(path)) this.data = validate(JSON.parse(readFileSync(path, "utf-8"))); }
    catch (error) { log("读取运行数据失败：", path, errorText(error)); }
  }
  changed(): void { this.dirty = true; }
  save(force = false): void {
    if (!this.dirty || (!force && Date.now() - this.lastSave < SAVE_INTERVAL)) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data) + "\n", { mode: 0o600 });
      renameSync(`${this.path}.tmp`, this.path);
      this.lastSave = Date.now(); this.dirty = false;
    } catch (error) { log("运行数据写盘失败：", this.path, errorText(error)); }
  }
}
export class MessageMap {
  private readonly store: JsonStore<Record<string, MapEntry[]>>;
  constructor(path = MAP_PATH) {
    this.store = new JsonStore(path, {}, (raw) => {
      const result: Record<string, MapEntry[]> = {};
      for (const [key, list] of Object.entries(object(raw))) if (Array.isArray(list)) {
        result[key] = list.filter((entry) => Number.isSafeInteger(entry?.q) && typeof entry?.m === "string" && Number.isFinite(entry?.t));
      }
      return result;
    });
    this.prune();
  }
  private prune(): void {
    const now = Date.now();
    for (const [key, list] of Object.entries(this.store.data)) {
      const kept = list.filter((entry) => now - entry.t <= MAP_AGE).slice(-MAP_LIMIT);
      if (kept.length !== list.length) { this.store.data[key] = kept; this.store.changed(); }
    }
  }
  add(key: string, q: number, m: string): void {
    if (!Number.isSafeInteger(q) || !m) return;
    this.prune();
    const list = (this.store.data[key] ?? []).filter((entry) => entry.m !== m);
    list.push({ q, m, t: Date.now() });
    this.store.data[key] = list.slice(-MAP_LIMIT); this.store.changed();
  }
  matrixIdsForQq(key: string, q: number): string[] {
    this.prune(); return [...new Set((this.store.data[key] ?? []).filter((entry) => entry.q === q).map((entry) => entry.m))];
  }
  qqIdForMatrix(key: string, m: string): number | undefined {
    this.prune(); return this.store.data[key]?.findLast((entry) => entry.m === m)?.q;
  }
  replaceQq(key: string, oldId: number, newId: number): void {
    for (const entry of this.store.data[key] ?? []) if (entry.q === oldId) {
      entry.q = newId; entry.t = Date.now(); this.store.changed();
    }
  }
  save(force = false): void { this.prune(); this.store.save(force); }
}

// ── Matrix HTTP 与媒体：使用本机实测的端点 ────────────────────────
export class ImageTooLargeError extends Error { constructor() { super("图片超过大小上限"); } }
async function readMedia(response: Response, maxBytes: number): Promise<MediaData> {
  if (!response.ok) throw new Error(`媒体下载失败，状态码 ${response.status}`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel(); throw new ImageTooLargeError();
  }
  if (!response.body) throw new Error("媒体响应为空");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new ImageTooLargeError(); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return { bytes: Buffer.concat(chunks, length), mime: response.headers.get("content-type")?.split(";")[0] || "image/jpeg" };
}
export class MatrixApi {
  constructor(private readonly base: string, private readonly token: string, private readonly signal?: AbortSignal) {}
  private timeout(milliseconds: number): AbortSignal {
    return this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);
  }
  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const response = await fetch(`${this.base.replace(/\/$/, "")}/_matrix/client/v3${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: this.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Matrix 请求失败，状态码 ${response.status}${response.status === 400 && (await response.text()).includes("M_UNKNOWN_POS") ? "，M_UNKNOWN_POS" : ""}`);
    const text = await response.text(); return (text ? JSON.parse(text) : {}) as T;
  }
  whoami(): Promise<{ user_id: string }> { return this.request("GET", "/account/whoami"); }
  sync(since: string | undefined, timeoutMs: number, filter: unknown): Promise<SyncResponse> {
    const query = new URLSearchParams({ timeout: String(timeoutMs), filter: JSON.stringify(filter) });
    if (since) query.set("since", since);
    return this.request("GET", `/sync?${query}`, undefined, timeoutMs + 20_000);
  }
  sendText(room: string, txn: string, content: Record<string, unknown>): Promise<{ event_id: string }> {
    return this.request("PUT", `/rooms/${encodeURIComponent(room)}/send/m.room.message/${encodeURIComponent(txn)}`, content);
  }
  redact(room: string, event: string, txn: string, reason: string): Promise<unknown> {
    return this.request("PUT", `/rooms/${encodeURIComponent(room)}/redact/${encodeURIComponent(event)}/${encodeURIComponent(txn)}`, { reason });
  }
  event(room: string, event: string): Promise<MatrixEvent> {
    return this.request("GET", `/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(event)}`);
  }
  async roomName(room: string): Promise<string | undefined> {
    try {
      const result = await this.request<{ name?: string }>("GET", `/rooms/${encodeURIComponent(room)}/state/m.room.name/`, undefined, 10_000);
      return result.name;
    } catch (error) { log("读取房间名失败：", errorText(error)); return undefined; }
  }
  async upload(media: MediaData, filename: string): Promise<string> {
    const response = await fetch(`${this.base.replace(/\/$/, "")}/_matrix/media/v3/upload?${new URLSearchParams({ filename })}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": media.mime },
      body: new Uint8Array(media.bytes), signal: this.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Matrix 媒体上传失败，状态码 ${response.status}`);
    const result = object(await response.json());
    if (typeof result.content_uri !== "string" || !result.content_uri.startsWith("mxc://")) throw new Error("Matrix 上传未返回媒体地址");
    return result.content_uri;
  }
  async download(mxc: string, maxBytes: number): Promise<MediaData> {
    const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc);
    if (!match) throw new Error("Matrix 图片地址不是有效的 mxc 地址");
    const response = await fetch(`${this.base.replace(/\/$/, "")}/_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`, {
      headers: { Authorization: `Bearer ${this.token}` }, signal: this.timeout(30_000),
    });
    return readMedia(response, maxBytes);
  }
}

// ── OneBot：通知、动作配对、超时与断线重连 ────────────────────────
export class OneBotClient {
  private ws?: WebSocket;
  private closed = false;
  private selfId = 0;
  private seq = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onGroupMessage?: (event: OneBotEvent) => void;
  onNotice?: (event: OneBotEvent) => void;
  onReady?: () => void;
  constructor(private readonly url: string, private readonly token?: string) {}
  get botId(): number { return this.selfId; }
  connect(): void {
    if (this.closed) return;
    try {
      const ws = new WebSocket(this.url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined, handshakeTimeout: 10_000 });
      this.ws = ws;
      ws.on("open", () => {
        log("OneBot 已连接");
        void this.call("get_login_info", {}).then((raw) => {
          const info = object(raw); const id = finiteId(info.user_id);
          if (!id) throw new Error("OneBot 返回的机器人账号无效");
          this.selfId = id; log(`QQ 账号：${String(info.nickname ?? "未知")}(${id})`); this.onReady?.();
        }).catch((error) => { log("读取 QQ 账号失败：", errorText(error)); ws.close(); });
      });
      ws.on("message", (data: RawData) => this.onFrame(data.toString()));
      ws.on("error", (error) => log("OneBot 错误：", errorText(error)));
      ws.on("close", (code) => {
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("OneBot 连接已断开")); }
        this.pending.clear();
        if (!this.closed) { log(`OneBot 断开，代码 ${code}，3 秒后重连`); this.retry = setTimeout(() => this.connect(), 3000); }
      });
    } catch (error) {
      log("OneBot 连接失败：", errorText(error));
      if (!this.closed) this.retry = setTimeout(() => this.connect(), 3000);
    }
  }
  close(): void {
    this.closed = true; clearTimeout(this.retry);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("桥接正在退出")); }
    this.pending.clear();
    try { this.ws?.terminate(); } catch (error) { log("关闭 OneBot 失败：", errorText(error)); }
  }
  private onFrame(raw: string): void {
    try {
      const data = object(JSON.parse(raw));
      if (typeof data.echo === "string") {
        const item = this.pending.get(data.echo);
        if (item) {
          this.pending.delete(data.echo); clearTimeout(item.timer);
          if (data.status === "ok" || data.retcode === 0) item.resolve(data.data);
          else item.reject(new Error(`OneBot 动作失败：${String(data.retcode)} ${String(data.wording ?? data.message ?? "")}`));
        }
        return;
      }
      const event = data as OneBotEvent;
      if (!this.selfId && event.self_id) this.selfId = Number(event.self_id);
      if (event.post_type === "message" && event.message_type === "group") this.onGroupMessage?.(event);
      else if (event.post_type === "notice") this.onNotice?.(event);
    } catch (error) { log("处理 OneBot 数据失败：", errorText(error)); }
  }
  call(action: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (this.closed || !ws || ws.readyState !== WebSocket.OPEN) { reject(new Error("OneBot 未连接")); return; }
      const echo = `bridge-${++this.seq}`;
      const timer = setTimeout(() => { if (this.pending.delete(echo)) reject(new Error(`OneBot 动作 ${action} 超时`)); }, 20_000);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }), (error) => {
          if (error && this.pending.delete(echo)) { clearTimeout(timer); reject(error); }
        });
      } catch (error) { this.pending.delete(echo); clearTimeout(timer); reject(error); }
    });
  }
  sendGroupText(group: number, message: string | MessageSegment[]): Promise<unknown> {
    return this.call("send_group_msg", { group_id: group, message });
  }
}

// ── 消息段、CQ 转换与懒加载表情目录 ────────────────────────────────
function decodeCq(text: string): string {
  return text.replaceAll("&#91;", "[").replaceAll("&#93;", "]").replaceAll("&#44;", ",").replaceAll("&amp;", "&");
}
export function decodeHtml(text: string): string {
  return text.replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (all, number: string | undefined, name: string | undefined) => {
    if (number) {
      const code = number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : Number(number);
      try { return String.fromCodePoint(code); } catch { return all; }
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[String(name).toLowerCase()] ?? all;
  });
}
export function parseCq(raw: string): MessageSegment[] {
  const result: MessageSegment[] = []; let offset = 0;
  for (const match of raw.matchAll(/\[CQ:([\w-]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index! > offset) result.push({ type: "text", data: { text: decodeCq(raw.slice(offset, match.index)) } });
    const data: Record<string, unknown> = {};
    for (const field of match[2].split(",").slice(1)) {
      const equals = field.indexOf("="); if (equals > 0) data[field.slice(0, equals)] = decodeCq(field.slice(equals + 1));
    }
    result.push({ type: match[1], data }); offset = match.index! + match[0].length;
  }
  if (offset < raw.length) result.push({ type: "text", data: { text: decodeCq(raw.slice(offset)) } });
  return result;
}
export function messageSegments(event: OneBotEvent): MessageSegment[] {
  if (Array.isArray(event.message)) {
    const list = event.message.filter((part) => part && typeof part.type === "string").map((part) => ({ type: part.type, data: object(part.data) }));
    if (list.length) return list;
  }
  return parseCq(typeof event.raw_message === "string" ? event.raw_message : typeof event.message === "string" ? event.message : "");
}
function flashImage(data: Record<string, unknown>): boolean {
  return data.type === "flash" || String(data.sub_type) === "1" || String(data.summary ?? "").includes("闪照");
}
export function segmentsToText(parts: MessageSegment[], faces = new Map<string, string>()): string {
  // 语音、视频、文件只转占位；目前不传输这些媒体的原始内容。
  return parts.map(({ type, data }) => {
    if (type === "text") return String(data.text ?? "");
    if (type === "reply") return "";
    if (type === "at") return `@${String(data.name || data.qq || "未知")}`;
    if (type === "image") return flashImage(data) ? "[闪照]" : "[图片]";
    if (type === "face") return `[${faces.get(String(data.id)) || "表情"}]`;
    if (type === "record") return "[语音]";
    if (type === "video") return "[视频]";
    if (type === "file") return `[文件${data.name ? ` ${String(data.name)}` : ""}]`;
    if (type === "forward") return "[合并转发]";
    if (type === "json" || type === "xml") return "[卡片]";
    return "[消息]";
  }).join("").trim();
}
/** 保持原来的同步 CQ 转纯文本接口；运行中的桥接另加表情名称目录。 */
export function cqToText(raw: string): string { return segmentsToText(parseCq(raw)).replace(/\s+/g, " ").trim(); }
class FaceCatalog {
  private loading?: Promise<Map<string, string>>;
  constructor(private readonly bot: Pick<OneBotClient, "call">) {}
  get(): Promise<Map<string, string>> {
    return this.loading ??= (async () => {
      const names = new Map<string, string>();
      try {
        const data = object(await this.bot.call("fetch_sys_faces", {}));
        for (const pack of Array.isArray(data.packs) ? data.packs : []) {
          for (const face of Array.isArray(pack.emojis) ? pack.emojis : []) {
            if (face.q_sid != null && typeof face.q_des === "string") names.set(String(face.q_sid), face.q_des.replace(/^\/+/, ""));
          }
        }
      } catch (error) { log("表情目录获取失败，使用占位：", errorText(error)); }
      return names;
    })();
  }
}
class RateLimiter {
  private stamps: number[] = [];
  constructor(private readonly perMinute: number) {}
  take(): boolean {
    const now = Date.now(); this.stamps = this.stamps.filter((time) => now - time < 60_000);
    if (this.stamps.length >= this.perMinute) return false;
    this.stamps.push(now); return true;
  }
}
function txn(...parts: (string | number)[]): string {
  return `bridge-${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40)}`;
}
function replyTarget(content: Record<string, unknown>): string | undefined {
  const id = object(object(content["m.relates_to"])["m.in_reply_to"]).event_id;
  return typeof id === "string" ? id : undefined;
}
function matrixBody(content: Record<string, unknown>): string {
  let text = typeof content.body === "string" ? content.body : "";
  // Matrix 原生回复的纯文本回退块不再重复搬到 QQ。
  if (replyTarget(content) && text.startsWith("> ")) {
    const split = text.indexOf("\n\n"); if (split >= 0) text = text.slice(split + 2);
  }
  return text.trim();
}

// ── 每个连接串行处理，保证图片、回复、编辑与撤回的对照关系一致 ─────
export interface RuntimeLink {
  cfg: ResolvedLink; key: string; out: RateLimiter; in: RateLimiter; toQqPrefix: string;
  seenEvents: Set<string>; memberNames: Map<string, string>; qqMembers: Map<number, Member>;
  qqNames: Map<string, number>; originalEvents: Map<string, MatrixEvent>;
  noticeBusy: boolean; memberBusy: boolean; nextNotice: number; nextMembers: number;
  tail: Promise<void>; queued: number;
}
export class BridgeRelay {
  readonly runtimes: RuntimeLink[];
  private readonly faces: FaceCatalog;
  constructor(config: BridgeConfig, private readonly api: MatrixApi,
    private readonly bot: Pick<OneBotClient, "call" | "sendGroupText" | "botId">,
    private readonly map: MessageMap, private readonly state: JsonStore<BridgeState>,
    private readonly me: string, private readonly signal?: AbortSignal) {
    this.faces = new FaceCatalog(bot);
    this.runtimes = resolveLinks(config).map((cfg) => ({ cfg, key: `${cfg.matrix}|${cfg.qq}`,
      out: new RateLimiter(cfg.maxPerMinute ?? 30), in: new RateLimiter(cfg.maxPerMinute ?? 30),
      toQqPrefix: cfg.toQqPrefix ?? "[Matrix]", seenEvents: new Set(), memberNames: new Map(),
      qqMembers: new Map(), qqNames: new Map(), originalEvents: new Map(), noticeBusy: false,
      memberBusy: false, nextNotice: 0, nextMembers: 0, tail: Promise.resolve(), queued: 0 }));
  }
  enqueue(rt: RuntimeLink, task: () => Promise<void>): Promise<void> {
    if (rt.queued >= 100) { log("桥接待处理队列已满，丢弃：", rt.key); return Promise.resolve(); }
    rt.queued++;
    const next = rt.tail.then(async () => { if (!this.signal?.aborted) await task(); })
      .catch((error) => { if (!this.signal?.aborted) log("处理单条桥接事件失败：", rt.key, errorText(error)); })
      .finally(() => { rt.queued--; });
    rt.tail = next; return next;
  }
  private allowed(rt: RuntimeLink, direction: "out" | "in"): boolean {
    if (rt[direction].take()) return true;
    log("每分钟限额已满，丢弃一条：", rt.key, direction === "out" ? "QQ 到 Matrix" : "Matrix 到 QQ"); return false;
  }
  private marker(rt: RuntimeLink, src: string, messageId: unknown, from: unknown): Record<string, unknown> {
    return { src, group: rt.cfg.qq, messageId: messageId ?? "", from: from ?? "" };
  }
  private remember(rt: RuntimeLink, event: MatrixEvent): void {
    if (!event.event_id) return;
    rt.originalEvents.set(event.event_id, event);
    if (rt.originalEvents.size > MAP_LIMIT) rt.originalEvents.delete(rt.originalEvents.keys().next().value!);
  }
  async refreshMembers(rt: RuntimeLink): Promise<void> {
    if (rt.memberBusy) return;
    rt.memberBusy = true; rt.nextMembers = Date.now() + MEMBER_INTERVAL;
    try {
      const data = await this.bot.call("get_group_member_list", { group_id: rt.cfg.qq });
      if (!Array.isArray(data)) throw new Error("群成员接口未返回数组");
      const members = new Map<number, Member>(); const names = new Map<string, number>();
      // 群名片先登记，再补昵称；昵称不能抢占另一人的群名片。
      for (const raw of data) {
        const item = object(raw); const id = finiteId(item.user_id); if (!id) continue;
        const member = { ...item, user_id: id } as Member; members.set(id, member);
        if (member.card) names.set(member.card, id);
      }
      for (const [id, member] of members) if (member.nickname && !names.has(member.nickname)) names.set(member.nickname, id);
      rt.qqMembers = members; rt.qqNames = names;
      if (DEBUG) log(`群 ${rt.cfg.qq} 成员缓存已刷新，${members.size} 人`);
    } catch (error) { log(`群 ${rt.cfg.qq} 成员缓存刷新失败：`, errorText(error)); }
    finally { rt.memberBusy = false; }
  }
  private memberName(rt: RuntimeLink, id: number): string {
    const member = rt.qqMembers.get(id); return member?.card || member?.nickname || String(id);
  }
  private findMember(rt: RuntimeLink, name: string): number | undefined {
    const exact = rt.qqNames.get(name); if (exact !== undefined) return exact;
    const id = finiteId(name); if (id !== undefined && rt.qqMembers.has(id)) return id;
    for (const [userId, member] of rt.qqMembers) if (member.card?.startsWith(name)) return userId;
    for (const [userId, member] of rt.qqMembers) if (member.nickname?.startsWith(name)) return userId;
    return undefined;
  }
  async handleQq(event: OneBotEvent): Promise<void> {
    const group = finiteId(event.group_id); const sender = finiteId(event.sender?.user_id ?? event.user_id);
    // 登录信息返回前不处理群事件，避免机器人刚重连时自己的消息漏过回环检查。
    if (!this.bot.botId || !group || !sender || sender === this.bot.botId || sender === event.self_id) return;
    for (const rt of this.runtimes) if (rt.cfg.qq === group && rt.cfg.direction !== "toqq") await this.enqueue(rt, () => this.forwardQq(rt, event, sender));
  }
  private async forwardQq(rt: RuntimeLink, event: OneBotEvent, sender: number): Promise<void> {
    const parts = messageSegments(event);
    const faces = parts.some((part) => part.type === "face") ? await this.faces.get() : new Map<string, string>();
    const body = segmentsToText(parts, faces);
    if (!body || !this.allowed(rt, "out")) return;
    const who = event.sender?.card || event.sender?.nickname || this.memberName(rt, sender);
    const prefix = `${rt.cfg.toMatrixPrefix ?? "[QQ]"} ${who}：`;
    const messageId = finiteId(event.message_id);
    const id = messageId ?? randomUUID();
    const marker = this.marker(rt, "qq", messageId, sender);
    const content: Record<string, unknown> = { msgtype: "m.text", body: clip(prefix + body), "dito.bridge": marker };
    const reply = parts.find((part) => part.type === "reply");
    const replyId = finiteId(reply?.data.id);
    const original = rt.cfg.reply && replyId !== undefined ? this.map.matrixIdsForQq(rt.key, replyId)[0] : undefined;
    if (original) content["m.relates_to"] = { "m.in_reply_to": { event_id: original } };
    try {
      const sent = await this.api.sendText(rt.cfg.matrix, txn(rt.key, "qq-text", id), content);
      if (messageId !== undefined) this.map.add(rt.key, messageId, sent.event_id);
      this.remember(rt, { type: "m.room.message", event_id: sent.event_id, sender: this.me, content });
      if (DEBUG) log("QQ 文字已转发：", rt.key, messageId);
    } catch (error) { log("QQ 文字转发失败：", rt.key, errorText(error)); }
    if (!rt.cfg.media) return;
    const images = parts.filter((part) => part.type === "image");
    for (let index = 0; index < images.length; index++) {
      try {
        const media = await this.qqImage(images[index].data, rt.cfg.maxImageBytes);
        const ext = ({ "image/png": "png", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[media.mime] ?? "jpg";
        const filename = `qq-${id}-${index}.${ext}`;
        const url = await this.api.upload(media, filename);
        const imageContent: Record<string, unknown> = { msgtype: "m.image", body: clip(prefix + "图片"), filename, url,
          info: { mimetype: media.mime, size: media.bytes.length }, "dito.bridge": marker };
        if (original) imageContent["m.relates_to"] = { "m.in_reply_to": { event_id: original } };
        const sent = await this.api.sendText(rt.cfg.matrix, txn(rt.key, "qq-image", id, index), imageContent);
        if (messageId !== undefined) this.map.add(rt.key, messageId, sent.event_id);
        this.remember(rt, { type: "m.room.message", event_id: sent.event_id, sender: this.me, content: imageContent });
        if (DEBUG) log("QQ 图片已转发：", rt.key, messageId, media.bytes.length);
      } catch (error) { log("QQ 图片未转发，保留文字占位：", rt.key, errorText(error)); }
    }
  }
  private async qqImage(data: Record<string, unknown>, maxBytes: number): Promise<MediaData> {
    let url = typeof data.url === "string" ? data.url : "";
    if (!url && typeof data.file === "string") {
      const found = object(await this.bot.call("get_image", { file: data.file }));
      url = typeof found.url === "string" ? found.url : "";
    }
    if (!/^https?:\/\//i.test(url)) throw new Error("图片没有可下载的网络地址");
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetch(url, { signal: this.signal ? AbortSignal.any([timeout, this.signal]) : timeout });
    return readMedia(response, maxBytes);
  }
  async handleNotice(event: OneBotEvent): Promise<void> {
    const group = finiteId(event.group_id); if (!group) return;
    if (event.notice_type === "group_recall" && finiteId(event.operator_id) === this.bot.botId) return;
    if (event.notice_type === "notify" && event.sub_type === "poke" && finiteId(event.user_id) === this.bot.botId) return;
    for (const rt of this.runtimes) if (rt.cfg.qq === group && rt.cfg.direction !== "toqq") await this.enqueue(rt, async () => {
      if (event.notice_type === "group_recall" && rt.cfg.recall) {
        const id = finiteId(event.message_id); if (id === undefined) return;
        for (const matrixId of this.map.matrixIdsForQq(rt.key, id)) {
          try { await this.api.redact(rt.cfg.matrix, matrixId, txn(rt.key, "qq-recall", id, matrixId), "QQ 侧撤回"); }
          catch (error) { log("QQ 撤回同步失败：", rt.key, errorText(error)); }
        }
      } else if (event.notice_type === "notify" && event.sub_type === "poke" && rt.cfg.poke) {
        if (!this.allowed(rt, "out")) return;
        const from = finiteId(event.user_id) ?? 0; const to = finiteId(event.target_id) ?? 0;
        const body = clip(`[戳一戳] ${this.memberName(rt, from)} ${event.action || "拍了拍"} ${this.memberName(rt, to)}${event.suffix ? ` ${event.suffix}` : ""}`);
        try {
          await this.api.sendText(rt.cfg.matrix, `qq-poke-${randomUUID()}`, { msgtype: "m.text", body,
            "dito.bridge": this.marker(rt, "qq-poke", event.message_id, from) });
        } catch (error) { log("戳一戳同步到房间失败：", rt.key, errorText(error)); }
      }
    });
  }
  private async deleteQq(rt: RuntimeLink, id: number): Promise<void> {
    try { await this.bot.call("delete_msg", { message_id: id }); }
    catch (error) { log("QQ 撤回失败，可能没有管理权限：", rt.key, errorText(error)); }
  }
  async handleMatrix(rt: RuntimeLink, event: MatrixEvent): Promise<void> {
    if (!event.event_id) return;
    this.remember(rt, event);
    const redacted = event.unsigned?.redacted_because;
    const target = event.type === "m.room.redaction" ? event.redacts ?? object(event.content).redacts : redacted ? event.event_id : undefined;
    if (typeof target === "string" && rt.cfg.recall && rt.cfg.direction !== "tomatrix") {
      const actor = redacted?.sender ?? event.sender;
      if (actor === this.me) return;
      const dedup = `redact:${target}`;
      if (rt.seenEvents.has(dedup)) return;
      const id = this.map.qqIdForMatrix(rt.key, target);
      if (id !== undefined) { rt.seenEvents.add(dedup); await this.deleteQq(rt, id); }
      return;
    }
    if (event.type !== "m.room.message" || !event.sender || rt.cfg.direction === "tomatrix" || redacted) return;
    const content = object(event.content);
    if (event.sender === this.me || "dito.bridge" in content) return;
    if (rt.seenEvents.has(event.event_id)) return;
    rt.seenEvents.add(event.event_id);
    if (rt.seenEvents.size > MAP_LIMIT) rt.seenEvents.delete(rt.seenEvents.values().next().value!);
    const relates = object(content["m.relates_to"]);
    let effective = content; let oldQq: number | undefined; let originalId: string | undefined;
    if (relates.rel_type === "m.replace") {
      originalId = typeof relates.event_id === "string" ? relates.event_id : undefined;
      if (!originalId || !content["m.new_content"]) return;
      effective = object(content["m.new_content"]);
      if ("dito.bridge" in effective) return;
      oldQq = this.map.qqIdForMatrix(rt.key, originalId);
      try {
        const original = rt.originalEvents.get(originalId) ?? await this.api.event(rt.cfg.matrix, originalId);
        if (original.sender === this.me || "dito.bridge" in object(original.content)) return;
        if (original.sender && original.sender !== event.sender) { log("忽略非原作者的编辑：", rt.key); return; }
        this.remember(rt, original);
      } catch (error) { log("无法确认原消息，忽略本次编辑：", rt.key, errorText(error)); return; }
    }
    const body = matrixBody(effective);
    const who = rt.memberNames.get(event.sender) ?? event.sender;
    const poke = /^(?:\[戳一戳\]\s*|\/poke\s+)(.+)$/.exec(body);
    if (poke && rt.cfg.poke && !originalId) {
      const targetId = this.findMember(rt, poke[1].trim());
      if (targetId === undefined) { log("戳一戳找不到群成员：", rt.key); return; }
      if (!this.allowed(rt, "in")) return;
      try { await this.bot.call("group_poke", { group_id: rt.cfg.qq, user_id: targetId }); }
      catch (error) { log("房间戳一戳执行失败：", rt.key, errorText(error)); }
      return;
    }
    if (/^\/公告(?:\s|$)/.test(body) && rt.cfg.noticeToQq && !originalId) {
      if (!this.allowed(rt, "in")) return;
      try {
        const info = object(await this.bot.call("get_group_member_info", { group_id: rt.cfg.qq, user_id: this.bot.botId }));
        if (info.role !== "admin" && info.role !== "owner") { log("机器人不是管理员或群主，拒绝发公告：", rt.key); return; }
        const text = body.replace(/^\/公告\s*/, "").trim();
        if (!text) { log("群公告正文为空：", rt.key); return; }
        await this.bot.call("_send_group_notice", { group_id: rt.cfg.qq, content: clip(text) });
      } catch (error) { log("房间群公告发布失败：", rt.key, errorText(error)); }
      return;
    }
    if (!body && effective.msgtype !== "m.image") return;
    if (!this.allowed(rt, "in")) return;
    if (oldQq !== undefined) await this.deleteQq(rt, oldQq);
    const parts: MessageSegment[] = [];
    const replyId = rt.cfg.reply ? replyTarget(effective) : undefined;
    const qqReply = replyId ? this.map.qqIdForMatrix(rt.key, replyId) : undefined;
    if (qqReply !== undefined) parts.push({ type: "reply", data: { id: String(qqReply) } });
    const prefix = `${rt.toQqPrefix} ${who}：`;
    const type = effective.msgtype;
    if (type === "m.image") {
      let text = "[图片]";
      if (rt.cfg.media && typeof effective.url === "string") {
        try {
          const media = await this.api.download(effective.url, rt.cfg.maxImageBytes);
          parts.push({ type: "text", data: { text: clip(prefix + (body || "图片")) } });
          parts.push({ type: "image", data: { file: `base64://${media.bytes.toString("base64")}` } });
          text = "";
        } catch (error) {
          text = error instanceof ImageTooLargeError ? "[图片过大，未转发]" : "[图片下载失败，未转发]";
          log("Matrix 图片未转发：", rt.key, errorText(error));
        }
      } else if (rt.cfg.media) text = "[图片地址不可用，未转发]";
      if (text) parts.push({ type: "text", data: { text: clip(prefix + text) } });
    } else {
      const text = type === "m.text" || type === "m.notice" || type === "m.emote" ? body
        : type === "m.audio" ? "[语音]" : type === "m.video" ? "[视频]"
          : type === "m.file" ? `[文件 ${body}]` : "[不支持的消息]";
      parts.push({ type: "text", data: { text: clip(prefix + text) } });
    }
    try {
      const sent = object(await this.bot.sendGroupText(rt.cfg.qq, parts));
      const id = finiteId(sent.message_id);
      if (id === undefined) { log("QQ 发送成功但未返回消息编号，无法登记对照表：", rt.key); return; }
      if (oldQq !== undefined) this.map.replaceQq(rt.key, oldQq, id);
      if (originalId) this.map.add(rt.key, id, originalId);
      this.map.add(rt.key, id, event.event_id);
      if (DEBUG) log("房间消息已转发：", rt.key, event.event_id, id);
    } catch (error) { log("转发到 QQ 群失败：", rt.key, errorText(error)); }
  }
  async pollNotices(rt: RuntimeLink): Promise<void> {
    if (!rt.cfg.notice || rt.cfg.direction === "toqq" || rt.noticeBusy) return;
    rt.noticeBusy = true; rt.nextNotice = Date.now() + rt.cfg.noticeIntervalSec * 1000;
    try {
      const result = await this.bot.call("_get_group_notice", { group_id: rt.cfg.qq });
      const data = object(result);
      const notices = Array.isArray(result) ? result : Array.isArray(data.notices) ? data.notices : Array.isArray(data.data) ? data.data : undefined;
      if (!notices) throw new Error("群公告接口未返回公告数组");
      this.state.data.notices ??= {};
      let saved = this.state.data.notices[rt.key];
      const ids = notices.map((notice) => String(notice.notice_id ?? notice.id ?? "")).filter(Boolean);
      if (!saved?.initialized) {
        this.state.data.notices[rt.key] = { initialized: true, ids: ids.slice(-MAP_LIMIT) };
        this.state.changed(); if (DEBUG) log("群公告首次同步只记录已有公告：", rt.key, ids.length); return;
      }
      const seen = new Set(saved.ids);
      for (const raw of notices.slice().reverse()) {
        const item = object(raw); const id = String(item.notice_id ?? item.id ?? "");
        if (!id || seen.has(id)) continue;
        if (!this.allowed(rt, "out")) continue;
        const message = object(item.message);
        const text = decodeHtml(String(message.text ?? item.content ?? item.text ?? ""));
        const from = finiteId(item.sender_id ?? item.sender ?? item.user_id) ?? 0;
        try {
          await this.api.sendText(rt.cfg.matrix, txn(rt.key, "qq-notice", id), { msgtype: "m.text",
            body: clip(`[群公告] ${this.memberName(rt, from)}：${text}`), "dito.bridge": this.marker(rt, "qq-notice", id, from) });
          seen.add(id); saved.ids = [...seen].slice(-MAP_LIMIT); this.state.changed();
        } catch (error) { log("群公告同步失败：", rt.key, errorText(error)); }
      }
    } catch (error) { log("读取群公告失败：", rt.key, errorText(error)); }
    finally { rt.noticeBusy = false; }
  }
}

// ── 启动、定时刷新与可中断的长轮询 ────────────────────────────────
export async function runBridgeChannel(): Promise<void> {
  const stop = new AbortController();
  const state = new JsonStore<BridgeState>(STATE_PATH, {}, (raw) => {
    const value = object(raw);
    return { since: typeof value.since === "string" ? value.since : undefined,
      notices: Object.fromEntries(Object.entries(object(value.notices)).filter(([, item]) => object(item).initialized === true && Array.isArray(object(item).ids))) as Record<string, NoticeState> };
  });
  const map = new MessageMap();
  let bot: OneBotClient | undefined;
  let relay: BridgeRelay | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const shutdown = (): void => { if (!stop.signal.aborted) { log("收到退出信号，正在收尾"); stop.abort(); bot?.close(); } };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  try {
    const config = loadBridgeConfig();
    if (config.enabled === false) { log("配置已禁用，不启动"); return; }
    if (!resolveLinks(config).length) throw new Error("桥接配置里没有有效连接");
    const app = loadConfig();
    const matrix = app.channels.matrix as MatrixChannelConfig; const qq = app.channels.qq as QqChannelConfig;
    if (!matrix?.homeserver || !matrix.accessToken) throw new Error("Matrix 配置缺少服务器或访问令牌");
    if (!qq?.url) throw new Error("QQ 配置缺少 OneBot 地址");
    secrets = [matrix.accessToken, qq.accessToken ?? ""];
    const api = new MatrixApi(matrix.homeserver, matrix.accessToken, stop.signal);
    const me = await api.whoami(); if (!me.user_id) throw new Error("Matrix 身份验证未返回用户编号");
    log("Matrix 身份：", me.user_id);
    bot = new OneBotClient(qq.url, qq.accessToken || undefined);
    relay = new BridgeRelay(config, api, bot, map, state, me.user_id, stop.signal);
    for (const rt of relay.runtimes) {
      const name = await api.roomName(rt.cfg.matrix);
      rt.toQqPrefix = rt.cfg.toQqPrefix ?? (name ? `[${name}]` : "[Matrix]");
      log(`桥接：${rt.cfg.matrix}（${name ?? "无房间名"}）与 QQ 群 ${rt.cfg.qq}，方向 ${rt.cfg.direction}`);
    }
    const activeRelay = relay;
    bot.onGroupMessage = (event) => { void activeRelay.handleQq(event).catch((error) => log("QQ 消息处理失败：", errorText(error))); };
    bot.onNotice = (event) => { void activeRelay.handleNotice(event).catch((error) => log("QQ 通知处理失败：", errorText(error))); };
    bot.onReady = () => {
      for (const rt of activeRelay.runtimes) void activeRelay.enqueue(rt, async () => { await activeRelay.refreshMembers(rt); await activeRelay.pollNotices(rt); });
    };
    bot.connect();
    timer = setInterval(() => {
      state.save(); map.save();
      if (!bot?.botId || stop.signal.aborted) return;
      for (const rt of activeRelay.runtimes) {
        if (Date.now() >= rt.nextMembers && !rt.memberBusy) { rt.nextMembers = Date.now() + MEMBER_INTERVAL; void activeRelay.enqueue(rt, () => activeRelay.refreshMembers(rt)); }
        if (Date.now() >= rt.nextNotice && !rt.noticeBusy && rt.cfg.notice && rt.cfg.direction !== "toqq") {
          rt.nextNotice = Date.now() + rt.cfg.noticeIntervalSec * 1000; void activeRelay.enqueue(rt, () => activeRelay.pollNotices(rt));
        }
      }
    }, 1000);
    const filter = { room: { rooms: relay.runtimes.map((rt) => rt.cfg.matrix),
      timeline: { limit: 50, types: ["m.room.message", "m.room.redaction"] },
      state: { lazy_load_members: true, types: ["m.room.name", "m.room.member"] } } };
    let firstSync = !state.data.since;
    log(firstSync ? "首次同步，只记位置不转发历史消息" : "从上次的位置接着同步");
    while (!stop.signal.aborted) {
      try {
        const response = await api.sync(state.data.since, firstSync ? 0 : 30_000, filter);
        if (stop.signal.aborted) break;
        for (const rt of relay.runtimes) {
          const room = response.rooms?.join?.[rt.cfg.matrix]; if (!room) continue;
          for (const event of [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])]) {
            if (event.type === "m.room.member" && event.state_key && typeof event.content?.displayname === "string") rt.memberNames.set(event.state_key, event.content.displayname);
          }
          if (!firstSync || REPLAY) for (const event of room.timeline?.events ?? []) {
            await relay.enqueue(rt, () => activeRelay.handleMatrix(rt, event));
          }
        }
        // 对照表写入完成后再记录同步位置，退出也先保存对照表。
        state.data.since = response.next_batch; state.changed(); map.save(); state.save(); firstSync = false;
      } catch (error) {
        if (stop.signal.aborted) break;
        const message = errorText(error); log("同步失败，5 秒后重试：", message);
        if (message.includes("M_UNKNOWN_POS")) { state.data.since = undefined; state.changed(); firstSync = true; }
        await new Promise<void>((resolve) => {
          const finish = (): void => { clearTimeout(wait); stop.signal.removeEventListener("abort", finish); resolve(); };
          const wait = setTimeout(finish, 5000); stop.signal.addEventListener("abort", finish, { once: true });
          if (stop.signal.aborted) finish();
        });
      }
    }
  } catch (error) { if (!stop.signal.aborted) log("桥接启动失败：", errorText(error)); }
  finally {
    clearInterval(timer); stop.abort(); bot?.close();
    if (relay) await Promise.all(relay.runtimes.map((rt) => rt.tail));
    map.save(true); state.save(true);
    process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown);
    log("桥接已退出，状态与消息对照表已保存");
  }
}
