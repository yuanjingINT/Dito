/**
 * Dito 桌面版（Electron 壳）。
 *
 * - 启动内置的 Dito Web 服务（复用 bin/web.ts，Xiaomi MiMo 风格 UI）
 * - 服务运行在 127.0.0.1 随机端口，窗口只加载本机服务
 * - 提示词加密包（desktop/prompts/dito-prompts.bin）存在时，前端 API 自动隐藏提示词正文
 *
 * 运行：npm run desktop  或  electron .
 */
const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const WEB_TS = path.join(ROOT, "bin", "web.ts");
const PROMPT_BUNDLE =
  process.env.DITO_PROMPT_BUNDLE ||
  path.join(ROOT, "desktop", "prompts", "dito-prompts.bin");

let mainWindow = null;
let serverProcess = null;
let serverPort = 0;

/** 启动 Dito Web 服务子进程（Electron 的 Node 模式 + tsx 直接运行 TS） */
function startServer() {
  return new Promise((resolve, reject) => {
    const script = [
      `import { runWebServer } from ${JSON.stringify(pathToFileURL(WEB_TS).href)};`,
      `await runWebServer(0);`,
    ].join("\n");

    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          // 桌面版只从加密包读取提示词，不回退明文目录。
          DITO_DESKTOP: "1",
          DITO_PROMPT_BUNDLE: PROMPT_BUNDLE,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32", // Linux/macOS 上成组，退出时整组结束
      },
    );

    serverProcess = child;

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(port);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Web 服务启动超时。\n${stderr || stdout || ""}`.trim()));
    }, 20000);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
      const m = stdout.match(/DITO_WEB_ACTUAL_PORT=(\d+)/);
      if (m) finish(null, Number(m[1]));
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (err) => {
      finish(new Error(`无法启动 Dito Web 服务：${err.message}`));
    });

    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`Web 服务提前退出（exit ${code}）。\n${stderr || stdout || ""}`.trim()));
      } else {
        serverProcess = null;
      }
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "Dito（蒂特）",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#fcfaf8",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow && mainWindow.show());
  mainWindow.on("page-title-updated", (event) => event.preventDefault());

  // 只允许访问本机 Dito 服务，外部链接交给系统浏览器
  const allowedOrigin = `http://127.0.0.1:${serverPort}`;
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault();
      if (url.startsWith("http://") || url.startsWith("https://")) shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(`${allowedOrigin}/?desktop=1`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function boot() {
  if (!fs.existsSync(PROMPT_BUNDLE)) {
    dialog.showErrorBox(
      "缺少加密提示词包",
      "未找到 desktop/prompts/dito-prompts.bin。\n\n请先在项目目录运行：\n  npm run desktop:encrypt-prompts\n然后重新启动桌面版。",
    );
    app.quit();
    return;
  }
  try {
    serverPort = await startServer();
  } catch (err) {
    dialog.showErrorBox(
      "Dito 桌面版启动失败",
      err instanceof Error ? err.message : String(err),
    );
    app.quit();
    return;
  }
  createWindow();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (serverProcess) {
      try {
        if (process.platform !== "win32") {
          process.kill(-serverProcess.pid, "SIGTERM");
        } else {
          serverProcess.kill();
        }
      } catch {
        try { serverProcess.kill(); } catch { /* ignore */ }
      }
      serverProcess = null;
    }
  });
}
