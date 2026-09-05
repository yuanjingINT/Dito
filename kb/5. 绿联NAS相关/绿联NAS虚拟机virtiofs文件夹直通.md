# 绿联 NAS 给虚拟机共享文件夹：virtiofs + bindfs + fstab 自动挂载

UGOS Pro 的虚拟机（libvirt）想给 Linux 客户机共享宿主机文件夹，用 virtiofs。因为 UGOS 强制 `passthrough` 模式，挂进来是 `root:root` 且权限很紧，所以要在虚拟机里用 bindfs 重映射所有权。适用 UGOS Pro 1.13.x。

## 宿主机（UGOS）侧

```bash
ssh root@<ugos-host>        # 或 ssh 用户 后 sudo -i
virsh list --all            # VM 名是 UUID
virsh dumpxml <vm-name> > /tmp/vm-config.xml
```

在 `/tmp/vm-config.xml` 中，`<domain>` 下（`<devices>` 之外）加共享内存后端：
```xml
<memoryBacking>
    <access mode='shared'/>
    <source type='memfd'/>
</memoryBacking>
```

`<devices>` 里加 filesystem 块（`/volume1/projects` 换成实际路径，`projects-fs` 是 tag，记住它）：
```xml
<filesystem type='mount' accessmode='passthrough'>
    <driver type='virtiofs'/>
    <source dir='/volume1/projects'/>
    <target dir='projects-fs'/>
</filesystem>
```

重定义并重启 VM：
```bash
virsh define /tmp/vm-config.xml
virsh shutdown <vm-name>
virsh start <vm-name>
```

## 虚拟机（客户机）侧

```bash
sudo apt install bindfs
sudo mkdir -p /mnt/.projects-raw
sudo mkdir -p /mnt/projects
# 先手动挂一次确认 tag 对不对
sudo mount -t virtiofs projects-fs /mnt/.projects-raw
```

写 `/etc/fstab`（uid/gid 换成虚拟机里你的用户 id，UGOS 的 admin 组 GID 固定 10，别改）：
```
projects-fs  /mnt/.projects-raw  virtiofs  nofail,x-systemd.automount,x-systemd.device-timeout=10  0  0
bindfs#/mnt/.projects-raw  /mnt/projects  fuse  force-user=1000,force-group=1000,create-as-user,create-for-group=10,chown-ignore,chgrp-ignore,perms=0770,nofail,x-systemd.requires=/mnt/.projects-raw  0  0
```

```bash
sudo systemctl daemon-reload
ls /mnt/.projects-raw && sudo mount /mnt/projects
ls -ld /mnt/projects      # 应该是 drwxrwx--- 你的用户
```

## 坑

- fstab 里的 tag（`projects-fs`）必须和 XML 的 `<target dir>` 完全一致（区分大小写）。
- 用 UGOS GUI 改过 VM 后 `<filesystem>` 块可能被丢，挂载失效就重新加 XML 并重启 VM。
- 虚拟机里的用户名和 UGOS 里想要文件归属的用户名尽量一致。

## 参考

- UGREEN-NASync/community-guide 的 VM folder passthrough 一文
