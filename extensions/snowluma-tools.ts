/**
 * SnowLuma 工具集（终端与 QQ 频道共用）：
 * - 全部 OneBot action（目录快照）逐一注册为独立工具（模型自主选择）
 * - 精选封装：qq_react / qq_poke / qq_send_like / qq_qzone_post
 * - qq_meme_send / qq_meme_list：表情包库（与频道共用同一个库目录）
 *
 * bot 为模块级单例、按需懒连接；连接失败时工具返回友好错误（不抛出）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import { SnowLumaWebSocketClient, message } from "@snowluma/sdk";
import { loadConfig } from "./util.js";
import { MemeStore } from "../bin/memes.js";
import { homedir } from "node:os";

type Bot = SnowLumaWebSocketClient;

interface SnowLumaAction {
  name: string;
  tool: string;
  summary: string;
  returns: string;
  readOnly: boolean;
  category: string;
  inputSchema: Record<string, unknown>;
}
const SNOWLUMA_ACTIONS: SnowLumaAction[] = JSON.parse(
  readFileSync(join(import.meta.dirname ?? ".", "snowluma-actions.json"), "utf-8"),
) as SnowLumaAction[];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 探测 OneBot 端口（TCP 握手语义与 qq.ts 相同） */
export function probeWs(url: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let hadConnect = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const target = new URL(url.replace(/^ws/, "http"));
    const port = Number(target.port || (url.startsWith("wss") ? 443 : 80));
    const socket = net.createConnection({ host: target.hostname, port }, () => {
      hadConnect = true;
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET ${target.pathname || "/"} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    const timer = setTimeout(() => done(hadConnect), timeoutMs);
    socket.on("data", (d) => {
      if (/^HTTP\/\d\.\d \d{3}/.test(d.toString("latin1"))) done(true);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      done(hadConnect || err.code === "ECONNRESET" || err.code === "EPIPE");
    });
    socket.on("close", () => done(hadConnect));
  });
}

// ── 共享 bot 单例（终端按需懒连接） ─────────────────────────────

let sharedBot: Bot | null = null;
let connecting: Promise<boolean> | null = null;

function ensureBot(): Bot {
  if (sharedBot) return sharedBot;
  const ch = loadConfig().channels.qq;
  sharedBot = new SnowLumaWebSocketClient({
    url: ch.url,
    accessToken: ch.accessToken || undefined,
    reconnect: true,
  });
  return sharedBot;
}

/** 确保连接可用；最多重试 3 次（每次间隔 2s），失败返回 null */
async function ensureConnected(): Promise<Bot | null> {
  const bot = ensureBot();
  if (bot.isConnected) return bot;
  if (!connecting) {
    connecting = (async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await bot.connect();
          return true;
        } catch {
          await sleep(2000);
        }
      }
      return false;
    })().finally(() => {
      connecting = null;
    });
  }
  return (await connecting) ? bot : null;
}

