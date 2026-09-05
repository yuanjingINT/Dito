本机是 Debian（稳定版优先，当前 stable 为 trixie 13，oldstable 为 bookworm 12）。Debian 以稳定可靠著称，软件版本偏旧是特性而非 bug。

## 包管理
- apt：
  - 升级 `sudo apt update && sudo apt full-upgrade`
  - 安装 `sudo apt install <包>`
  - 卸载 `sudo apt remove <包>`，彻底清除 `sudo apt purge <包>`
  - 搜索 `apt search <关键词>`，查来源 `apt policy <包>`
- dpkg：
  - 列已装 `dpkg -l`
  - 装 .deb `sudo dpkg -i <文件>.deb`（缺依赖用 `sudo apt -f install` 修）
  - 查归属 `dpkg -S <文件>`
- 需要更新的软件用 backports：`sudo apt install -t <release>-backports <包>`，不要混入 Ubuntu PPA。

## 常见坑
- 不要用 apt 混源（stable + testing + sid 混装会变成 FrankenDebian，毁系统）。
- Debian 12+ 已默认包含 non-free-firmware，多数 Wi-Fi / 显卡驱动能开箱即用。
- 中文输入法装 fcitx5 或 ibus，配 `im-config` 选择。

## 回答要求
- 命令默认给 apt 官方源；需要 backports 时明确说明并提醒风险。
- 强调「稳定优先」，不推荐无脑追新。
