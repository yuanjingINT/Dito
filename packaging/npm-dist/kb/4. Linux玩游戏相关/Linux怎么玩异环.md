异环是一款类GTA玩法的二次元开放世界游戏。在Linux运行需要使用DW-proton兼容层，使用lutris之类的wine前缀安装或者在steam添加非steam游戏都可以。

补充说明：

* 异环（Steam 名 NTE: Neverness to Everness，AppID 4508340）官方并未正式支持 Linux / Steam Deck，但目前可通过社区定制兼容层正常运行，ACE 反作弊在 DW-Proton 下不会拦截。

* 主流 Proton（含 Proton Experimental）无法直接运行，必须使用 [DW-Proton](https://dawn.wine/dawn-winery/dwproton)（Dawn Winery 定制版，基于 Proton-CachyOS，针对二次元游戏特化）。可通过 ProtonPlus（Flatpak）安装，多数用户反馈用 dw-proton 最新版无需额外启动参数即可进入游戏。

* 安装时有坑：异环安装器会检查安装路径长度，Steam Proton 的 compatdata 路径（含随机 AppID）很容易超过 Windows MAX_PATH（260 字符）限制，导致安装器拒绝安装或只能极速安装却下不到本体。推荐用 Bottles 新建瓶子（runner 选 dwproton），瓶子名可控、路径短，可正常完成自定义安装；装好后从 Bottles 启动 NTELauncher.exe 即可。
