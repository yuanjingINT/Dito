/**
 * Dito 手机频道：手机 / PWA 经中继与电脑上的 Dito 对话。
 *
 * 用法：dito mobile [--reset]
 *   启动后连接中继（relayUrl 空 = 本地内嵌中继、局域网直连），
 *   终端显示配对二维码；手机扫码 → 电脑端确认 → 建立会话开始对话。
 *   已配对设备重连自动接入；每台设备可建多个对话（列表/新建/切换/删除），
 *   支持语音输入（桌面端 ASR）与语音回传（桌面端 TTS → chat.tts）。
 *
 * 协议见 docs/protocol.md；许可证 GPL-3.0-only。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline/promises";

import WebSocket from "ws";
import QRCode from "qrcode";

import {
  loadConfig,
  saveConfig,
  readPersona,
  ditoDataDir,
  type MobileChannelConfig,
  type MobileDeviceConfig,
} from "../extensions/util.js";
import { transcribeRemoteAudio, synthesizeSpeech, type VoiceConfig } from "../extensions/voice.js";
import { openChannelSession, parseSessionTurns, type TuiSession } from "./session.js";
import { runWithTaskSlot } from "./channel-chat.js";
import { startRelay, type RelayHandle } from "../relay/server.mjs";

const TAG = "dito mobile";
const MOBILE_DIR = join(ditoDataDir(), "mobile");
const CHATS_INDEX = join(MOBILE_DIR, "mobile-chats.json");
const CONV_STORE = join(MOBILE_DIR, "mobile-conversations.json");
const SESSIONS_DIR = join(MOBILE_DIR, "mobile-sessions");
const EMBED_PORT = Number(process.env.DITO_MOBILE_PORT ?? 8787);
const EMBED_PORTS = [EMBED_PORT, EMBED_PORT + 1, EMBED_PORT + 2, EMBED_PORT + 3];
/** 主对话（兼容旧版单会话映射：mobile-chats.json 里 <devKey> → 会话文件） */
const MAIN_CONV = "main";
/** TTS 单次合成的文本上限（控制音频体量，超出截断） */
const TTS_TEXT_LIMIT = 600;
/** 供「点按重播语音」缓存的最近回复条数 */
const TTS_CACHE_LIMIT = 80;

const C = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m" };

const TOKEN = () => randomBytes(16).toString("hex");

function log(msg: string): void {
  console.log(`${C.dim}[${TAG}]${C.reset} ${msg}`);
}

/** 手机场景系统提示词：主人设 + 「正通过手机对话」的上下文 */
function buildMobileSystemPrompt(deviceName: string): string {
  const persona = readPersona("dito");
  return [
    "# Dito 人格设定",
    "以下设定是最高优先级行为准则，任何情况下都要遵守，并覆盖系统里其它任何「你是谁」的默认描述。",
    "当被问到你是谁、你是什么助手、你是什么模型时：你是 dito（蒂特），不是 pi，不是 coding agent。",
    "",
    `【场景】你跑在主人的电脑上，此刻主人正通过已配对的手机「${deviceName}」与你对话。回复显示在手机屏幕上：口语、自然、长度适合手机阅读，避免大段堆砌与超长列表。`,
    "",
    persona,
  ].join("\n");
}

/** 每台设备一条会话；beginTurn 标记一轮新回复，事件流据此回传 */
interface DeviceChat {
  session: TuiSession;
  beginTurn(id: string): void;
}

// ── 对话元数据（每设备多个对话；main = 旧版默认会话） ──────────────
interface ConvMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 会话文件绝对路径（创建后写入） */
  file?: string;
}

interface ConvStore {
  /** devKey -> 当前对话 id */
  active: Record<string, string>;
  /** devKey -> 对话列表（新对话插最前） */
  items: Record<string, ConvMeta[]>;
}

function loadConvStore(): ConvStore {
  try {
    const parsed = JSON.parse(readFileSync(CONV_STORE, "utf-8")) as Partial<ConvStore>;
    return { active: parsed.active ?? {}, items: parsed.items ?? {} };
  } catch {
    return { active: {}, items: {} };
  }
}

