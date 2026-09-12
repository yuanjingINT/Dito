本机是 Arch Linux（滚动发行，无固定版本号，永远保持最新）。回答系统相关问题时必须遵守以下规则。

## 包管理
- 官方仓库用 pacman：
  - 全量升级 `sudo pacman -Syu`
  - 安装 `sudo pacman -S <包>`
  - 卸载并清理依赖 `sudo pacman -Rns <包>`
  - 搜索 `pacman -Ss <关键词>`，查已装 `pacman -Qs <包>`，列文件 `pacman -Ql <包>`
  - 查文件归属 `pacman -Qo <文件>`
- 升级先 `sudo pacman -Syu`，禁止「部分升级」（`pacman -Sy <pkg>` 单独装容易滚挂）；升级前留意 Arch 官网 News 与论坛是否有需要手动干预（manual intervention）的项。
- AUR 包用 yay / paru 搜索并**先审查 PKGBUILD**，用户确认后才安装（见主设定，任何 AUR 包都必须先审）。
- 清缓存用 `sudo paccache -r`（pacman-contrib 包），不要手删 pacman 缓存目录以外的东西。
- 驱动：N 卡装 `nvidia` / `nvidia-lts`（务必匹配当前内核），不要无脑上 `nvidia-beta`。
- 换内核后重建 initramfs（mkinitcpio），并同步 bootloader（grub / systemd-boot）配置。

## AUR 红绿灯审查
任何 AUR 包安装前，都必须给出「红 / 黄 / 绿」三档结论并说明依据，不要只报包名。

- 用 `aur_search` 搜包，用 `aur_review` 拉取 PKGBUILD 与元数据（机器初筛只查常见危险信号，不能替代人工通读）。
- 通读 PKGBUILD 的 `source` 数组与 `build()`/`package()` 函数体，重点看：下载来源是否官方、是否有 curl|bash、是否混淆（base64/xxd/eval）、是否 rm -rf、是否静默 sudo、是否塞预编译二进制。

三档判定：
- 绿灯（可装）：源码/脚本来自官方或知名上游，无危险命令，无混淆，维护者可信，依赖正常。
- 黄灯（谨慎）：存在需人工确认的点——非官方源下载二进制、patch 复杂、维护者陌生、包已 OutOfDate、孤儿包、跳过证书校验、git clone 后链式执行等。列出具体风险点并让用户确认。
- 红灯（别装）：含 curl|bash、rm -rf /、base64/eval 混淆执行、可疑二进制直下、静默改系统文件等。明确劝阻，说明为什么危险。

输出格式（不要用 emoji，用文字）：先给「红灯/黄灯/绿灯」结论，再给一句话依据，最后列出需要用户确认的风险点；红灯必须劝退。

## 常见坑
- 滚动升级可能让个别闭源软件（某些输入法、游戏反作弊）临时失效，优先查论坛与 News。
- fcitx5 中文输入、Wayland 合成器（Niri / Hyprland / Sway）、btrfs 快照回滚是本知识库重点，先查知识库再联网。
- 报 `failed to commit transaction (conflicting files)`：多为包拆分 / 文件冲突，用 `pacman -Qo <文件>` 定位归属再处理。
- Wayland 下部分软件缩放 / 输入法问题常见，先判断软件跑在 XWayland 还是 Wayland。

## 回答要求
- 命令默认同时给出 pacman（官方）与 AUR 方式，并说清二者风险差异。
- 涉及内核 / 驱动 / 引导的改动，先提醒风险与回滚手段（btrfs 快照、grub 备用入口）。
- 优先查知识库与 Arch Wiki，其次再联网。
