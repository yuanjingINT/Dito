/**
 * Dito 终端对话。
 *
 * 用法：
 *   dito              # 进入全屏对话 TUI（Tab 切换模式）
 *   dito "你好"        # 单次问答
 *   dito send "你好"   # 显式从终端直接发消息给 Dito（同 dito msg / dito message / -m）
 *   dito voice        # 语音对话（水波界面 + 朗读/录音）
 *   dito config       # 配置页面（TUI）
 *   dito web          # Web UI（对话 + 图形化配置 + 知识库/记忆）
 *
 * 通过 pi SDK 起会话，加载 Dito 扩展，默认模型走 opencode 免费公共模型（免 Key 开箱即用），
 * 内置智谱 GLM-4-Flash 等国内直连免费模型可选。
 * 对话界面复用 @earendil-works/pi-tui 实现全屏 TUI，Tab 在「闲聊 / 标准 / 计划」间切换。
 */
import readline from "node:readline/promises";
import { join } from "node:path";

import { MODE_DEFS, getMode } from "../extensions/mode.js";
import { toggleSudoMode } from "../extensions/permission.js";
import { runVoiceMode, type VoiceConfig } from "../extensions/voice.js";
import { runConfigTui } from "./config-tui.js";
import { runTui } from "./tui.js";
import { loadConfig } from "../extensions/util.js";
import { createSession, type SessionBundle } from "./session.js";

// ── 配色 ────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
};

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface ConsolePrinter {
  attach(session: { subscribe(cb: (event: unknown) => void): unknown }): void;
}

/**
 * 会话输出：彩色前缀 + 流式正文 + dim 工具提示 + braille 转圈。
 */
function createPrinter(): ConsolePrinter {
  let spinner: ReturnType<typeof setInterval> | null = null;
  let prefixWritten = false;
  let inThinking = false;
  const seenTools = new Set<string>();

  function stopSpinner(): void {
    if (spinner) {
      clearInterval(spinner);
      spinner = null;
      process.stdout.write("\r\x1b[2K");
    }
  }

  function startSpinner(label: string): void {
    stopSpinner();
    let i = 0;
    process.stdout.write(`\r${C.dim}${BRAILLE[0]} ${label}${C.reset}`);
    spinner = setInterval(() => {
      i = (i + 1) % BRAILLE.length;
      process.stdout.write(`\r\x1b[2K${C.dim}${BRAILLE[i]} ${label}${C.reset}`);
    }, 80);
  }

  function ensurePrefix(): void {
    if (!prefixWritten) {
      stopSpinner();
      const modeColor = MODE_DEFS[getMode()].color;
      process.stdout.write(`${modeColor}${C.bold}蒂特 ›${C.reset} `);
      prefixWritten = true;
    }
  }

  function resetTurn(): void {
    stopSpinner();
    if (prefixWritten) process.stdout.write("\n");
    prefixWritten = false;
    inThinking = false;
    seenTools.clear();
  }

  function attach(session: { subscribe(cb: (event: unknown) => void): unknown }): void {
    session.subscribe((event) => {
      const e = event as {
        type: string;
        assistantMessageEvent?: { type: string; delta?: string };
        toolName?: string;
        toolCallId?: string;
        args?: unknown;
        message?: { role?: string; stopReason?: string; errorMessage?: string };
      };
      const ame = e.assistantMessageEvent;

      if (e.type === "message_update" && ame) {
        // 思考中
        if (ame.type === "thinking_start") {
          stopSpinner();
          inThinking = true;
          process.stdout.write(`\n${C.dim}${C.bold}◇ 思考中…${C.reset}\n${C.italic}${C.dim}`);
        } else if (ame.type === "thinking_delta") {
          process.stdout.write(ame.delta ?? "");
        } else if (ame.type === "thinking_end") {
          if (inThinking) process.stdout.write(`${C.reset}\n`);
          inThinking = false;
        } else if (ame.type === "text_delta") {
          if (inThinking) { process.stdout.write(`${C.reset}\n`); inThinking = false; }
          ensurePrefix();
          process.stdout.write(ame.delta ?? "");
        }
        return;
      }

      if (e.type === "tool_execution_start" && e.toolName) {
        if (e.toolCallId && seenTools.has(e.toolCallId)) return;
        if (e.toolCallId) seenTools.add(e.toolCallId);
        if (inThinking) { process.stdout.write(`${C.reset}\n`); inThinking = false; }
        ensurePrefix();
        const args = e.args == null ? "" : (() => {
          const s = typeof e.args === "string" ? e.args : (() => { try { return JSON.stringify(e.args); } catch { return String(e.args); } })();
          const flat = s.replace(/\s+/g, " ").trim();
          return flat.length > 160 ? flat.slice(0, 160) + "…" : flat;
        })();
        process.stdout.write(
          `\n${C.yellow}${C.bold}⚙ 指令：${e.toolName}${C.reset}` +
          (args ? `  ${C.dim}${args}${C.reset}` : "") + `\n`,
        );
        startSpinner("执行中");
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        if (e.message.stopReason === "error" && e.message.errorMessage) {
          stopSpinner();
          if (inThinking) { process.stdout.write(`${C.reset}\n`); inThinking = false; }
          const msg = e.message.errorMessage;
          if (/429|rate limit|限流/i.test(msg)) {
            process.stdout.write(`\n${C.yellow}[opencode 免费额度限流，稍后再试]${C.reset}\n`);
          } else {
            process.stdout.write(`\n${C.red}[出错] ${msg}${C.reset}\n`);
          }
        }
      } else if (e.type === "agent_end") {
        resetTurn();
      }
    });
  }

  return { attach };
}

