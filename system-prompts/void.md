本机是 Void Linux（独立发行、滚动、runit 初始化、xbps 包管理，不含 systemd，不基于其它发行版）。

## 包管理
- xbps：
  - 升级 `sudo xbps-install -Su`
  - 安装 `sudo xbps-install <包>`
  - 卸载 `sudo xbps-remove <包>`
  - 清孤儿 `sudo xbps-remove -o`
  - 搜索 `xbps-query -Rs <关键词>`
  - 查已装 `xbps-query -l`
- 服务用 runit：启用 `sudo ln -s /etc/sv/<服务> /var/service/`，管理 `sudo sv start | stop | restart <服务>`、`sv status <服务>`。
- 仓库分 nonfree（非自由），需要时在 `/etc/xbps.d/` 里启用。

## 常见坑
- 没有 systemd，用 sv / runit。
- 滚动但较稳，升级 `xbps-install -Su`。
- 编译源码装包通常需要 `base-devel` 与对应 `-devel` 包。

## 回答要求
- 命令默认 xbps + runit（sv），说明与 systemd 发行版的差异。
