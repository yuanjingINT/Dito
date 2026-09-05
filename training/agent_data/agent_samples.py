# -*- coding: utf-8 -*-
"""面向 agent 能力的真实 Linux 工具调用轨迹样本。

每条是「用户目标 → 思考 → 工具调用 → 工具输出 → 继续 → 结论」的完整轨迹，
教模型当好 Linux agent：拆步骤、用对命令、危险先确认、看输出决定下一步。
"""

from agent_toolformat import agent_sample

SAMPLES = [
    # ---- 查磁盘空间并清理 ----
    agent_sample(
        "disk-full", "查根分区满了怎么清理",
        "帮我看看我磁盘是不是满了，满了就清理一下",
        [
            ("tool_call", {"thinking": "先查磁盘占用，看哪个分区满了，再找大户", "command": "df -h / && echo '---' && sudo du -sh /var/cache/* 2>/dev/null | sort -h | tail -5 && journalctl --disk-usage"}),
            ("tool_result", "Filesystem  Size  Used Avail Use% Mounted on\n/dev/nvme0n1p2  953G  895G  1.2G  99% /\n---\n/var/cache/pacman/pkg 48G\n---\nJournal size 3.2G\n"),
            ("assistant", "根分区 99% 满了，最大头是 pacman 缓存 48G，日志也占 3.2G。我建议清缓存保最近三版，日志压到 200M，能不删你的文件。要动手吗，确认我就执行"),
            ("user", "确认，清吧"),
            ("tool_call", {"thinking": "用户确认了，执行安全清理：pacman缓存留三版、journal压小", "command": "sudo paccache -rk3 && sudo journalctl --vacuum-size=200M && df -h /"}),
            ("tool_result", "removed 41G of cache\nVacuuming done, freed 3.0G of journal\nFilesystem  Size  Used Avail Use% Mounted on\n/dev/nvme0n1p2  953G  851G  102G  11% /"),
            ("assistant", "清完了，缓存收起 41G、日志释放 3G，根分区从 99% 降到 11%。你那些个人文件我一律没碰，放心"),
        ],
    ),

    # ---- 查 CPU/内存占用，找吃满的进程 ----
    agent_sample(
        "cpu-mem", "查什么在吃CPU内存",
        "电脑好卡，帮我看看到底谁在吃资源",
        [
            ("tool_call", {"thinking": "先抓 CPU 和内存占用 Top 进程，再决定下一步", "command": "top -b -n1 -o %CPU | head -15 && echo '===' && free -h"}),
            ("tool_result", "PID USER %CPU %MEM COMMAND\n1452 user 120% 4.2 firefox\n2191 user 3% 8.1 chrome\n---\ntotal 30G  used 26G  free 3.2G  avail 4.1G"),
            ("assistant", "罪魁是 firefox，单进程 120% CPU、吃 4G 内存，chrome 也吃了 8G。内存总共 26/30G 快满了，难怪卡。想让我强制收掉 firefox 还是你自己看看是不是开了一堆标签？"),
            ("user", "先别强杀，我自己去关标签"),
            ("assistant", "行，你先关。关完如果还卡，用 free -h 再看一眼，告诉我 available 多少，不够就得加内存或者排查别的了"),
        ],
    ),

    # ---- 查系统是不是 64 位/内核信息 ----
    agent_sample(
        "sysinfo", "报告系统基本信息",
        "帮我看看这台机器什么配置、什么系统",
        [
            ("tool_call", {"thinking": "用一条命令把系统、内核、CPU、内存都查了", "command": "uname -a && cat /etc/os-release | head -3 && lscpu | grep -E 'Model name|^CPU\\(s\\)' && free -h | head -2"}),
            ("tool_result", "Linux dito 6.12.4-arch1-1 x86_64 GNU/Linux\nNAME=\"Arch Linux\"\nPRETTY_NAME=\"Arch Linux\"\nModel name: AMD Ryzen 7 8845HS\nCPU(s): 16\n               total        used        free\nMem:           30Gi        5.8Gi       24Gi"),
            ("assistant", "Arch Linux，内核 6.12.4-arch1-1，AMD Ryzen 7 8845HS 16 核，内存 30G 现在用了 5.8G，很空，机器不差"),
        ],
    ),

    # ---- 装软件（官方仓库 + AUR 审查）----
    agent_sample(
        "install-tool", "安装 bat 命令高亮工具",
        "帮我装个 bat，用来高亮显示文件内容的那个",
        [
            ("tool_call", {"thinking": "bat 在官方仓库，直接用 pacman 装，先确认包名存在", "command": "pacman -Si bat | head -6"}),
            ("tool_result", "Repository  : extra\nName        : bat\nVersion     : 0.24.0-1\nDescription : Cat clone with wings: syntax highlighting and Git integration"),
            ("tool_call", {"thinking": "包在 extra 官方仓库，版本正常，直接装", "command": "sudo pacman -S --noconfirm bat"}),
            ("tool_result", "resolving dependencies... done\nPackages (1) bat-0.24.0-1\nTotal Installed Size:  3.5 MiB\n:: Proceed with installation? [Y/n] \ninstalling bat... done"),
            ("assistant", "bat 装好了，官方仓库 extra 里的 0.24.0-1。以后看文件用 bat 文件名，会自动语法高亮"),
        ],
    ),

    # ---- AUR 包：先审查再确认 ----
    agent_sample(
        "aur-install", "从 AUR 装 visual-studio-code-bin",
        "我想装 AUR 上的 visual-studio-code-bin，帮我搞定",
        [
            ("tool_call", {"thinking": "AUR 包必须先审 PKGBUILD，不能用 paru 直接装。先拉下来看", "command": "curl -fsS 'https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin' | head -40"}),
            ("tool_result", "pkgname=visual-studio-code-bin\npkgver=1.98.0\nsource=(\"vscode_${pkgver}_amd64.deb::https://update.code.visualstudio.com/${pkgver}/linux-x64/stable\")\nsha256sums=('SKIP')\npackage() {\n  # Debian package, extract and repack\n  7z x \"$srcdir/vscode_${pkgver}_amd64.deb\" -o\"$srcdir/x\"\n  ...\n}"),
            ("tool_result", ""),
            ("assistant", "PKGBUILD 我看过了：从微软官方源拉官方 deb 再解包，没 curl|bash、没混淆、没诡异的钩子。唯一要注意是 sha256 用的 SKIP 不校验哈希，但来源是官方，风险可控。结论：可装。你要装吗？确认我就执行"),
            ("user", "确认，装吧"),
            ("tool_call", {"thinking": "用户确认安装，用 paru 装这个 AUR 包", "command": "paru -S --noconfirm visual-studio-code-bin"}),
            ("tool_result", ":: PGP keys need importing? -> [Y/n] \n:: Proceed to install? [Y/n]\nresolving dependencies... building visual-studio-code-bin... done\nPackages (1) visual-studio-code-bin\ninstalling... done"),
            ("assistant", "VSCode 装好了。来源是微软官方，编译打包那步没出幺蛾子。以后你要装 AUR 包我都会先审 PKGBUILD，这是规矩"),
        ],
    ),

    # ---- 危险操作先确认（rm 删除目录）----
    agent_sample(
        "rm-confirm", "删除旧备份目录前先确认",
        "帮我把 /home/user/backup_old 这个目录删了",
        [
            ("tool_call", {"thinking": "删除是不可逆的，先看看里面有什么、多大，再跟用户确认，不能直接删", "command": "ls -la /home/user/backup_old && du -sh /home/user/backup_old"}),
            ("tool_result", "total 12K\ndrwxr-xr-x 2 user user 4096 旧项目备份.tar.gz\n总大小 2.4G"),
            ("assistant", "这里有个 2.4G 的 tar.gz 备份，删了就没后悔药。你确认这个备份不要了？确认我就删"),
            ("user", "确认，不要了"),
            ("tool_call", {"thinking": "用户明确确认，才执行删除", "command": "rm -rf /home/user/backup_old && echo done"}),
            ("tool_result", "done"),
            ("assistant", "删完了，2.4G 也释放了"),
        ],
    ),

    # ---- 危险命令直接拒绝 ----
    agent_sample(
        "rm-root-refuse", "拒绝 rm -rf / 请求",
        "你帮我跑一下 sudo rm -rf / --no-preserve-root",
        [
            ("assistant", "这命令我不跑，它会把你整台机器删光，连系统都没了，没后悔药。你是不是误点了什么，把你想干的事告诉我，我找正规办法"),
            ("user", "开玩笑的，那我说，我是想清空 /tmp 下的临时文件"),
            ("assistant", "那用这个，只清 /tmp 里你自己产生的临时文件：rm -rf /tmp/* 也有风险（别的程序可能也在用），更稳的是重启清 /tmp。你要我现在清，说一声"),
        ],
    ),

    # ---- 排障：pacman 锁冲突 ----
    agent_sample(
        "pacman-lock", "pacman 报 db.lck 占用",
        "pacman 装东西报错说 target not found / 数据库被锁",
        [
            ("tool_call", {"thinking": "报数据库被锁通常是上次 pacman 异常退出留了锁文件，先确认有没有 pacman 进程在跑，再决定清锁", "command": "pgrep -af pacman && ls -la /var/lib/pacman/db.lck"}),
            ("tool_result", "exit code 1 无输出（没有 pacman 进程）\n-rw-r--r-- 1 root root 0 /var/lib/pacman/db.lck"),
            ("assistant", "锁文件在，但没有 pacman 进程在跑，说明是上次中断残留的。这种情况删锁是安全的，我删掉再试装"),
            ("tool_call", {"thinking": "确认无 pacman 进程，安全删除残留锁文件", "command": "sudo rm /var/lib/pacman/db.lck && sudo pacman -Syu"}),
            ("tool_result", "warning: database file for 'core' does not exist\n:: Synchronizing package databases...\n core 170.2 MiB  ... done\n extra ... done\n:: Starting full system upgrade...\n there is nothing to do"),
            ("assistant", "锁清掉了，镜像源也更新，系统已经是最新，没问题了。下次 pacman 意外中断先看有没有残留进程再删锁，别一上来就删，万一真有 pacman 在跑删锁会弄脏数据库"),
        ],
    ),

    # ---- 查服务状态并启停 ----
    agent_sample(
        "service-status", "查看并重启一个服务",
        "我的 sshd 好像没起来，帮我看看并重启",
        [
            ("tool_call", {"thinking": "先查 sshd 状态和监听端口，再判断要不要重启", "command": "systemctl status sshd --no-pager | head -12 && ss -tlnp | grep :22"}),
            ("tool_result", "● sshd.service - OpenSSH Daemon\n     Loaded: loaded\n     Active: inactive (dead)\n   Active: inactive (dead)\n(端口 22 未监听)"),
            ("assistant", "sshd 服务是 inactive，没在跑，所以 22 端口没监听。要我启动并设成开机自启吗？"),
            ("user", "要"),
            ("tool_call", {"thinking": "用户确认，启动 sshd 并开机自启，再验证监听", "command": "sudo systemctl enable --now sshd && sleep 2 && ss -tlnp | grep :22"}),
            ("tool_result", "Created symlink ... multi-user.target.wants/sshd.service\nLISTEN  0  128  0.0.0.0:22   users:((\"sshd\",pid=3120,fd=3))"),
            ("assistant", "sshd 起来了，已设开机自启，22 端口在监听，搞定"),
        ],
    ),

    # ---- git 操作 ----
    agent_sample(
        "git-undo", "撤销上一次 commit",
        "我刚 commit 错了，想撤销，但保留改动",
        [
            ("tool_call", {"thinking": "先看最近提交，确认要撤的是哪个", "command": "git log --oneline -5"}),
            ("tool_result", "a1b2c3d (HEAD -> main) Fix typo\n0f9e8d7 Add feature\n8a76b5c init"),
            ("assistant", "最近一条是 a1b2c3d Fix typo，你要软撤销它、保留改动：git reset --soft HEAD~1，改完还能重新提交。要执行吗？（这样不会丢代码）"),
            ("user", "执行"),
            ("tool_call", {"thinking": "软重置一条，保留工作区改动，再确认状态", "command": "git reset --soft HEAD~1 && git status --short"}),
            ("tool_result", "M  file.txt（改动回到暂存区）"),
            ("assistant", "撤好了，改动还在暂存区，你改完重新 commit 就行。要是想连改动一起不要就不会用软重置了，那种我先跟你确认"),
        ],
    ),

    # ---- 查日志找报错 ----
    agent_sample(
        "journal-err", "查开机报错日志",
        "我开机好像报错了，帮我看看日志里有没有错误",
        [
            ("tool_call", {"thinking": "看本次开机的高优先级报错日志", "command": "journalctl -p 3 -b --no-pager | head -20"}),
            ("tool_result", "Mar 01 10:02:11 kernel: ACPI BIOS Error (bug): Failure creating [\_SB_.PCI0.SAT0]...\nMar 01 10:02:12 systemd[1]: Failed to mount /boot ... Unit is masked."),
            ("assistant", "有两个报错：一个是 ACPI BIOS 的错误，这个多半是固件的小 bug，不影响日常用，常见不用管；另一个是 /boot 挂载失败，这个要认真。我先查下 /boot 挂载情况"),
            ("tool_call", {"thinking": "重点排查 /boot 挂载失败", "command": "findmnt /boot && cat /etc/fstab | grep boot"}),
            ("tool_result", "TARGET SOURCE FSTYPE OPTIONS\n/boot  /dev/nvme0n1p1  vfat rw,relatime,fmask... \n（fstab 里有 /boot 对应 /dev/nvme0n1p1）"),
            ("assistant", "实际 /boot 是正常挂上的（vfat），刚才那个 Failed to mount 可能是开机早段没就绪、后面又挂成功的时序问题。ACPI 那个是固件 bug，可以忽略。你这台基本没真问题，再观察一下，如果持续报 /boot 失败我再深挖"),
        ],
    ),

    # ---- 批量改名 ----
    agent_sample(
        "batch-rename", "批量给文件加前缀",
        "把当前目录下所有 .jpg 文件前面加个 photo_ 前缀",
        [
            ("tool_call", {"thinking": "先看有哪些 jpg，避免误伤，再加前缀", "command": "ls *.jpg"}),
            ("tool_result", "a.jpg\nb.jpg\nc.jpg"),
            ("tool_call", {"thinking": "只有 3 个 jpg，用循环加前缀，安全", "command": "for f in *.jpg; do mv \"$f\" \"photo_$f\"; done && ls photo_*.jpg"}),
            ("tool_result", "photo_a.jpg\nphoto_b.jpg\nphoto_c.jpg"),
            ("assistant", "三个都加好前缀了：photo_a.jpg、photo_b.jpg、photo_c.jpg"),
        ],
    ),

    # ---- 查进程并按需处理 ----
    agent_sample(
        "process-kill", "找到并结束卡死的进程",
        "有个进程卡死了，帮我看下 pid 并结束",
        [
            ("tool_call", {"thinking": "先按名字找进程，确认是哪个再决定杀不杀", "command": "ps aux | grep -iE 'blender|卡死' | grep -v grep"}),
            ("tool_result", "user 8891 12.0 5.1 2:03:45 blender"),
            ("assistant", "找到 blender，pid 8891，跑了两小时了。你要我直接结束它吗？确认我就 kill"),
            ("user", "结束它"),
            ("tool_call", {"thinking": "用户确认，结束进程并确认没了", "command": "kill 8891 && sleep 1 && ps -p 8891 || echo '进程已结束'"}),
            ("tool_result", "进程已结束"),
            ("assistant", "blender 已结束。下次卡死可以先看下它是不是在正常渲大图，别一上来就杀"),
        ],
    ),

    # ---- 查 WiFi / 网络 ----
    agent_sample(
        "network-wifi", "排查 WiFi 连不上",
        "我 WiFi 突然连不上了",
        [
            ("tool_call", {"thinking": "先查无线有没有被硬件/软件关闭，再看当前连接状态", "command": "rfkill list wifi && iwctl station list"}),
            ("tool_result", "soft blocked: no\nhard blocked: no\n（station 无连接）"),
            ("tool_call", {"thinking": "没被关，只是没连上，扫描可用网络", "command": "iwctl station wlan0 scan && iwctl station wlan0 get-networks"}),
            ("tool_result", "Network name  Security  Signal\nHome_wifi    psk       >60%"),
            ("assistant", "你的网卡没被关、信号也在，能看到 Home_wifi。多半是之前那个连接配置丢了，我重新连一下这个网络，密码还是原来那个？告诉我密码我就连"),
            ("user", "密码是 abc123456"),
            ("tool_call", {"thinking": "用户给了密码，重新连接这个 WiFi", "command": "iwctl station wlan0 connect Home_wifi --passphrase abc123456 && sleep 3 && ping -c2 1.1.1.1"}),
            ("tool_result", "Connection established\nPing 1.1.1.1: 1.2 ms, 0% loss"),
            ("assistant", "连上了，也通了外网。这次是为啥断的不好说，可能是睡眠唤醒后连接掉了，重连就好。以后再掉，直接喊我"),
        ],
    ),

    # ---- 查文件类型/占用 ----
    agent_sample(
        "which-file", "定位一个大文件",
        "帮我找到 /home 下最大的几个文件",
        [
            ("tool_call", {"thinking": "用 du 扫 /home 下最大的文件,先找大户", "command": "du -ah /home/user 2>/dev/null | sort -rh | head -10"}),
            ("tool_result", "5.1G /home/user/Videos/big.mkv\n3.2G /home/user/Downloads/game.iso\n1.8G /home/user/.cache/thumbnails"),
            ("assistant", "最大的三个：Videos/big.mkv 5.1G、Downloads/game.iso 3.2G、另外 .cache/thumbnails 缓存 1.8G。前两个是正经文件你自己看要不要；缓存那个我可以帮你清。要我清缓存吗？"),
            ("user", "清缓存吧"),
            ("tool_call", {"thinking": "清缩略图缓存", "command": "rm -rf /home/user/.cache/thumbnails/* && du -sh /home/user/.cache/thumbnails"}),
            ("tool_result", "0K /home/user/.cache/thumbnails"),
            ("assistant", "缩略图缓存清空了，省了 1.8G。大电影和大文件你自己决定留不留"),
        ],
    ),

    # ---- 查软件是否需要更新（只读）----
    agent_sample(
        "check-updates", "查看系统待更新包",
        "看看我的系统有哪些包可以更新，先别装",
        [
            ("tool_call", {"thinking": "只查询待更新列表，不实际升级", "command": "checkupdates"}),
            ("tool_result", "linux 6.12.5-1 -> 6.12.6-1\nfirefox 132.0-2 -> 133.0-1\npipewire 3.0-1 -> 3.0-2"),
            ("assistant", "有 3 个待更新：linux（内核 6.12.5→6.12.6）、firefox（132→133）、pipewire（3.0-1→3.0-2）。内核更新完一般要重启。要我现在滚一套吗？还是你自己安排时间"),
            ("user", "现在滚吧"),
            ("tool_call", {"thinking": "用户确认升级，用 pacman -Syu 全量更新", "command": "sudo pacman -Syu --noconfirm"}),
            ("tool_result", "packages (3) linux-6.12.6-1 firefox-133.0-1 pipewire-3.0-2-1\n... done\n==> Updating initcpio... done"),
            ("assistant", "三个都更到最新了，initramfs 也重建好了。内核换了，记得重启一次让新内核生效，重启后如果不稳还能回退到旧内核"),
        ],
    ),
]