/** 给 Dito 发一条消息，打印回复后退出。 */
async function sendOneMessage(text: string, fresh = false): Promise<void> {
  const created = await createSession({ fresh });
  const printer = createPrinter();
  printer.attach(created.session);
  await created.session.prompt(text);
  process.stdout.write("\n");
  created.session.dispose();
}

// ── 扩展装配 ────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "config") {
    await runConfigTui();
    return;
  }

  if (args[0] === "qq") {
    const { runQqChannel } = await import("./qq.js");
    await runQqChannel();
    return;
  }

  if (args[0] === "matrix") {
    const { runMatrixChannel } = await import("./matrix.js");
    await runMatrixChannel();
    return;
  }

  if (args[0] === "web") {
    const { runWebServer } = await import("./web.js");
    await runWebServer();
    return;
  }

  if (args[0] === "voice") {
    const voicePlugin = loadConfig().plugins.voice;
    if (voicePlugin.enabled === false) {
      console.error("语音插件已在配置中停用。请先在 `dito config` 或 Web UI 的配置页启用「语音对话」插件。");
      process.exit(1);
    }
    const { session } = await createSession();
    await runVoiceMode(session, voicePlugin as unknown as VoiceConfig);
    session.dispose();
    return;
  }

  // 显式“终端直接发消息”：dito send/msg/message <消息>
  // 支持 --fresh/-f 开新会话再发；没带消息时自动读取管道/stdin 内容。
  const SEND_ALIASES = ["send", "msg", "message"];
  if (SEND_ALIASES.includes(args[0] ?? "")) {
    let text: string;
    let fresh = false;
    const sendArgs: string[] = [];
    for (const a of args.slice(1)) {
      if (a === "--fresh" || a === "-f") fresh = true;
      else sendArgs.push(a);
    }
    text = sendArgs.join(" ").trim();
    if (!text && !process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      text = Buffer.concat(chunks).toString("utf8").trim();
    }
    if (!text) {
      console.error("用法：dito send <消息>  （也支持 echo '消息' | dito send，或 dito msg / dito message）");
      process.exit(2);
    }
    await sendOneMessage(text, fresh);
    return;
  }

  // 也支持常见的 -m / --message 传参写法：
  //   dito -m "你好"
  //   dito --message "你好" --fresh
  const messageFlagIndex = args.findIndex((a) => a === "-m" || a === "--message");
  if (messageFlagIndex !== -1) {
    let fresh = false;
    const messageArgs: string[] = [];
    for (const a of args) {
      if (a === "-m" || a === "--message" || a === "--fresh" || a === "-f") continue;
      messageArgs.push(a);
    }
    const text = messageArgs.join(" ").trim();
    if (!text) {
      console.error("用法：dito -m <消息> 或 dito --message <消息>");
      process.exit(2);
    }
    await sendOneMessage(text, fresh);
    return;
  }

  const oneShot = args.join(" ").trim();
  if (oneShot) {
    await sendOneMessage(oneShot);
    return;
  }

  const created = await createSession();
  let session = created.session;
  const modelName = created.modelName;

  // 非 TTY（管道输入）退化为行式循环 + printer 输出
  if (!process.stdin.isTTY) {
    let printer = createPrinter();
    printer.attach(session);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      for await (const line of rl) {
        const text = line.trim();
        if (!text) continue;
        if (text === "/exit" || text === "/quit" || text === "exit") break;
        if (text === "/new" || text === "/新会话") {
          session.dispose();
          const next = await createSession({ fresh: true });
          session = next.session;
          printer = createPrinter();
          printer.attach(session);
          process.stdout.write(`\n${C.green}[已开启新会话]${C.reset}\n\n`);
          continue;
        }
        if (text.startsWith("/sudo")) {
          const arg = text.replace("/sudo", "").trim().toLowerCase();
          let next: boolean | undefined;
          if (["on", "1", "开", "开启"].includes(arg)) next = true;
          else if (["off", "0", "关", "关闭"].includes(arg)) next = false;
          else if (arg !== "") {
            console.log("[用法] /sudo on | off（开启/关闭 sudo 权限模式）");
            continue;
          }
          const on = toggleSudoMode(next);
          process.stdout.write(
            on
              ? `${C.green}[sudo 模式已开启：权限门关闭，需要 root 的命令自动加 sudo]${C.reset}\n`
              : `${C.green}[sudo 模式已关闭：恢复权限门与危险命令确认]${C.reset}\n`,
          );
          continue;
        }
        await session.prompt(text);
        process.stdout.write("\n");
      }
    } finally {
      rl.close();
      session.dispose();
    }
    return;
  }

  await runTui(session, modelName, () => createSession({ fresh: true }));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "readline was closed" || msg.includes("readline")) {
    process.exit(0);
  }
  console.error("\n[Dito] 出错：", msg);
  process.exit(1);
});
