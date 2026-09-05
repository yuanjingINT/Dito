Linux 先行逆向双系统安装方案（双 ESP 隔离机制）

适用场景

适用于 UEFI 启动模式下，已先行安装 Linux 系统、后需部署 Windows 的逆向双系统安装需求。兼容 x86 架构主流硬件平台。

标准化操作流程

1. 磁盘空间准备
在已安装的 Linux 系统中，通过磁盘管理工具（如 GParted、cfdisk）压缩现有卷，划分出足量的未分配空闲空间，用于后续 Windows 系统及其专属引导分区的部署。

2. 安装介质制作

· 在 Linux 环境下，借助 Wine 运行[微 PE 工具箱](https://www.wepe.com.cn/
)程序，获取官方微 PE ISO 镜像文件。
· 使用 Ventoy 工具将微 PE 镜像与 Windows 原版安装镜像整合至同一 U 盘，制成多镜像启动盘。

3. 启动至 PE 环境
重启设备，进入主板 UEFI 设置，将 U 盘调整为首选启动项，启动并进入微 PE 维护系统。

4. 目标分区创建
在微 PE 环境中使用分区工具（如 DiskGenius），于此前预留的空闲空间内执行以下操作：

· 创建 Windows 专属 ESP 分区（FAT32 格式）。
· 创建 Windows 系统主分区（NTFS 格式）。

注意：全程不得对 Linux 原有的任何分区进行修改或格式化。

5. 定向系统安装
运行微 PE 内置的 Windows 安装器（如 WinNTSetup），在引导驱动器选项中 手动指定 新创建的专属 ESP 分区，在安装驱动器选项中指定 Windows 系统主分区，完成系统释放与部署。

6. 双系统引导管理
安装完成后，双 ESP 分区将分别承载对应系统的引导程序。开机时通过主板 UEFI 启动项菜单（Boot Menu），即可自由选择启动 Linux 或 Windows，双系统稳定共存。

7. 安装后注意事项

· 禁用 Windows 快速启动（Fast Startup）：进入 Windows 后，在"控制面板 → 电源选项 → 选择电源按钮的功能 → 更改当前不可用的设置"中取消勾选"启用快速启动"。快速启动会使 Windows 关机时进入混合休眠状态并锁定 NTFS 分区，导致 Linux 端无法正常挂载或写入共享数据分区，严重时还会造成分区损坏。
· 硬件时钟时间标准：Windows 默认将硬件时钟当作本地时间（localtime），Linux 默认当作 UTC，双系统切换后会出现时间相差 8 小时的问题。解决方案二选一：在 Linux 中执行 `timedatectl set-local-rtc 1` 将硬件时钟改为本地时间（不推荐，可能影响日志时间戳）；或在 Windows 中将硬件时钟设为 UTC（推荐，通过注册表设置）。
· 若主板开启了 Secure Boot，需确保 Linux 端的引导程序（如 GRUB、systemd-boot）已正确配置 Secure Boot 支持（如使用 sbctl 签名），否则可能无法从 UEFI 启动项进入 Linux。

强制合规要求

必做项

· Windows 专属 ESP 分区必须格式化为 FAT32 文件系统，以符合 UEFI 规范。
· 必须在 Linux 端提前完成 空闲空间预留，严禁在 PE 或安装过程中直接调整 Linux 现有分区。
· 必须通过 PE 环境 进行系统部署，以绕过 Windows 原版安装程序的强制分区限制。

禁做项

· 严禁 Windows 与 Linux 共用 同一个 ESP 分区。
· 严禁在安装过程中 格式化、删除或修改 Linux 原有的 ESP 分区及系统分区。

