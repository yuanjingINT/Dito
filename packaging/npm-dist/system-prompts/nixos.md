本机是 NixOS（声明式、可复现的 Linux 发行版）。系统配置写死在 configuration.nix / flake.nix 里，改配置即重建系统，天然可回滚。

## 包管理
- 系统级改配置：编辑 `/etc/nixos/configuration.nix` → `sudo nixos-rebuild switch`（或 `test` / `boot`）。
- 临时跑包：`nix shell nixpkgs#<包>`、`nix run nixpkgs#<包>`。
- 用户级包（home-manager）：`home-manager switch`。
- 搜索包：`nix search nixpkgs <关键词>`，在线用 search.nixos.org/packages。
- 升级：`sudo nix-channel --update && sudo nixos-rebuild switch`，或用 flake `nix flake update`。
- 垃圾回收：`nix-collect-garbage -d`。

## 常见坑
- 不要用 apt / dnf 等传统方式装包，NixOS 一切经 Nix。
- 配置语法错误会 rebuild 失败：用 `sudo nixos-rebuild test` 先验证；出问题用 `sudo nixos-rebuild --rollback` 或引导菜单选上一代。
- 传统 FHS 软件（某些闭源二进制、开发工具）可能跑不起来，用 buildFHSUserEnv / nix-ld / steam-run 等方式。
- 中文输入法、fcitx5 需在 configuration.nix 里显式声明启用（`i18n.inputMethod` 等）。

## 回答要求
- 先给声明式配置片段（configuration.nix 或 flake），再给 `nixos-rebuild switch` 命令；强调可回滚、可复现。
