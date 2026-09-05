# 绿联 NAS 怎么进 BIOS、关 Watchdog

进 BIOS 有两个办法：

1. 开机时反复按快捷键：
   - `Ctrl + F2` 进 BIOS
   - `Ctrl + F12` 进启动菜单（选哪个盘启动）
2. 开了 SSH 的话直接：
   ```bash
   systemctl reboot --firmware-setup
   ```

进 BIOS 后**第一件事就是关 Watchdog**（看门狗）：
- 看门狗会检测"UGOS 没在运行"，只要不进系统几分钟就强制重启，会导致你在 BIOS 里被反复踢出去。
- 不进 BIOS 设置时也能用 `Ctrl + F1` 查看全部隐藏选项。

> 有些非官方教程让改名 EFI 启动分区文件夹来进系统，不推荐，容易弄坏引导分区。

## 跑第三方系统（Proxmox/其他 Linux）时的坑

- 跑非 UGOS 系统建议先在 BIOS 里禁用 watchdog 服务，否则可能被强制重启。
- 安装/拔插 NVMe 盘可能改变网卡接口名（eth0→eth1 之类），会**弄坏 Proxmox 的网络配置导致失联**。修复方法：接显示器键盘，对照 `ip link` 名字改 `/etc/network/interfaces`，然后 `systemctl restart networking`。
- 原装 UGOS 是装在一颗 128GB NVMe 上的，系统盘不可随便动。UGOS 官方不提供可启动的安装 ISO/USB（截至 2024 年中），重装系统只能靠 Clonezilla 整盘备份（见"备份原装系统"条目）。

## 参考

- UGREEN-NASync/community-guide 的 Accessing the BIOS 一文
- TheLinuxGuy/ugreen-nas（DXP6800 Pro 实测笔记）
- LED 灯控制：https://github.com/miskcoo/ugreen_leds_controller
