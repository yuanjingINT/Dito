import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { ROOT_DIR } from "./util.js";
import { readEncryptedPrompt } from "./prompt-crypto.js";
import { registerDistroTools } from "./distro-tools.js";
const SYSTEM_PROMPTS_DIR = join(ROOT_DIR, "system-prompts");
function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 4e3, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
function readFileIfExists(p) {
  try {
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  } catch {
    return "";
  }
}
function parseOsRelease() {
  const out = {};
  const raw = readFileIfExists("/etc/os-release") || readFileIfExists("/usr/lib/os-release");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}
const DISTRO_BY_ID = {
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
  void: "void"
};
const DISTRO_BY_LIKE = {
  arch: "arch",
  debian: "debian",
  ubuntu: "ubuntu",
  fedora: "fedora",
  rhel: "linux-generic",
  "opensuse": "opensuse",
  suse: "opensuse",
  gentoo: "gentoo"
};
function resolvePromptKey(id, idLike) {
  if (DISTRO_BY_ID[id]) return DISTRO_BY_ID[id];
  for (const like of idLike) {
    if (DISTRO_BY_LIKE[like]) return DISTRO_BY_LIKE[like];
  }
  return "linux-generic";
}
function detectPackageManager(id) {
  const hints = [
    ["pacman", ["pacman"]],
    ["apt", ["apt-get", "apt"]],
    ["dnf", ["dnf", "dnf5"]],
    ["yum", ["yum"]],
    ["zypper", ["zypper"]],
    ["emerge", ["emerge"]],
    ["apk", ["apk"]],
    ["xbps-install", ["xbps-install"]],
    ["nix", ["nix"]],
    ["eopkg", ["eopkg"]]
  ];
  for (const [name, bins] of hints) {
    for (const b of bins) {
      if (run(`command -v ${b}`)) return name;
    }
  }
  const byId = {
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
    void: "xbps-install"
  };
  return byId[id] || "未知";
}
function detectInitSystem() {
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
function detectSession() {
  let sessionType = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
  if (!sessionType) {
    if (process.env.WAYLAND_DISPLAY) sessionType = "wayland";
    else if (process.env.DISPLAY) sessionType = "x11";
  }
  const desktop = process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || "";
  return { sessionType: sessionType || "未知", desktop: desktop || "未知" };
}
function detectSystem() {
  const platform = process.platform;
  const kernel = run("uname -r");
  const arch = process.arch === "x64" ? "x86_64" : process.arch;
  if (platform === "darwin") {
    const version2 = run("sw_vers -productVersion");
    return {
      os: "macOS",
      promptKey: "macos",
      distroName: "macOS",
      prettyName: version2 ? `macOS ${version2}` : "macOS",
      version: version2,
      codename: "",
      kernel,
      arch,
      packageManager: "brew",
      initSystem: "launchd",
      sessionType: "aqua",
      desktop: "Aqua"
    };
  }
  if (platform === "win32") {
    const ver = run("cmd /c ver");
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
      desktop: "Windows 桌面"
    };
  }
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
      desktop: ""
    };
  }
  const rel = parseOsRelease();
  const id = (rel.ID || "").toLowerCase();
  const idLike = (rel.ID_LIKE || "").toLowerCase().split(/\s+/).filter(Boolean);
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
    desktop: session.desktop
  };
}
function readSystemPrompt(key) {
  const encrypted = readEncryptedPrompt("system-prompts", `${key}.md`);
  if (encrypted !== null) return encrypted;
  if (process.env.DITO_DESKTOP === "1") return "";
  return readFileIfExists(join(SYSTEM_PROMPTS_DIR, `${key}.md`));
}
function buildSystemPrompt(info) {
  const distroLabel = [info.distroName, info.version, info.codename && `[${info.codename}]`].filter(Boolean).join(" ");
  const facts = [
    `- 操作系统：${info.os}`,
    `- 发行版：${distroLabel}`,
    `- 内核：${info.kernel || "未知"}`,
    `- 架构：${info.arch}`,
    `- 包管理器：${info.packageManager}`,
    `- 初始化系统：${info.initSystem}`,
    `- 会话类型：${info.sessionType || "未知"}${info.desktop && info.desktop !== "未知" ? `（${info.desktop}）` : ""}`
  ].join("\n");
  const body = readSystemPrompt(info.promptKey) || readSystemPrompt("linux-generic");
  const parts = ["# 本机运行环境（自动检测，只读事实，供你判断用）", facts];
  if (body) {
    parts.push("", `# 「${info.distroName}」专属运维提示词`, body);
  }
  return parts.join("\n");
}
let cachedInfo = null;
function getSystemInfo() {
  if (!cachedInfo) cachedInfo = detectSystem();
  return cachedInfo;
}
function systemExtension(pi) {
  if (process.platform === "linux") {
    registerDistroTools(pi);
  }
  pi.on("before_agent_start", (event) => {
    const info = getSystemInfo();
    const text = buildSystemPrompt(info);
    const marker = "# 本机运行环境（自动检测";
    if (event.systemPrompt.includes(marker)) return void 0;
    return { systemPrompt: `${event.systemPrompt}

${text}` };
  });
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
        details: { ...info }
      };
    }
  });
  pi.registerCommand("system", {
    description: "显示本机系统信息与命中的发行版提示词：/system",
    handler: async (_args, ctx) => {
      const info = getSystemInfo();
      ctx.ui.notify(`本机：${info.prettyName || info.distroName}（命中提示词 ${info.promptKey}.md）`, "info");
    }
  });
}
export {
  SYSTEM_PROMPTS_DIR,
  buildSystemPrompt,
  systemExtension as default,
  detectSystem,
  getSystemInfo
};
