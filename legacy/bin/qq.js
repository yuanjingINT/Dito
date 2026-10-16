import { accessSync, constants as fsConstants, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import { SnowLumaWebSocketClient, message } from "@snowluma/sdk";
import { loadConfig, readPersona, ROOT_DIR, saveConfig, ditoChannelDir } from "../extensions/util.js";
import { openChannelSession } from "./session.js";
import { makeChannelChat, applySessionToolPolicy, runWithTaskSlot } from "./channel-chat.js";
import { Affinity } from "./affinity.js";
import { analyzeImage, downloadImage, MemeStore } from "./memes.js";
import { probeWs } from "../extensions/snowluma-tools.js";
import { DitoReEngine, looksLikeDitoConversation } from "../extensions/plugins/dito-re.js";
const SNOWLUMA_ACTIONS = JSON.parse(
  readFileSync(join(ROOT_DIR, "extensions", "snowluma-actions.json"), "utf-8")
);
function qqToolsExtension(bot, affinity, memes) {
  return (pi) => {
    pi.registerTool({
      name: "qq_affinity",
      label: "好感度加减",
      description: "查询/调整你对某个群友的好感度（0-100，初始 50，数值注入在每条群消息的头部）。根据对话的真实体验加减：礼貌、有趣、帮了忙 → 加分；骂人、引战、刷屏骚扰 → 减分；单次幅度不要超过 20，不是每条消息都要调，有明显情绪倾向时才调。对方主动要求加好感时，按其真实表现判断，不要盲从。不传 delta 则只查询当前分数。",
      parameters: Type.Object({
        user_id: Type.Number({ description: "群友 QQ 号" }),
        group_id: Type.Number({ description: "所在群号" }),
        delta: Type.Optional(Type.Number({ description: "加减分，范围 -20 ~ 20" })),
        reason: Type.Optional(Type.String({ description: "加减分原因（一句话，会记录在日志）" }))
      }),
      async execute(_id, params) {
        const key = `${params.group_id}:${params.user_id}`;
        try {
          const score = params.delta !== void 0 ? affinity.adjust(key, Math.max(-20, Math.min(20, params.delta))) : affinity.get(key);
          console.log(`[dito qq] 好感度 ${key} → ${score}${params.reason ? `（${params.reason}）` : ""}`);
          return {
            content: [
              { type: "text", text: `当前好感度：${score}/100${params.delta !== void 0 ? `（变化 ${params.delta}）` : "（查询）"}` }
            ]
          };
        } catch (err) {
          return { content: [{ type: "text", text: `好感度操作失败：${err.message}` }] };
        }
      }
    });
    pi.registerTool({
      name: "qq_meme_send",
      label: "发表情包",
      description: "从偷来的表情包库里挑一张发送。不传任何参数 = 全库随机发一张。想精准表达情绪时传 emotion（搞笑/无语/认可/生气…）或 query 内容关键词（如 猫、摆烂、鼓掌）；没有匹配的也会全库随机兜底。group_id 和 user_id 二选一，指定发到哪个聊天。",
      parameters: Type.Object({
        emotion: Type.Optional(Type.String({ description: "想要的情绪：开心/搞笑/无语/生气/惊讶/认可/无奈 等" })),
        query: Type.Optional(Type.String({ description: "内容关键词，如 猫、干饭" })),
        group_id: Type.Optional(Type.Number({ description: "发到群聊" })),
        user_id: Type.Optional(Type.Number({ description: "发到私聊" }))
      }),
      async execute(_id, params) {
        try {
          const entry = memes.pick(params.emotion, params.query);
          if (!entry) return { content: [{ type: "text", text: "表情包库还是空的，等群友发图我再偷" }] };
          const seg = message.image(`base64://${readFileSync(memes.filePath(entry)).toString("base64")}`);
          if (params.group_id) await bot.sendGroupMessage(params.group_id, [seg]);
          else if (params.user_id) await bot.sendPrivateMessage(params.user_id, [seg]);
          else return { content: [{ type: "text", text: "没说发到哪：传 group_id 或 user_id" }] };
          return {
            content: [{ type: "text", text: `已发表情包：${entry.emotion}「${entry.desc}」` }]
          };
        } catch (err) {
          return { content: [{ type: "text", text: `发表情包失败：${err.message}` }] };
        }
      }
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
        return { content: [{ type: "text", text: `库存 ${list.length} 张：
${lines.join("\n")}`.slice(0, 3e3) }] };
      }
    });
    for (const action of SNOWLUMA_ACTIONS) {
      const summary = action.summary + (action.returns ? ` 返回：${action.returns}` : "");
      const caution = action.readOnly ? "只读动作，可放心调用" : "会改动状态，调用前先与对方/主人确认";
      pi.registerTool({
        name: `snowluma_${action.tool}`,
        label: action.summary.slice(0, 24),
        description: `[SnowLuma/${action.category || "OneBot"}] ${summary}（${caution}）`,
        parameters: action.inputSchema,
        executionMode: action.readOnly ? void 0 : "sequential",
        async execute(_id, params) {
          try {
            const result = await bot.raw(action.name, params ?? {});
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: true, result }, null, 2).slice(0, 8e3) }]
            };
          } catch (err) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }] };
          }
        }
      });
    }
    pi.registerTool({
      name: "qq_react",
      label: "表情回应群消息",
      description: "给一条 QQ 群消息贴表情回应（消息情绪的轻量参与，不必每条都文字回复）。注意：表情回应仅群聊可用，私聊不支持（QQ 协议限制）。根据消息情绪挑表情：认同/没问题 → 124 OK 手势，赞/厉害 → 398 超级ok，认同/开心 → 13 呲牙，好笑 → 28 偷笑，无语 → 32 疑问，感动/难过 → 5 流泪，佩服 → 4 得意，害羞 → 6 害羞。不要频繁使用，一条消息最多回应一次。",
      parameters: Type.Object({
        message_id: Type.Number({ description: "要回应的消息 id" }),
        emoji_id: Type.String({ description: "QQ 系统表情 ID（如 13 呲牙、28 偷笑、32 疑问）" }),
        set: Type.Optional(Type.Boolean({ description: "false = 取消回应，默认 true" }))
      }),
      async execute(_id, params) {
        try {
          await bot.raw("set_msg_emoji_like", {
            message_id: params.message_id,
            emoji_id: String(params.emoji_id),
            set: params.set !== false
          });
          return { content: [{ type: "text", text: "回应了" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `回应失败：${err.message}` }] };
        }
      }
    });
    pi.registerTool({
      name: "qq_poke",
      label: "戳一戳",
      description: "在 QQ 上戳一戳某人。私聊传 user_id，群聊传 group_id + user_id。被别人戳了或想调侃朋友时用。",
      parameters: Type.Object({
        user_id: Type.Number({ description: "要戳的 QQ 号" }),
        group_id: Type.Optional(Type.Number({ description: "群号；不传则戳好友" }))
      }),
      async execute(_id, params) {
        try {
          if (params.group_id) await bot.groupPoke(params.group_id, params.user_id);
          else await bot.friendPoke(params.user_id);
          return { content: [{ type: "text", text: "戳了" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `戳失败：${err.message}` }] };
        }
      }
    });
    pi.registerTool({
      name: "qq_send_like",
      label: "QQ 点赞",
      description: "给某个 QQ 号点赞（赞名片，每天有次数上限）。",
      parameters: Type.Object({
        user_id: Type.Number({ description: "QQ 号" }),
        times: Type.Optional(Type.Number({ description: "次数，默认 1，最多 10" }))
      }),
      async execute(_id, params) {
        try {
          await bot.sendLike(params.user_id, Math.min(10, Math.max(1, params.times ?? 1)));
          return { content: [{ type: "text", text: "赞了" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `点赞失败：${err.message}` }] };
        }
      }
    });
    pi.registerTool({
      name: "qq_qzone_post",
      label: "发QQ空间说说",
      description: "发一条主人的 QQ 空间说说（走 SnowLuma 原生 send_qzone_msg）。只应在主人（乌龙/yuanjingINT）明确要求发空间时使用，内容与主人确认过再发。可用 images 传图片。",
      parameters: Type.Object({
        content: Type.String({ description: "说说正文" }),
        images: Type.Optional(Type.Array(Type.String(), { description: "图片（file:// http:// base64://），可选" }))
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        try {
          const result = await bot.raw("send_qzone_msg", {
            content: params.content,
            ...params.images?.length ? { images: params.images } : {}
          });
          return { content: [{ type: "text", text: `说说已发出去：${JSON.stringify(result).slice(0, 300)}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `发空间失败：${err.message}` }] };
        }
      }
    });
  };
}
function extractPlainText(rawMessage) {
  return (rawMessage ?? "").replace(/\[CQ:[^\]]*\]/g, "").trim();
}
function isNewChatCommand(text2) {
  return text2.trim().toLowerCase() === "/whatnew";
}
const NEW_CHAT_REPLY = "新对话开好了 旧的翻篇";
function pickEmojiByEmotion(text2) {
  const t = text2.toLowerCase();
  const has = (re) => re.test(t);
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
const REPLY_IMAGE_LIMIT = 100;
function toPangoMarkup(text2) {
  const esc = text2.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>").replace(/`([^`\n]+?)`/g, "<tt>$1</tt>");
}
function renderTextPng(text2) {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dito-qq-img-"));
    const pngPath = join(dir, "out.png");
    let font = "";
    try {
      font = execFileSync("sh", ["-c", "fc-match -f '%{file}' 'Noto Sans CJK SC' 2>/dev/null || fc-match -f '%{file}' :lang=zh"], {
        encoding: "utf-8"
      }).trim();
    } catch {
    }
    const baseArgs = ["-size", "680x", "-density", "96", "-pointsize", "22", "-background", "#f7f3ea", "-fill", "#2a2a2a", ...font ? ["-font", font] : []];
    const bin = existsSync("/usr/bin/magick") ? "magick" : "convert";
    try {
      execFileSync(bin, [...baseArgs, `pango:${toPangoMarkup(text2)}`, pngPath], {
        timeout: 2e4,
        stdio: ["ignore", "ignore", "ignore"],
        maxBuffer: 32 * 1024 * 1024
      });
    } catch {
      const txtPath = join(dir, "in.txt");
      const plain = text2.replace(/\*\*([^*\n]+?)\*\*/g, "$1").replace(/`/g, "");
      writeFileSync(txtPath, plain, "utf-8");
      execFileSync(bin, [...baseArgs, `caption:@${txtPath}`, pngPath], {
        timeout: 2e4,
        stdio: ["ignore", "ignore", "ignore"]
      });
    }
    return existsSync(pngPath) ? pngPath : null;
  } catch (err) {
    console.error("[dito qq] 文字转图片失败，改发文本：", err.message);
    return null;
  }
}
function findExecutableIn(dir) {
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
function detectSnowlumaCommand() {
  const sh = (cmd) => {
    try {
      return execFileSync("sh", ["-c", cmd], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  if (sh("command -v snowluma")) return "snowluma";
  const unit = sh("systemctl --user list-unit-files --type=service 2>/dev/null | grep -i snowluma | head -1 | awk '{print $1}'");
  if (unit) return `systemctl --user start ${unit}`;
  const sysUnit = sh("systemctl list-unit-files --type=service 2>/dev/null | grep -i snowluma | head -1 | awk '{print $1}'");
  if (sysUnit) return `systemctl start ${sysUnit}`;
  const container = sh("docker ps -a --format '{{.Names}}' 2>/dev/null | grep -i snowluma | head -1");
  if (container) return `docker start ${container}`;
  const home = homedir();
  const dirs = [
    "/opt/snowluma",
    "/usr/local/share/snowluma",
    join(home, ".local", "share", "snowluma"),
    join(home, ".snowluma"),
    join(home, "SnowLuma"),
    join(home, "snowluma")
  ];
  for (const dir of dirs) {
    if (existsSync(dir)) {
      const exe = findExecutableIn(dir);
      if (exe) return exe;
    }
  }
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ensureSnowLuma(ch) {
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
    const detected = detectSnowlumaCommand();
    if (!detected) {
      console.error(
        "SnowLuma 未运行，且没能自动找到它的启动命令（已探测 PATH / systemd / docker / 常见目录）。\n两条路任选：\n  1. 安装 SnowLuma 本体后重跑 dito qq（进 PATH 或在 `dito config` → 频道 → QQ 里填启动命令，会自动填入并拉起）\n  2. 用任意标准 OneBot 11 服务替代（如 NapCat）：把 channels.qq.url 指向它的 WS 地址即可，但 SnowLuma 特有的空间等扩展动作是否可用取决于该服务端。"
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
  const deadline = Date.now() + 6e4;
  while (Date.now() < deadline) {
    await sleep(1500);
    if (child.exitCode !== null && child.exitCode !== 0 && child.signalCode === null) {
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
  }
  console.error("[dito qq] 等待 SnowLuma 就绪超时（60s），已终止拉起的进程");
  process.exit(1);
}
const CHAT_SESSIONS_DIR = ditoChannelDir("qq");
const TASK_TIMEOUT_MS = 18e4;
function promptWithWatchdog(chat, text2, label) {
  return runWithTaskSlot(() => {
    const timer = setTimeout(() => {
      console.error(`[${label}] 任务超时（${TASK_TIMEOUT_MS / 1e3}s），强制中断：${text2.slice(0, 40)}`);
      void chat.session.abort().catch(() => {
      });
    }, TASK_TIMEOUT_MS);
    return chat.session.prompt(text2, { streamingBehavior: "followUp" }).finally(() => clearTimeout(timer));
  });
}
function stealMemes(segments, source, memes) {
  void (async () => {
    for (const s of segments) {
      const seg = s;
      if (!seg || seg.type !== "image" && seg.type !== "mface") continue;
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
        console.error("[dito qq] 偷表情包失败：", err.message);
      }
    }
  })();
}
function buildQqSystemPrompt() {
  const persona = readPersona("dito-qq") || readPersona("dito");
  return [
    "# Dito 人格设定",
    "以下设定是最高优先级行为准则，任何情况下都要遵守，并覆盖系统里其它任何「你是谁」的默认描述。",
    "当被问到你是谁、你是什么助手、你是什么模型时：你是 dito（蒂特），不是 pi，不是 coding agent。",
    "",
    persona
  ].join("\n");
}
async function runQqChannel() {
  const cfg = loadConfig();
  let ch = cfg.channels.qq;
  if (!ch.enabled) {
    console.error("QQ 频道未启用：在 `dito config` 的「频道」分区启用 channels.qq 并填 SnowLuma 地址。");
    process.exit(1);
  }
  mkdirSync(join(CHAT_SESSIONS_DIR, "qq-sessions"), { recursive: true, mode: 448 });
  const chats = /* @__PURE__ */ new Map();
  const affinity = new Affinity(join(CHAT_SESSIONS_DIR, "affinity.json"));
  const memes = new MemeStore(join(CHAT_SESSIONS_DIR, "memes"));
  const ditoRe = new DitoReEngine({
    config: cfg.plugins["dito-re"],
    historyFile: join(CHAT_SESSIONS_DIR, "dito-re-context.json")
  });
  process.once("exit", () => ditoRe.flush());
  const seenMessageIds = /* @__PURE__ */ new Set();
  const seenOnce = (id2) => {
    if (id2 === void 0) return false;
    if (seenMessageIds.has(id2)) return true;
    if (seenMessageIds.size > 1e3) seenMessageIds.clear();
    seenMessageIds.add(id2);
    return false;
  };
  const sendSegments = (key, segments) => {
    const [, type2, id2] = key.match(/^(qq-(?:private|group))-(.+)$/) ?? [];
    if (!type2 || !id2) return Promise.resolve();
    return type2 === "qq-group" ? bot.sendGroupMessage(Number(id2), segments) : bot.sendPrivateMessage(Number(id2), segments);
  };
  const imageSegment = (path) => message.image(`base64://${readFileSync(path).toString("base64")}`);
  const send = async (key, reply) => {
    let sent = false;
    if ([...reply].length > REPLY_IMAGE_LIMIT) {
      const png = renderTextPng(reply);
      if (png) {
        try {
          await sendSegments(key, [imageSegment(png)]);
          sent = true;
        } catch (err) {
          console.error("[dito qq] 图片发送失败，回退文字：", err.message);
        }
      }
    }
    if (!sent) await sendSegments(key, [message.text(reply)]);
    if ((ch.memeChance ?? 0.3) > 0 && Math.random() < (ch.memeChance ?? 0.3)) {
      const entry = memes.pick();
      if (entry) {
        try {
          await sendSegments(key, [imageSegment(memes.filePath(entry))]);
          console.log(`[dito qq] 附赠表情包：${entry.emotion}「${entry.desc}」`);
        } catch (err) {
          console.error("[dito qq] 附赠表情包失败：", err.message);
        }
      }
    }
    if (type === "qq-group") ditoRe.markBotReply(Number(id), reply);
  };
  const sessionFor = async (key, forceNew = false) => {
    const previous = chats.get(key);
    if (previous && !forceNew) return previous;
    if (previous) {
      chats.delete(key);
      try {
        await previous.session.abort();
      } catch {
      }
      try {
        previous.session.dispose();
      } catch {
      }
    }
    const created = await openChannelSession(join(CHAT_SESSIONS_DIR, "qq-chats.json"), key, [
      qqToolsExtension(bot, affinity, memes)
    ], {
      systemPrompt: buildQqSystemPrompt(),
      skipPluginIds: ["mode", "snowluma"],
      sessionsDir: join(CHAT_SESSIONS_DIR, "qq-sessions"),
      memoryScope: key,
      disableThinking: true
    }, forceNew);
    const ownerMatch = /^qq-private-(\d+)$/.exec(key);
    const isOwner = !!ownerMatch && ch.owners.includes(Number(ownerMatch[1]));
    applySessionToolPolicy(created.session, isOwner, "dito qq");
    const chat = makeChannelChat(created.session, (reply) => send(key, reply), "dito qq");
    chats.set(key, chat);
    console.log(`[dito qq] 新聊天会话：${key}（模型 ${created.modelName}，工具含 SnowLuma 全量动作）`);
    return chat;
  };
  const onPrivate = async (event) => {
    ch = loadConfig().channels.qq;
    if (!ch.friends) return;
    if (seenOnce(event.message_id)) return;
    if (event.user_id === await safeSelfId(bot)) return;
    affinity.reloadIfChanged();
    memes.reloadIfChanged();
    stealMemes(Array.isArray(event.message) ? event.message : [], `私聊-${event.user_id}`, memes);
    const key = `qq-private-${event.user_id}`;
    const name = event.sender?.nickname ?? String(event.user_id);
    const content = extractPlainText(event.raw_message);
    if (!content) return;
    if (isNewChatCommand(content)) {
      await sessionFor(key, true);
      await send(key, NEW_CHAT_REPLY);
      console.log(`[dito qq] 私聊 ${event.user_id} 重开新对话`);
      return;
    }
    const chat = await sessionFor(key);
    await promptWithWatchdog(chat, `[QQ私聊 来自 ${name}] ${content}`, "dito qq");
  };
  const onGroup = async (event) => {
    const currentConfig = loadConfig();
    ch = currentConfig.channels.qq;
    ditoRe.setConfig(currentConfig.plugins["dito-re"]);
    if (!ch.groups.includes(event.group_id)) return;
    if (seenOnce(event.message_id)) return;
    affinity.reloadIfChanged();
    memes.reloadIfChanged();
    const name = event.sender?.card || event.sender?.nickname || String(event.user_id);
    let content = extractPlainText(event.raw_message);
    const keywords = ch.wakeKeywords.filter(Boolean);
    const self = await safeSelfId(bot);
    if (event.user_id === self) return;
    const segments = Array.isArray(event.message) ? event.message : [];
    const atMe = segments.some(
      (s) => s?.type === "at" && String(s.data?.qq ?? "") === String(self)
    );
    const replySegment = segments.some((s) => s?.type === "reply");
    const replyToDito = replySegment && ditoRe.hasRecentBotReply(event.group_id);
    stealMemes(Array.isArray(event.message) ? event.message : [], `群-${event.group_id}`, memes);
    ditoRe.remember({
      messageId: event.message_id,
      groupId: event.group_id,
      userId: event.user_id,
      name,
      text: content || "（非文字消息）",
      atMe
    });
    const score = affinity.get(`${event.group_id}:${event.user_id}`);
    if (score < 20) {
      console.log(`[dito qq] 群 ${event.group_id} 的 ${event.user_id} 好感度 ${score} < 20，忽略消息`);
      return;
    }
    if (isNewChatCommand(content)) {
      const key2 = `qq-group-${event.group_id}`;
      await sessionFor(key2, true);
      await send(key2, NEW_CHAT_REPLY);
      console.log(`[dito qq] 群 ${event.group_id} 重开新对话`);
      return;
    }
    const explicitlyAddressed = looksLikeDitoConversation(content, { atMe, replyToDito });
    const woken = atMe || explicitlyAddressed || keywords.length > 0 && keywords.some((k) => content.toLowerCase().includes(k.toLowerCase()));
    if (!content && !woken) return;
    if (woken && keywords.length > 0) {
      let stripped = content;
      for (const k of keywords) stripped = stripped.replace(new RegExp(k, "gi"), "").trim();
      if (stripped) content = stripped;
    }
    if (!content) {
      content = atMe ? "（对方@了你，发的是一个表情/图片，没有文字）" : woken ? "（对方呼叫了你，没有留下其它文字）" : "（对方发了一个表情/图片，没有文字）";
    }
    const key = `qq-group-${event.group_id}`;
    const reEnabled = ditoRe.getConfig().enabled;
    const decision = reEnabled ? ditoRe.decide({
      groupId: event.group_id,
      userId: event.user_id,
      name,
      text: content,
      atMe,
      woken,
      wakeOnly: ch.wakeOnlyGroups.includes(event.group_id),
      replyToDito
    }) : {
      shouldReply: Math.random() < (woken ? 1 : ch.wakeOnlyGroups.includes(event.group_id) ? 0 : ch.groupReplyChance ?? 0.2),
      reason: "default",
      chance: woken ? 1 : ch.wakeOnlyGroups.includes(event.group_id) ? 0 : ch.groupReplyChance ?? 0.2
    };
    if (!decision.shouldReply) {
      const topic = decision.matchedTopic ? `，主题「${decision.matchedTopic.name}」` : "";
      console.log(`[dito qq] 群 ${event.group_id} 未命中自动回复概率（${decision.chance}${topic}），忽略：${content.slice(0, 30)}`);
      return;
    }
    if (ch.autoReact !== false) {
      try {
        await bot.raw("set_msg_emoji_like", {
          message_id: event.message_id,
          emoji_id: pickEmojiByEmotion(content),
          set: true
        });
      } catch (err) {
        console.error("[dito qq] 自动表情回应失败：", err.message);
      }
    }
    const chat = await sessionFor(key);
    const currentMessage = `[QQ群 ${event.group_id} 来自 ${name}｜好感度 ${score}/100] ${content}`;
    const prompt = reEnabled ? `${currentMessage}

${ditoRe.promptContext(event.group_id, content, decision)}` : currentMessage;
    await promptWithWatchdog(chat, prompt, "dito qq");
  };
  const onNotice = async (event) => {
    const e = event;
    if (e.sub_type !== "poke") return;
    if (!ch.pokeBack) return;
    const self = await safeSelfId(bot);
    if (e.target_id !== self) return;
    try {
      if (e.group_id) await bot.groupPoke(e.group_id, e.user_id);
      else await bot.friendPoke(e.user_id);
      console.log(`[dito qq] 被戳（${e.user_id}），已戳回去`);
    } catch (err) {
      console.error("[dito qq] 戳回去失败：", err.message);
    }
  };
  const onRequest = async (event) => {
    const e = event;
    if (ch.autoApprove && e.flag) {
      try {
        await bot.raw(
          e.request_type === "group" ? "set_group_add_request" : "set_friend_add_request",
          { flag: e.flag, sub_type: e.sub_type ?? "add", approve: true }
        );
        console.log(`[dito qq] 已自动同意请求（${e.request_type} 来自 ${e.user_id}）`);
        return;
      } catch (err) {
        console.error("[dito qq] 自动同意失败：", err.message);
      }
    }
    console.log(`[dito qq] 收到 ${e.request_type} 请求（来自 ${e.user_id}），未自动处理`);
  };
  const auto = await ensureSnowLuma(ch);
  if (auto.child) {
    const cleanup = () => {
      try {
        auto.child?.kill("SIGTERM");
      } catch {
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
  let bot = createBot();
  function createBot() {
    const b = new SnowLumaWebSocketClient({
      url: ch.url,
      accessToken: ch.accessToken || void 0,
      reconnect: true
    });
    bindHandlers(b);
    return b;
  }
  function swapBot(next) {
    try {
      bot.close();
    } catch {
    }
    bot = next;
  }
  function connectWithRetry(b) {
    return (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await b.connect();
          return;
        } catch {
          if (attempt === 1) {
            console.log("[dito qq] OneBot 端口未就绪（QQ 可能还没扫码登录），每 3 秒重试；登录后自动进入工作状态");
          }
          await sleep(3e3);
        }
      }
    })();
  }
  function bindHandlers(b) {
    b.onPrivateMessage(onPrivate);
    b.onGroupMessage(onGroup);
    b.onNotice(onNotice);
    b.onRequest(onRequest);
  }
  await connectWithRetry(bot);
  const rebuildClient = async () => {
    console.log("[dito qq] 检测到连接断开，重建 SnowLuma 客户端…");
    const fresh = createBot();
    swapBot(fresh);
    await connectWithRetry(fresh);
    console.log("[dito qq] SnowLuma 客户端已恢复");
  };
  const healthTimer = setInterval(() => {
    void (async () => {
      try {
        const portAlive = await probeWs(ch.url, 2500);
        if (portAlive && !bot.isConnected) await rebuildClient();
      } catch {
      }
    })();
  }, 6e4);
  healthTimer.unref();
  let login = null;
  try {
    login = await bot.getLoginInfo();
  } catch {
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
  await new Promise(() => {
  });
}
let selfIdCache = null;
async function safeSelfId(bot) {
  if (selfIdCache === null) {
    try {
      selfIdCache = (await bot.getLoginInfo()).user_id;
    } catch {
      selfIdCache = -1;
    }
  }
  return selfIdCache;
}
export {
  isNewChatCommand,
  pickEmojiByEmotion,
  qqToolsExtension,
  renderTextPng,
  runQqChannel
};
