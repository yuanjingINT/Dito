> **提示：**
> 在 [CodeNames · freedesktop.org](https://nouveau.freedesktop.org/CodeNames.html) 这个页面搜索自己的显卡，看看对应的 family 是什么。然后在 NVIDIA - ArchWiki 这个页面查找对应的包名。nv160 family（差不多16系）往后的显卡用 `nvidia-open`。`nvidia-open` 是内核模块开源的驱动，不是完全的开源驱动。不同的内核对应的包的后缀不同，像 `linux-zen` 这样的自定义内核要装 `-dkms` 后缀的。**不过，考虑到日后更新的稳定性，强烈推荐无论使用什么内核，都统一使用 `-dkms` 版本的驱动包，它会在内核更新时自动重新编译驱动。除了驱动包，还要安装 `nvidia-utils` 工具集。**

### archlinux主机显卡驱动安装对照表


结合 Nouveau 的代号数据与 ArchWiki 的官方驱动支持状态，整理出的显卡驱动安装对照表如下：

| 显卡型号                            | 架构 (Family 代号)               | 需要安装的驱动包 (推荐 `-dkms` 版) |
| :---------------------------------- | :------------------------------- | :--------------------------------- |
| **GeForce RTX 50系** (及更新)       | **Blackwell (GBXXX)**            | `nvidia-open-dkms`                 |
| **GeForce RTX 40系**                | **Ada Lovelace (NV190 / ADXXX)** | `nvidia-open-dkms`                 |
| **GeForce RTX 30系**                | **Ampere (NV170 / GAXXX)**       | `nvidia-open-dkms`                 |
| **GeForce RTX 20系 / GTX 16系**     | **Turing (NV160 / TUXXX)**       | `nvidia-open-dkms`                 |
| **NVIDIA Titan V / Quadro GV100**   | **Volta (NV140 / GV100)**        | `nvidia-580xx-dkms`                |
| **GeForce GTX 10系**                | **Pascal (NV130 / GPXXX)**       | `nvidia-580xx-dkms`                |
| **GeForce GTX 750 / 900系**         | **Maxwell (NV110 / GMXXX)**      | `nvidia-580xx-dkms`                |
| **GeForce GTX 600 / 700系 / Titan** | **Kepler (NVE0 / GKXXX)**        | `nvidia-470xx-dkms`                |
| **GeForce GTX 400 / 500系**         | **Fermi (NVC0 / GF1XX)**         | `nvidia-390xx-dkms`                |
| **GeForce 8/9/100/200/300系**       | **Tesla (NV50 / G80-90-GT2XX)**  | `nvidia-340xx-dkms`                |
| **GeForce 6/7系** (及更老)          | **Curie (NV40 / G70)** 及更早    | *(已停止打包，不再支持)*           |

## 警告：`nvidia`和`nvidia-dkms`已经不存在了，需要装`nvidia`的显卡要去aur上装`nvidia-版本号-dkms`，详情看表格。

> **2025 年 12 月重要变更（NVIDIA 590 驱动）：**
> 随着 NVIDIA 驱动更新到 590 版本，Arch 官方仓库的包名发生了如下替换：
> - `nvidia` → `nvidia-open`
> - `nvidia-dkms` → `nvidia-open-dkms`
> - `nvidia-lts` → `nvidia-lts-open`
>
> 590 驱动不再支持 Pascal（GTX 10系）及更老的显卡（Maxwell、Volta）。这些显卡必须改用 AUR 中的 `nvidia-580xx-dkms` 遗留驱动。
> Turing（RTX 20系 / GTX 16系）及更新的显卡会在系统升级时自动迁移到 `nvidia-open`（开放内核模块），无需手动干预。

---

### 工具集与 N 卡视频硬件编解码安装指南

根据参考的 Wiki 页面内容，N 卡的工具集和硬件编解码安装步骤如下：

**1. 安装内核头文件（DKMS 前提）**
因为强烈推荐使用 `-dkms` 版本的驱动，所以必须安装与你当前内核匹配的头文件，以便在内核更新时自动编译模块。
*如果你使用默认内核：*
```bash
sudo pacman -S --needed linux-headers
```

如果你使用其他内核（例如 `linux-zen`）： 请替换为相应的包名（如 `linux-zen-headers`）。

2. 安装驱动及工具集
除了对照表中的驱动包外，还需要安装基础的 `nvidia-utils`。**如果使用的是 legacy 遗留驱动包（如 `nvidia-580xx-dkms`、`nvidia-470xx-dkms` 等），必须从 AUR 安装与之版本号匹配的工具集**（如 `nvidia-580xx-utils`、`lib32-nvidia-580xx-utils`），不能混用官方仓库的 `nvidia-utils`。对于 `nvidia-open` / `nvidia-open-dkms` 系列的现代驱动，直接使用官方仓库的 `nvidia-utils` 和 `lib32-nvidia-utils` 即可。为了支持 32 位应用（如 Steam 游戏），建议一并安装 lib32- 的工具集：
```
sudo pacman -S nvidia-open-dkms nvidia-utils lib32-nvidia-utils
```
(注：请将 `nvidia-open-dkms` 替换为你显卡实际需要的驱动包名)

3. 安装硬件视频编解码支持
NVIDIA 的硬件编解码由 `nvidia-utils` 和 `libva-nvidia-driver` 提供：

sudo pacman -S libva-nvidia-driver

> 注：`libva-nvidia-driver` 就是上游项目 `nvidia-vaapi-driver`（GitHub: elFarto/nvidia-vaapi-driver）在 Arch 官方仓库中的包名，两者是同一个软件，无需另外从 AUR 或 archlinuxcn 安装。

4. 重启并验证 (可选)
驱动和编解码包安装完成后，重启系统 (reboot) 以激活显卡驱动。
如果你想验证硬件编解码是否正常工作，可以安装 `libva-utils` 并运行 `vainfo` 检查：

```
sudo pacman -S libva-utils
vainfo
```
(如果是多显卡环境，可通过环境变量指定显卡：`LIBVA_DRIVER_NAME=nvidia vainfo`)
