/**
 * Dito 手机频道：手机 / PWA 经中继与电脑上的 Dito 对话。
 *
 * 用法：dito mobile [--reset]
 *   启动后连接中继（relayUrl 空 = 本地内嵌中继、局域网直连），
 *   终端显示配对二维码；手机扫码 → 电脑端确认 → 建立会话开始对话。
 *   已配对设备重连自动接入，每个设备一条独立持久会话（主人级权限）。
 *
 * 协议见 docs/protocol.md；许可证 GPL-3.0-only。
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
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
import { openChannelSession, type TuiSession } from "./session.js";
import { runWithTaskSlot } from "./channel-chat.js";
import { startRelay, type RelayHandle } from "../relay/server.mjs";

const TAG = "dito mobile";
const MOBILE_DIR = join(ditoDataDir(), "mobile");
const EMBED_PORT = Number(process.env.DITO_MOBILE_PORT ?? 8787);
const EMBED_PORTS = [EMBED_PORT, EMBED_PORT + 1, EMBED_PORT + 2, EMBED_PORT + 3];

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

  mkdirSync(join(MOBILE_DIR, "mobile-sessions"), { recursive: true });

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

  // ── 设备会话 ────────────────────────────────────────────────────
  const chats = new Map<string, DeviceChat>(); // deviceToken -> 会话

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

  async function sessionFor(device: MobileDeviceConfig): Promise<DeviceChat> {
    const hit = chats.get(device.id);
    if (hit) return hit;
    const key = `mobile-${device.id.slice(0, 8)}`;
    const created = await openChannelSession(join(MOBILE_DIR, "mobile-chats.json"), key, undefined, {
      systemPrompt: buildMobileSystemPrompt(device.name),
      skipPluginIds: ["mode"],
      sessionsDir: join(MOBILE_DIR, "mobile-sessions"),
      memoryScope: key,
    });
    const chat = attachStreamRelay(created.session, device.id);
    chats.set(device.id, chat);
    log(`手机会话就绪：${key}（${device.name}）`);
    return chat;
  }

  /** 把会话事件流翻译成手机端消息（chat.delta / chat.tool / chat.end / chat.error） */
  function attachStreamRelay(session: TuiSession, deviceToken: string): DeviceChat {
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
        sendTo({ type: "chat.end", id: turnId, text: buf.trim() });
        buf = "";
        turnId = "";
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

  /** 设备业务消息：M1 只有 chat.user；一轮对话一个 id，流式回传 */
  async function onDeviceMessage(deviceToken: string, payload: any): Promise<void> {
    if (!payload || typeof payload !== "object") return;
    if (payload.type !== "chat.user") return;
    const device = loadConfig().channels.mobile.devices.find((d) => d.id === deviceToken);
    if (!device) {
      log("收到未登记设备的消息，已忽略");
      return;
    }
    const text = String(payload.text ?? "").trim();
    if (!text) return;
    const chat = await sessionFor(device);
    const turnId = typeof payload.id === "string" ? payload.id : randomBytes(8).toString("hex");
    log(`「${device.name}」：${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
    chat.beginTurn(turnId);
    await runWithTaskSlot(() => chat.session.prompt(text));
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
