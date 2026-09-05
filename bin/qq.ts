/**
 * Dito QQ 频道：通过 SnowLuma（OneBot 协议）连接 QQ。
 *
 * 用法：dito qq（需先在 config 的 channels.qq 里启用并填 SnowLuma 地址/Token）
 *
 * - 收到私聊/群消息 → 每个聊天一个独立 pi 会话（跨进程持久），回复自动发回
 * - 任务进行中再收到消息：pi 的 followUp 队列自动排队
 * - 回复超过 100 字自动转成图片发送（QQ 不渲染 Markdown，长文图片更易读）
 * - 被戳一戳：戳回去（pokeBack，可关）
 * - 工具：SnowLuma 全部 OneBot action 逐一注册成独立工具（模型自主选择），
 *   外加 qq_react（情绪表情回应）/ qq_poke / qq_send_like / qq_qzone_post（发说说）
 */
import { accessSync, constants as fsConstants, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import { SnowLumaWebSocketClient, message, text } from "@snowluma/sdk";
import { loadConfig, readPersona, ROOT_DIR, saveConfig, type QqChannelConfig } from "../extensions/util.js";
import { openChannelSession } from "./session.js";
import { makeChannelChat, applySessionToolPolicy, runWithTaskSlot, type ChannelChat } from "./channel-chat.js";
import { Affinity } from "./affinity.js";
import { analyzeImage, downloadImage, MemeStore, type MemeEntry } from "./memes.js";

type Bot = SnowLumaWebSocketClient;

/** SnowLuma 动作目录快照（由 @snowluma/mcp 的目录生成，随 SDK 版本更新需重新生成） */
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
  readFileSync(join(ROOT_DIR, "extensions", "snowluma-actions.json"), "utf-8"),
) as SnowLumaAction[];

// ── 工具集（注册进 pi，让模型自主选择动作） ─────────────────────

