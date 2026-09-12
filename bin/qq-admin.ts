/**
 * Dito QQ 管理后台（dito qqadmin）。
 *
 * 独立进程：自建一条 SnowLuma WS 客户端（多客户端并存）收实时事件、调 OneBot
 * 动作；直接读写本地数据（好感度/表情包/会话映射/配置），供网页端管理 QQ 频道。
 *
 * - HTTP + SSE 单端口（默认 127.0.0.1:3880，channels.qq.admin.port）
 * - 鉴权：token 非空时要求 ?token= 或 Bearer（本机 127.0.0.1 始终放行）
 * - 手机远程：启动时自动把 /qq 挂到 mobile 中继隧道（若 mobile 启用）
 *
 * 零新依赖（node:http + 已有 ws/@snowluma/sdk）。GPL-3.0-only，见仓库 LICENSE。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";

import { SnowLumaWebSocketClient, message } from "@snowluma/sdk";

import { loadConfig, saveConfig, ditoDataDir, ROOT_DIR, type QqChannelConfig } from "../extensions/util.js";
import { Affinity } from "./affinity.js";
import { MemeStore } from "./memes.js";
import { renderTextPng } from "./qq.js";

const TAG = "dito qqadmin";
const C = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", bold: "\x1b[1m" };

function log(msg: string): void {
  console.log(`${C.dim}[${TAG}]${C.reset} ${msg}`);
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分` : `${m}分钟`;
}

const DITO_DIR = ditoDataDir();
const CHAT_SESSIONS_DIR = join(DITO_DIR);
const QQ_CHATS_INDEX = join(DITO_DIR, "qq-chats.json");
const QQ_SESSIONS_DIR = join(DITO_DIR, "qq-sessions");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** 后台可透传的 OneBot 动作白名单（含只读与常用群管理；发消息走专用路由） */
const ALLOWED_ACTIONS = new Set([
  "get_login_info", "get_friend_list", "get_stranger_info", "get_group_list", "get_group_info",
  "get_group_member_list", "get_group_member_info", "get_group_msg_history", "get_friend_msg_history",
  "get_msg", "get_version_info", "get_status",
  "set_group_card", "set_group_ban", "set_group_whole_ban", "set_group_admin",
  "set_group_leave", "send_group_notice", "get_group_notice", "delete_msg",
  "friend_poke", "group_poke", "send_like", "set_qq_profile", "set_online_status",
]);

/** SSE 客户端集合 */
const sseClients = new Set<ServerResponse>();

function sseBroadcast(obj: unknown): void {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Dito 会话 JSONL 轻量解析（与 bin/session.ts 的扫描同思路） */
interface ChatTurn { role: "user" | "assistant"; text: string; ts?: string }
function parseSessionJsonl(file: string, limit: number): ChatTurn[] {
  if (!existsSync(file)) return [];
  const turns: ChatTurn[] = [];
  try {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string };
        if (e.type !== "message" || !e.message?.role) continue;
        if (e.message.role !== "user" && e.message.role !== "assistant") continue;
        const content = e.message.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content
            .map((c) => (c as { type?: string; text?: string }).type === "text" ? (c as { text?: string }).text ?? "" : "")
            .join("\n");
        }
        text = text.trim();
        if (!text) continue;
        turns.push({ role: e.message.role, text, ts: e.timestamp });
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    return [];
  }
  return turns.slice(-limit);
}

