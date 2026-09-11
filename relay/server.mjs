/**
 * Dito 中继服务（relay）。
 *
 * 手机/PWA 与桌面端不在同一网络时，双方都以出站 WebSocket 连到本中继，
 * 中继按「房间」转发消息，并提供 HTTP 隧道（把公网请求转发到桌面本地服务，
 * 如 MCP Server）与配对页托管（/p/<room>，可服务 PWA 静态文件）。
 *
 * 三种 WebSocket 角色（/ws/<room>）：
 *   host   ?host=<hostToken>      桌面端，注册房间；断线重连自动接管
 *   pair   ?pair=<一次性令牌>      新设备配对；host 同意后换发长期 deviceToken
 *   device ?device=<deviceToken>   已配对设备
 *
 * host↔relay 控制消息：pair.issue / pair.token / pair.request / pair.approve /
 * pair.reject / device.check / device.ok / device.unknown。
 * 业务消息统一包一层 forward：host→客户端 {type:"forward",to:<connId>,payload}，
 * 客户端→host 到达为 {type:"forward",from:<connId>,deviceToken,payload}。
 *
 * HTTP 隧道：GET/POST /t/<room>/<path> + `Authorization: Bearer <deviceToken>`
 *   → host 收 {type:"http", id, method, path, headers, bodyB64}
 *   → 回 {type:"http.response", id, status, contentType, bodyB64}。
 *
 * 单文件，仅依赖 ws；也可作为模块被桌面端内嵌（startRelay）。
 * GPL-3.0-only，见仓库 LICENSE。
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const MAX_HTTP_BODY = 10 * 1024 * 1024; // 隧道请求/响应体上限
const MAX_CLIENTS_PER_ROOM = 8;
const ROOM_GC_MS = 10 * 60 * 1000; // host 掉线后房间保留时长
const HTTP_TIMEOUT_MS = 120 * 1000;
const DEVICE_CHECK_TIMEOUT_MS = 5 * 1000;

const TOKEN = () => crypto.randomBytes(16).toString("hex");
const now = () => Date.now();

function firstLanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "127.0.0.1";
}

// ── 极简配对页（未配置 PWA 时使用；浏览器打开即测） ─────────────────
const PAIR_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dito 连接</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;display:flex;flex-direction:column;height:100dvh}
#log{flex:1;overflow-y:auto;padding:14px;line-height:1.6}
.me{color:#8fd3ff}.tool{color:#ffd479;font-size:.85em}.err{color:#ff8080}.dim{color:#8a8f98;font-size:.85em}
form{display:flex;gap:8px;padding:10px;border-top:1px solid #262a33}
input{flex:1;background:#181b22;border:1px solid #2c313c;color:#e6e6e6;border-radius:10px;padding:12px;font-size:16px}
button{background:#2f6fed;color:#fff;border:0;border-radius:10px;padding:0 18px;font-size:16px}
</style></head><body>
<div id="log"></div>
<form id="f"><input id="i" placeholder="跟 Dito 说点什么…" autocomplete="off"><button>发送</button></form>
<script>
const q = new URLSearchParams(location.search);
const room = location.pathname.split("/").pop();
const ws = new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/ws/"+room+"?pair="+q.get("k"));
const log = document.getElementById("log");
let buf = "", turn = null;
function line(cls, text){ const d=document.createElement("div"); if(cls)d.className=cls; d.textContent=text; log.appendChild(d); log.scrollTop=log.scrollHeight; return d; }
ws.onopen = () => { ws.send(JSON.stringify({type:"pair.hello",name:"网页配对",platform:"browser"})); line("dim","连接中，等待电脑端确认…"); };
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "pair.ok") line("dim","✓ 已连接到电脑");
  else if (m.type === "pair.rejected") line("err","电脑端拒绝了配对");
  else if (m.type === "host.lost") line("err","电脑端已断开");
  else if (m.type === "chat.delta") { buf += m.delta; if(!turn) turn=line("me",""); turn.textContent = buf; }
  else if (m.type === "chat.end") { buf = ""; turn = null; }
  else if (m.type === "chat.tool") line("tool","⚙ "+m.name+" "+(m.argsShort||""));
  else if (m.type === "chat.error") line("err","出错："+m.message);
};
ws.onclose = () => line("err","连接已关闭");
document.getElementById("f").onsubmit = (e) => {
  e.preventDefault();
  const i = document.getElementById("i");
  if (!i.value.trim()) return;
  buf = ""; turn = null;
  ws.send(JSON.stringify({type:"chat.user", id: crypto.randomUUID(), text: i.value.trim()}));
  i.value = "";
};
</script></body></html>`;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".map": "application/json",
};

/**
 * 启动中继。
 * @param {{port?:number, host?:string, baseUrl?:string, pwaDir?:string|null, log?:(msg:string)=>void}} opts
 *   baseUrl：配对 URL 对外基址（如 https://relay.example.com）；缺省用局域网 IP。
 *   pwaDir：/p/<room> 服务该目录下的 PWA 静态文件；缺省用内置极简配对页。
 * @returns {Promise<{port:number, issuePairToken:(room:string)=>{token:string,url:string}|null, close:()=>Promise<void>}>}
 */
