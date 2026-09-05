/**
 * Dito 系统检测：自动识别当前操作系统与 Linux 发行版，
 * 并注入对应的「系统专属运维提示词」，让 Dito 的回答贴合本机环境。
 *
 * 检测只读、无副作用：读 /etc/os-release、uname、环境变量与常用命令探测。
 * 结果进程内缓存一次；提示词文件在 system-prompts/ 目录，按发行版 key 命名。
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ROOT_DIR } from "./util.js";
import { readEncryptedPrompt } from "./prompt-crypto.js";
import { registerDistroTools } from "./distro-tools.js";

export const SYSTEM_PROMPTS_DIR = join(ROOT_DIR, "system-prompts");

export interface SystemInfo {
  /** 操作系统大类：Linux / macOS / Windows / FreeBSD ... */
  os: string;
  /** 提示词文件 key（对应 system-prompts/<key>.md，不含扩展名） */
  promptKey: string;
  /** 人类可读发行版名，如 Arch Linux / Ubuntu */
  distroName: string;
  /** os-release 的 PRETTY_NAME */
  prettyName: string;
  /** 版本号或 codename */
  version: string;
  codename: string;
  kernel: string;
  arch: string;
  packageManager: string;
  initSystem: string;
  sessionType: string;
  desktop: string;
}

// ── 只读探测工具 ──────────────────────────────────────────────

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function readFileIfExists(p: string): string {
  try {
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  } catch {
    return "";
  }
}

