import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  MatrixClient,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
  LogService,
  LogLevel
} from "matrix-bot-sdk";
import { ditoChannelDir, loadConfig } from "../extensions/util.js";
import { openChannelSession } from "./session.js";
import { makeChannelChat, applySessionToolPolicy, runWithTaskSlot } from "./channel-chat.js";
const CHAT_SESSIONS_DIR = ditoChannelDir("matrix");
const CRYPTO_STORE_DIR = join(CHAT_SESSIONS_DIR, "matrix-crypto-store");
function roomKey(roomId) {
  return `matrix-${roomId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}
async function isOwnerRoom(client, roomId, ch) {
  const owners = ch.owners ?? [];
  if (owners.length === 0) return false;
  try {
    const joined = await client.getJoinedRoomMembers(roomId);
    const members = Array.isArray(joined) ? joined : Object.keys(joined);
    return members.every((m) => m === client.userId || owners.includes(m)) && members.some((m) => owners.includes(m));
  } catch {
    return false;
  }
}
function isMentioned(event, selfId) {
  const c = event?.content ?? {};
  const ids = c["m.mentions"]?.user_ids;
  if (Array.isArray(ids) && ids.includes(selfId)) return true;
  if (typeof c.formatted_body === "string" && c.formatted_body.includes(selfId)) return true;
  const body = typeof c.body === "string" ? c.body : "";
  if (body.includes(selfId)) return true;
  const alias = selfId.split(":")[0];
  return new RegExp(`${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "i").test(body);
}
async function runMatrixChannel() {
  const cfg = loadConfig();
  const ch = cfg.channels.matrix;
  if (!ch.enabled || !ch.accessToken) {
    console.error("Matrix 频道未启用：用 `dito config` 启用 Matrix，填写 homeserver 与 accessToken（保存在 user/matrix/config.json）。");
    process.exit(1);
  }
  LogService.setLevel(LogLevel.WARN);
  const client = new MatrixClient(
    ch.homeserver,
    ch.accessToken,
    new SimpleFsStorageProvider(join(CHAT_SESSIONS_DIR, "matrix-bot-state.json")),
    new RustSdkCryptoStorageProvider(CRYPTO_STORE_DIR)
  );
  mkdirSync(CRYPTO_STORE_DIR, { recursive: true });
  AutojoinRoomsMixin.setupOnClient(client);
  const selfId = await client.getUserId();
  const chats = /* @__PURE__ */ new Map();
  console.log("");
  console.log("  Dito Matrix 频道已连接（E2EE 已启用）");
  console.log("");
  console.log(`  ➜  账号：${selfId}`);
  console.log(`  ➜  服务器：${ch.homeserver}`);
  console.log(`  ➜  房间范围：${ch.rooms.length ? `${ch.rooms.length} 个指定房间` : "所有已加入房间"}`);
  console.log("  按 Ctrl+C 退出。");
  console.log("");
  client.on("room.message", (roomId, event) => {
    void (async () => {
      try {
        const ch2 = loadConfig().channels.matrix;
        if (!ch2.enabled) return;
        const content = event?.content;
        if (!content || event.sender === selfId) return;
        if (ch2.rooms.length > 0 && !ch2.rooms.includes(roomId)) return;
        if (content.msgtype !== "m.text") return;
        const body = (content.body ?? "").trim();
        if (!body) return;
        const mentionOnly = ch2.mentionOnly === true || (ch2.mentionOnlyRooms ?? []).includes(roomId);
        if (mentionOnly && !isMentioned(event, selfId)) {
          const ownerCmd = body.startsWith("/") && (ch2.owners ?? []).includes(event.sender ?? "");
          if (!ownerCmd) {
            console.log(`[dito matrix] ${roomId} 仅 @ 回复，忽略 ${event.sender} 的消息`);
            return;
          }
        }
        const key = roomKey(roomId);
        const isNewChat = body.toLowerCase() === "/whatnew";
        if (isNewChat) {
          const previous = chats.get(key);
          if (previous) {
            try {
              await previous.session.abort();
            } catch {
            }
            try {
              previous.session.dispose();
            } catch {
            }
            chats.delete(key);
          }
        }
        let chat = chats.get(key);
        if (!chat) {
          const created = await openChannelSession(join(CHAT_SESSIONS_DIR, "matrix-chats.json"), key, void 0, {
            sessionsDir: join(CHAT_SESSIONS_DIR, "matrix-sessions"),
            memoryScope: key,
            disableThinking: true
          }, isNewChat);
          applySessionToolPolicy(created.session, await isOwnerRoom(client, roomId, ch2), "dito matrix");
          chat = makeChannelChat(created.session, (reply) => client.sendEvent(roomId, "m.room.message", { msgtype: "m.text", body: reply }), "dito matrix");
          chats.set(key, chat);
          console.log(`[dito matrix] 新房间会话：${roomId}（模型 ${created.modelName}）`);
        }
        if (isNewChat) {
          await client.sendEvent(roomId, "m.room.message", { msgtype: "m.text", body: "新对话开好了，旧的翻篇" });
          console.log(`[dito matrix] 房间 ${roomId} 重开新对话`);
          return;
        }
        const senderName = event.sender && event.sender.startsWith("@") ? event.sender.split(":")[0].slice(1) : event.sender;
        const timer = setTimeout(() => {
          void chat.session.abort().catch(() => {
          });
        }, 18e4);
        try {
          await runWithTaskSlot(() => chat.session.prompt(`[Matrix 房间 来自 ${senderName}] ${body}`, {
            streamingBehavior: "followUp"
          }));
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        console.error("[dito matrix] 处理消息失败：", err.message);
      }
    })();
  });
  await client.start();
  console.log("  同步已开始，等待消息。");
  await new Promise(() => {
  });
}
export {
  runMatrixChannel
};
