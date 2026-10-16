import permissionExtension from "../permission.js";
const permissionPlugin = {
  id: "permission",
  name: "权限门 / sudo",
  description: "高危命令拦截与危险操作确认；可开启 sudo 权限模式：权限门关闭 + 需要 root 的命令自动加 sudo。",
  icon: "permission",
  version: "1.1.0",
  apply(ctx) {
    permissionExtension(ctx.pi);
  }
};
export {
  permissionPlugin
};