function saveConvStore(store: ConvStore): void {
  mkdirSync(MOBILE_DIR, { recursive: true });
  writeFileSync(CONV_STORE, JSON.stringify(store, null, 2), "utf-8");
}

/** chatKey = mobile-chats.json 的键 / memoryScope。main 保持旧键以兼容既有会话与记忆库 */
function chatKeyOf(devKey: string, cid: string): string {
  return cid === MAIN_CONV ? `mobile-${devKey}` : `mobile-${devKey}:${cid}`;
}

/** 从会话 JSONL 提取标题候选（第一条用户消息；需全量解析，不能只取尾部窗口） */
function firstUserText(file?: string): string {
  if (!file || !existsSync(file)) return "";
  return parseSessionTurns(file, 10_000).find((t) => t.role === "user")?.text ?? "";
}

function lastTurnText(file?: string): string {
  if (!file || !existsSync(file)) return "";
  const turns = parseSessionTurns(file, 1);
  return turns.at(-1)?.text ?? "";
}

function turnCount(file?: string): number {
  if (!file || !existsSync(file)) return 0;
  return parseSessionTurns(file, 10_000).length;
}

/** 旧会话文件的修改时间（毫秒），用于迁移元数据的时间字段 */
function fileMtimeIso(file?: string): string {
  try {
    if (file && existsSync(file)) return new Date(statSync(file).mtime.getTime()).toISOString();
  } catch {}
  return new Date().toISOString();
}

