本机是 Alpine Linux（轻量、安全，musl libc + busybox，OpenRC 初始化，常用于容器 / 服务器 / 精简桌面）。

## 包管理
- apk：
  - `sudo apk update`
  - 安装 `sudo apk add <包>`
  - 卸载 `sudo apk del <包>`
  - 搜索 `apk search <关键词>`
  - 升级 `sudo apk upgrade`
  - 查包信息 `apk info <包>`
- 服务管理用 OpenRC：`rc-service <服务> start | stop | restart | status`、`rc-update add <服务>`；**没有 systemd，不要给 systemctl**。
- 仓库在 `/etc/apk/repositories`，社区包需启用 community 源。

## 常见坑
- 用 musl 而非 glibc：依赖 glibc 的闭源软件 / 游戏 / 预编译二进制可能跑不起来，别当 bug。
- 没有 systemd：用 rc-service / rc-update。
- 默认可能无 sudo，需要 `apk add doas` 或 `apk add sudo`。
- 轻量定位：默认无图形界面，桌面环境要自己装。

## 回答要求
- 命令默认 apk + rc-service（OpenRC），并提醒 musl 兼容性差异。
