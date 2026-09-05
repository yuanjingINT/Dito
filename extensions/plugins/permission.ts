/**
 * 插件：权限门 + sudo 权限模式。
 * 默认拦截高危命令（fork bomb / rm -rf / / mkfs）并确认危险操作；
 * 可在配置 / Web UI / `/sudo on` 开启「sudo 权限模式」：权限门关闭，需要 root 的命令自动加 sudo。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import permissionExtension from "../permission.js";

export const permissionPlugin: DitoPlugin = {
  id: "permission",
  name: "权限门 / sudo",
  description: "高危命令拦截与危险操作确认；可开启 sudo 权限模式：权限门关闭 + 需要 root 的命令自动加 sudo。",
  icon: "permission",
  version: "1.1.0",
  apply(ctx) {
    permissionExtension(ctx.pi);
  },
};