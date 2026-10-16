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
  ditoDataDir
} from "../extensions/util.js";
import { transcribeRemoteAudio, synthesizeSpeech } from "../extensions/voice.js";
import { openChannelSession, parseSessionTurns } from "./session.js";
import { runWithTaskSlot } from "./channel-chat.js";
import { startRelay } from "../relay/server.mjs";
const TAG = "dito mobile";
const MOBILE_DIR = join(ditoDataDir(), "mobile");
const CHATS_INDEX = join(MOBILE_DIR, "mobile-chats.json");
const CONV_STORE = join(MOBILE_DIR, "mobile-conversations.json");
const SESSIONS_DIR = join(MOBILE_DIR, "mobile-sessions");
const EMBED_PORT = Number(process.env.DITO_MOBILE_PORT ?? 8787);
const EMBED_PORTS = [EMBED_PORT, EMBED_PORT + 1, EMBED_PORT + 2, EMBED_PORT + 3];
const MAIN_CONV = "main";
const TTS_TEXT_LIMIT = 600;
const TTS_CACHE_LIMIT = 80;
const C = { reset: "\x1B[0m", dim: "\x1B[90m", cyan: "\x1B[36m", green: "\x1B[32m", yellow: "\x1B[33m", bold: "\x1B[1m" };
const TOKEN = () => randomBytes(16).toString("hex");
function log(msg) {
  console.log(`${C.dim}[${TAG}]${C.reset} ${msg}`);
}
function buildMobileSystemPrompt(deviceName) {
  const persona = readPersona("dito");
  return [
    "# Dito 人格设定",
    "以下设定是最高优先级行为准则，任何情况下都要遵守，并覆盖系统里其它任何「你是谁」的默认描述。",
    "当被问到你是谁、你是什么助手、你是什么模型时：你是 dito（蒂特），不是 pi，不是 coding agent。",
    "",
    `【场景】你跑在主人的电脑上，此刻主人正通过已配对的手机「${deviceName}」与你对话。回复显示在手机屏幕上：口语、自然、长度适合手机阅读，避免大段堆砌与超长列表。`,
    "",
    persona
  ].join("\n");
}
function loadConvStore() {
  try {
    const parsed = JSON.parse(readFileSync(CONV_STORE, "utf-8"));
    return { active: parsed.active ?? {}, items: parsed.items ?? {} };
  } catch {
    return { active: {}, items: {} };
  }
}
function saveConvStore(store) {
  mkdirSync(MOBILE_DIR, { recursive: true });
  writeFileSync(CONV_STORE, JSON.stringify(store, null, 2), "utf-8");
}
function chatKeyOf(devKey, cid) {
  return cid === MAIN_CONV ? `mobile-${devKey}` : `mobile-${devKey}:${cid}`;
}
function firstUserText(file) {
  if (!file || !existsSync(file)) return "";
  return parseSessionTurns(file, 1e4).find((t) => t.role === "user")?.text ?? "";
}
function lastTurnText(file) {
  if (!file || !existsSync(file)) return "";
  const turns = parseSessionTurns(file, 1);
  return turns.at(-1)?.text ?? "";
}
function turnCount(file) {
  if (!file || !existsSync(file)) return 0;
  return parseSessionTurns(file, 1e4).length;
}
function fileMtimeIso(file) {
  try {
    if (file && existsSync(file)) return new Date(statSync(file).mtime.getTime()).toISOString();
  } catch {
  }
  return (/* @__PURE__ */ new Date()).toISOString();
}
async function runMobileChannel(argv = []) {
  const reset = argv.includes("--reset");
  const cfg = loadConfig();
  const ch = cfg.channels.mobile;
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
  let wsBase;
  let relay = null;
  if (ch.relayUrl) {
    wsBase = `${ch.relayUrl.replace(/^http/, "ws").replace(/\/+$/, "")}`;
    log(`使用远程中继：${ch.relayUrl}`);
  } else {
    const started = await startEmbeddedRelay(ch);
    relay = started.handle;
    wsBase = `ws://127.0.0.1:${started.port}`;
    log(`本地局域网模式：内嵌中继端口 ${started.port}（手机需与电脑同一网络）`);
  }
  const chats = /* @__PURE__ */ new Map();
  const voiceMode = /* @__PURE__ */ new Set();
  const ttsCache = /* @__PURE__ */ new Map();
  function cacheTurnText(id, text) {
    ttsCache.set(id, text);
    while (ttsCache.size > TTS_CACHE_LIMIT) ttsCache.delete(ttsCache.keys().next().value);
  }
  function ensureStore(devKey) {
    const store = loadConvStore();
    if (!store.items[devKey]?.length) {
      const legacyFile = (() => {
        try {
          return JSON.parse(readFileSync(CHATS_INDEX, "utf-8"))[`mobile-${devKey}`] ?? "";
        } catch {
          return "";
        }
      })();
      const meta = {
        id: MAIN_CONV,
        title: firstUserText(legacyFile).slice(0, 24),
        createdAt: fileMtimeIso(legacyFile),
        updatedAt: fileMtimeIso(legacyFile),
        ...legacyFile ? { file: legacyFile } : {}
      };
      store.items[devKey] = [meta];
      if (!store.active[devKey]) store.active[devKey] = MAIN_CONV;
      saveConvStore(store);
    }
    return { store, items: store.items[devKey] };
  }
  function activeCid(devKey) {
    const { store, items } = ensureStore(devKey);
    const active = store.active[devKey];
    if (active && items.some((c) => c.id === active)) return active;
    return items[0]?.id ?? MAIN_CONV;
  }
  function setConvTitle(devKey, cid, patch) {
    const { store, items } = ensureStore(devKey);
    const hit = items.find((c) => c.id === cid);
    if (!hit) return;
    const { titleIfEmpty, ...rest } = patch;
    if (titleIfEmpty && !hit.title) hit.title = titleIfEmpty.slice(0, 24);
    Object.assign(hit, rest);
    saveConvStore(store);
  }
  function buildSessionList(devKey) {
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
        updatedAt: c.updatedAt || c.createdAt
      };
    });
    if (dirty) saveConvStore(store);
    view.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { type: "session.list", active: activeCid(devKey), items: view };
  }
  let mcp = null;
  if (cfg.plugins.mcp?.enabled && cfg.plugins.mcp.server?.enabled) {
    try {
      const { startMcpServer } = await import("./mcp-server.js");
      mcp = await startMcpServer(cfg.plugins.mcp.server);
      const prefix = "/mcp";
      if (!ch.tunnel[prefix] || ch.tunnel[prefix] !== `http://127.0.0.1:${mcp.port}`) {
        ch.tunnel[prefix] = `http://127.0.0.1:${mcp.port}`;
        saveConfig(cfg);
        log(`隧道已挂载 ${prefix} → 本机 MCP Server`);
      }
    } catch (err) {
      log(`MCP Server 启动失败（手机端将无法调用电脑工具）：${err.message}`);
    }
  }
  async function chatForConv(device, cid) {
    const devKey = device.id.slice(0, 8);
    const chatKey = chatKeyOf(devKey, cid);
    const hit = chats.get(chatKey);
    if (hit) return hit;
    const created = await openChannelSession(CHATS_INDEX, chatKey, void 0, {
      systemPrompt: buildMobileSystemPrompt(device.name),
      skipPluginIds: ["mode"],
      sessionsDir: SESSIONS_DIR,
      memoryScope: chatKey
    });
    const chat = attachStreamRelay(created.session, device.id, devKey, cid);
    chats.set(chatKey, chat);
    if (created.session.sessionFile) setConvTitle(devKey, cid, { file: created.session.sessionFile });
    log(`手机会话就绪：${chatKey}（${device.name}）`);
    return chat;
  }
  function attachStreamRelay(session, deviceToken, devKey, cid) {
    let turnId = "";
    let buf = "";
    const sendTo = (payload) => sendToDevice(deviceToken, payload);
    session.subscribe((event) => {
      const e = event;
      if (!turnId) return;
      const ame = e.assistantMessageEvent;
      if (e.type === "message_update" && ame?.type === "text_delta") {
        buf += ame.delta ?? "";
        sendTo({ type: "chat.delta", id: turnId, delta: ame.delta ?? "" });
        return;
      }
      if (e.type === "tool_execution_start" && e.toolName) {
        const args = e.args == null ? "" : (() => {
          const s = typeof e.args === "string" ? e.args : (() => {
            try {
              return JSON.stringify(e.args);
            } catch {
              return String(e.args);
            }
          })();
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
        setConvTitle(devKey, cid, { updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
        const endedTurn = turnId;
        buf = "";
        turnId = "";
        if (text && voiceMode.has(devKey)) void speakAndSend(deviceToken, endedTurn, text);
      }
    });
    return {
      beginTurn(id) {
        turnId = id;
        buf = "";
      },
      session
    };
  }
  async function speakAndSend(deviceToken, turnId, text) {
    try {
      const clipped = text.slice(0, TTS_TEXT_LIMIT);
      const voiceCfg = loadConfig().plugins.voice;
      const synth = await synthesizeSpeech(clipped, voiceCfg);
      if (!synth || synth.audio.length === 0) return;
      sendToDevice(deviceToken, { type: "chat.tts", id: turnId, mime: synth.mime, audioB64: synth.audio.toString("base64") });
    } catch {
    }
  }
  let hostWs = null;
  let backoff = 3;
  let closedByUs = false;
  const connIdByDevice = /* @__PURE__ */ new Map();
  function sendToDevice(deviceToken, payload) {
    const connId = connIdByDevice.get(deviceToken);
    if (connId === void 0 || !hostWs || hostWs.readyState !== WebSocket.OPEN) return;
    hostWs.send(JSON.stringify({ type: "forward", to: connId, payload }));
  }
  async function connectHost() {
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
      setTimeout(() => void connectHost(), backoff * 1e3);
      backoff = Math.min(backoff * 2, 30);
    });
    ws.on("error", (err) => log(`中继连接出错：${err.message}`));
  }
  async function onHostMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "pair.token": {
        await showQr(msg.url);
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
  async function showQr(url) {
    const qr = await QRCode.toString(url, { type: "terminal", small: true });
    console.log(`
${C.cyan}${C.bold}手机扫码连接 Dito${C.reset}`);
    console.log(qr);
    console.log(`${C.dim}或直接打开：${url}${C.reset}
`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  async function handlePairRequest(ws, msg) {
    const name = msg.name || "未知设备";
    const platform = msg.platform || "";
    let approve = ch.autoApprove;
    if (!approve) {
      console.log(`
${C.yellow}新设备请求配对：${name}（${platform || "未知平台"}，连接 #${msg.connId}）${C.reset}`);
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
    current.channels.mobile.devices.push({ id: deviceToken, name, platform, pairedAt: (/* @__PURE__ */ new Date()).toISOString() });
    saveConfig(current);
    log(`设备「${name}」已配对（共 ${current.channels.mobile.devices.length} 台）`);
  }
  function deleteConv(device, cid) {
    const devKey = device.id.slice(0, 8);
    const { store, items } = ensureStore(devKey);
    const hit = items.find((c) => c.id === cid);
    if (!hit) return;
    const chatKey = chatKeyOf(devKey, cid);
    const wasActive = activeCid(devKey) === cid;
    store.items[devKey] = items.filter((c) => c.id !== cid);
    delete store.active[devKey];
    saveConvStore(store);
    try {
      const index = JSON.parse(readFileSync(CHATS_INDEX, "utf-8"));
      const file = index[chatKey];
      delete index[chatKey];
      mkdirSync(MOBILE_DIR, { recursive: true });
      writeFileSync(CHATS_INDEX, JSON.stringify(index, null, 2), "utf-8");
      if (file && existsSync(file)) unlinkSync(file);
    } catch {
    }
    if (hit.file && existsSync(hit.file)) {
      try {
        unlinkSync(hit.file);
      } catch {
      }
    }
    const mem = chats.get(chatKey);
    if (mem) {
      chats.delete(chatKey);
      try {
        mem.session.dispose();
      } catch {
      }
    }
    log(`「${device.name}」删除对话 ${cid}${wasActive ? "（当前对话，已自动切换）" : ""}`);
  }
  async function onDeviceMessage(deviceToken, payload) {
    if (!payload || typeof payload.type !== "string") return;
    const device = loadConfig().channels.mobile.devices.find((d) => d.id === deviceToken);
    if (!device) {
      log("收到未登记设备的消息，已忽略");
      return;
    }
    const devKey = device.id.slice(0, 8);
    const reply = (p) => sendToDevice(deviceToken, p);
    switch (payload.type) {
      // ── 会话管理 ──
      case "session.list": {
        reply(buildSessionList(devKey));
        return;
      }
      case "session.new": {
        const cid2 = `c-${randomBytes(3).toString("hex")}`;
        const { store } = ensureStore(devKey);
        const nowIso = (/* @__PURE__ */ new Date()).toISOString();
        store.items[devKey] = [{ id: cid2, title: "", createdAt: nowIso, updatedAt: nowIso }, ...store.items[devKey]];
        store.active[devKey] = cid2;
        saveConvStore(store);
        await chatForConv(device, cid2);
        log(`「${device.name}」新建对话 ${cid2}`);
        reply(buildSessionList(devKey));
        return;
      }
      case "session.switch": {
        const cid2 = String(payload.id ?? "");
        const { items } = ensureStore(devKey);
        if (!items.some((c) => c.id === cid2)) {
          reply({ type: "chat.error", id: "", message: "对话不存在或已被删除" });
          reply(buildSessionList(devKey));
          return;
        }
        const { store } = ensureStore(devKey);
        store.active[devKey] = cid2;
        saveConvStore(store);
        await chatForConv(device, cid2);
        log(`「${device.name}」切换到对话 ${cid2}`);
        reply(buildSessionList(devKey));
        return;
      }
      case "session.delete": {
        const cid2 = String(payload.id ?? "");
        const wasActive = activeCid(devKey) === cid2;
        deleteConv(device, cid2);
        if (wasActive) {
          const { store, items: rest } = ensureStore(devKey);
          if (rest.length > 0) {
            const next = [...rest].sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))[0];
            store.active[devKey] = next.id;
            saveConvStore(store);
            await chatForConv(device, next.id);
          } else {
            const cidNew = `c-${randomBytes(3).toString("hex")}`;
            const nowIso = (/* @__PURE__ */ new Date()).toISOString();
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
        const cid2 = String(payload.id ?? "") || activeCid(devKey);
        const { items } = ensureStore(devKey);
        const meta = items.find((c) => c.id === cid2);
        const file = meta?.file ?? chatKeyFileOf(devKey, cid2);
        const limit = Number.isFinite(payload.limit) ? Math.min(Number(payload.limit), 500) : 200;
        const turns = file ? parseSessionTurns(file, limit) : [];
        reply({ type: "session.history", id: cid2, items: turns });
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
        const text2 = ttsCache.get(id) ?? "";
        if (text2) await speakAndSend(deviceToken, id, text2);
        else reply({ type: "chat.error", id, message: "这条回复不在语音缓存里了，重新生成一条吧" });
        return;
      }
      // ── 聊天 ──
      case "chat.user":
      case "chat.voice": {
        break;
      }
      default:
        return;
    }
    const turnId = typeof payload.id === "string" ? payload.id : randomBytes(8).toString("hex");
    const cid = activeCid(devKey);
    const chat = await chatForConv(device, cid);
    chat.beginTurn(turnId);
    if (payload.type === "chat.voice") {
      const sendToConn = (p) => sendToDevice(deviceToken, p);
      sendToConn({ type: "chat.tool", id: turnId, name: "语音识别", argsShort: "", state: "start" });
      let text2 = "";
      try {
        const audio = Buffer.from(String(payload.audioB64 ?? ""), "base64");
        if (audio.length === 0) throw new Error("空音频");
        const voiceCfg = loadConfig().plugins.voice;
        text2 = await transcribeRemoteAudio(audio, String(payload.mime ?? ""), voiceCfg);
      } catch (err) {
        sendToConn({ type: "chat.error", id: turnId, message: `语音识别失败：${err.message}` });
        return;
      }
      if (!text2) {
        sendToConn({ type: "chat.error", id: turnId, message: "语音识别结果为空（检查桌面端语音 STT 配置，如 MiMo key）" });
        return;
      }
      log(`「${device.name}」（语音）：${text2.slice(0, 80)}`);
      setConvTitle(devKey, cid, { updatedAt: (/* @__PURE__ */ new Date()).toISOString(), titleIfEmpty: text2 });
      await runWithTaskSlot(() => chat.session.prompt(text2));
      return;
    }
    const text = String(payload.text ?? "").trim();
    if (!text) return;
    log(`「${device.name}」：${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
    setConvTitle(devKey, cid, { updatedAt: (/* @__PURE__ */ new Date()).toISOString(), titleIfEmpty: text });
    await runWithTaskSlot(() => chat.session.prompt(text));
  }
  function chatKeyFileOf(devKey, cid) {
    const key = chatKeyOf(devKey, cid);
    try {
      return JSON.parse(readFileSync(CHATS_INDEX, "utf-8"))[key];
    } catch {
      return void 0;
    }
  }
  async function handleTunnel(ws, msg) {
    const reply = (status, contentType, body) => {
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
      const body = msg.bodyB64 ? Buffer.from(msg.bodyB64, "base64") : void 0;
      const hasBody = body && msg.method !== "GET" && msg.method !== "HEAD" && body.length > 0;
      const res = await fetch(target, {
        method: msg.method,
        headers: msg.headers ?? {},
        body: hasBody ? new Uint8Array(body) : void 0
      });
      const buf = Buffer.from(await res.arrayBuffer());
      reply(res.status, res.headers.get("content-type") ?? "application/octet-stream", buf);
    } catch (err) {
      reply(502, "application/json", Buffer.from(JSON.stringify({ error: err.message })));
    }
  }
  async function startEmbeddedRelay(mobile) {
    let lastErr = null;
    for (const port of EMBED_PORTS) {
      try {
        const handle = await startRelay({
          port,
          pwaDir: mobile.pwaDir || null,
          log: (m) => console.log(`${C.dim}[relay]${C.reset} ${m}`)
        });
        return { handle, port };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`内嵌中继启动失败（端口 ${EMBED_PORTS.join("/")} 均不可用）：${lastErr?.message ?? ""}`);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  async function shutdown() {
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
export {
  runMobileChannel
};
