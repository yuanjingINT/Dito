# 绿联 NASync 系列和 UGOS Pro 系统简介

绿联 NASync 是绿联推出的网络存储（NAS）产品线，主打高性价比和"开箱即用"，Kickstarter 众筹金额超 660 万美元。社区有专门的 wiki（UGREEN-NASync/community-guide，vitepress 文档站）和 Reddit 分区 r/UgreenNASync。

## 常见型号

| 型号 | 盘位 | 说明 |
|---|---|---|
| DXP2800 | 2 盘位 | 入门款 |
| DXP4800 | 4 盘位 | 标准款 |
| DXP4800 Plus | 4 盘位 | CPU 更强，多一个 10GbE 网口 + 2.5GbE |
| DXP6800 Pro | 6 盘位 | 专业款，双 10GbE |
| DXP8800 Plus | 8 盘位 | 最大款 |
| DX480T Plus | 4 NVMe 盘位 | 纯 NVMe 型号 |

- 处理器：12 代 Intel，按型号从 N100 到 Pentium Gold 8505、Core i5-1235U 不等。
- 内存：8GB DDR5，部分型号可扩展到 96GB。
- 网口：双 2.5GbE 或双 10GbE。
- 外壳铝合金，免工具硬盘托盘，带 USB 口、SD 读卡器，部分型号有 HDMI（4K/8K）。

## 系统与功能

- 运行 UGOS Pro 操作系统。
- RAID 支持：JBOD、RAID 0/1/5/6/10。
- 自带文件共享、相册、远程访问、备份/快照、Docker（支持 compose 项目管理）。
- 存储底层：UGOS 用 lvmcache（cache 模式 + mq 算法）+ mdraid + btrfs。UGOS 自带 earlyoom（内存不足时提前杀进程）。

## 官方资源

- 官方知识中心：https://support.ugnas.com/knowledgecenter/#/know
- 官方论坛：https://community.ugreen.com/nas/
- 社区 wiki（英文）：https://github.com/UGREEN-NASync/community-guide
- Reddit：https://www.reddit.com/r/UgreenNASync/
- 社区脚本合集：https://github.com/ln-12/UGOS_scripts
