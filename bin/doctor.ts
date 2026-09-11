/**
 * Dito 环境体检（dito doctor）。
 *
 * 一键检查：Node 版本与 node:sqlite、配置完整性、模型连通性、
 * 录音/STT/TTS 依赖、中继/频道状态、MCP 配置。每项给「通过 / 告警 / 失败」
 * 与修复建议，退出码 0 = 全部通过或有告警，1 = 有失败项。
 * GPL-3.0-only，见仓库 LICENSE。
 */
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { loadConfig, ditoDataDir, ditoConfigPath, agentDir } from "../extensions/util.js";
import { detectSystem } from "../extensions/system.js";
import { expand, detectRecorder } from "../extensions/voice.js";

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
  hint?: string;
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  bold: "\x1b[1m",
};
const MARK: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };
const COLOR: Record<Status, string> = { ok: C.green, warn: C.yellow, fail: C.red };

function check(name: string, status: Status, detail: string, hint?: string): Check {
  return { name, status, detail, hint };
}

function whichSync(cmd: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const exts = platform() === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(platform() === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function fileExists(cmd: string): boolean {
  if (cmd.startsWith("/")) return existsSync(cmd);
  return whichSync(cmd) !== null;
}

export async function runDoctor(): Promise<void> {
  // --ci：CI/脚本用，失败项不改变退出码（只看报告）
  const ciMode = process.argv.includes("--ci") || process.argv.includes("-c");
  const checks: Check[] = [];

  // ── 运行时 ──────────────────────────────────────────────────────
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    checks.push(check("Node 版本", "fail", `当前 ${process.versions.node}`, "需要 Node ≥ 22.5（node:sqlite）"));
  } else if (maj < 24 && (maj < 23 || min < 4)) {
    checks.push(check("Node 版本", "ok", `${process.versions.node}（node:sqlite 需 experimental flag，启动器已自动加）`));
  } else {
    checks.push(check("Node 版本", "ok", process.versions.node));
  }

  // ── 系统 ────────────────────────────────────────────────────────
  const info = detectSystem();
  checks.push(
    check("系统识别", "ok", `${info.prettyName || info.distroName} · ${info.arch} · ${info.desktop || info.sessionType || info.initSystem}`),
  );

  // ── 配置 ────────────────────────────────────────────────────────
  let cfg;
  try {
    cfg = loadConfig();
    checks.push(check("配置文件", "ok", ditoConfigPath()));
  } catch (err) {
    checks.push(check("配置文件", "fail", `读取失败：${(err as Error).message}`, `检查 ${ditoConfigPath()} 是否为合法 JSON`));
    printReport(checks);
    process.exit(1);
  }

  // ── 数据目录 ────────────────────────────────────────────────────
  const dataDir = ditoDataDir();
  const dirsOk = existsSync(dataDir);
  checks.push(
    check("数据目录", dirsOk ? "ok" : "warn", dataDir, dirsOk ? undefined : "首次运行对话后自动创建"),
  );

  // ── pi 共享鉴权 ─────────────────────────────────────────────────
  const authPath = join(agentDir(), "auth.json");
  checks.push(
    check("pi 鉴权文件", existsSync(authPath) ? "ok" : "warn", authPath, existsSync(authPath) ? undefined : "使用需要 Key 的供应商时需配置（opencode 免费模型不需要）"),
  );

  // ── 模型 ────────────────────────────────────────────────────────
  const provider = cfg.providers.find((p) => p.id === cfg.model.provider);
  if (!provider) {
    checks.push(check("模型供应商", "fail", `配置的 provider「${cfg.model.provider}」不存在`, "dito config → 模型与供应商"));
  } else {
    const key = (provider.apiKey ?? "").trim();
    const envRef = key.startsWith("$");
    const resolved = envRef ? (process.env[key.slice(1)] ?? "").trim() : key;
    const freeProvider = provider.id === "opencode-free";
    checks.push(
      check(
        "模型供应商",
        resolved || freeProvider ? "ok" : "warn",
        `${provider.name} · 聊天 ${cfg.model.chat} · 视觉 ${cfg.model.vision}`,
        resolved || freeProvider ? undefined : "API Key 为空（$ENV 引用未解析）：免费模型可忽略，付费模型需配 Key",
      ),
    );
  }

  // ── 语音 ────────────────────────────────────────────────────────
  const voice = cfg.plugins.voice;
  if (voice?.enabled) {
    const recorder = detectRecorder();
    checks.push(
      check(
        "音频录制",
        recorder ? "ok" : "fail",
        recorder || "不可用",
        recorder ? undefined : platform() === "win32" || platform() === "darwin" ? "安装 ffmpeg 并加入 PATH" : "安装 pipewire（pw-record）或 pulseaudio（parec）或 alsa-utils（arecord）",
      ),
    );
    if (voice.stt === "xiaomi") {
      checks.push(
        check("STT（MiMo ASR）", voice.xiaomiApiKey?.trim() ? "ok" : "fail", voice.xiaomiApiKey?.trim() ? `${voice.xiaomiAsrModel}` : "未配置 Key", voice.xiaomiApiKey?.trim() ? undefined : "dito config → 语音 → 小米 API Key"),
      );
    } else if (voice.stt === "whisper") {
      const model = expand(voice.whisperModel);
      const ok = !!model && existsSync(model);
      checks.push(check("STT（whisper）", ok ? "ok" : "warn", model || "模型未下载", ok ? undefined : "模型文件不存在：语音模式首次使用会尝试，或手动下载 ggml 模型到该路径"));
    } else if (voice.stt === "custom") {
      checks.push(check("STT（自定义）", voice.customSttCommand ? "ok" : "warn", voice.customSttCommand || "未配置命令"));
    }
    const ttsBin = voice.tts === "espeak" ? "espeak-ng" : voice.tts === "piper" ? "piper" : null;
    if (voice.tts === "xiaomi") {
      checks.push(check("TTS（MiMo）", voice.xiaomiApiKey?.trim() ? "ok" : "fail", voice.xiaomiTtsModel));
    } else if (ttsBin) {
      checks.push(check(`TTS（${voice.tts}）`, fileExists(ttsBin) ? "ok" : "warn", ttsBin, fileExists(ttsBin) ? undefined : `未安装 ${ttsBin}：` + (platform() === "darwin" ? "brew install" : platform() === "win32" ? "winget install" : "pacman/dnf/apt 安装")));
    }
  }

  // ── 频道 ────────────────────────────────────────────────────────
  if (cfg.channels.qq.enabled) {
    checks.push(check("QQ 频道", "ok", `SnowLuma ${cfg.channels.qq.url} · 主人 ${cfg.channels.qq.owners.join("/") || "未配置"}`));
  }
  if (cfg.channels.matrix.enabled) {
    checks.push(check("Matrix 频道", cfg.channels.matrix.accessToken ? "ok" : "warn", cfg.channels.matrix.homeserver, cfg.channels.matrix.accessToken ? undefined : "Access Token 未填"));
  }
  if (cfg.channels.mobile.enabled || cfg.channels.mobile.devices.length > 0) {
    checks.push(
      check(
        "手机频道",
        "ok",
        `${cfg.channels.mobile.relayUrl || "局域网模式（内嵌中继）"} · 已配对 ${cfg.channels.mobile.devices.length} 台`,
      ),
    );
  }

  // ── MCP ─────────────────────────────────────────────────────────
  if (cfg.plugins.mcp?.enabled) {
    const s = cfg.plugins.mcp.server;
    checks.push(
      check("MCP", "ok", s.enabled ? `对外暴露 @127.0.0.1:${s.port}${s.allowBash ? " · pc_bash 开" : ""} · 外部服务器 ${cfg.plugins.mcp.clients.length} 个` : "仅接入模式"),
    );
  }

  // ── 常用外部命令 ────────────────────────────────────────────────
  if (platform() === "linux") {
    checks.push(check("ImageMagick（QQ 长文转图）", fileExists("magick") || fileExists("convert") ? "ok" : "warn", fileExists("magick") || fileExists("convert") ? "可用" : "未安装（QQ 频道长回复退化为纯文本）"));
  }

  // ── 报告 ────────────────────────────────────────────────────────
  printReport(checks);
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  console.log(
    `\n${C.bold}体检结果：${C.reset}` +
      checks.filter((c) => c.status === "ok").length + " 通过 · " +
      `${COLOR.warn}${checks.filter((c) => c.status === "warn").length} 告警${C.reset} · ` +
      `${COLOR.fail}${checks.filter((c) => c.status === "fail").length} 失败${C.reset}` +
      (hasWarn && !hasFail ? `\n${C.dim}（告警不阻塞使用，按提示补齐即可）${C.reset}` : ""),
  );
  process.exit(hasFail && !ciMode ? 1 : 0);
}

function printReport(checks: Check[]): void {
  console.log(`\n${C.bold}◈ Dito 体检（${platform()}）${C.reset}\n`);
  for (const c of checks) {
    const color = COLOR[c.status];
    console.log(`  ${color}${MARK[c.status]}${C.reset} ${c.name}${C.dim} — ${c.detail}${C.reset}`);
    if (c.hint) console.log(`    ${C.dim}↳ ${c.hint}${C.reset}`);
  }
}
