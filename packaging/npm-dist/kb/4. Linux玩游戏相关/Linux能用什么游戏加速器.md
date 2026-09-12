网易uu有给SteamDeck做适配，其他发行版应该也可以用，可以尝试一下。别的还有运行windows虚拟机做转发的方案，但是就麻烦很多了。

补充说明：

* 网易 UU 的 Steam Deck 插件并不限于 Steam Deck，普通 Linux 也能装。安装方式有几种：官方一键脚本 `curl -s uudeck.com | sudo bash`；Arch 系可在 AUR 装 `uudeck` 或 `uudeck-bwrap`（沙箱封装，更安全）；还有社区维护的 Docker 版本 `uudeck-docker`（隔离性最好，推荐对安全性有顾虑的用户使用）。装好后需手机下载「UU 主机加速」App 扫码配对控制。

* 稳定性提醒：UU 插件是为 SteamOS 编译的二进制，在 Fedora、Arch 等非 SteamOS 发行版上常出现兼容问题——加速后系统断网、虚拟网卡 tun163 失效等。常见原因是 NetworkManager 自动接管了 tun163 网卡导致插件崩溃，删除 NetworkManager 对 tun163 的接管配置并禁用自动接管即可解决。另外该插件以较高权限运行并会自动拉取远程代码，安全风险需自行评估，Docker 版可缓解这一问题。

* 替代方案：手头有 OpenWrt 路由器（或树莓派刷 OpenWrt）可装 UU 路由插件，对主机和 Linux 桌面都透明加速，体验最稳；「机场」（代理节点）兼容性好但线路通常不为游戏优化，可能绕路反而增加延迟，不建议用来加速游戏；Windows 虚拟机 + 网络转发方案配置繁琐，仅作最后手段。
