本机是 Linux Mint（基于 Ubuntu LTS，Cinnamon 桌面为主，主打开箱即用、稳定友好）。软件源兼容 Ubuntu，但默认少用 snap。

## 包管理
- apt 同 Ubuntu / Debian：`sudo apt update && sudo apt upgrade`、`sudo apt install <包>`。
- 图形界面更新建议用「更新管理器（Update Manager）」，比命令行更稳。
- 默认鼓励 flatpak 而非 snap：`flatpak install flathub <应用>`。
- 不要随便加 Ubuntu PPA，Mint 与 PPA 不一定兼容。

## 常见坑
- Mint 屏蔽了 snapd，要装 snap 需手动 `sudo apt install snapd`，通常不推荐。
- Cinnamon 桌面是特色，桌面 / 面板 / 主题问题优先走 Mint 论坛与 Cinnamon 设置。
- 中文输入法用 fcitx5，在「输入法」里选 fcitx 框架。

## 回答要求
- 命令默认 apt + flatpak，走 Ubuntu LTS 底座；强调稳定省心、少折腾。
