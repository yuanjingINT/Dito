import readline from "node:readline/promises";
import { toggleSudoMode } from "../extensions/permission.js";
import { runVoiceMode } from "../extensions/voice.js";
import { runConfigTui } from "./config-tui.js";
import { runTui } from "./tui.js";
import { createPrinter } from "./console-printer.js";
import { createPrinter as createPrinter2 } from "./console-printer.js";
import { loadConfig, ditoDataDir } from "../extensions/util.js";
import { ensurePluginInstallation } from "./plugin-manager.js";
import { createSession } from "./session.js";
import { assertImageSupport, parseMessageArgs, readImageAttachment } from "./image-input.js";
const C = {
  reset: "\x1B[0m",
  dim: "\x1B[90m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  cyan: "\x1B[36m",
  magenta: "\x1B[35m",
  bold: "\x1B[1m",
  italic: "\x1B[3m"
};
async function sendOneMessage(text, fresh = false, imagePaths = []) {
  const attachments = await Promise.all(imagePaths.map(readImageAttachment));
  const scope = process.env.DITO_MEMORY_SCOPE;
  const created = await createSession({ fresh, memoryScope: scope, sessionsDir: scope ? join(ditoDataDir(), "sessions", scope) : undefined });
  const printer = createPrinter();
  printer.attach(created.session);
  try {
    assertImageSupport(created.session, attachments.length);
    await created.session.prompt(text, { images: attachments.map((image) => image.content) });
    process.stdout.write("\n");
  } finally {
    printer.dispose();
    created.session.dispose();
  }
  process.exit(0);
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "plugins") {
    await ensurePluginInstallation({ force: true });
    return;
  }
  if (args[0] !== "doctor") await ensurePluginInstallation();
  const requirePlugin = (id) => {
    const cfg = loadConfig();
    const installed = cfg.plugins.manager.installed.includes(id) || (id === "qq" || id === "matrix" || id === "mobile") && cfg.channels[id].enabled;
    if (installed) return true;
    console.error(`插件「${id}」尚未安装。请在终端运行：dito plugins`);
    process.exitCode = 1;
    return false;
  };
  if (args[0] === "config") {
    await runConfigTui();
    return;
  }
  if (args[0] === "qq") {
    if (!requirePlugin("qq")) return;
    const { runQqChannel } = await import("./qq.js");
    await runQqChannel();
    return;
  }
  if (args[0] === "qqadmin") {
    if (!requirePlugin("qq")) return;
    const { runQqAdminChannel } = await import("./qq-admin.js");
    await runQqAdminChannel(args.slice(1));
    return;
  }
  if (args[0] === "matrix") {
    if (!requirePlugin("matrix")) return;
    const { runMatrixChannel } = await import("./matrix.js");
    await runMatrixChannel();
    return;
  }
  if (args[0] === "bridge") {
    if (!requirePlugin("bridge")) return;
    const { runBridgeChannel } = await import("./bridge.js");
    await runBridgeChannel();
    return;
  }
  if (args[0] === "mobile") {
    if (!requirePlugin("mobile")) return;
    const { runMobileChannel } = await import("./mobile.js");
    await runMobileChannel(args.slice(1));
    return;
  }
  if (args[0] === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    await runDoctor();
    return;
  }
  if (args[0] === "mcp") {
    if (!requirePlugin("mcp")) return;
    const { runMcpServerMain } = await import("./mcp-server.js");
    await runMcpServerMain();
    return;
  }
  if (args[0] === "voice") {
    if (!requirePlugin("voice")) return;
    const voicePlugin = loadConfig().plugins.voice;
    if (voicePlugin.enabled === false) {
      console.error("语音插件已在配置中停用。请先在 `dito config` 或 Web UI 的配置页启用「语音对话」插件。");
      process.exit(1);
    }
    const { session: session2 } = await createSession();
    await runVoiceMode(session2, voicePlugin);
    session2.dispose();
    return;
  }
  const SEND_ALIASES = ["send", "msg", "message"];
  if (args.length) {
    const explicitSend = SEND_ALIASES.includes(args[0]);
    const parsed = parseMessageArgs(explicitSend ? args.slice(1) : args);
    if (explicitSend && !parsed.text && !process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      parsed.text = Buffer.concat(chunks).toString("utf8").trim();
    }
    if (!parsed.text && !parsed.imagePaths.length) {
      console.error("用法：dito send <消息> [--image 图片路径]（可重复指定；也支持 -m、管道文字与纯图片）");
      process.exit(2);
    }
    await sendOneMessage(parsed.text, parsed.fresh, parsed.imagePaths);
    return;
  }
  const created = await createSession({ sessionFile: process.env.DITO_SESSION_FILE });
  delete process.env.DITO_SESSION_FILE;
  let session = created.session;
  const modelName = created.modelName;
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
          printer.dispose();
          session.dispose();
          const next = await createSession({ fresh: true });
          session = next.session;
          printer = createPrinter();
          printer.attach(session);
          process.stdout.write(`
${C.green}[已开启新会话]${C.reset}

`);
          continue;
        }
        if (text.startsWith("/sudo")) {
          const arg = text.replace("/sudo", "").trim().toLowerCase();
          let next;
          if (["on", "1", "开", "开启"].includes(arg)) next = true;
          else if (["off", "0", "关", "关闭"].includes(arg)) next = false;
          else if (arg !== "") {
            console.log("[用法] /sudo on | off（开启/关闭 sudo 权限模式）");
            continue;
          }
          const on = toggleSudoMode(next);
          process.stdout.write(
            on ? `${C.green}[sudo 模式已开启：权限门关闭，需要 root 的命令自动加 sudo]${C.reset}
` : `${C.green}[sudo 模式已关闭：恢复权限门与危险命令确认]${C.reset}
`
          );
          continue;
        }
        await session.prompt(text);
        process.stdout.write("\n");
      }
    } finally {
      rl.close();
      printer.dispose();
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
export {
  createPrinter2 as createPrinter
};
