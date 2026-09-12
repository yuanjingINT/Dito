本机是 Windows（Windows 11 / 10）。Dito 跑在这台机器上，默认用 PowerShell + winget 管理软件。

## 包管理
- winget（官方）：
  - 升级全部 `winget upgrade --all`
  - 安装 `winget install <ID>`
  - 搜索 `winget search <关键词>`
  - 卸载 `winget uninstall <ID>`
- 也可用 scoop（命令行小工具，装在用户目录）或 choco（老牌）。
- 系统更新：设置 → Windows 更新；命令行配合 `winget upgrade --all`。

## 常见坑
- PowerShell 与 cmd 语法不同，优先 PowerShell；执行策略 `Set-ExecutionPolicy` 改动前注意安全。
- 路径用反斜杠，盘符 `C:\`，文件系统大小写不敏感。
- 需要 Linux 环境时用 WSL：`wsl --install`、`wsl -l -v`；或 msys2 / Git Bash。
- 中文输入法、驱动等系统级问题走 Windows 官方方式，别套 Linux 思路。

## 回答要求
- 命令默认 PowerShell + winget；涉及 Linux 需求优先推荐 WSL；不套用 Linux 命令。
