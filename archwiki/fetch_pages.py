#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取 Arch Wiki 核心页面原始 wikitext。

用法:
    python3 fetch_pages.py [--pages 'Pacman;Systemd;...'] [--all]

默认抓取 curated 列表；--all 抓取 categories.txt 里列出的全部分类页面（未提供则跳过）。
输出:
    raw/<page>.wiki        原始 wikitext
    raw/urls.json          标题 -> 抓取状态
"""
import argparse
import json
import pathlib
import re
import time
import urllib.parse

import requests

BASE = "https://wiki.archlinux.org/index.php"
HERE = pathlib.Path(__file__).resolve().parent
RAW = HERE / "raw"
RAW.mkdir(exist_ok=True)

# 与 Dito 日常工作/Arch 桌面运维强相关的核心页面
CURATED = [
    # 安装 / 系统基础
    "Installation guide",
    "General recommendations",
    "General troubleshooting",
    "Arch Linux",
    "Arch User Repository",
    "Mirrors",
    "pacman",
    "pacman/Package signing",
    "pacman/Pacnew and Pacsave",
    "pacman/Restore local database",
    "pacman/Tips and tricks",
    "Arch build system",
    "Creating packages",
    "PKGBUILD",
    "Makepkg",
    "System maintenance",
    "Downgrading packages",
    "FAQ",
    # 内核 / 引导 / 固件
    "Kernel",
    "Kernel module",
    "mkinitcpio",
    "Microcode",
    "GRUB",
    "systemd-boot",
    "Unified Extensible Firmware Interface",
    "Secure Boot",
    "Arch boot process",
    "Dm-crypt",
    "Partitioning",
    "File systems",
    "Fstab",
    "Btrfs",
    "Ext4",
    "XFS",
    "Swap",
    "5-level paging",
    # 图形 / 显示 / 输入
    "Xorg",
    "Wayland",
    "Sway",
    "Hyprland",
    "Niri",
    "Display manager",
    "GDM",
    "SDDM",
    "NVIDIA",
    "AMDGPU",
    "Intel graphics",
    "Hardware video acceleration",
    "HiDPI",
    "Fonts",
    "Font configuration",
    "Input acceleration",
    "Xinput",
    "further",
    "Localization (简体中文)",
    "IBus",
    "Fcitx5",
    # 声音 / 网络
    "Advanced Linux Sound Architecture",
    "PipeWire",
    "PulseAudio",
    "Network configuration",
    "NetworkManager",
    "Iwd",
    "Wireless",
    "Internet sharing",
    "Firewall",
    "Nftables",
    "Iptables",
    "OpenSSH",
    "DNS",
    "DHCP",
    "systemd-networkd",
    "Hostnames",
    # 服务 / 容器 / 虚拟化
    "systemd",
    "systemd/User",
    "systemd/Services",
    "daemons",
    "Enhancing systemd",
    "Docker",
    "Podman",
    "Systemd-nspawn",
    "LXC",
    "QEMU",
    "libvirt",
    "VirtualBox",
    "Wine",
    "Proton",
    "Steam",
    "Gaming",
    "Bubblewrap",
    "Firejail",
    "Security",
    "AppArmor",
    "SELinux",
    # 硬件 / 电源 / 性能
    "Power management",
    "CPU frequency scaling",
    "TLP",
    "Thermald",
    "fan speed control",
    "Laptop",
    "Solid state drive",
    "NVMe",
    "hdparm",
    "Udev",
    "Backup and recovery",
    "Synchronization and backup programs",
    "Rsync",
    # 常见应用 / 工具
    "List of applications",
    "Common applications",
    "Bash",
    "Zsh",
    "Fish",
    "Git",
    "Vim",
    "Neovim",
    "Tmux",
    "GNU nano",
    "OpenRC",
    # 网络工具
    "Curl",
    "Wget",
    "Htop",
    "Neofetch",
    "Fastfetch",
    "Reflector",
    "Paccache",
    "Pkgfile",
]

# 写入分类入口（可选 --all）
CATEGORIES_FILE = HERE / "categories.txt"
CATEGORIES = [
    "Category:Package management",
    "Category:Boot process",
    "Category:File systems",
    "Category:Networking",
    "Category:Audio",
    "Category:Graphics",
    "Category:Eye candy",
    "Category:Hardware detection and troubleshooting",
    "Category:Input devices",
    "Category:Kernel",
    "Category:Power management",
    "Category:Security",
    "Category:System administration",
    "Category:Virtualization",
    "Category:Games",
]


def norm_title(title: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", title).strip()


def fetch_page(title: str, session: requests.Session):
    url = BASE + "?" + urllib.parse.urlencode({"title": title, "action": "raw"})
    for attempt in range(3):
        try:
            r = session.get(url, timeout=20, allow_redirects=True)
            if r.status_code == 200 and len(r.text) > 50:
                return "ok", r.text, r.url
            if r.status_code == 404:
                return "notfound", "", r.url
        except requests.RequestException:
            time.sleep(2 * (attempt + 1))
    return "error", "", url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", default=None, help="分号分隔的页面列表")
    ap.add_argument("--all", action="store_true", help="抓取 categories.txt 中分类成员（开发中）")
    args = ap.parse_args()

    pages = []
    if args.pages:
        pages = [p.strip() for p in args.pages.split(";") if p.strip()]
    elif args.all and CATEGORIES_FILE.exists():
        for cat in CATEGORIES:
            if (RAW / f"cat_{norm_title(cat)}.txt").exists():
                pages += (RAW / f"cat_{norm_title(cat)}.txt").read_text(encoding="utf-8").splitlines()
    else:
        pages = list(CURATED)

    pages = list(dict.fromkeys(pages))  # 去重保序
    print(f"待抓取 {len(pages)} 页", flush=True)
    session = requests.Session()
    session.headers.update({"User-Agent": "Dito-dataset/0.1 (archwiki-mirror; educational)"})
    urls = {}
    ok = 0
    for i, title in enumerate(pages, 1):
        fname = RAW / f"{norm_title(title)}.wiki"
        if fname.exists() and fname.stat().st_size > 100:
            print(f"[{i}/{len(pages)}] 跳过已存在 {title}", flush=True)
            continue
        status, text, url = fetch_page(title, session)
        urls[title] = {"status": status, "url": url, "size": len(text)}
        if status == "ok":
            fname.write_text(text, encoding="utf-8")
            ok += 1
            print(f"[{i}/{len(pages)}] OK {title} ({len(text)} chars)", flush=True)
        else:
            print(f"[{i}/{len(pages)}] {status} {title}", flush=True)
        time.sleep(0.15)

    (RAW / "urls.json").write_text(json.dumps(urls, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n完成: 成功 {ok} / 共 {len(pages)}")


if __name__ == "__main__":
    main()