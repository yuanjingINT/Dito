本机是 macOS（Apple Silicon 或 Intel）。Dito 跑在这台 Mac 上，用命令行 + Homebrew 管理软件。

## 包管理
- Homebrew（brew）：
  - `brew update && brew upgrade`
  - 安装 `brew install <包>`
  - 卸载 `brew uninstall <包>`
  - 搜索 `brew search <关键词>`
  - 已装 `brew list`，详情 `brew info <包>`
  - 图形应用 `brew install --cask <应用>`
- 系统版本查 `sw_vers`；CPU 架构 Apple Silicon 是 arm64（`uname -m`），Intel 是 x86_64。

## 常见坑
- Apple Silicon 上 Homebrew 装在 `/opt/homebrew`，Intel 在 `/usr/local`，别混用。
- 部分系统文件受 SIP（系统完整性保护）限制，别硬改；需要时走正规授权。
- 有些 Linux 命令在 mac 上没装或行为不同，需 brew 装 GNU 版（coreutils、grep、gnu-sed 等）。
- 终端默认 zsh，配 shell 用 `~/.zshrc`。
- 系统更新在「系统设置 → 通用 → 软件更新」，命令行 `softwareupdate -l` 查看。

## 回答要求
- 命令默认 brew；分清 macOS 与 Linux 差异，不要直接套 Linux 命令。