function parseOsRelease(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileIfExists("/etc/os-release") || readFileIfExists("/usr/lib/os-release");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// ── 发行版识别映射 ────────────────────────────────────────────

/** os-release ID → 提示词 key。优先精确匹配，再走 ID_LIKE。 */
const DISTRO_BY_ID: Record<string, string> = {
  arch: "arch",
  archarm: "arch",
  manjaro: "arch",
  endeavouros: "arch",
  cachyos: "arch",
  garuda: "arch",
  artix: "arch",
  arcolinux: "arch",
  debian: "debian",
  raspbian: "debian",
  devuan: "debian",
  pureos: "debian",
  kali: "debian",
  ubuntu: "ubuntu",
  pop: "ubuntu",
  elementary: "ubuntu",
  zorin: "ubuntu",
  kubuntu: "ubuntu",
  xubuntu: "ubuntu",
  lubuntu: "ubuntu",
  "ubuntu-mate": "ubuntu",
  "ubuntu-budgie": "ubuntu",
  neon: "ubuntu",
  linuxmint: "linuxmint",
  fedora: "fedora",
  nobara: "fedora",
  ultramarine: "fedora",
  silverblue: "fedora",
  kinoite: "fedora",
  opensuse: "opensuse",
  "opensuse-tumbleweed": "opensuse",
  "opensuse-leap": "opensuse",
  "opensuse-microos": "opensuse",
  sles: "opensuse",
  sled: "opensuse",
  gentoo: "gentoo",
  funtoo: "gentoo",
  nixos: "nixos",
  alpine: "alpine",
  void: "void",
};

/** os-release ID_LIKE → 提示词 key（精确 ID 未命中时的兜底）。 */
const DISTRO_BY_LIKE: Record<string, string> = {
  arch: "arch",
  debian: "debian",
  ubuntu: "ubuntu",
  fedora: "fedora",
  rhel: "linux-generic",
  "opensuse": "opensuse",
  suse: "opensuse",
  gentoo: "gentoo",
};

function resolvePromptKey(id: string, idLike: string[]): string {
  if (DISTRO_BY_ID[id]) return DISTRO_BY_ID[id];
  for (const like of idLike) {
    if (DISTRO_BY_LIKE[like]) return DISTRO_BY_LIKE[like];
  }
  return "linux-generic";
}

// ── 子探测 ────────────────────────────────────────────────────

function detectPackageManager(id: string): string {
  const hints: Array<[string, string[]]> = [
    ["pacman", ["pacman"]],
    ["apt", ["apt-get", "apt"]],
    ["dnf", ["dnf", "dnf5"]],
    ["yum", ["yum"]],
    ["zypper", ["zypper"]],
    ["emerge", ["emerge"]],
    ["apk", ["apk"]],
    ["xbps-install", ["xbps-install"]],
    ["nix", ["nix"]],
    ["eopkg", ["eopkg"]],
  ];
  for (const [name, bins] of hints) {
    for (const b of bins) {
      if (run(`command -v ${b}`)) return name;
    }
  }
  const byId: Record<string, string> = {
    arch: "pacman",
    manjaro: "pacman",
    debian: "apt",
    ubuntu: "apt",
    linuxmint: "apt",
    fedora: "dnf",
    opensuse: "zypper",
    gentoo: "emerge",
    nixos: "nix",
    alpine: "apk",
    void: "xbps-install",
  };
  return byId[id] || "未知";
}

function detectInitSystem(): string {
  const exe = run("readlink /proc/1/exe");
  const cmdline = readFileIfExists("/proc/1/cmdline").replace(/\0/g, " ").trim();
  if (exe.includes("systemd") || cmdline.includes("systemd") || run("command -v systemctl")) return "systemd";
  if (exe.includes("openrc") || run("command -v rc-service")) return "OpenRC";
  if (exe.includes("runit") || run("command -v sv")) return "runit";
  if (exe.includes("s6")) return "s6";
  if (exe.includes("dinit")) return "dinit";
  if (exe.includes("launchd") || run("command -v launchctl")) return "launchd";
  return "未知";
}

function detectSession(): { sessionType: string; desktop: string } {
  let sessionType = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
  if (!sessionType) {
    if (process.env.WAYLAND_DISPLAY) sessionType = "wayland";
    else if (process.env.DISPLAY) sessionType = "x11";
  }
  const desktop = process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || "";
  return { sessionType: sessionType || "未知", desktop: desktop || "未知" };
}

// ── 主检测 ────────────────────────────────────────────────────

export function detectSystem(): SystemInfo {
  const platform = process.platform;
  const kernel = run("uname -r");
  const arch = process.arch === "x64" ? "x86_64" : process.arch;

  // macOS
  if (platform === "darwin") {
    const version = run("sw_vers -productVersion");
    return {
      os: "macOS",
      promptKey: "macos",
      distroName: "macOS",
      prettyName: version ? `macOS ${version}` : "macOS",
      version,
      codename: "",
      kernel,
      arch,
      packageManager: "brew",
      initSystem: "launchd",
      sessionType: "aqua",
      desktop: "Aqua",
    };
  }

  // Windows
  if (platform === "win32") {
    const ver = run("cmd /c ver"); // e.g. Microsoft Windows [Version 10.0.26100.xxxx]
    return {
      os: "Windows",
      promptKey: "windows",
      distroName: "Windows",
      prettyName: ver || "Windows",
      version: "",
      codename: "",
      kernel,
      arch,
      packageManager: "winget",
      initSystem: "Windows 服务",
      sessionType: "桌面",
      desktop: "Windows 桌面",
    };
  }

  // BSD 系
  if (["freebsd", "openbsd", "netbsd", "dragonfly"].includes(platform)) {
    return {
      os: platform.charAt(0).toUpperCase() + platform.slice(1),
      promptKey: "bsd",
      distroName: platform.charAt(0).toUpperCase() + platform.slice(1),
      prettyName: run("uname -sr") || platform,
      version: run("uname -r"),
      codename: "",
      kernel: kernel || run("uname -sr"),
      arch,
      packageManager: platform === "openbsd" ? "pkg_add" : platform === "netbsd" ? "pkgin" : "pkg",
      initSystem: "未知",
      sessionType: "",
      desktop: "",
    };
  }

  // Linux（含其它类 Unix 的兜底）
  const rel = parseOsRelease();
  const id = (rel.ID || "").toLowerCase();
  const idLike = (rel.ID_LIKE || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const promptKey = id ? resolvePromptKey(id, idLike) : "linux-generic";
  const distroName = rel.NAME || rel.PRETTY_NAME || "Linux";
  const version = rel.VERSION_ID || rel.VERSION || "";
  const codename = rel.VERSION_CODENAME || "";
  const session = detectSession();

  return {
    os: id ? "Linux" : platform,
    promptKey,
    distroName,
    prettyName: rel.PRETTY_NAME || distroName,
    version,
    codename,
    kernel,
    arch,
    packageManager: detectPackageManager(id),
    initSystem: detectInitSystem(),
    sessionType: session.sessionType,
    desktop: session.desktop,
  };
}

// ── 提示词组装 ────────────────────────────────────────────────

function readSystemPrompt(key: string): string {
  const encrypted = readEncryptedPrompt("system-prompts", `${key}.md`);
  if (encrypted !== null) return encrypted;
  if (process.env.DITO_DESKTOP === "1") return "";
  return readFileIfExists(join(SYSTEM_PROMPTS_DIR, `${key}.md`));
}

export function buildSystemPrompt(info: SystemInfo): string {
  const distroLabel = [info.distroName, info.version, info.codename && `[${info.codename}]`].filter(Boolean).join(" ");
  const facts = [
    `- 操作系统：${info.os}`,
    `- 发行版：${distroLabel}`,
    `- 内核：${info.kernel || "未知"}`,
    `- 架构：${info.arch}`,
    `- 包管理器：${info.packageManager}`,
    `- 初始化系统：${info.initSystem}`,
    `- 会话类型：${info.sessionType || "未知"}${info.desktop && info.desktop !== "未知" ? `（${info.desktop}）` : ""}`,
  ].join("\n");

  const body = readSystemPrompt(info.promptKey) || readSystemPrompt("linux-generic");
  const parts = ["# 本机运行环境（自动检测，只读事实，供你判断用）", facts];
  if (body) {
    parts.push("", `# 「${info.distroName}」专属运维提示词`, body);
  }
  return parts.join("\n");
}

// ── 扩展入口 ──────────────────────────────────────────────────

let cachedInfo: SystemInfo | null = null;

/** 获取（并缓存）本机系统信息。 */
export function getSystemInfo(): SystemInfo {
  if (!cachedInfo) cachedInfo = detectSystem();
  return cachedInfo;
}

export default function systemExtension(pi: ExtensionAPI): void {
  // 发行版专属联网工具：AUR 搜索/红绿灯审查、COPR 仓库检索。
  registerDistroTools(pi);

  // 每轮把「本机环境 + 发行版专属提示词」追加到系统提示词。
  pi.on("before_agent_start", (event) => {
    const info = getSystemInfo();
    const text = buildSystemPrompt(info);
    const marker = "# 本机运行环境（自动检测";
    // 幂等：避免同一轮被多次注入
    if (event.systemPrompt.includes(marker)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
  });

  // 只读工具：让模型在需要时主动查询本机环境事实。
  pi.registerTool({
    name: "get_system_info",
    label: "查询本机系统信息",
    description: "返回自动检测到的本机操作系统、Linux 发行版、内核、架构、包管理器、初始化系统、会话类型等信息（只读）。",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute() {
      const info = getSystemInfo();
      return {
        content: [{ type: "text", text: buildSystemPrompt(info) }],
        details: { ...info },
      };
    },
  });

  pi.registerCommand("system", {
    description: "显示本机系统信息与命中的发行版提示词：/system",
    handler: async (_args, ctx) => {
      const info = getSystemInfo();
      ctx.ui.notify(`本机：${info.prettyName || info.distroName}（命中提示词 ${info.promptKey}.md）`, "info");
    },
  });
}
