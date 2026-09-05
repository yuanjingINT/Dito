# 绿联 NAS 硬件奇技与第三方系统（DXP 系列实测）

以下来自 TheLinuxGuy/ugreen-nas（DXP6800 Pro 众筹机实测笔记）和社区。

## 各家型号的 PCIe/NVMe 通道（DXP6800 Pro 实测）

- UGOS 系统盘 NVMe 插槽（出厂系统盘，不拆机很难动）：**PCIe 3.0 x1，约 800MB/s**
- NVMe 槽 1：**PCIe 3.0 x2，约 1600MB/s**
- NVMe 槽 2（挨着内存槽）：**PCIe 3.0 x4，约 3600MB/s**
- 扩展 PCIe 槽：PCIe 4.0 x4（用 NVMe 转接卡可以塞下 4 个 NVMe）

> 组 NVMe RAID 会被最慢那根（x1）拖后腿，别指望全速。判断方法：`lspci -vv -nn -s <pci地址> | grep Lnk`，看 `LnkSta` 里的 Width。

## UGOS 存储底层技术

UGOS 用 **lvmcache（cache 模式，mq 算法）+ 上层 mdraid + btrfs** 做存储和缓存。相比群晖 DSM：
- 优点：缓存不是 hot-spot 式，比群晖扎实。
- 缺点：**UGOS 没有实现 btrfs 快照/文件版本恢复**（群晖有 Snapshot Replication），不小心改坏/删了文件没法从几小时前快照捞回来。在意这点的别把 UGOS 当唯一保险，数据要另做快照/备份。

## 磁盘活动 LED 灯

跑 Proxmox 或自装 Linux 时，盘位 LED 默认不亮。用 LED 控制器：
- https://github.com/miskcoo/ugreen_leds_controller（DXP/DX 全系，社区最活跃）
- 旧方案：https://github.com/miskcoo/ugreen_dx4600_leds_controller

## Windows 驱动

网卡驱动是 **Aquantia AC113C**，去 https://www.marvell.com/support/downloads.html 下。其他芯片组驱动用 Intel Driver & Support Assistant 装。

## 玩机相关开源项目

- 图标替换：https://github.com/zeyu8023/ugreen-icon-replacer（UGOS Pro 系统图标脚本）
- Home Assistant 集成：https://github.com/Tom-Bom-badil/home-assistant_ugreen-nas
- homelab 全家桶：https://github.com/alisohail/ugreen-nas-homelab
- Docker 指南合集：https://github.com/EszopiCoder/ugreen-docker-guides
