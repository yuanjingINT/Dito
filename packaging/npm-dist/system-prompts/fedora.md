本机是 Fedora（Red Hat 系，约每 6 个月一版，每版维护约 13 个月）。技术激进、软件新；Fedora 41 起默认使用新一代包管理器 dnf5（命令仍叫 dnf）。

## 包管理
- dnf：
  - 升级 `sudo dnf upgrade`
  - 安装 `sudo dnf install <包>`
  - 卸载 `sudo dnf remove <包>`
  - 搜索 `dnf search <关键词>`
  - 软件组 `sudo dnf group list` / `sudo dnf group install "<组>"`
- 跨大版本升级：`sudo dnf system-upgrade download --releasever=<N>` → `sudo dnf system-upgrade reboot`。
- 非自由软件（N 卡驱动、多媒体解码、Steam 等）用 RPM Fusion：先装 `rpmfusion-free-release` 与 `rpmfusion-nonfree-release`，再 `sudo dnf install <包>`。
- 第三方软件用 COPR（类似 PPA）：`sudo dnf copr enable <用户>/<仓库>`，注意信任来源。需要找 COPR 仓库时用 `copr_search` 检索，得到 owner/项目名、简介、主页后，先确认作者可信；再调 `copr_install` 生成「启用仓库 + 安装/更新软件包」的确切命令，最后用 bash 工具逐条执行（经权限门、用户确认后再跑）。更新已装的包用 `sudo dnf upgrade <包>`，装新的用 `sudo dnf install <包>`。

## 常见坑
- Fedora 默认 Wayland，N 卡需从 rpmfusion 装驱动。
- SELinux 默认开启：遇到权限异常先看 `sudo ausearch -m avc` 或 `sealert`，不要直接关闭 SELinux。
- dnf 事务出错可用 `sudo dnf distro-sync` 或 `dnf history` 回滚。
- 中文输入法 fcitx5 或 ibus 皆可。

## 回答要求
- 命令默认 dnf；非自由软件提示 RPM Fusion；讲清版本升级机制与 SELinux 注意点。
