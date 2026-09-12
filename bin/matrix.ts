/**
 * Dito Matrix 频道：matrix-bot-sdk + Rust E2EE。
 *
 * 支持解密加密房间消息（Element 私聊默认加密）：设备密钥经 RustSdkCryptoStorageProvider
 * 持久化于 ~/.pi/agent/dito/matrix-crypto-store/，跨重启稳定。
 *
 * 用法：dito matrix（需先在 config 的 channels.matrix 里启用，
 * 填 homeserver + accessToken）
 *
 * - 自动加入受邀房间；每个房间一个独立 pi 会话（跨进程持久）
 * - 任务进行中再收到消息：pi 的 followUp 队列自动排队
 * - bot 上线前已加密的历史消息因 megolm 前向保密无法解密；上线后新消息均可解密
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import {
  MatrixClient,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
  LogService,
  LogLevel,
} from "matrix-bot-sdk";
import { loadConfig, type MatrixChannelConfig } from "../extensions/util.js";
import { openChannelSession } from "./session.js";
import { makeChannelChat, applySessionToolPolicy, runWithTaskSlot, type ChannelChat } from "./channel-chat.js";

const CHAT_SESSIONS_DIR = join(
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  "dito",
);
const CRYPTO_STORE_DIR = join(CHAT_SESSIONS_DIR, "matrix-crypto-store");

function roomKey(roomId: string): string {
  return `matrix-${roomId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

/** 主人判定（对齐 QQ 通道语义）：DM 且成员仅 bot + owners 则全量工具，其余会话受限 */
async function isOwnerRoom(client: MatrixClient, roomId: string, ch: MatrixChannelConfig): Promise<boolean> {
  const owners = ch.owners ?? [];
  if (owners.length === 0) return false;
  try {
    const members = Object.keys(await client.getJoinedRoomMembers(roomId));
    return members.every((m) => m === client.userId || owners.includes(m))
      && members.some((m) => owners.includes(m));
  } catch {
    return false;
  }
}

export async function runMatrixChannel(): Promise<void> {
  const cfg = loadConfig();
  const ch: MatrixChannelConfig = cfg.channels.matrix;
  if (!ch.enabled || !ch.accessToken) {
    console.error("Matrix 频道未启用：在 ~/.pi/agent/dito/config.json 的 channels.matrix 里设 enabled=true 并填 homeserver 与 accessToken。");
    process.exit(1);
  }

  LogService.setLevel(LogLevel.WARN); // 收敛日志噪音，CryptoClient 的 info 级 deviceId 会保留

  const client = new MatrixClient(
    ch.homeserver,
    ch.accessToken,
    new SimpleFsStorageProvider(join(CHAT_SESSIONS_DIR, "matrix-bot-state.json")),
    new RustSdkCryptoStorageProvider(CRYPTO_STORE_DIR),
  );
  mkdirSync(CRYPTO_STORE_DIR, { recursive: true });

  // 受邀自动加入
  AutojoinRoomsMixin.setupOnClient(client);

  const selfId = await client.getUserId();

  const chats = new Map<string, ChannelChat>();
  console.log("");
  console.log("  Dito Matrix 频道已连接（E2EE 已启用）");
  console.log("");
  console.log(`  ➜  账号：${selfId}`);
  console.log(`  ➜  服务器：${ch.homeserver}`);
  console.log(`  ➜  房间范围：${ch.rooms.length ? `${ch.rooms.length} 个指定房间` : "所有已加入房间"}`);
  console.log("  按 Ctrl+C 退出。");
  console.log("");

  // 加密消息由 CryptoClient 解密后以明文 m.room.message 形态进入 room.message
  client.on("room.message", (roomId: string, event: Record<string, any>) => {
    void (async () => {
      try {
        const content = event?.content;
        if (!content || event.sender === selfId) return;
        if (ch.rooms.length > 0 && !ch.rooms.includes(roomId)) return;
        if (content.msgtype !== "m.text") return; // m.notice / m.emote 等暂不处理
        const body = (content.body ?? "").trim();
        if (!body) return;
        const key = roomKey(roomId);
        let chat = chats.get(key);
        if (!chat) {
          const created = await openChannelSession(join(CHAT_SESSIONS_DIR, "matrix-chats.json"), key, undefined, {
            sessionsDir: join(CHAT_SESSIONS_DIR, "matrix-sessions"),
            memoryScope: key,
          });
          applySessionToolPolicy(created.session, await isOwnerRoom(client, roomId, ch), "dito matrix");
          chat = makeChannelChat(created.session, (reply) =>
            client.sendEvent(roomId, "m.room.message", { msgtype: "m.text", body: reply }), "dito matrix");
          chats.set(key, chat);
          console.log(`[dito matrix] 新房间会话：${roomId}（模型 ${created.modelName}）`);
        }
        const senderName = event.sender && event.sender.startsWith("@") ? event.sender.split(":")[0].slice(1) : event.sender;
        const timer = setTimeout(() => {
          void chat!.session.abort().catch(() => {});
        }, 180_000);
        try {
          await runWithTaskSlot(() =>
            chat!.session.prompt(`[Matrix 房间 来自 ${senderName}] ${body}`, {
              streamingBehavior: "followUp",
            }));
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        console.error("[dito matrix] 处理消息失败：", (err as Error).message);
      }
    })();
  });

  // start() 内部自动 prepare E2EE：注册设备密钥、上传 keys
  await client.start();
  console.log("  同步已开始，等待消息。");
  await new Promise<never>(() => {}); // 常驻
}
