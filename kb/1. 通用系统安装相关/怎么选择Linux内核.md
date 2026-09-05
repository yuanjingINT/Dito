Arch Linux 官方仓库提供以下几种内核，按使用场景选择即可：

· `linux`：最新稳定版内核，支持最新硬件与特性，适合大多数日用场景，也是默认安装的内核。日常办公、续航场景使用它即可。
· `linux-lts`：长期支持内核，仅推送安全补丁与关键 Bug 修复，版本落后于主线。适合追求长期稳定、不愿频繁折腾的系统，也可作为主内核出问题时的应急备用内核。
· `linux-zen`：针对桌面与游戏优化的内核，调整了调度器与内核参数，交互响应更跟手，适合游戏和多媒体场景。
· `linux-hardened`：安全加固内核，包含一系列减少攻击面的补丁，优先安全性，代价是部分性能损耗，适合对安全要求高的环境。
· `linux-rt`：实时内核，保证最低延迟与可预测的任务调度，适合音频制作、视频剪辑等对延迟敏感的专业场景。

此外，AUR 中有 `linux-cachyos` 内核（来自 CachyOS），默认使用 BORE 调度器（响应更敏锐）、ThinLTO 编译与 AutoFDO 性能分析优化，性能表现通常优于 `linux-zen`，适合追求极致性能的桌面用户。CachyOS 还提供 `linux-cachyos-lts`、`linux-cachyos-hardened`、`linux-cachyos-rt-bore`、`linux-cachyos-deckify`（掌机优化）等变体。

简要选择建议：日用续航用 `linux`，追求性能/游戏用 `linux-zen` 或 `linux-cachyos`，长期稳定用 `linux-lts`，注重安全用 `linux-hardened`，专业音频低延迟用 `linux-rt`。多个内核可同时安装，启动时在引导菜单中切换。