export function startRelay(opts = {}) {
  const log = opts.log ?? (() => {});
  const port = opts.port ?? 8787;
  const listenHost = opts.host ?? "0.0.0.0";
  const pwaDir = opts.pwaDir ? path.resolve(opts.pwaDir) : null;
  const baseUrl = (opts.baseUrl ?? `http://${firstLanIPv4()}:${port}`).replace(/\/+$/, "");

  /** room id -> 房间状态 */
  const rooms = new Map();
  /** 隧道请求 id -> {res, timer} */
  const pendingHttp = new Map();

  function send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function pairUrl(room, token) {
    return `${baseUrl}/p/${room}?k=${token}`;
  }

  function dropRoomSoon(room) {
    room.host = null;
    for (const c of room.conns.values()) send(c.ws, { type: "host.lost" });
    setTimeout(() => {
      if (room.host === null && rooms.get(room.id) === room) {
        rooms.delete(room.id);
        log(`房间 ${room.id} 已回收`);
      }
    }, ROOM_GC_MS);
  }

  // ── HTTP：健康检查 / 配对页（PWA） / 隧道 ─────────────────────────
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    // CORS：手机浏览器 PWA 与 MCP 客户端跨域访问需要
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (url.pathname === "/health") {
      const detail = [...rooms.entries()].map(([id, r]) => ({ id, host: !!(r.host && r.host.readyState === WebSocket.OPEN), devices: r.conns.size }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, detail }));
      return;
    }

    // /p/<room>?k=<token>：配对入口页
    const pMatch = url.pathname.match(/^\/p\/([a-z0-9-]+)$/);
    if (pMatch && req.method === "GET") {
      const room = rooms.get(pMatch[1]);
      if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><meta charset=utf-8><title>Dito</title><p>房间不存在或电脑端未在线。</p>");
        return;
      }
      if (pwaDir && fs.existsSync(path.join(pwaDir, "index.html"))) {
        res.writeHead(200, { "content-type": MIME[".html"] });
        fs.createReadStream(path.join(pwaDir, "index.html")).pipe(res);
      } else {
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(PAIR_PAGE);
      }
      return;
    }

    // /t/<room>/<path>：HTTP 隧道（Bearer deviceToken）
    const tMatch = url.pathname.match(/^\/t\/([a-z0-9-]+)(\/.*)$/);
    if (tMatch) {
      const room = rooms.get(tMatch[1]);
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
        res.writeHead(502, { "content-type": "text/plain" }); res.end("room offline"); return;
      }
      if (!auth || !room.deviceTokens.has(auth)) {
        res.writeHead(401, { "content-type": "text/plain" }); res.end("unauthorized"); return;
      }
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_HTTP_BODY) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pendingHttp.has(id)) {
            pendingHttp.delete(id);
            try { res.writeHead(504, { "content-type": "text/plain" }); res.end("tunnel timeout"); } catch {}
          }
        }, HTTP_TIMEOUT_MS);
        pendingHttp.set(id, { res, timer });
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (["host", "authorization", "connection", "content-length"].includes(k)) continue;
          headers[k] = String(v);
        }
        send(room.host, {
          type: "http", id, method: req.method, path: tMatch[2], headers,
          bodyB64: chunks.length ? Buffer.concat(chunks).toString("base64") : "",
        });
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  // ── WebSocket ────────────────────────────────────────────────────
  const wss = new WebSocketServer({ server, maxPayload: MAX_HTTP_BODY + 1024 * 1024 });

  function onClientMessage(room, conn, msg) {
    if (!conn.paired) return; // 未完成配对只允许 pair.hello（连接处已单独处理）
    if (room.host && room.host.readyState === WebSocket.OPEN) {
      send(room.host, { type: "forward", from: conn.id, deviceToken: conn.deviceToken, payload: msg });
    }
  }

  function joinDevice(room, ws, deviceToken) {
    if (!room.deviceTokens.has(deviceToken)) {
      // 中继内存里没有（如重启过）→ 问电脑端（权威设备列表在桌面配置里）
      if (!room.host || room.host.readyState !== WebSocket.OPEN) { ws.close(1008, "room offline"); return; }
      const timer = setTimeout(() => { room.deviceChecks.delete(deviceToken); ws.close(1008, "device check timeout"); }, DEVICE_CHECK_TIMEOUT_MS);
      room.deviceChecks.set(deviceToken, (ok) => {
        clearTimeout(timer);
        room.deviceChecks.delete(deviceToken);
        if (ok) { room.deviceTokens.add(deviceToken); joinDevice(room, ws, deviceToken); }
        else ws.close(1008, "unknown device");
      });
      send(room.host, { type: "device.check", token: deviceToken });
      return;
    }
    if (room.conns.size >= MAX_CLIENTS_PER_ROOM) { ws.close(1013, "room full"); return; }
    // 同设备重连：踢掉旧连接
    for (const c of [...room.conns.values()]) {
      if (c.deviceToken === deviceToken) { send(c.ws, { type: "replaced" }); c.ws.close(); room.conns.delete(c.id); }
    }
    const conn = { id: ++room.connSeq, ws, deviceToken, paired: true };
    room.conns.set(conn.id, conn);
    log(`房间 ${room.id} 设备已连接 #${conn.id}`);
    send(ws, { type: "device.ok" });
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      onClientMessage(room, conn, msg);
    });
    ws.on("close", () => room.conns.delete(conn.id));
  }

  wss.on("connection", (ws, req) => {
    let url;
    try { url = new URL(req.url ?? "/", "http://relay"); } catch { ws.close(); return; }
    const m = url.pathname.match(/^\/ws\/([a-z0-9-]+)$/);
    if (!m) { ws.close(1008, "bad path"); return; }
    const roomId = m[1];
    const hostToken = url.searchParams.get("host");
    const pairToken = url.searchParams.get("pair");
    const deviceToken = url.searchParams.get("device");

    // ── host 注册 ──
    if (hostToken) {
      let room = rooms.get(roomId);
      if (room && room.host && room.host.readyState === WebSocket.OPEN) { ws.close(1008, "host exists"); return; }
      if (!room) {
        room = { id: roomId, host: null, hostAliveAt: now(), pairTokens: new Set(), deviceTokens: new Set(), conns: new Map(), connSeq: 0, deviceChecks: new Map() };
        rooms.set(roomId, room);
        log(`房间 ${roomId} 已创建`);
      }
      room.host = ws;
      room.hostAliveAt = now();
      log(`房间 ${roomId} 电脑端已连接`);
      ws.on("message", (data) => {
        let msg;
        try { msg = JSON.parse(String(data)); } catch { return; }
        onHostMessage(room, ws, msg);
      });
      ws.on("close", () => {
        if (room.host === ws) { log(`房间 ${roomId} 电脑端断开`); dropRoomSoon(room); }
      });
      return;
    }

    const room = rooms.get(roomId);
    if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) { ws.close(1008, "room offline"); return; }

    // ── 新设备（一次性配对令牌） ──
    if (pairToken) {
      if (!room.pairTokens.delete(pairToken)) { ws.close(1008, "invalid pair token"); return; }
      if (room.conns.size >= MAX_CLIENTS_PER_ROOM) { ws.close(1013, "room full"); return; }
      const conn = { id: ++room.connSeq, ws, deviceToken: null, paired: false, hello: null };
      room.conns.set(conn.id, conn);
      log(`房间 ${roomId} 新设备配对请求 #${conn.id}`);
      // 等客户端 pair.hello（补充设备名）；1.5s 未收到按未知设备询问
      let askTimer = null;
      const ask = () => {
        askTimer = null;
        if (!conn.paired && room.host && room.host.readyState === WebSocket.OPEN) {
          send(room.host, { type: "pair.request", connId: conn.id, name: conn.hello?.name ?? "未知设备", platform: conn.hello?.platform ?? "" });
        }
      };
      askTimer = setTimeout(ask, 1500);
      ws.on("message", (data) => {
        let msg;
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg.type === "pair.hello" && !conn.paired) {
          conn.hello = msg;
          if (askTimer) { clearTimeout(askTimer); ask(); }
          return;
        }
        onClientMessage(room, conn, msg);
      });
      ws.on("close", () => {
        if (askTimer) clearTimeout(askTimer);
        room.conns.delete(conn.id);
      });
      return;
    }

    // ── 已配对设备 ──
    if (deviceToken) {
      joinDevice(room, ws, deviceToken);
      return;
    }

    ws.close(1008, "missing credentials");
  });

  function onHostMessage(room, ws, msg) {
    room.hostAliveAt = now();
    switch (msg.type) {
      case "pair.issue": {
        const token = TOKEN();
        room.pairTokens.add(token);
        send(ws, { type: "pair.token", token, url: pairUrl(room.id, token) });
        return;
      }
      case "pair.approve": {
        const conn = room.conns.get(msg.connId);
        if (!conn || conn.paired) return;
        const deviceToken = typeof msg.deviceToken === "string" && msg.deviceToken.length >= 32 ? msg.deviceToken : TOKEN();
        room.deviceTokens.add(deviceToken);
        conn.deviceToken = deviceToken;
        conn.paired = true;
        send(conn.ws, { type: "pair.ok", deviceToken });
        log(`房间 ${room.id} 设备 #${conn.id} 已配对`);
        return;
      }
      case "pair.reject": {
        const conn = room.conns.get(msg.connId);
        if (conn && !conn.paired) { send(conn.ws, { type: "pair.rejected" }); conn.ws.close(); room.conns.delete(conn.id); }
        return;
      }
      case "device.ok": {
        room.deviceChecks.get(msg.token)?.(true);
        return;
      }
      case "device.unknown": {
        room.deviceChecks.get(msg.token)?.(false);
        return;
      }
      case "forward": {
        const conn = room.conns.get(msg.to);
        if (conn && conn.paired) send(conn.ws, msg.payload);
        return;
      }
      case "http.response": {
        const pending = pendingHttp.get(msg.id);
        if (!pending) return;
        pendingHttp.delete(msg.id);
        clearTimeout(pending.timer);
        const body = msg.bodyB64 ? Buffer.from(msg.bodyB64, "base64") : Buffer.alloc(0);
        pending.res.writeHead(msg.status ?? 502, { "content-type": msg.contentType ?? "application/octet-stream" });
        pending.res.end(body);
        return;
      }
      default:
        return;
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, listenHost, () => {
      log(`中继已监听 ${listenHost}:${port}（配对页基址 ${baseUrl}）`);
      resolve({
        port,
        issuePairToken(room) {
          const r = rooms.get(room);
          if (!r || !r.host) return null;
          const token = TOKEN();
          r.pairTokens.add(token);
          return { token, url: pairUrl(room, token) };
        },
        close() {
          wss.close();
          for (const r of rooms.values()) {
            r.host?.close();
            for (const c of r.conns.values()) c.ws.close();
          }
          rooms.clear();
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}

// ── 命令行独立运行 ──────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const arg = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const port = Number(arg("port", "8787"));
  const baseUrl = arg("base-url");
  const pwaDir = arg("pwa-dir");
  startRelay({ port, baseUrl, pwaDir, log: (m) => console.log(`[relay] ${m}`) }).catch((err) => {
    console.error("[relay] 启动失败：", err.message);
    process.exit(1);
  });
}
