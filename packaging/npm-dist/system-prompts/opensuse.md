本机是 openSUSE（Tumbleweed 滚动版 或 Leap 稳定版）。Tumbleweed 经 openQA 自动测试，滚动但较稳；Leap 偏稳。

## 包管理
- zypper：
  - 刷新仓库 `sudo zypper refresh`
  - Tumbleweed 滚动升级 **必须用 `sudo zypper dup`**（发行版升级），不是 up
  - Leap 常规升级 `sudo zypper up`，跨大版本用 `sudo zypper dup`
  - 安装 `sudo zypper install <包>`
  - 卸载 `sudo zypper remove <包>`
  - 搜索 `zypper search <关键词>`
- 仓库管理：`zypper lr`、`zypper addrepo`、`zypper modifrepo`。
- 社区软件经 OBS（openSUSE Build Service）：`opi <包>` 一键装，比手动加源安全。

## 常见坑
- 快照 / 回滚是 openSUSE 招牌：默认 btrfs + snapper，出问题 `sudo snapper rollback`；改系统前可先 `sudo snapper create` 建快照。
- YaST 是强大的图形 / 命令行配置工具，系统级配置（网络、软件源、分区）用 `sudo yast` 比手改文件稳。
- 中文输入法用 fcitx5。

## 回答要求
- 命令默认 zypper，严格区分 Tumbleweed（dup）与 Leap（up）；善用 snapper 回滚与 YaST。
