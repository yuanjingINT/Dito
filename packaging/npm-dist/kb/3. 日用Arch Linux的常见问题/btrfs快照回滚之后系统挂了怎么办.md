原因：可能是esp挂载点为/boot导致里面的内核文件没能被btrfs快照存档，回档之后/boot里的内核和系统里的内核模块版本不一致导致进不去系统。启动时的报错信息应该是/boot挂载失败。
解决办法：进icu（Arch Linux的ISO LIVE环境，我把它称作ICU），重新挂载根和ESP，然后更新系统内核：`pacman -S linux`（此处的`linux`应该是你实际使用的内核。）