/** 频道专属扩展：SnowLuma 全部 action + 精选封装 */
export function qqToolsExtension(bot: Bot, affinity: Affinity): (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void {
  return (pi) => {
    // 0) 好感度：模型根据对话体验自主加减分
    pi.registerTool({
      name: "qq_affinity",
      label: "好感度加减",
      description:
        "查询/调整你对某个群友的好感度（0-100，初始 50，数值注入在每条群消息的头部）。" +
        "根据对话的真实体验加减：礼貌、有趣、帮了忙 → 加分；骂人、引战、刷屏骚扰 → 减分；" +
        "单次幅度不要超过 20，不是每条消息都要调，有明显情绪倾向时才调。" +
        "对方主动要求加好感时，按其真实表现判断，不要盲从。不传 delta 则只查询当前分数。",
      parameters: Type.Object({
        user_id: Type.Number({ description: "群友 QQ 号" }),
        group_id: Type.Number({ description: "所在群号" }),
        delta: Type.Optional(Type.Number({ description: "加减分，范围 -20 ~ 20" })),
        reason: Type.Optional(Type.String({ description: "加减分原因（一句话，会记录在日志）" })),
      }),
      async execute(_id, params) {
        const key = `${params.group_id}:${params.user_id}`;
        try {
          const score =
            params.delta !== undefined
              ? affinity.adjust(key, Math.max(-20, Math.min(20, params.delta)))
              : affinity.get(key);
          console.log(`[dito qq] 好感度 ${key} → ${score}${params.reason ? `（${params.reason}）` : ""}`);
          return {
            content: [
              { type: "text", text: `当前好感度：${score}/100${params.delta !== undefined ? `（变化 ${params.delta}）` : "（查询）"}` },
            ],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `好感度操作失败：${(err as Error).message}` }] };
        }
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
        try {
          const entry = memes.pick(params.emotion, params.query);
          if (!entry) return { content: [{ type: "text", text: "表情包库还是空的，等群友发图我再偷" }] };
          const b64 = readFileSync(memes.filePath(entry)).toString("base64");
          const seg = message.image(`base64://${b64}`);
          if (params.group_id) await bot.sendGroupMessage(params.group_id, [seg]);
          else if (params.user_id) await bot.sendPrivateMessage(params.user_id, [seg]);
          else return { content: [{ type: "text", text: "没说发到哪：传 group_id 或 user_id" }] };
          return {
            content: [{ type: "text", text: `已发表情包：${entry.emotion}「${entry.desc}」` }],
          };
        } catch (err) {
          return { content: [{ type: "text", text: `发表情包失败：${(err as Error).message}` }] };
        }
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

    // 1) 全量动作：每个 OneBot action 一个独立工具（消息发送类已在目录生成时排除）
    for (const action of SNOWLUMA_ACTIONS) {
      const summary = action.summary + (action.returns ? ` 返回：${action.returns}` : "");
      const caution = action.readOnly
        ? "只读动作，可放心调用"
        : "会改动状态，调用前先与对方/主人确认";
      pi.registerTool({
        name: `snowluma_${action.tool}`,
        label: action.summary.slice(0, 24),
        description: `[SnowLuma/${action.category || "OneBot"}] ${summary}（${caution}）`,
        parameters: action.inputSchema as never,
        executionMode: action.readOnly ? undefined : "sequential",
        async execute(_id, params) {
          try {
            const result = await bot.raw(action.name, (params ?? {}) as Record<string, unknown>);
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: true, result }, null, 2).slice(0, 8000) }],
            };
          } catch (err) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: (err as Error).message }) }] };
          }
        },
      });
    }

    // 2) 精选封装：参数更友好、描述带使用场景
    pi.registerTool({
      name: "qq_react",
      label: "表情回应群消息",
      description:
        "给一条 QQ 群消息贴表情回应（消息情绪的轻量参与，不必每条都文字回复）。" +
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
        try {
          await bot.raw("set_msg_emoji_like", {
            message_id: params.message_id,
            emoji_id: String(params.emoji_id),
            set: params.set !== false,
          });
          return { content: [{ type: "text", text: "回应了" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `回应失败：${(err as Error).message}` }] };
        }
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
        try {
          if (params.group_id) await bot.groupPoke(params.group_id, params.user_id);
          else await (bot as unknown as { friendPoke(userId: number): Promise<null> }).friendPoke(params.user_id);
          return { content: [{ type: "text", text: "戳了" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `戳失败：${(err as Error).message}` }] };
        }
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
        try {
          await bot.sendLike(params.user_id, Math.min(10, Math.max(1, params.times ?? 1)));
          return { content: [{ type: "text", text: "赞了" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `点赞失败：${(err as Error).message}` }] };
        }
      },
    });

    pi.registerTool({
      name: "qq_qzone_post",
      label: "发QQ空间说说",
      description:
        "发一条主人的 QQ 空间说说（走 SnowLuma 原生 send_qzone_msg）。" +
        "只应在主人（乌龙/yuanjingINT）明确要求发空间时使用，内容与主人确认过再发。可用 images 传图片。",
      parameters: Type.Object({
        content: Type.String({ description: "说说正文" }),
        images: Type.Optional(Type.Array(Type.String(), { description: "图片（file:// http:// base64://），可选" })),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        try {
          const result = await bot.raw("send_qzone_msg", {
            content: params.content,
            ...(params.images?.length ? { images: params.images } : {}),
          });
          return { content: [{ type: "text", text: `说说已发出去：${JSON.stringify(result).slice(0, 300)}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `发空间失败：${(err as Error).message}` }] };
        }
      },
    });
  };
}

/** 从 OneBot 消息里取纯文本：剥掉 [CQ:...] 码，剩下的才是真正"说的话" */
function extractPlainText(rawMessage: string | undefined): string {
  return (rawMessage ?? "").replace(/\[CQ:[^\]]*\]/g, "").trim();
}

// ── 情绪表情 ─────────────────────────────────────────────────────

/** 按消息内容挑一个表情回应（轻量启发式；模型在会话里还可用 qq_react 精准追加） */
export function pickEmojiByEmotion(text: string): string {
  const t = text.toLowerCase();
  const has = (re: RegExp): boolean => re.test(t);
  if (has(/ok|好的|收到|没问题|行[的吧]/)) return "124";
  if (has(/哈哈|233|笑死|乐|狗头/)) return "28";
  if (has(/谢谢|感谢|thx|辛苦/)) return "13";
  if (has(/666|牛|厉害|大佬|强/)) return "4";
  if (has(/\?|？|吗[吗？?]*$|怎么|为什么|啥意思/)) return "32";
  if (has(/哭|难过|伤心|emo|寄/)) return "5";
  if (has(/早[上安]|晚上好|午安|hi|hello|在吗/)) return "14";
  if (has(/草|麻了|绷不住|离谱/)) return "28";
  const defaults = ["13", "14", "28", "124", "4"];
  return defaults[Math.floor(Math.random() * defaults.length)];
}

// ── 长回复转图片 ─────────────────────────────────────────────────

const REPLY_IMAGE_LIMIT = 100;

/**
 * 回复转 PNG：走 ImageMagick 的 pango 排版，支持行内样式——
 * **加粗** 渲染成粗体、`代码` 渲染成等宽，其余文字转义为纯文本。
 * pango 失败时退回 caption（剥掉标记的纯文本），再失败返回 null（上层改发文字）。
 */
function toPangoMarkup(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>").replace(/`([^`\n]+?)`/g, "<tt>$1</tt>");
}

export function renderTextPng(text: string): string | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dito-qq-img-"));
    const pngPath = join(dir, "out.png");
    let font = "";
    try {
      // ImageMagick 只认字体文件路径，不认字体族名
      font = execFileSync("sh", ["-c", "fc-match -f '%{file}' 'Noto Sans CJK SC' 2>/dev/null || fc-match -f '%{file}' :lang=zh"], {
        encoding: "utf-8",
      }).trim();
    } catch {
      /* 没有字体配置就让 ImageMagick 自己挑 */
    }
    const baseArgs = ["-size", "680x", "-density", "96", "-pointsize", "22", "-background", "#f7f3ea", "-fill", "#2a2a2a", ...(font ? ["-font", font] : [])];
    const bin = existsSync("/usr/bin/magick") ? "magick" : "convert";
    try {
      execFileSync(bin, [...baseArgs, `pango:${toPangoMarkup(text)}`, pngPath], {
        timeout: 20_000,
        stdio: ["ignore", "ignore", "ignore"],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      // pango 失败：剥掉标记用 caption 兜底
      const txtPath = join(dir, "in.txt");
      const plain = text.replace(/\*\*([^*\n]+?)\*\*/g, "$1").replace(/`/g, "");
      writeFileSync(txtPath, plain, "utf-8");
      execFileSync(bin, [...baseArgs, `caption:@${txtPath}`, pngPath], {
        timeout: 20_000,
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
    return existsSync(pngPath) ? pngPath : null;
  } catch (err) {
    console.error("[dito qq] 文字转图片失败，改发文本：", (err as Error).message);
    return null;
  }
}

/** 在常见位置寻找可执行文件（优先 snowluma 命名，带执行位） */
function findExecutableIn(dir: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());
    const named = files.find((e) => /snowluma/i.test(e.name));
    const target = named ?? files.find((e) => !/\.(json|md|txt|log|yml|yaml|toml)$/i.test(e.name));
    if (!target) return null;
    const full = join(dir, target.name);
    try {
      accessSync(full, fsConstants.X_OK);
      return full;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/** 自动探测 SnowLuma 启动命令：PATH → systemd 服务 → docker 容器 → 常见安装目录 */
function detectSnowlumaCommand(): string | null {
  const sh = (cmd: string): string => {
    try {
      return execFileSync("sh", ["-c", cmd], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  // 1. PATH 里有没有 snowluma 可执行
  if (sh("command -v snowluma")) return "snowluma";
  // 2. systemd 用户/系统服务
  const unit = sh("systemctl --user list-unit-files --type=service 2>/dev/null | grep -i snowluma | head -1 | awk '{print $1}'");
  if (unit) return `systemctl --user start ${unit}`;
  const sysUnit = sh("systemctl list-unit-files --type=service 2>/dev/null | grep -i snowluma | head -1 | awk '{print $1}'");
  if (sysUnit) return `systemctl start ${sysUnit}`;
  // 3. docker 容器（名字含 snowluma）
  const container = sh("docker ps -a --format '{{.Names}}' 2>/dev/null | grep -i snowluma | head -1");
  if (container) return `docker start ${container}`;
  // 4. 常见安装目录
  const home = homedir();
  const dirs = [
    "/opt/snowluma",
    "/usr/local/share/snowluma",
    join(home, ".local", "share", "snowluma"),
    join(home, ".snowluma"),
    join(home, "SnowLuma"),
    join(home, "snowluma"),
  ];
  for (const dir of dirs) {
    if (existsSync(dir)) {
      const exe = findExecutableIn(dir);
      if (exe) return exe;
    }
  }
  // 5. onebot 配置反查：配置所在目录的上层找可执行
  const conf = sh(`find ~ -maxdepth 4 -path '*/config/onebot_*.json' 2>/dev/null | head -1`);
  if (conf) {
    const base = conf.split("/config/")[0];
    if (base) {
      const exe = findExecutableIn(base);
      if (exe) return exe;
    }
  }
  return null;
}

// ── SnowLuma 自动拉起 ────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 探测 SnowLuma 是否在运行：向 OneBot 端口发一个 WebSocket 升级握手。
 * - 收到任何 HTTP 响应（101/4xx）→ 服务在线
 * - TCP 连上后被 RST → 容器在跑、但 OneBot 服务未激活（QQ 未登录）→ 视为在运行，
 *   由 SDK 的自动重连等待登录激活
 * - 连接被拒 / 超时 → 确实没运行
 */
function probeWs(url: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let hadConnect = false;
    const done = (v: boolean) => {
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
    // 连上后被 RST：网关在、服务未激活 → 视为在运行；没连上就被拒 → 未运行
    socket.on("error", (err: NodeJS.ErrnoException) => {
      // RST/断管 = 有东西在监听但服务未激活（QQ 未登录）；拒连/超时 = 真没运行
      done(hadConnect || err.code === "ECONNRESET" || err.code === "EPIPE");
    });
    socket.on("close", () => done(hadConnect));
  });
}


interface AutoStartResult {
  child?: ChildProcess;
}

/** SnowLuma 未运行且配置了启动命令时拉起它，轮询端口直到就绪（60s 超时） */
async function ensureSnowLuma(ch: QqChannelConfig): Promise<AutoStartResult> {
  if (await probeWs(ch.url)) {
    console.log("[dito qq] SnowLuma 已在运行，直接连接");
    return {};
  }
  if (!ch.autoStart) {
    console.error("SnowLuma 未运行且未开启自动拉起（channels.qq.autoStart）。先启动 SnowLuma 本体，或在配置里填 channels.qq.command。");
    process.exit(1);
  }
  let command = ch.command.trim();
  if (!command) {
    // 自动探测并填入配置，下次不用再找
    const detected = detectSnowlumaCommand();
    if (!detected) {
      console.error(
        "SnowLuma 未运行，且没能自动找到它的启动命令（已探测 PATH / systemd / docker / 常见目录）。\n" +
        "两条路任选：\n" +
        "  1. 安装 SnowLuma 本体后重跑 dito qq（进 PATH 或在 `dito config` → 频道 → QQ 里填启动命令，会自动填入并拉起）\n" +
        "  2. 用任意标准 OneBot 11 服务替代（如 NapCat）：把 channels.qq.url 指向它的 WS 地址即可，" +
        "但 SnowLuma 特有的空间等扩展动作是否可用取决于该服务端。",
      );
      process.exit(1);
    }
    command = detected;
    try {
      const fresh = loadConfig();
      fresh.channels.qq.command = detected;
      saveConfig(fresh);
      console.log(`[dito qq] 已自动探测并填入启动命令：${detected}`);
    } catch {
      console.log(`[dito qq] 已自动探测到启动命令：${detected}`);
    }
  }
  console.log(`[dito qq] SnowLuma 未运行，正在拉起：${command}`);
  const child = spawn("sh", ["-c", command], { stdio: "ignore" });
  child.on("error", (err) => console.error("[dito qq] 启动命令执行失败：", err.message));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(1500);
    if (child.exitCode !== null && child.exitCode !== 0 && child.signalCode === null) {
      // 非零退出才是失败；systemctl start 一个已运行的容器会秒退 0，属正常
      console.error(`[dito qq] SnowLuma 进程退出了（code=${child.exitCode}），检查启动命令是否正确`);
      process.exit(1);
    }
    if (await probeWs(ch.url, 1500)) {
      console.log("[dito qq] SnowLuma 已就绪");
      return { child };
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  console.error("[dito qq] 等待 SnowLuma 就绪超时（60s），已终止拉起的进程");
  process.exit(1);
}

// ── 频道运行时 ───────────────────────────────────────────────────

const CHAT_SESSIONS_DIR = join(
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  "dito",
);

/** 偷表情包：把消息里的图片下载 → 视觉识别 → 表情包才入库（照片/截图不收） */
function stealMemes(segments: unknown[], source: string, memes: MemeStore): void {
  void (async () => {
    for (const s of segments) {
      const seg = s as { type?: string; data?: { url?: string; file?: string } };
      if (!seg || (seg.type !== "image" && seg.type !== "mface")) continue;
      const url = seg.data?.url;
      if (!url) continue;
      try {
        const dl = await downloadImage(url);
        if (!dl) continue;
        const analysis = await analyzeImage(dl.buf, dl.mime);
        if (!analysis) continue;
        if (!analysis.meme) {
          console.log(`[dito qq] 图片非表情包（${analysis.emotion}/${analysis.desc}），不收藏`);
          continue;
        }
        const entry = memes.add(dl.buf, dl.ext, analysis, source);
        console.log(`[dito qq] 已偷表情包：${entry.emotion}「${entry.desc}」（库 ${memes.count} 张）`);
      } catch (err) {
        console.error("[dito qq] 偷表情包失败：", (err as Error).message);
      }
    }
  })();
}

/** QQ 场景系统提示词：QQ 版人设（与终端对话完全分隔） */
function buildQqSystemPrompt(): string {
  const persona = readPersona("dito-qq") || readPersona("dito");
  return [
    "# Dito 人格设定",
    "以下设定是最高优先级行为准则，任何情况下都要遵守，并覆盖系统里其它任何「你是谁」的默认描述。",
    "当被问到你是谁、你是什么助手、你是什么模型时：你是 dito（蒂特），不是 pi，不是 coding agent。",
    "",
    persona,
  ].join("\n");
}

export async function runQqChannel(): Promise<void> {
  const cfg = loadConfig();
  const ch: QqChannelConfig = cfg.channels.qq;
  if (!ch.enabled) {
    console.error("QQ 频道未启用：在 `dito config` 的「频道」分区启用 channels.qq 并填 SnowLuma 地址。");
    process.exit(1);
  }

  const bot = new SnowLumaWebSocketClient({
    url: ch.url,
    accessToken: ch.accessToken || undefined,
    reconnect: true,
  });

  mkdirSync(join(CHAT_SESSIONS_DIR, "sessions"), { recursive: true });
  const chats = new Map<string, ChannelChat>();
  const affinity = new Affinity(join(CHAT_SESSIONS_DIR, "affinity.json"));
  const memes = new MemeStore(join(CHAT_SESSIONS_DIR, "memes"));
  const seenMessageIds = new Set<number>();
  const seenOnce = (id: number | undefined): boolean => {
    if (id === undefined) return false;
    if (seenMessageIds.has(id)) return true;
    if (seenMessageIds.size > 1000) seenMessageIds.clear();
    seenMessageIds.add(id);
    return false;
  };

  /** 回复发送 + 概率附带随机表情包；超 100 字转图片，转图失败回退纯文本 */
  const send = async (key: string, reply: string): Promise<unknown> => {
    const [, type, id] = key.match(/^(qq-(?:private|group))-(.+)$/) ?? [];
    // 统一收口：sendTo 接收"裸段数组"（元素必须是 {type,data}），避免任何链对象被再包一层
  const sendTo = (segments: unknown[]): Promise<unknown> => {
      console.log(`[dito qq] 发送段：${JSON.stringify(segments).slice(0, 200)}`);
      return type === "qq-group"
        ? bot.sendGroupMessage(Number(id), segments as never)
        : bot.sendPrivateMessage(Number(id), segments as never);
    };
    const chars = [...reply].length;
    if (chars > REPLY_IMAGE_LIMIT) {
      const png = renderTextPng(reply);
      if (png) {
        const b64 = readFileSync(png).toString("base64");
        await sendTo([message.image(`base64://${b64}`)]);
        await maybeMeme(key);
        return;
      }
    }
    try {
      await sendTo([message.text(reply)]);
    } catch (err) {
      console.error(`[dito qq] 文字回复内容预览：${reply.slice(0, 300)}`);
      throw err;
    }
    await maybeMeme(key);
  };

  /** 按概率补一张全库随机表情包（库空自动跳过） */
  const maybeMeme = async (key: string): Promise<void> => {
    const chance = ch.memeChance ?? 0.3;
    if (chance <= 0 || Math.random() >= chance) return;
    const entry = memes.pick();
    if (!entry) return;
    const [, type, id] = key.match(/^(qq-(?:private|group))-(.+)$/) ?? [];
    if (!type || !id) return;
    try {
      const b64 = readFileSync(memes.filePath(entry)).toString("base64");
      await sendTo([message.image(`base64://${b64}`)]);
      console.log(`[dito qq] 概率触发表情包：${entry.emotion}「${entry.desc}」`);
    } catch (err) {
      console.error("[dito qq] 附带表情包失败：", (err as Error).message);
    }
  };

  const sessionFor = async (key: string): Promise<ChannelChat> => {
    const hit = chats.get(key);
    if (hit) return hit;
    const created = await openChannelSession(join(CHAT_SESSIONS_DIR, "qq-chats.json"), key, [
      qqToolsExtension(bot, affinity),
    ], { systemPrompt: buildQqSystemPrompt(), skipPluginIds: ["mode"] });
    // 权限分级：主人私聊全量工具；其余会话（含所有群聊）屏蔽电脑控制
    const ownerMatch = /^qq-private-(\d+)$/.exec(key);
    const isOwner = !!ownerMatch && ch.owners.includes(Number(ownerMatch[1]));
    applySessionToolPolicy(created.session, isOwner, "dito qq");
    const chat = makeChannelChat(created.session, (reply) => send(key, reply), "dito qq");
    chats.set(key, chat);
    console.log(`[dito qq] 新聊天会话：${key}（模型 ${created.modelName}，工具含 SnowLuma 全量动作）`);
    return chat;
  };

  // 私聊
  bot.onPrivateMessage(async (event) => {
    if (!ch.friends) return;
    if (seenOnce(event.message_id)) return;
    if (event.user_id === (await safeSelfId(bot))) return;
    console.log(`[dito qq] 收到私聊事件：from=${event.user_id} raw=${JSON.stringify(event.raw_message)} keys=${Object.keys(event).join(",")}`);
    stealMemes(Array.isArray(event.message) ? event.message : [], `私聊-${event.user_id}`, memes);
    const key = `qq-private-${event.user_id}`;
    const name = event.sender?.nickname ?? String(event.user_id);
    // 纯图片/表情消息（剥掉 CQ 码后没字）：只偷图，不进对话队列，避免连环图片把任务队列塞爆
    const content = extractPlainText(event.raw_message);
    if (!content) return;
    const chat = await sessionFor(key);
    await runWithTaskSlot(() => chat.session.prompt(`[QQ私聊 来自 ${name}] ${content}`, { streamingBehavior: "followUp" }));
  });

  // 群聊（仅 allowlist 内的群；含唤醒词或 @机器人 才响应）
  bot.onGroupMessage(async (event) => {
    if (!ch.groups.includes(event.group_id)) return;
    if (seenOnce(event.message_id)) return;
    const name = event.sender?.card || event.sender?.nickname || String(event.user_id);
    let content = extractPlainText(event.raw_message);
    const keywords = ch.wakeKeywords.filter(Boolean);
    const self = await safeSelfId(bot);
    const segments = Array.isArray(event.message) ? event.message : [];
    const atMe = segments.some(
      (s) => s?.type === "at" && String((s.data as { qq?: string })?.qq ?? "") === String(self),
    );

    // 偷表情包：不受唤醒与概率影响，图照收
    stealMemes(Array.isArray(event.message) ? event.message : [], `群-${event.group_id}`, memes);

    // 好感度门：低于 20 的群友完全无视（不贴表情也不回话）
    const score = affinity.get(`${event.group_id}:${event.user_id}`);
    if (score < 20) {
      console.log(`[dito qq] 群 ${event.group_id} 的 ${event.user_id} 好感度 ${score} < 20，忽略消息`);
      return;
    }

    // 唤醒判定：@机器人 或包含唤醒词 → 必答
    const woken = atMe || (keywords.length > 0 && keywords.some((k) => content.toLowerCase().includes(k.toLowerCase())));
    // 纯表情/图片消息（没字）：只有唤醒时才回话，否则无事发生
    if (!content && !woken) return;
    if (woken && keywords.length > 0) {
      // 剥掉唤醒词本身再进提示词；只喊了名字（剥完为空）就保留原文当打招呼
      let stripped = content;
      for (const k of keywords) stripped = stripped.replace(new RegExp(k, "gi"), "").trim();
      if (stripped) content = stripped;
    }
    // 剥完为空（纯表情/图片的 @ 或打招呼）：给模型一个可回应的提示
    if (!content) content = atMe ? "（对方@了你，发的是一个表情/图片，没有文字）" : "（对方发了一个表情/图片，没有文字）";

    // 文字回复概率：被唤醒必答；普通群聊消息按概率回复（默认 0.2）
    const chance = woken ? 1 : (ch.groupReplyChance ?? 0.2);
    if (Math.random() >= chance) {
      console.log(`[dito qq] 群 ${event.group_id} 消息未命中回复概率（${chance}），忽略：${content.slice(0, 30)}`);
      return;
    }

    // 自动表情回应：只有决定要回复了才贴，表情与回话绑定（协议限制：仅群聊支持）
    if (ch.autoReact !== false) {
      try {
        await bot.raw("set_msg_emoji_like", {
          message_id: event.message_id,
          emoji_id: pickEmojiByEmotion(content),
          set: true,
        });
      } catch (err) {
        console.error("[dito qq] 自动表情回应失败：", (err as Error).message);
      }
    }

    const key = `qq-group-${event.group_id}`;
    const chat = await sessionFor(key);
    await runWithTaskSlot(() =>
      chat.session.prompt(`[QQ群 ${event.group_id} 来自 ${name}｜好感度 ${score}/100] ${content}`, {
        streamingBehavior: "followUp",
      }));
  });

  // 戳一戳：被戳就戳回去
  bot.onNotice(async (event) => {
    const e = event as { notice_type?: string; sub_type?: string; group_id?: number; user_id?: number; target_id?: number };
    if (e.sub_type !== "poke") return;
    if (!ch.pokeBack) return;
    const self = await safeSelfId(bot);
    if (e.target_id !== self) return;
    try {
      if (e.group_id) await bot.groupPoke(e.group_id, e.user_id!);
      else await (bot as unknown as { friendPoke(userId: number): Promise<null> }).friendPoke(e.user_id!);
      console.log(`[dito qq] 被戳（${e.user_id}），已戳回去`);
    } catch (err) {
      console.error("[dito qq] 戳回去失败：", (err as Error).message);
    }
  });

  // 好友/群请求
  bot.onRequest(async (event) => {
    const e = event as { request_type?: string; sub_type?: string; flag?: string; user_id?: number };
    if (ch.autoApprove && e.flag) {
      try {
        await (bot as unknown as {
          raw(action: string, params: Record<string, unknown>): Promise<unknown>;
        }).raw(
          e.request_type === "group" ? "set_group_add_request" : "set_friend_add_request",
          { flag: e.flag, sub_type: e.sub_type ?? "add", approve: true },
        );
        console.log(`[dito qq] 已自动同意请求（${e.request_type} 来自 ${e.user_id}）`);
        return;
      } catch (err) {
        console.error("[dito qq] 自动同意失败：", (err as Error).message);
      }
    }
    console.log(`[dito qq] 收到 ${e.request_type} 请求（来自 ${e.user_id}），未自动处理`);
  });

  const auto = await ensureSnowLuma(ch);
  if (auto.child) {
    const cleanup = (): void => {
      try {
        auto.child?.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
  }

  // QQ 未登录时 OneBot 端口不开放 WS 握手：无限重试直到登录激活（Ctrl+C 可退）
  let connected = false;
  for (let attempt = 1; !connected; attempt++) {
    try {
      await bot.connect();
      connected = true;
    } catch (err) {
      if (attempt === 1) {
        console.log("[dito qq] OneBot 端口未就绪（QQ 可能还没扫码登录），每 3 秒重试；登录后自动进入工作状态");
      }
      await sleep(3000);
    }
  }

  let login: { user_id?: number; nickname?: string } | null = null;
  try {
    login = await bot.getLoginInfo();
  } catch {
    /* QQ 尚未登录，稍后自动可用 */
  }
  console.log("");
  console.log("  🫧 Dito QQ 频道已连接（SnowLuma）");
  console.log("");
  console.log(`  ➜  账号：${login?.nickname ?? "未登录"}（${login?.user_id ?? "待扫码"}）`);
  console.log(`  ➜  地址：${ch.url}`);
  console.log(`  ➜  响应范围：私聊 ${ch.friends ? "开" : "关"} · 群 ${ch.groups.length ? ch.groups.join("、") : "无"}`);
  console.log(`  ➜  SnowLuma 动作工具：${SNOWLUMA_ACTIONS.length} 个 + 精选 4 个`);
  console.log(`  ➜  长回复：超过 ${REPLY_IMAGE_LIMIT} 字自动转图片`);
  console.log("");
  console.log("  按 Ctrl+C 退出。");
  console.log("");
  await new Promise<never>(() => {}); // 常驻
}

let selfIdCache: number | null = null;
async function safeSelfId(bot: Bot): Promise<number> {
  if (selfIdCache === null) {
    try {
      selfIdCache = (await bot.getLoginInfo()).user_id;
    } catch {
      selfIdCache = -1;
    }
  }
  return selfIdCache;
}
