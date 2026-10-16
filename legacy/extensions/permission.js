import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { confirmViaVoice, hasVoiceConfirm } from "./voice-hooks.js";
import { loadConfig, saveConfig } from "./util.js";
const FORBIDDEN = [
  /:\s*\(\s*\)\s*\{\s*:/,
  // fork bomb
  /rm\s+(-[a-z]*[rf][a-z]*\s+)+\/\s*(\*|\s|$)/,
  // rm -rf / 或 /*
  /mkfs[.\w]*\s+\/dev\//
  // 直接格式化设备（高危，先拦）
];
const DANGEROUS = [
  /\brm\s+-[a-z]*r/,
  // rm -r / rm -rf
  /\bdd\s+if=/,
  // dd 写盘
  /\bmkfs/,
  // 格式化
  /\bshutdown\b|\breboot\b|\bpoweroff\b|\binit\s+0\b/,
  /\bfdisk\b|\bparted\b|\bwipefs\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bpacman\s+-R|\byay\s+-R|\bparu\s+-R/,
  // 卸载软件
  /\bpacman\s+-S|\byay\s+-S|\bparu\s+-S/,
  // 安装软件（用户未明确指示时需确认）
  /\brm\s+-[a-z]*f[a-z]*\s/
  // 其它强制删除
];
function cmdAt(tokens) {
  return new RegExp(`(^|[;|&()\\n])\\s*(${tokens})\\b`);
}
const NEEDS_ROOT = [
  // 包管理
  cmdAt("pacman|apt|apt-get|aptitude|dpkg|dnf|yum|zypper|apk|emerge|eopkg|guix"),
  cmdAt("snap\\s+(install|remove|refresh|revert|set)"),
  // 服务管理
  cmdAt("systemctl\\s+(start|stop|restart|reload|enable|disable|daemon-reload|mask|unmask|poweroff|reboot|halt)"),
  cmdAt("service\\s+\\S+\\s+(start|stop|restart|reload)"),
  cmdAt("rc-service\\s+\\S+\\s+(start|stop|restart)"),
  // 挂载 / 卸载
  cmdAt("mount|umount"),
  // 用户与权限（passwd 除外：`sudo passwd` 是改 root 密码，语义不同，让模型自己决定）
  cmdAt("useradd|usermod|userdel|groupadd|groupdel|chown|chgrp"),
  // 内核模块
  cmdAt("modprobe|insmod|rmmod"),
  // 系统工具
  cmdAt("grub-install|grub-mkconfig|update-grub|visudo|pacman-key"),
  // 磁盘分区 / 格式化（原危险清单，需要 root）
  cmdAt("mkfs|fdisk|parted|wipefs|cfdisk")
];
const ELEVATED_PREFIX = /^\s*(sudo|doas|pkexec|su[\s-])/;
const CONTAINS_ELEVATION = /\b(sudo|doas|pkexec|su\s+-)/;
const SHELL_BUILTIN_FIRST = /^(?:cd|export|source|alias|unalias|set|unset|declare|typeset|local|shift|read|history|trap|ulimit|umask|wait|eval|exec|time|function|return|exit)\b/;
function maybeElevate(command, sudoCommand = "sudo", enabled = true) {
  const trimmed = command.trim();
  if (!enabled || !trimmed) return null;
  if (process.platform === "win32") return null;
  if (ELEVATED_PREFIX.test(trimmed)) return null;
  if (CONTAINS_ELEVATION.test(trimmed)) return null;
  if (SHELL_BUILTIN_FIRST.test(trimmed)) return null;
  if (/\bsystemctl\s+--user\b/.test(trimmed)) return null;
  for (const re of NEEDS_ROOT) {
    if (re.test(trimmed)) return `${sudoCommand.trim() || "sudo"} ${trimmed}`;
  }
  return null;
}
function sudoModeEnabled() {
  try {
    return loadConfig().plugins.permission.sudoMode === true;
  } catch {
    return false;
  }
}
function toggleSudoMode(next) {
  if (process.platform === "win32") {
    console.error("Windows 没有 sudo：sudo 模式不可用（需要管理员权限的操作请以管理员身份运行终端）。");
    return false;
  }
  const cfg = loadConfig();
  const target = next ?? cfg.plugins.permission.sudoMode !== true;
  cfg.plugins.permission.sudoMode = target;
  saveConfig(cfg);
  return target;
}
function buildSudoModePrompt() {
  const p = loadConfig().plugins.permission;
  const sudoCmd = (p.sudoCommand || "sudo").trim();
  const lines = [
    "# Dito 权限：sudo 模式（已开启）",
    "- 你拥有 sudo 权限：需要 root 才能执行的命令（安装/卸载软件、管理服务、挂载、改系统配置、分区格式化等）可以直接执行，Dito 会自动帮这类命令加上 `" + sudoCmd + "`。",
    "- 权限门已关闭：危险命令不再弹确认、不再拦截。请结合用户明确指示并自行谨慎判断再执行，绝对禁忌依然要遵守。"
  ];
  if (p.autoSudo === false) {
    lines.push("- 自动加 sudo 已由用户关闭：需要 root 时请自己把命令写成 `" + sudoCmd + " …`。");
  }
  return lines.join("\n");
}
function permissionExtension(pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command ?? "";
    const perm = loadConfig().plugins.permission;
    if (perm.sudoMode === true) {
      const elevated = maybeElevate(command, perm.sudoCommand, perm.autoSudo !== false);
      if (elevated) event.input.command = elevated;
      return;
    }
    for (const re of FORBIDDEN) {
      if (re.test(command)) {
        return { block: true, reason: "这命令太危险了，按你的禁忌规则我不碰（rm -rf /、fork bomb、格式化设备这类直接拦下）" };
      }
    }
    for (const re of DANGEROUS) {
      if (re.test(command)) {
        if (ctx.mode === "tui") {
          const ok = await ctx.ui.confirm("危险操作，先跟你确认一下", `我准备执行：

${command}

这可能有风险，确定让我继续吗？`);
          if (!ok) return { block: true, reason: "你没点头，我就先不执行了" };
          return;
        }
        if (hasVoiceConfirm()) {
          const ok = await confirmViaVoice(`我准备执行命令：${command}。有点风险，要继续吗？请回答确认或取消。`);
          if (!ok) return { block: true, reason: "你没确认，我就不动了" };
          return;
        }
        return { block: true, reason: "这条命令有风险，现在不是交互模式，我没法跟你确认，先拦下了——换交互模式再来" };
      }
    }
  });
  pi.on("before_agent_start", (event) => {
    if (!sudoModeEnabled()) return void 0;
    const text = buildSudoModePrompt();
    if (event.systemPrompt.includes("# Dito 权限：sudo 模式")) return void 0;
    return { systemPrompt: `${event.systemPrompt}

${text}` };
  });
  pi.registerCommand("sudo", {
    description: "开启/关闭 sudo 权限模式：/sudo on | off（不带参数则切换）",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      let next;
      if (["on", "1", "开", "开启"].includes(arg)) next = true;
      else if (["off", "0", "关", "关闭"].includes(arg)) next = false;
      else if (arg !== "") {
        ctx.ui.notify("用法：/sudo on | off（开启/关闭 sudo 权限模式）", "info");
        return;
      }
      const on = toggleSudoMode(next);
      ctx.ui.notify(
        on ? "已开启 sudo 模式：权限门关闭，需要 root 的命令自动加 sudo" : "已关闭 sudo 模式：恢复权限门与危险命令确认",
        "info"
      );
    }
  });
}
export {
  permissionExtension as default,
  maybeElevate,
  sudoModeEnabled,
  toggleSudoMode
};
