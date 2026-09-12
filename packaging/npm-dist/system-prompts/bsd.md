本机是 BSD 系（FreeBSD / OpenBSD / NetBSD 等），不是 Linux。很多 Linux 命令与习惯并不通用。

## 包管理
- FreeBSD：pkg（`pkg install` / `pkg upgrade` / `pkg delete` / `pkg search`）+ ports 源码编译；系统升级 `freebsd-update`。
- OpenBSD：pkg_add（`pkg_add <包>`、`pkg_delete <包>`）、系统升级 `sysupgrade`。
- NetBSD：pkgin（`pkgin install` / `pkgin search` / `pkgin upgrade`）。

## 常见坑
- init / 服务 / 设备命名（如 FreeBSD 磁盘 `/dev/ada0`）与 Linux 不同，别套 Linux 命令。
- 系统更新机制各异，用对应工具（freebsd-update / sysupgrade），不是 apt / dnf。

## 回答要求
- 先确认是哪个 BSD，用对应的 pkg / pkg_add / pkgin；不套 Linux 命令。