export async function runMobileChannel(argv: string[] = []): Promise<void> {
  const reset = argv.includes("--reset");
  const cfg = loadConfig();
  const ch: MobileChannelConfig = cfg.channels.mobile;

  // 显式运行 `dito mobile` 即视为启用；首次自动补齐房间与令牌
  ch.enabled = true;
  if (reset) {
    ch.room = "";
    ch.hostToken = "";
    ch.devices = [];
    log("已重置房间、令牌与设备列表");
  }
  if (!ch.room) ch.room = `r-${randomBytes(4).toString("hex")}`;
  if (!ch.hostToken) ch.hostToken = TOKEN();
  saveConfig(cfg);

  mkdirSync(SESSIONS_DIR, { recursive: true });

  // ── 中继：远程 or 内嵌局域网 ────────────────────────────────────
  let wsBase: string;
  let relay: RelayHandle | null = null;
  if (ch.relayUrl) {
    wsBase = `${ch.relayUrl.replace(/^http/, "ws").replace(/\/+$/, "")}`;
    log(`使用远程中继：${ch.relayUrl}`);
  } else {
    const started = await startEmbeddedRelay(ch);
    relay = started.handle;
    wsBase = `ws://127.0.0.1:${started.port}`;
    log(`本地局域网模式：内嵌中继端口 ${started.port}（手机需与电脑同一网络）`);
  }

  // ── 会话与对话状态 ─────────────────────────────────────────────
  const chats = new Map<string, DeviceChat>(); // chatKey -> 会话
  const voiceMode = new Set<string>(); // devKey -> 是否开启语音回传（自动 TTS）
  const ttsCache = new Map<string, string>(); // turnId -> 回复全文（点按重播用，FIFO 上限）

  function cacheTurnText(id: string, text: string): void {
    ttsCache.set(id, text);
    while (ttsCache.size > TTS_CACHE_LIMIT) ttsCache.delete(ttsCache.keys().next().value as string);
  }

  /** 读取某设备的对话元数据（保证条目存在；首次访问时迁移旧版单会话映射）。
   *  返回的 items 挂在 store 上：改动后需 saveConvStore(store) 持久化。 */
  function ensureStore(devKey: string): { store: ConvStore; items: ConvMeta[] } {
    const store = loadConvStore();
    if (!store.items[devKey]?.length) {
      const legacyFile = (() => {
        try {
          return (JSON.parse(readFileSync(CHATS_INDEX, "utf-8")) as Record<string, string>)[`mobile-${devKey}`] ?? "";
        } catch {
          return "";
        }
      })();
      const meta: ConvMeta = {
        id: MAIN_CONV,
        title: firstUserText(legacyFile).slice(0, 24),
        createdAt: fileMtimeIso(legacyFile),
        updatedAt: fileMtimeIso(legacyFile),
        ...(legacyFile ? { file: legacyFile } : {}),
      };
      store.items[devKey] = [meta];
      if (!store.active[devKey]) store.active[devKey] = MAIN_CONV;
      saveConvStore(store);
    }
    return { store, items: store.items[devKey] };
  }

  function activeCid(devKey: string): string {
    const { store, items } = ensureStore(devKey);
    const active = store.active[devKey];
    if (active && items.some((c) => c.id === active)) return active;
    return items[0]?.id ?? MAIN_CONV;
  }

  /** 更新对话元数据；titleIfEmpty 用于首轮消息自动起标题 */
  function setConvTitle(
    devKey: string,
    cid: string,
    patch: Partial<Pick<ConvMeta, "title" | "updatedAt" | "file">> & { titleIfEmpty?: string },
  ): void {
    const { store, items } = ensureStore(devKey);
    const hit = items.find((c) => c.id === cid);
    if (!hit) return;
    const { titleIfEmpty, ...rest } = patch;
    if (titleIfEmpty && !hit.title) hit.title = titleIfEmpty.slice(0, 24);
    Object.assign(hit, rest);
    saveConvStore(store);
  }

  /** 会话列表 payload（预览取最后一条消息，标题缺省从首条用户消息推导） */
  function buildSessionList(devKey: string): { type: "session.list"; active: string; items: unknown[] } {
    const { store, items } = ensureStore(devKey);
    let dirty = false;
    const view = items.map((c) => {
      if (!c.title) {
        const derived = firstUserText(c.file).slice(0, 24);
        if (derived) {
          c.title = derived;
          dirty = true;
        }
      }
      return {
        id: c.id,
        title: c.title || "新对话",
        preview: lastTurnText(c.file).slice(0, 60),
        messageCount: turnCount(c.file),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt || c.createdAt,
      };
    });
    if (dirty) saveConvStore(store);
    view.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { type: "session.list", active: activeCid(devKey), items: view };
  }

  // ── MCP Server 内嵌启动（手机端经隧道调用 pc_* 工具的通道） ────────
  let mcp: { close(): Promise<void> } | null = null;
  if (cfg.plugins.mcp?.enabled && cfg.plugins.mcp.server?.enabled) {
    try {
      const { startMcpServer } = await import("./mcp-server.js");
      mcp = await startMcpServer(cfg.plugins.mcp.server);
      const prefix = "/mcp";
      if (!ch.tunnel[prefix] || ch.tunnel[prefix] !== `http://127.0.0.1:${(mcp as { port: number }).port}`) {
        ch.tunnel[prefix] = `http://127.0.0.1:${(mcp as { port: number }).port}`;
        saveConfig(cfg);
        log(`隧道已挂载 ${prefix} → 本机 MCP Server`);
      }
    } catch (err) {
      log(`MCP Server 启动失败（手机端将无法调用电脑工具）：${(err as Error).message}`);
    }
  }

  /** 取（或创建）某设备某对话的会话句柄，并挂上事件流转发 */
  async function chatForConv(device: MobileDeviceConfig, cid: string): Promise<DeviceChat> {
    const devKey = device.id.slice(0, 8);
    const chatKey = chatKeyOf(devKey, cid);
    const hit = chats.get(chatKey);
    if (hit) return hit;
    const created = await openChannelSession(CHATS_INDEX, chatKey, undefined, {
      systemPrompt: buildMobileSystemPrompt(device.name),
      skipPluginIds: ["mode"],
      sessionsDir: SESSIONS_DIR,
      memoryScope: chatKey,
    });
    const chat = attachStreamRelay(created.session, device.id, devKey, cid);
    chats.set(chatKey, chat);
    if (created.session.sessionFile) setConvTitle(devKey, cid, { file: created.session.sessionFile });
    log(`手机会话就绪：${chatKey}（${device.name}）`);
    return chat;
  }

  /** 把会话事件流翻译成手机端消息（chat.delta / chat.tool / chat.end / chat.error） */
  function attachStreamRelay(session: TuiSession, deviceToken: string, devKey: string, cid: string): DeviceChat {
    let turnId = "";
    let buf = "";
    const sendTo = (payload: unknown): void => sendToDevice(deviceToken, payload);
    session.subscribe((event) => {
      const e = event as {
        type: string;
        assistantMessageEvent?: { type: string; delta?: string };
        toolName?: string;
        args?: unknown;
        message?: { role?: string; stopReason?: string; errorMessage?: string };
      };
      if (!turnId) return;
      const ame = e.assistantMessageEvent;
      if (e.type === "message_update" && ame?.type === "text_delta") {
        buf += ame.delta ?? "";
        sendTo({ type: "chat.delta", id: turnId, delta: ame.delta ?? "" });
        return;
      }
      if (e.type === "tool_execution_start" && e.toolName) {
        const args = e.args == null ? "" : (() => {
          const s = typeof e.args === "string" ? e.args : (() => { try { return JSON.stringify(e.args); } catch { return String(e.args); } })();
          const flat = s.replace(/\s+/g, " ").trim();
          return flat.length > 120 ? flat.slice(0, 120) + "…" : flat;
        })();
        sendTo({ type: "chat.tool", id: turnId, name: e.toolName, argsShort: args, state: "start" });
        return;
      }
      if (e.type === "message_end" && e.message?.role === "assistant" && e.message.stopReason === "error") {
        log(`模型错误：${e.message.errorMessage ?? "(无信息)"}`);
        sendTo({ type: "chat.error", id: turnId, message: e.message.errorMessage ?? "未知错误" });
        return;
      }
      if (e.type === "agent_end") {
        const text = buf.trim();
        sendTo({ type: "chat.end", id: turnId, text });
        cacheTurnText(turnId, text);
        setConvTitle(devKey, cid, { updatedAt: new Date().toISOString() });
        const endedTurn = turnId;
        buf = "";
        turnId = "";
        // 语音回传：设备开启语音模式时自动朗读回复（异步，不阻塞下一轮）
        if (text && voiceMode.has(devKey)) void speakAndSend(deviceToken, endedTurn, text);
      }
    });
    return {
      beginTurn(id: string) {
        turnId = id;
        buf = "";
      },
      session,
    };
  }

  /** 桌面端 TTS → chat.tts（base64 音频；失败静默，不影响文本回复） */
  async function speakAndSend(deviceToken: string, turnId: string, text: string): Promise<void> {
    try {
      const clipped = text.slice(0, TTS_TEXT_LIMIT);
      const voiceCfg = loadConfig().plugins.voice as VoiceConfig;
      const synth = await synthesizeSpeech(clipped, voiceCfg);
      if (!synth || synth.audio.length === 0) return;
      sendToDevice(deviceToken, { type: "chat.tts", id: turnId, mime: synth.mime, audioB64: synth.audio.toString("base64") });
    } catch {
      /* 合成失败不打扰对话 */
    }
  }

  // ── host ↔ 中继连接（断线自动重连） ─────────────────────────────
  let hostWs: WebSocket | null = null;
  let backoff = 3;
  let closedByUs = false;
  /** deviceToken -> 中继侧 connId（收到该设备 forward 时学习更新） */
  const connIdByDevice = new Map<string, number>();

  function sendToDevice(deviceToken: string, payload: unknown): void {
    const connId = connIdByDevice.get(deviceToken);
    if (connId === undefined || !hostWs || hostWs.readyState !== WebSocket.OPEN) return;
    hostWs.send(JSON.stringify({ type: "forward", to: connId, payload }));
  }

  async function connectHost(): Promise<void> {
    const ws = new WebSocket(`${wsBase}/ws/${ch.room}?host=${ch.hostToken}`);
    hostWs = ws;
    ws.on("open", () => {
      backoff = 3;
      log(`已连接中继（房间 ${ch.room}）`);
      ws.send(JSON.stringify({ type: "pair.issue" }));
    });
    ws.on("message", (data) => void onHostMessage(ws, String(data)));
    ws.on("close", () => {
      if (closedByUs) return;
      log(`与中继断开，${backoff}s 后重连`);
      setTimeout(() => void connectHost(), backoff * 1000);
      backoff = Math.min(backoff * 2, 30);
    });
    ws.on("error", (err) => log(`中继连接出错：${err.message}`));
  }

  async function onHostMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "pair.token": {
        await showQr(msg.url as string);
        return;
      }
      case "pair.request": {
        await handlePairRequest(ws, msg);
        return;
      }
      case "device.check": {
        const known = loadConfig().channels.mobile.devices.some((d) => d.id === msg.token);
        ws.send(JSON.stringify({ type: known ? "device.ok" : "device.unknown", token: msg.token }));
        if (!known) log(`未知设备尝试重连，已拒绝（token ${String(msg.token).slice(0, 8)}…）`);
        return;
      }
      case "forward": {
        const token = String(msg.deviceToken ?? "");
        const from = Number(msg.from);
        if (token && Number.isFinite(from)) {
          if (connIdByDevice.get(token) !== from) connIdByDevice.set(token, from);
          await onDeviceMessage(token, msg.payload);
        }
        return;
      }
      case "http": {
        await handleTunnel(ws, msg);
        return;
      }
      default:
        return;
    }
  }

  async function showQr(url: string): Promise<void> {
    const qr = await QRCode.toString(url, { type: "terminal", small: true });
    console.log(`\n${C.cyan}${C.bold}手机扫码连接 Dito${C.reset}`);
    console.log(qr);
    console.log(`${C.dim}或直接打开：${url}${C.reset}\n`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  async function handlePairRequest(ws: WebSocket, msg: { connId: number; name?: string; platform?: string }): Promise<void> {
    const name = msg.name || "未知设备";
    const platform = msg.platform || "";
    let approve = ch.autoApprove;
    if (!approve) {
      console.log(`\n${C.yellow}新设备请求配对：${name}（${platform || "未知平台"}，连接 #${msg.connId}）${C.reset}`);
      const ans = await rl.question("允许连接？[y/N] ");
      approve = /^y(es)?$/i.test(ans.trim());
    }
    if (!approve) {
      ws.send(JSON.stringify({ type: "pair.reject", connId: msg.connId }));
      log(`已拒绝设备「${name}」`);
      return;
    }
    const deviceToken = TOKEN();
    ws.send(JSON.stringify({ type: "pair.approve", connId: msg.connId, deviceToken }));
    const current = loadConfig();
    current.channels.mobile.devices.push({ id: deviceToken, name, platform, pairedAt: new Date().toISOString() });
    saveConfig(current);
    log(`设备「${name}」已配对（共 ${current.channels.mobile.devices.length} 台）`);
  }

  /** 删除对话：清元数据、chats 索引与会话文件；若删的是当前对话则自动切到最近一个（没有就新建） */
  function deleteConv(device: MobileDeviceConfig, cid: string): void {
    const devKey = device.id.slice(0, 8);
    const { store, items } = ensureStore(devKey);
    const hit = items.find((c) => c.id === cid);
    if (!hit) return;
    const chatKey = chatKeyOf(devKey, cid);
    const wasActive = activeCid(devKey) === cid;
    store.items[devKey] = items.filter((c) => c.id !== cid);
    delete store.active[devKey];
    saveConvStore(store);

    // chats 索引（chatKey → 会话文件）移除
    try {
      const index = JSON.parse(readFileSync(CHATS_INDEX, "utf-8")) as Record<string, string>;
      const file = index[chatKey];
      delete index[chatKey];
      mkdirSync(MOBILE_DIR, { recursive: true });
      writeFileSync(CHATS_INDEX, JSON.stringify(index, null, 2), "utf-8");
      if (file && existsSync(file)) unlinkSync(file);
    } catch {}
    if (hit.file && existsSync(hit.file)) {
      try {
        unlinkSync(hit.file);
      } catch {}
    }
    // 内存中的会话一并释放
    const mem = chats.get(chatKey);
    if (mem) {
      chats.delete(chatKey);
      try {
        mem.session.dispose();
      } catch {}
    }
    log(`「${device.name}」删除对话 ${cid}${wasActive ? "（当前对话，已自动切换）" : ""}`);
  }

  /** 设备业务消息：聊天、语音、会话管理与语音回传 */
  async function onDeviceMessage(deviceToken: string, payload: any): Promise<void> {
    if (!payload || typeof payload.type !== "string") return;
    const device = loadConfig().channels.mobile.devices.find((d) => d.id === deviceToken);
    if (!device) {
      log("收到未登记设备的消息，已忽略");
      return;
    }
    const devKey = device.id.slice(0, 8);
    const reply = (p: unknown): void => sendToDevice(deviceToken, p);

    switch (payload.type) {
      // ── 会话管理 ──
      case "session.list": {
        reply(buildSessionList(devKey));
        return;
      }
      case "session.new": {
        const cid = `c-${randomBytes(3).toString("hex")}`;
        const { store } = ensureStore(devKey);
        const nowIso = new Date().toISOString();
        store.items[devKey] = [{ id: cid, title: "", createdAt: nowIso, updatedAt: nowIso }, ...store.items[devKey]];
        store.active[devKey] = cid;
        saveConvStore(store);
        await chatForConv(device, cid);
        log(`「${device.name}」新建对话 ${cid}`);
        reply(buildSessionList(devKey));
        return;
      }
      case "session.switch": {
        const cid = String(payload.id ?? "");
        const { items } = ensureStore(devKey);
        if (!items.some((c) => c.id === cid)) {
          reply({ type: "chat.error", id: "", message: "对话不存在或已被删除" });
          reply(buildSessionList(devKey));
          return;
        }
        const { store } = ensureStore(devKey);
        store.active[devKey] = cid;
        saveConvStore(store);
        await chatForConv(device, cid);
        log(`「${device.name}」切换到对话 ${cid}`);
        reply(buildSessionList(devKey));
        return;
      }
      case "session.delete": {
        const cid = String(payload.id ?? "");
        const wasActive = activeCid(devKey) === cid;
        deleteConv(device, cid);
        if (wasActive) {
          // 自动切到最近一个；一个不剩就新建
          const { store, items: rest } = ensureStore(devKey);
          if (rest.length > 0) {
            const next = [...rest].sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))[0];
            store.active[devKey] = next.id;
            saveConvStore(store);
            await chatForConv(device, next.id);
          } else {
            const cidNew = `c-${randomBytes(3).toString("hex")}`;
            const nowIso = new Date().toISOString();
            store.items[devKey] = [{ id: cidNew, title: "", createdAt: nowIso, updatedAt: nowIso }];
            store.active[devKey] = cidNew;
            saveConvStore(store);
            await chatForConv(device, cidNew);
          }
        }
        reply(buildSessionList(devKey));
        return;
      }
      case "session.history": {
        const cid = String(payload.id ?? "") || activeCid(devKey);
        const { items } = ensureStore(devKey);
        const meta = items.find((c) => c.id === cid);
        const file = meta?.file ?? chatKeyFileOf(devKey, cid);
        const limit = Number.isFinite(payload.limit) ? Math.min(Number(payload.limit), 500) : 200;
        const turns = file ? parseSessionTurns(file, limit) : [];
        reply({ type: "session.history", id: cid, items: turns });
        return;
      }

      // ── 语音 ──
      case "voice.mode": {
        const on = !!payload.on;
        if (on) voiceMode.add(devKey);
        else voiceMode.delete(devKey);
        log(`「${device.name}」语音回传${on ? "开启" : "关闭"}`);
        reply({ type: "voice.mode", on });
        return;
      }
      case "tts.request": {
        const id = String(payload.id ?? "");
        const text = ttsCache.get(id) ?? "";
        if (text) await speakAndSend(deviceToken, id, text);
        else reply({ type: "chat.error", id, message: "这条回复不在语音缓存里了，重新生成一条吧" });
        return;
      }

      // ── 聊天 ──
      case "chat.user":
      case "chat.voice": {
        break; // 落到下方统一处理
      }
      default:
        return;
    }

    // 聊天统一路由到设备当前对话
    const turnId = typeof payload.id === "string" ? payload.id : randomBytes(8).toString("hex");
    const cid = activeCid(devKey);
    const chat = await chatForConv(device, cid);
    chat.beginTurn(turnId);

    if (payload.type === "chat.voice") {
      // 语音消息：ASR 转文字后走正常对话流程
      const sendToConn = (p: unknown): void => sendToDevice(deviceToken, p);
      sendToConn({ type: "chat.tool", id: turnId, name: "语音识别", argsShort: "", state: "start" });
      let text = "";
      try {
        const audio = Buffer.from(String(payload.audioB64 ?? ""), "base64");
        if (audio.length === 0) throw new Error("空音频");
        const voiceCfg = loadConfig().plugins.voice as VoiceConfig;
        text = await transcribeRemoteAudio(audio, String(payload.mime ?? ""), voiceCfg);
      } catch (err) {
        sendToConn({ type: "chat.error", id: turnId, message: `语音识别失败：${(err as Error).message}` });
        return;
      }
      if (!text) {
        sendToConn({ type: "chat.error", id: turnId, message: "语音识别结果为空（检查桌面端语音 STT 配置，如 MiMo key）" });
        return;
      }
      log(`「${device.name}」（语音）：${text.slice(0, 80)}`);
      setConvTitle(devKey, cid, { updatedAt: new Date().toISOString(), titleIfEmpty: text });
      await runWithTaskSlot(() => chat.session.prompt(text));
      return;
    }

    const text = String(payload.text ?? "").trim();
    if (!text) return;
    log(`「${device.name}」：${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
    setConvTitle(devKey, cid, { updatedAt: new Date().toISOString(), titleIfEmpty: text });
    await runWithTaskSlot(() => chat.session.prompt(text));
  }

  /** 兼容读取：元数据缺 file 时从 mobile-chats.json 找（旧版映射） */
  function chatKeyFileOf(devKey: string, cid: string): string | undefined {
    const key = chatKeyOf(devKey, cid);
    try {
      return (JSON.parse(readFileSync(CHATS_INDEX, "utf-8")) as Record<string, string>)[key];
    } catch {
      return undefined;
    }
  }

  /** HTTP 隧道：按配置前缀映射到本地服务（MCP 等）；体量与超时由中继保证 */
  async function handleTunnel(ws: WebSocket, msg: { id: string; method: string; path: string; headers?: Record<string, string>; bodyB64?: string }): Promise<void> {
    const reply = (status: number, contentType: string, body: Buffer): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "http.response", id: msg.id, status, contentType, bodyB64: body.toString("base64") }));
    };
    const prefixes = Object.keys(ch.tunnel ?? {}).sort((a, b) => b.length - a.length);
    const hit = prefixes.find((p) => msg.path === p || msg.path.startsWith(`${p}/`));
    if (!hit) {
      reply(404, "application/json", Buffer.from(JSON.stringify({ error: "no tunnel mapping for path" })));
      return;
    }
    const target = `${(ch.tunnel[hit] ?? "").replace(/\/+$/, "")}${msg.path.slice(hit.length)}`;
    try {
      const body = msg.bodyB64 ? Buffer.from(msg.bodyB64, "base64") : undefined;
      const hasBody = body && msg.method !== "GET" && msg.method !== "HEAD" && body.length > 0;
      const res = await fetch(target, {
        method: msg.method,
        headers: msg.headers ?? {},
        body: hasBody ? new Uint8Array(body) : undefined,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      reply(res.status, res.headers.get("content-type") ?? "application/octet-stream", buf);
    } catch (err) {
      reply(502, "application/json", Buffer.from(JSON.stringify({ error: (err as Error).message })));
    }
  }

  // ── 内嵌中继（本地局域网模式） ──────────────────────────────────
  async function startEmbeddedRelay(mobile: MobileChannelConfig): Promise<{ handle: RelayHandle; port: number }> {
    let lastErr: Error | null = null;
    for (const port of EMBED_PORTS) {
      try {
        const handle = await startRelay({
          port,
          pwaDir: mobile.pwaDir || null,
          log: (m) => console.log(`${C.dim}[relay]${C.reset} ${m}`),
        });
        return { handle, port };
      } catch (err) {
        lastErr = err as Error;
      }
    }
    throw new Error(`内嵌中继启动失败（端口 ${EMBED_PORTS.join("/")} 均不可用）：${lastErr?.message ?? ""}`);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  async function shutdown(): Promise<void> {
    closedByUs = true;
    rl.close();
    hostWs?.close();
    await mcp?.close();
    await relay?.close();
    process.exit(0);
  }

  await connectHost();
  console.log(`${C.green}Dito 手机频道已启动。手机扫码即可连接；Ctrl-C 退出。${C.reset}`);
}
