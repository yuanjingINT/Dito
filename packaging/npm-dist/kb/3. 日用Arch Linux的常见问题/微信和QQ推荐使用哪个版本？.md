腾讯现在都有官方的 Linux 版本了，推荐直接用官方包：

- QQ：官方基于 Electron（NT 架构）的版本，AUR 包名是 `linuxqq`。
- 微信：2024 年 3 月腾讯推出了基于原生跨平台方案（Universal）的微信，功能与 Windows/Mac 版逐步对齐。AUR 上原版打包为 `wechat-bin`，另有 `wechat` 包提供进程管理、可选沙盒、输入法及 HiDPI 修复等增强功能。也可以用 Flatpak 从 Flathub 安装 `com.tencent.WeChat`。

如果要沙箱可以试试 `linuxqq-nt-bwrap` 和 `wechat-universal-bwrap`，这两个包用 bubblewrap 做了沙盒封装。

shorin 用的是 `linuxqq-appimage` 和 `wechat-appimage` 这两个包，是 appimage 版本的，没有遇到过什么问题。如果 wayland 运行 qq 出现了剪贴板问题可以试试 `linuxqq-clipsync-git` 这个包。
