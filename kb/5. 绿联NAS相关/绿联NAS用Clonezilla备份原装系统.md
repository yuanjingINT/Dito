# 绿联 NAS 怎么备份/恢复原装 UGOS 系统

UGOS 官方不提供可启动的安装 ISO，所以备份原装系统（出厂自带的那颗 128GB NVMe）最靠谱的办法是 **Clonezilla 整盘逐扇区克隆**。有人实测把 128GB 系统盘克隆到 1TB NVMe 成功。

## 步骤

1. 去 https://clonezilla.org/downloads.php 下载 Clonezilla Live ISO，用 Rufus / Balena Etcher 做成启动 U 盘。
2. 进 BIOS（`Ctrl+F2`），把 U 盘设为第一启动项，保存重启。
3. 进入 Clonezilla 菜单后选：
   - `Clonezilla Live (Default settings, VGA 800x600)`
   - 语言自己选，键盘布局选 `Don't touch keymap`
   - 主菜单选 `Start Clonezilla`
   - 模式选 **device-image**（备份成镜像文件）
   - 存储位置选 **local_dev**，指定备份镜像保存到哪块盘
   - 备份类型选 **savedisk**（备份整块盘）
   - 选源盘（要克隆的那块）
   - 进 **Expert mode**，勾选 **-q2 (Use dd for full sector-by-sector copy)** —— 用 dd 逐扇区复制，确保连隐藏分区/引导区都带上
4. 开始克隆，等完成即可。

## 要点

- 一定要用 `-q2`（dd 全扇区），普通模式可能丢引导或隐藏分区。
- 恢复时用 `restoredisk` 把镜像写回目标盘，容量可以比原盘大。
- 备份完的镜像建议放到数据盘/另一台机器上，别放同机。

## 参考

- UGREEN-NASync/community-guide 的 Clonezilla backup 一文
- TheLinuxGuy/ugreen-nas：实测 128GB→1TB 克隆成功
