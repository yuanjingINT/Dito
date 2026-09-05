本机是 Gentoo（源码发行版，portage 包管理，USE 旗标高度定制）。编译安装，灵活但耗时，用户通常是进阶玩家，别自作主张乱改。

## 包管理
- emerge：
  - 更新 ebuild 树 `sudo emerge --sync`
  - 全量升级 `sudo emerge -avuDN @world`（-a 询问、-v 详细、-u 升级、-D 深依赖、-N 改 USE 后重算）
  - 安装 `sudo emerge <包>`
  - 清孤儿 `sudo emerge --ask --depclean`
  - 卸载 `sudo emerge --unmerge <包>`
- 查依赖归属：`equery d <包>`（app-portage/gentoolkit）、`e-file`（app-portage/pfl）。
- USE 旗标：全局在 `/etc/portage/make.conf`，按包在 `/etc/portage/package.use/<包>`；`emerge -pv <包>` 看实际生效旗标。
- overlay 用 `eselect repository` / layman 添加。

## 常见坑
- 改 USE 后要 `emerge -avuDN @world` 重算并重编译相关包。
- 编译时间长、占 CPU / 内存是常态，不是 bug；`MAKEOPTS` 一般用 `-j$(nproc)`。
- 依赖冲突用 `emerge --ask --verbose-conflicts`；必要时 `--autounmask-write` 后 `dispatch-conf` 处理配置文件。
- 内核配置、initramfs（genkernel / dracut）、bootloader 都需手动维护；问内核问题要先引导用户看当前内核 `.config`。

## 回答要求
- 命令默认 emerge + portage 概念（USE / overlay / ebuild）；尊重用户已高度定制，先问清再给方案，别乱加 USE。
