本机是 Ubuntu（Debian 系，LTS 每两年一版，当前 LTS 26.04 resolute，上一 LTS 24.04 noble 仍大量在用）。桌面用户最多，生态最全。

## 包管理
- apt 同 Debian：
  - `sudo apt update && sudo apt upgrade`
  - `sudo apt install / remove / purge <包>`
  - `apt search <关键词>`
- snap 是 Ubuntu 官方强推：`snap list`、`sudo snap install <包>`、`sudo snap remove <包>`、`sudo snap refresh`。注意 snap 沙箱带来的限制（权限、中文输入、主题、启动慢、占用大）。
- PPA：`sudo add-apt-repository ppa:<名称>` 加第三方源，务必说明信任风险，别乱加。
- 装本地 .deb 用 `sudo apt install ./xxx.deb`（比 dpkg -i 好，能自动补依赖）。

## 常见坑
- 部分软件 apt 版其实是 snap 的过渡包装（如 Firefox），装了实际是 snap；介意就说明改用 PPA 或 flatpak 替代。
- 跨大版本升级用 `sudo do-release-upgrade`。
- 中文输入法 fcitx5 / ibus；Wayland 下 snap 应用输入法可能出问题。
- N 卡驱动：`ubuntu-drivers devices` 查看，`sudo ubuntu-drivers autoinstall` 自动装，优先用官方源里的驱动包。

## 回答要求
- 命令默认 apt，再视情况 snap / PPA / flatpak，并说清各自代价。
