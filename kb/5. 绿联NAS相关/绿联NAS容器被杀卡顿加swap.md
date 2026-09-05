# 绿联 NAS 容器老是被杀、系统卡顿：加 swap

症状：8GB 内存的绿联 NAS 跑一堆 Docker 容器，容器反复崩溃重启，`docker inspect` 显示 exit code 137 但 `OOMKilled: false`，日志中途截断，`free -h` 显示 swap 几乎用满。

## 根因

UGOS 自带 **earlyoom**，内存紧张时会在内核 OOM killer 之前主动杀进程。它直接从内核层面杀，Docker 完全不知情，所以 `OOMKilled: false`。earlyoom 默认阈值：可用内存 < 5% 或 **空闲 swap < 20%** 就开杀。出厂约 10GB swap（zram + NVMe 上 swap 分区）对 40~60 个容器很快见底。

确认是不是 earlyoom 干的：
```bash
pgrep -a earlyoom
cat /etc/default/earlyoom
grep earlyoom /var/log/syslog | grep SIGKILL | tail -10
```

## 加 swap 文件

swap 放 NVMe 的 `/overlay` 分区（出厂就 100GB+，系统盘够快）。**不要**放 HDD 阵列 `/volume1`、网络共享或 btrfs/zfs 卷（HDD 当 swap 更卡）。

```bash
# 先看空间，留出至少 50% 空闲
df -h /overlay

sudo fallocate -l 16G /overlay/swapfile   # 大小自定，见下表
sudo chmod 600 /overlay/swapfile
sudo mkswap /overlay/swapfile
sudo swapon /overlay/swapfile
free -h
```

## 开机自动启用：别用 fstab，用 systemd 轮询

UGOS 开机时 swap 激活早于 `/overlay` 挂载完成，写 fstab 会静默失败。正确做法是写一个等到 `/overlay` 就绪再 swapon 的服务：

```bash
sudo tee /etc/systemd/system/overlay-swapfile.service << 'EOF'
[Unit]
Description=Activate swapfile on /overlay

[Service]
Type=oneshot
TimeoutStartSec=300
ExecStart=/bin/sh -c 'until mountpoint -q /overlay; do sleep 2; done; grep -q /overlay/swapfile /proc/swaps || /sbin/swapon /overlay/swapfile'
ExecStop=/sbin/swapoff /overlay/swapfile
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now overlay-swapfile.service
```

## 加多大

| 内存 | 容器数 | 建议加 swap |
|---|---|---|
| 8GB | 20~40 | 8~16GB |
| 8GB | 40~60+ | 16~24GB |
| 16GB | 40~60 | 8GB |
| 16GB | 60+ | 16GB |

校验标准：加完后总 swap 的 20%（earlyoom 杀进程线）能覆盖日常用量即可。

## 撤销

```bash
sudo systemctl disable --now overlay-swapfile.service
sudo rm /etc/systemd/system/overlay-swapfile.service
sudo systemctl daemon-reload
sudo rm /overlay/swapfile
```

## 注意

swap 只是续命，不是根治。swap 常年满说明容器太多、内存不够，正经解法是减容器或换大内存机器。

## 参考

- UGREEN-NASync/community-guide 的 Increasing Swap Space 一文（DXP4800 Plus 8GB 实测）
