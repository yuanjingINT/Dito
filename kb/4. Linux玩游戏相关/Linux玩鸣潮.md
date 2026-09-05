* 鸣潮官方启动器无法在 wine 或 proton 上正常使用，请使用社区工具（如 [wutheringwaves-cli-manager](https://github.com/timetetng/wutheringwaves-cli-manager) 或 [LutheringLaves](https://github.com/last-live/LutheringLaves)）下载和更新游戏。

* 通常情况下，国服游玩需要添加 `SteamOS=1` 环境变量。部分用户反馈需要 `steamdeck=1`。

* 反作弊（ACE）状态更新：鸣潮于 2025 年 4 月在 Steam 上架后开始适配 Steam Deck，Valve 用 Proton 9.0-4 将其标记为「Playable」。2.4 版本起正式支持 Linux，初期必须用 `STEAMDECK=1`/`SteamOS=1` 伪装成 Steam Deck 才能绕过 ACE；到 2.7 版本（2025 年底）后已基本放开，使用最新版 GE-Proton（10-28 及以上）可以直接启动而不再被 ACE 踢出，旧版本仍需加环境变量。GE-Proton 10-8 起内置了为鸣潮强制 SteamOS=1 的补丁，也修复了此前偶发闪退的问题。

* 如果上线 10 分钟就被踢下线，需要重新登录。可以尝试 B 站用户 `@神麤詭末` 的解决方案：修改文件 `游戏安装目录/Client/Binaries/Win64/ThirdParty/KrPcSdk_Mainland/KRSDKRes/KRSDKConfig.json`，将 `KR_ChannelId` 从 `19` 为 `205`。之后启动游戏可能会提示网络错误，点击 `重试` 即可正常进入游戏。

* 使用 proton-ge 游玩可能会偶尔闪退，可以尝试自己用 spritz-wine 和 vkd3d-proton 搭建运行环境。已知问题：游戏内浏览器组件（公告、抽卡记录、反馈页面）在 Proton 下存在透明度和显示异常，开发者已在游戏内公告承认此问题；Proton 10.0 之前 `mfplat` 实现不全会导致剧情视频无法播放，10.0 起已修复。
