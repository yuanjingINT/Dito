/**
 * Dito 桌面版启动器：找到 Electron 二进制后运行 `electron .`
 * 优先使用本地 node_modules/electron（若有系统 Electron 发行版则复用其 dist），
 * 其次回退到 PATH 中的 electron。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

// 常见系统 Electron 发行版目录，npm 包 electron 可直接复用，避免重复下载 Electron 二进制。
const SYSTEM_DIST_DIRS = [
  "/usr/lib/electron43",
  "/usr/lib/electron42",
  "/usr/lib/electron",
];

if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
  for (const dir of SYSTEM_DIST_DIRS) {
    if (fs.existsSync(path.join(dir, "electron"))) {
      process.env.ELECTRON_OVERRIDE_DIST_PATH = dir;
      break;
    }
  }
}

let electronBin;
try {
  // 本地 node_modules 安装了 electron 包时，require('electron') 返回 Electron 可执行文件路径。
  electronBin = require("electron");
} catch {
  electronBin = "electron"; // 回退到系统 PATH
}

const child = spawn(electronBin, [".", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

child.on("error", (err) => {
  console.error("[Dito Desktop] 无法启动 Electron：", err.message);
  console.error("请安装 Electron：npm install --save-dev electron");
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
