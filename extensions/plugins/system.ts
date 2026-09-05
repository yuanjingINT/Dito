/**
 * 插件：系统检测。
 * 自动识别本机操作系统与 Linux 发行版，注入对应「系统专属运维提示词」，
 * 并提供 get_system_info 工具与 /system 命令。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import systemExtension from "../system.js";

export const systemPlugin: DitoPlugin = {
  id: "system",
  name: "系统检测",
  description: "自动识别本机系统与 Linux 发行版，切换对应的运维提示词（pacman/apt/dnf/zypper/brew/winget 等）。",
  icon: "system",
  version: "1.0.0",
  apply(ctx) {
    systemExtension(ctx.pi);
  },
};
