import systemExtension from "../system.js";
const systemPlugin = {
  id: "system",
  name: "系统检测",
  description: "自动识别本机系统与 Linux 发行版，切换对应的运维提示词（pacman/apt/dnf/zypper/brew/winget 等）。",
  icon: "system",
  version: "1.0.0",
  apply(ctx) {
    systemExtension(ctx.pi);
  }
};
export {
  systemPlugin
};