export async function runQqAdminChannel(argv: string[] = []): Promise<void> {
  const argOf = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const noBot = argv.includes("--no-bot");

  const cfg = loadConfig();
  const ch: QqChannelConfig = cfg.channels.qq;
  const port = Number(argOf("--port") ?? ch.admin?.port ?? 3880);
  const token = argOf("--token") ?? ch.admin?.token ?? "";
  const host = argOf("--host") ?? "127.0.0.1";

  const affinity = new Affinity(join(CHAT_SESSIONS_DIR, "affinity.json"));
  const memes = new MemeStore(join(CHAT_SESSIONS_DIR, "memes"));

  // ── SnowLuma 客户端（独立于 dito qq 进程） ──────────────────────
  let bot: SnowLumaWebSocketClient | null = null;
  let botConnected = false;
  let botStartedAt = Date.now();

  function bindBot(b: SnowLumaWebSocketClient): void {
    b.onEvent((event: any) => {
      const post = event?.post_type ?? "";
      if (post !== "message" && post !== "notice" && post !== "request" && post !== "meta_event") return;
      sseBroadcast({
        type: "qq.event",
        time: event.time ?? Date.now() / 1000,
        post,
        messageType: event.message_type ?? "",
        subType: event.sub_type ?? "",
        groupId: event.group_id,
        userId: event.user_id ?? event.sender?.user_id,
        nickname: event.sender?.nickname ?? "",
        card: event.sender?.card ?? "",
        rawMessage: event.raw_message ?? "",
        messageId: event.message_id,
        noticeType: event.notice_type ?? "",
        requestType: event.request_type ?? "",
        comment: event.comment ?? "",
      });
    });
  }

  async function connectBot(): Promise<void> {
    if (noBot) return;
    bot = new SnowLumaWebSocketClient({ url: ch.url, accessToken: ch.accessToken || undefined, reconnect: true });
    bindBot(bot);
    try {
      await bot.connect();
      botConnected = true;
      botStartedAt = Date.now();
      log(`已连接 SnowLuma（${ch.url}）`);
      sseBroadcast({ type: "bot.status", connected: true });
    } catch (err) {
      botConnected = false;
      log(`SnowLuma 连接失败：${(err as Error).message}（页面将以数据管理模式运行）`);
    }
  }

  /** tool 名 → SnowLuma 实际动作名（目录快照里部分扩展动作带 _ 前缀） */
  let actionNameMap: Map<string, string> | null = null;
  function resolveAction(name: string): string {
    if (actionNameMap === null) {
      actionNameMap = new Map();
      try {
        const catalog = JSON.parse(
          readFileSync(join(ROOT_DIR, "extensions", "snowluma-actions.json"), "utf-8"),
        ) as Array<{ name: string; tool: string }>;
        for (const a of catalog) actionNameMap.set(a.tool, a.name);
      } catch {
        /* 目录缺失则按原名调用 */
      }
    }
    return actionNameMap.get(name) ?? name;
  }

  async function raw(action: string, params?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!bot || !botConnected) return { ok: false, error: "SnowLuma 未连接（--no-bot 或离线）" };
    try {
      const result = await bot.raw(resolveAction(action), params);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ── 发消息（与 qq.ts 相同的组装策略） ───────────────────────────
  async function sendToChat(key: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const m = key.match(/^qq-(private|group)-(\d+)$/);
    if (!m) return { ok: false, error: "无效的聊天 key" };
    const [, type, id] = m;
    let segments: unknown[];
    if ([...text].length > 100) {
      const png = renderTextPng(text);
      segments = png
        ? [message.image(`base64://${readFileSync(png).toString("base64")}`)]
        : [message.text(text)];
    } else {
      segments = [message.text(text)];
    }
    const action = type === "group" ? "send_group_msg" : "send_private_msg";
    const params = type === "group" ? { group_id: Number(id), message: segments } : { user_id: Number(id), message: segments };
    const r = await raw(action, params as Record<string, unknown>);
    if (r.ok) sseBroadcast({ type: "qq.sent", key, text });
    return { ok: r.ok, error: r.error };
  }

  // ── 静态资源 ────────────────────────────────────────────────────
  const WEB_DIR = resolve(import.meta.dirname ?? ".", "..", "web-ui", "qq-admin");
  function serveStatic(res: ServerResponse, rel: string): boolean {
    const target = resolve(WEB_DIR, rel === "" ? "index.html" : rel);
    if (!target.startsWith(WEB_DIR + sep) && target !== WEB_DIR) return false;
    if (!existsSync(target) || !statSync(target).isFile()) return false;
    res.writeHead(200, { "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream" });
    res.end(readFileSync(target));
    return true;
  }

  // ── 路由 ────────────────────────────────────────────────────────
  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? "GET";

    // 状态
    if (path === "/api/status" && method === "GET") {
      const login = await raw("get_login_info");
      let sessions = 0;
      try {
        sessions = readdirSync(QQ_SESSIONS_DIR).filter((f) => f.endsWith(".jsonl")).length;
      } catch {}
      json(res, 200, {
        ok: true,
        botConnected,
        noBot,
        uptimeMs: Date.now() - botStartedAt,
        login: login.ok ? login.result : null,
        config: {
          url: ch.url,
          owners: ch.owners,
          groups: ch.groups,
          wakeKeywords: ch.wakeKeywords,
          groupReplyChance: ch.groupReplyChance,
          memeChance: ch.memeChance,
          autoReact: ch.autoReact,
          friends: ch.friends,
          pokeBack: ch.pokeBack,
          autoApprove: ch.autoApprove,
          enabled: ch.enabled,
        },
        stats: {
          affinityKeys: Object.keys(affinity.all()).length,
          memes: memes.count,
          sessions,
        },
      });
      return;
    }

    // SSE 实时流
    if (path === "/api/events/stream" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello", botConnected })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {
          clearInterval(ping);
          sseClients.delete(res);
        }
      }, 15000);
      res.on("close", () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    // 好友 / 群 / 群成员
    if (path === "/api/friends" && method === "GET") {
      json(res, 200, await raw("get_friend_list"));
      return;
    }
    if (path === "/api/groups" && method === "GET") {
      json(res, 200, await raw("get_group_list"));
      return;
    }
    const memberMatch = path.match(/^\/api\/groups\/(\d+)\/members$/);
    if (memberMatch && method === "GET") {
      json(res, 200, await raw("get_group_member_list", { group_id: Number(memberMatch[1]) }));
      return;
    }

    // 会话列表与历史
    if (path === "/api/chats" && method === "GET") {
      let index: Record<string, string> = {};
      try {
        index = JSON.parse(readFileSync(QQ_CHATS_INDEX, "utf-8")) as Record<string, string>;
      } catch {}
      const chats = Object.entries(index).map(([key, file]) => {
        let messages = 0;
        let lastTs = "";
        try {
          const turns = parseSessionJsonl(file, 10000);
          messages = turns.length;
          lastTs = turns[turns.length - 1]?.ts ?? "";
        } catch {}
        return { key, file: basename(file), messages, lastTs };
      });
      json(res, 200, { ok: true, chats });
      return;
    }
    const histMatch = path.match(/^\/api\/chats\/(qq-(?:private|group)-\d+)\/history$/);
    if (histMatch && method === "GET") {
      const key = histMatch[1];
      const limit = Math.min(500, Math.max(10, Number(url.searchParams.get("limit") ?? 100)));
      let index: Record<string, string> = {};
      try {
        index = JSON.parse(readFileSync(QQ_CHATS_INDEX, "utf-8")) as Record<string, string>;
      } catch {}
      const ditoTurns = index[key] ? parseSessionJsonl(index[key], limit) : [];
      const [, type, id] = key.match(/^qq-(private|group)-(\d+)$/) ?? [];
      const onebot =
        type === "group"
          ? await raw("get_group_msg_history", { group_id: Number(id), count: limit })
          : await raw("get_friend_msg_history", { user_id: Number(id), count: limit });
      json(res, 200, { ok: true, ditoTurns, onebot: onebot.ok ? onebot.result : null, onebotError: onebot.error });
      return;
    }
    const sendMatch = path.match(/^\/api\/chats\/(qq-(?:private|group)-\d+)\/send$/);
    if (sendMatch && method === "POST") {
      const body = await readBody(req);
      let text = "";
      try {
        text = String((JSON.parse(body) as { text?: string }).text ?? "");
      } catch {}
      if (!text.trim()) {
        json(res, 400, { ok: false, error: "text 不能为空" });
        return;
      }
      json(res, 200, await sendToChat(sendMatch[1], text.trim()));
      return;
    }
    // 会话重置：移除映射并删除会话文件（dito qq 运行中时下一条消息自动开新会话）
    const chatDelMatch = path.match(/^\/api\/chats\/(qq-(?:private|group)-\d+)$/);
    if (chatDelMatch && method === "DELETE") {
      const key = chatDelMatch[1];
      let index: Record<string, string> = {};
      try {
        index = JSON.parse(readFileSync(QQ_CHATS_INDEX, "utf-8")) as Record<string, string>;
      } catch {}
      const file = index[key];
      if (!file) {
        json(res, 404, { ok: false, error: "会话不存在" });
        return;
      }
      delete index[key];
      const { writeFileSync } = await import("node:fs");
      writeFileSync(QQ_CHATS_INDEX, JSON.stringify(index, null, 2), "utf-8");
      try {
        if (file.startsWith(QQ_SESSIONS_DIR + sep) && existsSync(file)) unlinkSync(file);
      } catch (err) {
        log(`会话文件删除失败（映射已移除）：${(err as Error).message}`);
      }
      json(res, 200, { ok: true, key, note: "映射已移除，会话文件已删除；dito qq 运行中时下一条消息自动开新会话" });
      return;
    }

    // 好感度
    if (path === "/api/affinity" && method === "GET") {
      json(res, 200, { ok: true, data: affinity.all() });
      return;
    }
    const affMatch = path.match(/^\/api\/affinity\/(\d+)\/(\d+)$/);
    if (affMatch && method === "POST") {
      const body = await readBody(req);
      let score: number | undefined;
      let delta: number | undefined;
      try {
        const b = JSON.parse(body) as { score?: number; delta?: number };
        score = typeof b.score === "number" ? b.score : undefined;
        delta = typeof b.delta === "number" ? b.delta : undefined;
      } catch {}
      const key = `${affMatch[1]}:${affMatch[2]}`;
      const value = score !== undefined ? affinity.set(key, score) : delta !== undefined ? affinity.adjust(key, delta) : affinity.get(key);
      json(res, 200, { ok: true, key, value });
      return;
    }

    // 表情包库
    if (path === "/api/memes" && method === "GET") {
      json(res, 200, { ok: true, dir: memes.dir, entries: memes.list() });
      return;
    }
    const memeImgMatch = path.match(/^\/api\/memes\/([a-f0-9]+)\/image$/);
    if (memeImgMatch && method === "GET") {
      const entry = memes.list().find((e) => e.id === memeImgMatch[1]);
      const file = entry ? join(memes.dir, entry.file) : "";
      if (!file || !file.startsWith(memes.dir + sep) || !existsSync(file)) {
        json(res, 404, { ok: false, error: "not found" });
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "image/png", "cache-control": "max-age=60" });
      res.end(readFileSync(file));
      return;
    }
    const memeDelMatch = path.match(/^\/api\/memes\/([a-f0-9]+)$/);
    if (memeDelMatch && method === "DELETE") {
      const entries = memes.list();
      const entry = entries.find((e) => e.id === memeDelMatch[1]);
      if (!entry) {
        json(res, 404, { ok: false, error: "not found" });
        return;
      }
      const file = join(memes.dir, entry.file);
      if (file.startsWith(memes.dir + sep) && existsSync(file)) unlinkSync(file);
      // 从索引移除：直接重写 memes.json（MemeStore 会热重载）
      const next = entries.filter((e) => e.id !== entry.id);
      const idx = join(memes.dir, "memes.json");
      if (existsSync(idx)) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(idx, JSON.stringify(next, null, 1), "utf-8");
      }
      json(res, 200, { ok: true, removed: entry.id });
      return;
    }

    // QQ 频道配置
    if (path === "/api/config/qq" && method === "GET") {
      const c = loadConfig().channels.qq;
      json(res, 200, {
        ok: true,
        config: {
          enabled: c.enabled, url: c.url, autoStart: c.autoStart, owners: c.owners, groups: c.groups,
          wakeKeywords: c.wakeKeywords, groupReplyChance: c.groupReplyChance, autoReact: c.autoReact,
          memeChance: c.memeChance, friends: c.friends, pokeBack: c.pokeBack, autoApprove: c.autoApprove,
        },
      });
      return;
    }
    if (path === "/api/config/qq" && method === "PATCH") {
      const body = await readBody(req);
      let patch: Record<string, unknown>;
      try {
        patch = JSON.parse(body) as Record<string, unknown>;
      } catch {
        json(res, 400, { ok: false, error: "invalid json" });
        return;
      }
      const current = loadConfig();
      const c = current.channels.qq;
      const numList = (v: unknown): number[] | undefined =>
        Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n) && n !== 0) : undefined;
      const strList = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;
      if (typeof patch.enabled === "boolean") c.enabled = patch.enabled;
      if (typeof patch.autoStart === "boolean") c.autoStart = patch.autoStart;
      if (typeof patch.autoReact === "boolean") c.autoReact = patch.autoReact;
      if (typeof patch.friends === "boolean") c.friends = patch.friends;
      if (typeof patch.pokeBack === "boolean") c.pokeBack = patch.pokeBack;
      if (typeof patch.autoApprove === "boolean") c.autoApprove = patch.autoApprove;
      if (numList(patch.owners)) c.owners = numList(patch.owners)!;
      if (numList(patch.groups)) c.groups = numList(patch.groups)!;
      if (numList(patch.wakeOnlyGroups)) c.wakeOnlyGroups = numList(patch.wakeOnlyGroups)!;
      if (strList(patch.wakeKeywords)) c.wakeKeywords = strList(patch.wakeKeywords)!;
      if (typeof patch.groupReplyChance === "number") c.groupReplyChance = Math.max(0, Math.min(1, patch.groupReplyChance));
      if (typeof patch.memeChance === "number") c.memeChance = Math.max(0, Math.min(1, patch.memeChance));
      if (typeof patch.url === "string" && patch.url.trim()) c.url = patch.url.trim();
      saveConfig(current);
      json(res, 200, { ok: true, config: { ...c, accessToken: undefined } });
      return;
    }

    // ── Matrix ──────────────────────────────────────────────────
    if (path === "/api/matrix/status" && method === "GET") {
      const mc = loadConfig().channels.matrix;
      const result: Record<string, unknown> = { ok: true, enabled: mc.enabled, homeserver: mc.homeserver, hasToken: !!mc.accessToken, roomsLimit: mc.rooms, owners: mc.owners };
      // 守护进程探测（/proc 扫描；非 Linux 返回 unknown）
      if (process.platform === "linux") {
        let pid: number | null = null;
        let etime = "";
        try {
          const { readdirSync, readFileSync: rf } = await import("node:fs");
          for (const d of readdirSync("/proc")) {
            if (!/^\d+$/.test(d)) continue;
            try {
              const cmd = rf(`/proc/${d}/cmdline`, "utf-8").replace(/\0/g, " ");
              if (cmd.includes("dito.ts") && / matrix(\s|$)/.test(cmd)) {
                pid = Number(d);
                const stat = rf(`/proc/${d}/stat`, "utf-8").split(")");
                const fields = stat[1]?.trim().split(" ") ?? [];
                const uptime = Number(rf("/proc/uptime", "utf-8").split(" ")[0]);
                const starttime = Number(fields[19] ?? 0) / 100;
                etime = formatDuration(uptime - starttime);
                break;
              }
            } catch {}
          }
        } catch {}
        result.daemon = { running: pid !== null, pid, uptime: etime };
      } else {
        result.daemon = { running: null, pid: null, uptime: "" };
      }
      // homeserver 可达 + whoami
      if (mc.homeserver && mc.accessToken) {
        try {
          const who = await fetch(`${mc.homeserver.replace(/\/+$/, "")}/_matrix/client/v3/account/whoami`, {
            headers: { Authorization: `Bearer ${mc.accessToken}` },
            signal: AbortSignal.timeout(8000),
          });
          const whoJson = (await who.json()) as { user_id?: string };
          result.reachable = true;
          result.account = who.ok ? whoJson.user_id ?? "" : "";
          result.tokenValid = who.ok;
          // 已加入房间
          if (who.ok) {
            try {
              const jr = await fetch(`${mc.homeserver.replace(/\/+$/, "")}/_matrix/client/v3/joined_rooms`, {
                headers: { Authorization: `Bearer ${mc.accessToken}` }, signal: AbortSignal.timeout(8000) });
              const roomIds = ((await jr.json()) as { joined_rooms?: string[] }).joined_rooms ?? [];
              const rooms = await Promise.all(roomIds.slice(0, 50).map(async (roomId) => {
                let name = "";
                let members = 0;
                try {
                  const nr = await fetch(`${mc.homeserver.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, {
                    headers: { Authorization: `Bearer ${mc.accessToken}` }, signal: AbortSignal.timeout(8000) });
                  if (nr.ok) name = ((await nr.json()) as { name?: string }).name ?? "";
                } catch {}
                try {
                  const mr = await fetch(`${mc.homeserver.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`, {
                    headers: { Authorization: `Bearer ${mc.accessToken}` }, signal: AbortSignal.timeout(8000) });
                  if (mr.ok) members = Object.keys(((await mr.json()) as { joined?: Record<string, unknown> }).joined ?? {}).length;
                } catch {}
                return { id: roomId, name, members };
              }));
              result.joinedRooms = rooms;
            } catch { result.joinedRooms = []; }
          }
        } catch {
          result.reachable = false;
        }
      }
      json(res, 200, result);
      return;
    }
    if (path === "/api/config/matrix" && method === "GET") {
      const c = loadConfig().channels.matrix;
      json(res, 200, { ok: true, config: { enabled: c.enabled, homeserver: c.homeserver, hasToken: !!c.accessToken, rooms: c.rooms, owners: c.owners ?? [] } });
      return;
    }
    if (path === "/api/config/matrix" && method === "PATCH") {
      const body = await readBody(req);
      let patch: Record<string, unknown>;
      try { patch = JSON.parse(body) as Record<string, unknown>; } catch { json(res, 400, { ok: false, error: "invalid json" }); return; }
      const current = loadConfig();
      const c = current.channels.matrix;
      if (typeof patch.enabled === "boolean") c.enabled = patch.enabled;
      if (typeof patch.homeserver === "string" && patch.homeserver.trim()) c.homeserver = patch.homeserver.trim();
      if (typeof patch.accessToken === "string" && patch.accessToken.trim()) c.accessToken = patch.accessToken.trim();
      if (Array.isArray(patch.rooms)) c.rooms = patch.rooms.map(String).map((x) => x.trim()).filter(Boolean);
      if (Array.isArray(patch.owners)) c.owners = patch.owners.map(String).map((x) => x.trim()).filter(Boolean);
      saveConfig(current);
      json(res, 200, { ok: true, note: "rooms/owners/enabled 即时生效；homeserver/accessToken 改动需重启 dito matrix" });
      return;
    }

    // 动作白名单透传
    const actionMatch = path.match(/^\/api\/actions\/([a-z_]+)$/);
    if (actionMatch && method === "POST") {
      const name = actionMatch[1];
      if (!ALLOWED_ACTIONS.has(name)) {
        json(res, 403, { ok: false, error: `动作 ${name} 不在后台白名单内` });
        return;
      }
      const body = await readBody(req);
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(body || "{}") as Record<string, unknown>;
      } catch {}
      json(res, 200, await raw(name, params));
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  }

  // ── HTTP 服务器 ─────────────────────────────────────────────────
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://qqadmin");
    // 鉴权：token 非空时，非本机请求必须带令牌
    const remote = req.socket.remoteAddress ?? "";
    const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (token && !isLocal) {
      const given = url.searchParams.get("token") ?? String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (given !== token) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        res.end("需要访问令牌（config channels.qq.admin.token）");
        return;
      }
    }

    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (serveStatic(res, url.pathname.replace(/^\/+/, ""))) return;
      if (!serveStatic(res, "index.html")) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("web-ui/qq-admin 缺失（静态资源未找到）");
      }
    } catch (err) {
      log(`请求处理出错：${(err as Error).message}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: (err as Error).message });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  log(`管理后台已就绪：http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/`);

  // 手机远程管理：自动挂 mobile 中继隧道
  if (cfg.channels.mobile?.enabled) {
    const want = `http://127.0.0.1:${port}`;
    if (cfg.channels.mobile.tunnel["/qq"] !== want) {
      cfg.channels.mobile.tunnel["/qq"] = want;
      saveConfig(cfg);
      log(`已挂载手机隧道 /qq → ${want}（配对设备经中继访问 /t/<房间>/qq/）`);
    }
  }

  await connectBot();

  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
  console.log(`${C.green}${C.bold}Dito QQ 管理后台运行中，Ctrl-C 退出。${C.reset}`);
  setInterval(() => {}, 1 << 30);
}
