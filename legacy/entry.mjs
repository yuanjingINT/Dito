#!/usr/bin/env node
// Optional compatibility entry, launched by the native C executable.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./register-loader.mjs";

// Preserve C's isolated --scope send form when a model needs SDK/OAuth support.
const literalAt = process.argv.indexOf("--", 2);
const candidateScope = process.argv.indexOf("--scope", 2);
const scopeAt = literalAt >= 0 && candidateScope > literalAt ? -1 : candidateScope;
if (scopeAt >= 0) {
  const scope = process.argv[scopeAt + 1];
  if (!scope || scope.includes("/") || scope.includes("..")) {
    console.error("会话 scope 无效");
    process.exit(2);
  }
  process.env.DITO_MEMORY_SCOPE = scope;
  process.argv.splice(scopeAt, 2);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error("兼容功能需要 Node ≥ 22.5；C 终端本身不需要 Node。");
  process.exit(1);
}
if (major < 24 && (major < 23 || minor < 4) && !process.execArgv.includes("--experimental-sqlite")) {
  const child = spawnSync(process.execPath, [...process.execArgv, "--experimental-sqlite", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}

try {
  if (process.argv[2] === "--subagent") {
    await import("./subagent-bridge.mjs");
  } else if (process.argv[2] === "--tool") {
    await import("./tool-bridge.mjs");
  } else if (["--help", "-h"].includes(process.argv[2])) {
    console.log("Dito JavaScript 兼容层：dito legacy [旧版命令]\n无参数恢复完整旧版终端；config/plugins/qq/qqadmin/matrix/mobile/bridge/voice/relay。\n--check 离线模块检查；--version 版本。无需 TS 或 tsx。");
  } else if (process.argv[2] === "--version") {
    console.log("Dito 0.3.0-alpha · JavaScript compatibility bridge");
  } else if (process.argv[2] === "--check") {
    await import("./check.mjs");
  } else if (process.argv[2] === "relay") {
    const { startRelay } = await import("./relay/server.mjs");
    const args = process.argv.slice(3);
    const arg = (name, fallback) => {
      const index = args.indexOf(`--${name}`);
      return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
    };
    const port = Number(arg("port", "8787"));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("relay 端口无效");
    await startRelay({ port, host: arg("host"), baseUrl: arg("base-url"), pwaDir: arg("pwa-dir"), log: (message) => console.log(`[relay] ${message}`) });
  } else {
    await import("./bin/dito.js");
  }
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") {
    console.error("兼容依赖缺失。请运行 packaging/install-native.sh 安装，或在 legacy 目录运行 npm ci --omit=dev。");
  } else console.error(error?.message || String(error));
  process.exitCode = 1;
}
