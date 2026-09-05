/**
 * Dito Matrix 频道：通过官方 matrix-js-sdk 连接 Matrix homeserver。
 *
 * 用法：dito matrix（需先在 config 的 channels.matrix 里启用，
 * 填 homeserver + accessToken——Element 里：设置 → 帮助与关于 → 高级 → Access Token）
 *
 * - 自动加入受邀房间；每个房间一个独立 pi 会话（跨进程持久）
 * - 任务进行中再收到消息：pi 的 followUp 队列自动排队
 * - 说明：走普通明文房间消息；加密房间需要 E2EE 装置验证，暂不支持
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { createClient, type MatrixClient } from "matrix-js-sdk";
import { loadConfig, type MatrixChannelConfig } from "../extensions/util.js";
import { openChannelSession } from "./session.js";
import { makeChannelChat, applySessionToolPolicy, runWithTaskSlot, type ChannelChat } from "./channel-chat.js";

const CHAT_SESSIONS_DIR = join(
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  "dito",
);

function roomKey(roomId: string): string {
  return `matrix-${roomId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

export async function runMatrixChannel(): Promise<void> {
  const cfg = loadConfig();
  const ch: MatrixChannelConfig = cfg.channels.matrix;
  if (!ch.enabled || !ch.accessToken) {
    console.error("Matrix 频道未启用：在 ~/.pi/agent/dito/config.json 的 channels.matrix 里设 enabled=true 并填 homeserver 与 accessToken。");
    process.exit(1);
  }

  const client: MatrixClient = createClient({ baseUrl: ch.homeserver, accessToken: ch.accessToken });
  const who = await client.whoami();
  const selfId = who.user_id;
  if (!selfId) throw new Error("whoami 没返回 user_id，Access Token 可能无效");

  const chats = new Map<string, ChannelChat>();
  console.log("");
  console.log("  🫧 Dito Matrix 频道已连接");
  console.log("");
  console.log(`  ➜  账号：${selfId}`);
  console.log(`  ➜  服务器：${ch.homeserver}`);
  console.log(`  ➜  房间范围：${ch.rooms.length ? `${ch.rooms.length} 个指定房间` : "所有已加入房间"}`);
  console.log("  按 Ctrl+C 退出。");
  console.log("");

  // 受邀自动加入
  client.on("RoomMember.membership", (_event, member) => {
    if (member.userId === selfId && member.membership === "invite") {
      client.joinRoom(member.roomId).catch((err) => {
        console.error(`[dito matrix] 加入 ${member.roomId} 失败：`, (err as Error).message);
      });
    }
  });

  client.on("room.timeline", (event, _room, toStartOfTimeline, _removed, data) => {
    if (toStartOfTimeline || !data?.liveEvent) return;
    void (async () => {
      try {
        const roomId = event.getRoomId();
        if (!roomId || event.getSender() === selfId) return;
        if (event.getType() !== "m.room.message") return;
        if (ch.rooms.length > 0 && !ch.rooms.includes(roomId)) return;
        const content = event.getContent<{ body?: string; msgtype?: string }>();
        if (content.msgtype !== "m.text") return; // m.notice 等多半是其他机器人/系统消息
        const body = (content.body ?? "").trim();
        if (!body) return;
        const key = roomKey(roomId);
        let chat = chats.get(key);
        if (!chat) {
          const created = await openChannelSession(join(CHAT_SESSIONS_DIR, "matrix-chats.json"), key, undefined, {
    sessionsDir: join(CHAT_SESSIONS_DIR, "matrix-sessions"),
    memoryScope: key,
  });
          applySessionToolPolicy(created.session, false, "dito matrix");
          chat = makeChannelChat(created.session, (reply) => client.sendTextMessage(roomId, reply), "dito matrix");
          chats.set(key, chat);
          console.log(`[dito matrix] 新房间会话：${roomId}（模型 ${created.modelName}）`);
        }
        const senderName = event.sender && event.sender.startsWith("@") ? event.sender.split(":")[0].slice(1) : event.sender;
        await runWithTaskSlot(() =>
          chat.session.prompt(`[Matrix 房间 来自 ${senderName}] ${body}`, {
            streamingBehavior: "followUp",
          }));
      } catch (err) {
        console.error("[dito matrix] 处理消息失败：", (err as Error).message);
      }
    })();
  });

  await client.startClient({ initialSyncLimit: 1 });
  await new Promise<never>(() => {}); // 常驻
}