async function callBot(action: string, params: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const bot = await ensureConnected();
  if (!bot) return { ok: false, error: "SnowLuma 未连接（确认 QQ 频道已启用且 SnowLuma 在运行）" };
  try {
    return { ok: true, result: await bot.raw(action, params) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 表情包库单例（与 QQ 频道共用同一目录） */
let memeStore: MemeStore | null = null;
function getMemeStore(): MemeStore {
  if (!memeStore) {
    const dir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "dito", "memes");
    memeStore = new MemeStore(dir);
  }
  return memeStore;
}

/** SnowLuma 全量工具扩展工厂（终端插件用；QQ 频道进程跳过此插件、用自己的带依赖版本） */
export function createSnowLumaToolsExtension(): (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void {
  const memes = getMemeStore();
  return (pi) => {
    // 1) 全量 OneBot action
    for (const action of SNOWLUMA_ACTIONS) {
      const summary = action.summary + (action.returns ? ` 返回：${action.returns}` : "");
      const caution = action.readOnly ? "只读动作，可放心调用" : "会改动状态，调用前先与对方/主人确认";
      pi.registerTool({
        name: `snowluma_${action.tool}`,
        label: action.summary.slice(0, 24),
        description: `[SnowLuma/${action.category || "OneBot"}] ${summary}（${caution}）`,
        parameters: action.inputSchema as never,
        executionMode: action.readOnly ? undefined : "sequential",
        async execute(_id, params) {
          const r = await callBot(action.name, (params ?? {}) as Record<string, unknown>);
          return {
            content: [{ type: "text", text: JSON.stringify(r, null, 2).slice(0, 8000) }],
          };
        },
      });
    }

    // 2) 精选封装
    pi.registerTool({
      name: "qq_react",
      label: "表情回应群消息",
      description:
        "给一条 QQ 群消息贴表情回应（消息情绪的轻量参与）。" +
        "注意：表情回应仅群聊可用，私聊不支持（QQ 协议限制）。" +
        "根据消息情绪挑表情：认同/没问题 → 124 OK 手势，赞/厉害 → 398 超级ok，" +
        "认同/开心 → 13 呲牙，好笑 → 28 偷笑，无语 → 32 疑问，感动/难过 → 5 流泪，" +
        "佩服 → 4 得意，害羞 → 6 害羞。不要频繁使用，一条消息最多回应一次。",
      parameters: Type.Object({
        message_id: Type.Number({ description: "要回应的消息 id" }),
        emoji_id: Type.String({ description: "QQ 系统表情 ID（如 13 呲牙、28 偷笑、32 疑问）" }),
        set: Type.Optional(Type.Boolean({ description: "false = 取消回应，默认 true" })),
      }),
      async execute(_id, params) {
        const r = await callBot("set_msg_emoji_like", {
          message_id: params.message_id,
          emoji_id: String(params.emoji_id),
          set: params.set !== false,
        });
        return { content: [{ type: "text", text: r.ok ? "回应了" : `回应失败：${r.error}` }] };
      },
    });

    pi.registerTool({
      name: "qq_poke",
      label: "戳一戳",
      description: "在 QQ 上戳一戳某人。私聊传 user_id，群聊传 group_id + user_id。被别人戳了或想调侃朋友时用。",
      parameters: Type.Object({
        user_id: Type.Number({ description: "要戳的 QQ 号" }),
        group_id: Type.Optional(Type.Number({ description: "群号；不传则戳好友" })),
      }),
      async execute(_id, params) {
        const action = params.group_id ? "group_poke" : "friend_poke";
        const args = params.group_id
          ? { group_id: params.group_id, user_id: params.user_id }
          : { user_id: params.user_id };
        const r = await callBot(action, args);
        return { content: [{ type: "text", text: r.ok ? "戳了" : `戳失败：${r.error}` }] };
      },
    });

    pi.registerTool({
      name: "qq_send_like",
      label: "QQ 点赞",
      description: "给某个 QQ 号点赞（赞名片，每天有次数上限）。",
      parameters: Type.Object({
        user_id: Type.Number({ description: "QQ 号" }),
        times: Type.Optional(Type.Number({ description: "次数，默认 1，最多 10" })),
      }),
      async execute(_id, params) {
        const r = await callBot("send_like", { user_id: params.user_id, times: Math.min(10, Math.max(1, params.times ?? 1)) });
        return { content: [{ type: "text", text: r.ok ? "赞了" : `点赞失败：${r.error}` }] };
      },
    });

    pi.registerTool({
      name: "qq_qzone_post",
      label: "发QQ空间说说",
      description:
        "发一条主人的 QQ 空间说说（走 SnowLuma 原生 send_qzone_msg）。" +
        "只应在主人明确要求发空间时使用，内容与主人确认过再发。可用 images 传图片。",
      parameters: Type.Object({
        content: Type.String({ description: "说说正文" }),
        images: Type.Optional(Type.Array(Type.String(), { description: "图片（file:// http:// base64://），可选" })),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        const r = await callBot("send_qzone_msg", {
          content: params.content,
          ...(params.images?.length ? { images: params.images } : {}),
        });
        return {
          content: [
            { type: "text", text: r.ok ? `说说已发出去：${JSON.stringify(r.result).slice(0, 300)}` : `发空间失败：${r.error}` },
          ],
        };
      },
    });

    pi.registerTool({
      name: "qq_meme_send",
      label: "发表情包",
      description:
        "从偷来的表情包库里挑一张发送。不传任何参数 = 全库随机发一张。" +
        "想精准表达情绪时传 emotion（搞笑/无语/认可/生气…）或 query 内容关键词（如 猫、摆烂、鼓掌）；" +
        "没有匹配的也会全库随机兜底。group_id 和 user_id 二选一，指定发到哪个聊天。",
      parameters: Type.Object({
        emotion: Type.Optional(Type.String({ description: "想要的情绪：开心/搞笑/无语/生气/惊讶/认可/无奈 等" })),
        query: Type.Optional(Type.String({ description: "内容关键词，如 猫、干饭" })),
        group_id: Type.Optional(Type.Number({ description: "发到群聊" })),
        user_id: Type.Optional(Type.Number({ description: "发到私聊" })),
      }),
      async execute(_id, params) {
        const entry = memes.pick(params.emotion, params.query);
        if (!entry) return { content: [{ type: "text", text: "表情包库还是空的，等群友发图我再偷" }] };
        const seg = message.image(`base64://${readFileSync(memes.filePath(entry)).toString("base64")}`);
        if (params.group_id) await (await ensureConnected())?.sendGroupMessage(params.group_id, [seg]);
        else if (params.user_id) await (await ensureConnected())?.sendPrivateMessage(params.user_id, [seg]);
        else return { content: [{ type: "text", text: "没说发到哪：传 group_id 或 user_id" }] };
        return { content: [{ type: "text", text: `已发表情包：${entry.emotion}「${entry.desc}」` }] };
      },
    });

    pi.registerTool({
      name: "qq_meme_list",
      label: "查看表情包库",
      description: "列出偷来的表情包库存（情绪、内容、来源）。",
      parameters: Type.Object({}),
      async execute() {
        const list = memes.list();
        if (list.length === 0) return { content: [{ type: "text", text: "表情包库是空的" }] };
        const lines = list.map((e) => `- ${e.emotion}「${e.desc}」标签:${e.tags.join("/")}（来源 ${e.source}）`);
        return { content: [{ type: "text", text: `库存 ${list.length} 张：\n${lines.join("\n")}`.slice(0, 3000) }] };
      },
    });
  };
}
