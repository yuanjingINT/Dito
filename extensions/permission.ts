/**
 * Dito 权限门 + sudo 权限模式。
 *
 * 两种状态（配置 plugins.permission，或聊天里 `/sudo on|off` 切换，改动即时生效）：
 * - sudoMode = false（默认）：权限门开启——fork bomb / rm -rf / / mkfs 设备直接禁止；
 *   危险操作（rm -r、pacman -S、格式化等）在 TUI / 语音模式先向用户确认。
 * - sudoMode = true：权限门完全关闭，不再拦截/确认任何命令；同时 Dito 获得 sudo 权限——
 *   需要 root 的命令（装/卸软件、管理服务、挂载、用户管理等）自动在前面加 sudo（autoSudo，可关）。
 *
 * 每次工具调用 / 每轮开始都重新读取配置，因此 Web UI 或 `dito config` 改完即时生效。
 */
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { confirmViaVoice, hasVoiceConfirm } from "./voice-hooks.js";
import { loadConfig, saveConfig } from "./util.js";

// ── 权限门规则（仅非 sudo 模式生效） ────────────────────────────

// 无论如何都禁止（不询问）
const FORBIDDEN: RegExp[] = [
  /:\s*\(\s*\)\s*\{\s*:/, // fork bomb
  /rm\s+(-[a-z]*[rf][a-z]*\s+)+\/\s*(\*|\s|$)/, // rm -rf / 或 /*
  /mkfs[.\w]*\s+\/dev\//, // 直接格式化设备（高危，先拦）
];

// 需要确认的危险操作
const DANGEROUS: RegExp[] = [
  /\brm\s+-[a-z]*r/, // rm -r / rm -rf
  /\bdd\s+if=/, // dd 写盘
  /\bmkfs/, // 格式化
  /\bshutdown\b|\breboot\b|\bpoweroff\b|\binit\s+0\b/,
  /\bfdisk\b|\bparted\b|\bwipefs\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bpacman\s+-R|\byay\s+-R|\bparu\s+-R/, // 卸载软件
  /\bpacman\s+-S|\byay\s+-S|\bparu\s+-S/, // 安装软件（用户未明确指示时需确认）
  /\brm\s+-[a-z]*f[a-z]*\s/, // 其它强制删除
];

// ── sudo 模式：自动提权（autoSudo） ─────────────────────────────
// 命中这些模式且整体命令尚未提权时，自动在前面加 sudo。
// yay / paru 会自行向 pacman 提权（makepkg 还禁止 root），因此不在此列。
// 所有模式都要求目标命令出现在「命令位置」：行首或 ; & | ( ) 换行之后（允许空白），
// 避免把路径/参数里的词（如 /etc/passwd）误判成命令。
function cmdAt(tokens: string): RegExp {
  return new RegExp(`(^|[;|&()\\n])\\s*(${tokens})\\b`);
}

const NEEDS_ROOT: RegExp[] = [
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
  cmdAt("mkfs|fdisk|parted|wipefs|cfdisk"),
];

/** 命令已经以提权方式开头（sudo / doas / pkexec / su -c） */
const ELEVATED_PREFIX = /^\s*(sudo|doas|pkexec|su[\s-])/;
/** 命令里任意位置已经出现提权词（如 `echo x | sudo tee …`），不再重复加 */
const CONTAINS_ELEVATION = /\b(sudo|doas|pkexec|su\s+-)/;
/** 首词是 shell 内建/局部命令时不能整体套 sudo（会破坏语义），跳过自动提权 */
const SHELL_BUILTIN_FIRST =
  /^(?:cd|export|source|alias|unalias|set|unset|declare|typeset|local|shift|read|history|trap|ulimit|umask|wait|eval|exec|time|function|return|exit)\b/;

/** 判断一条命令是否需要 root；需要则返回加好提权前缀的命令，否则返回 null。 */
export function maybeElevate(
  command: string,
  sudoCommand: string = "sudo",
  enabled: boolean = true,
): string | null {
  const trimmed = command.trim();
  if (!enabled || !trimmed) return null;
  if (ELEVATED_PREFIX.test(trimmed)) return null;
  if (CONTAINS_ELEVATION.test(trimmed)) return null;
  if (SHELL_BUILTIN_FIRST.test(trimmed)) return null;
  // systemctl --user 是普通用户服务，不需要 root
  if (/\bsystemctl\s+--user\b/.test(trimmed)) return null;
  for (const re of NEEDS_ROOT) {
    if (re.test(trimmed)) return `${sudoCommand.trim() || "sudo"} ${trimmed}`;
  }
  return null;
}

// ── sudo 模式开关（共享状态 = 配置文件，即时生效） ────────────────

export function sudoModeEnabled(): boolean {
  try {
    return loadConfig().plugins.permission.sudoMode === true;
  } catch {
    return false;
  }
}

/** 切换 sudo 模式并写回配置。返回切换后的状态。 */
export function toggleSudoMode(next?: boolean): boolean {
  const cfg = loadConfig();
  const target = next ?? cfg.plugins.permission.sudoMode !== true;
  cfg.plugins.permission.sudoMode = target;
  saveConfig(cfg);
  return target;
}

// ── sudo 模式系统提示词 ─────────────────────────────────────────

function buildSudoModePrompt(): string {
  const p = loadConfig().plugins.permission;
  const sudoCmd = (p.sudoCommand || "sudo").trim();
  const lines = [
    "# Dito 权限：sudo 模式（已开启）",
    "- 你拥有 sudo 权限：需要 root 才能执行的命令（安装/卸载软件、管理服务、挂载、改系统配置、分区格式化等）可以直接执行，Dito 会自动帮这类命令加上 `" + sudoCmd + "`。",
    "- 权限门已关闭：危险命令不再弹确认、不再拦截。请结合用户明确指示并自行谨慎判断再执行，绝对禁忌依然要遵守。",
  ];
  if (p.autoSudo === false) {
    lines.push("- 自动加 sudo 已由用户关闭：需要 root 时请自己把命令写成 `" + sudoCmd + " …`。");
  }
  return lines.join("\n");
}

// ── 扩展入口 ─────────────────────────────────────────────────────

export default function permissionExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = (event.input as { command?: string }).command ?? "";
    const perm = loadConfig().plugins.permission;

    if (perm.sudoMode === true) {
      // sudo 模式：权限门关闭；需要 root 的命令自动提权（就地改写参数）
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
          const ok = await ctx.ui.confirm("危险操作，先跟你确认一下", `我准备执行：\n\n${command}\n\n这可能有风险，确定让我继续吗？`);
          if (!ok) return { block: true, reason: "你没点头，我就先不执行了" };
          return;
        }
        if (hasVoiceConfirm()) {
          // 语音模式：朗读命令 + 录音听取「确认/取消」
          const ok = await confirmViaVoice(`我准备执行命令：${command}。有点风险，要继续吗？请回答确认或取消。`);
          if (!ok) return { block: true, reason: "你没确认，我就不动了" };
          return;
        }
        return { block: true, reason: "这条命令有风险，现在不是交互模式，我没法跟你确认，先拦下了——换交互模式再来" };
      }
    }
  });

  // sudo 模式开启时，每轮把权限说明注入系统提示词
  pi.on("before_agent_start", (event) => {
    if (!sudoModeEnabled()) return undefined;
    const text = buildSudoModePrompt();
    if (event.systemPrompt.includes("# Dito 权限：sudo 模式")) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
  });

  pi.registerCommand("sudo", {
    description: "开启/关闭 sudo 权限模式：/sudo on | off（不带参数则切换）",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      let next: boolean | undefined;
      if (["on", "1", "开", "开启"].includes(arg)) next = true;
      else if (["off", "0", "关", "关闭"].includes(arg)) next = false;
      else if (arg !== "") {
        ctx.ui.notify("用法：/sudo on | off（开启/关闭 sudo 权限模式）", "info");
        return;
      }
      const on = toggleSudoMode(next);
      ctx.ui.notify(
        on
          ? "已开启 sudo 模式：权限门关闭，需要 root 的命令自动加 sudo"
          : "已关闭 sudo 模式：恢复权限门与危险命令确认",
        "info",
      );
    },
  });
}