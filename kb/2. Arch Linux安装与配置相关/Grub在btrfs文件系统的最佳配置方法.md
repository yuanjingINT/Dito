
原理：grub装进esp，`grub.cfg`生成在`/boot/grub`，手动编辑esp里的`grub.cfg`指定目录，在启动时读取真正的`grub.cfg`。

1. 删除链接

    如果你的`/boot/grub`是指向esp里的grub的链接，请删除后创建真实的目录。

    ```
    sudo rm -rf /boot/grub

    sudo mkdir -p /boot/grub
    ```

2. 查找根分区的UUID

    ```
    findmnt / -n -o UUID
    ```

    >`findmnt /`列出跟根目录挂载信息

    >`-n`隐藏标题

    >`-o UUID`只输出UUID

3. 编辑存根

    ```
    sudo vim /efi/grub/grub.cfg
    ```

    此处的`/efi`应为你实际的esp位置。

    写入以下内容：

    ```
    # 设置root环境变量为实际的根分区设备
    search --fs-uuid --no-floppy  --set=root 你的Btrfs分区UUID

    # 读取根分区中的grub.cfg文件
    configfile /@/boot/grub/grub.cfg
    ```

    >`search --fs-uuid <你的Btrfs分区UUID>`通过uuid搜索分区。

    >`--no-floppy`跳过软盘设备。

    >`--set=root`将搜索到的第一个设备设置为`root`。

    `root`是grub的环境变量之一，默认值是grub所在的设备。我的grub安装在了esp，那`root`的值就是esp的设备名。我们为了btrfs回档要把grub.cfg存在btrfs文件系统里，所以要手动指定root的值为btrfs文件系统所在的设备。

    `configfile`读取配置文件。`/@/boot/grub/grub.cfg`是配置文件目录，不指定设备的话默认在`root`环境变量指定的设备上查找此目录。

4. 配置快照启动项grub-btrfs

    `grub-btrfs.cfg`是快照启动项的配置文件。grub寻找此文件时查的目录由`prifix`变量指定，这个变量代表的是grub的安装位置。我的grub安装在esp，所以`prefix`的值是`/efi/grub`，也就是说grub查找快照启动项的配置文件时的完整路径是`/efi/grub/grub-btrfs.cfg`。但是快照启动项的配置文件默认被生成到`/boot/grub/grub-btrfs.cfg`而不是`/efi/grub/grub-btrfs.cfg`，所以我们要修改`grub-btrfs`的配置文件指定grub在`/boot/grub`里寻找快照启动项的配置文件。

    ```
    sudo vim /etc/default/grub-btrfs/config
    ```

    找到下面这段内容：

    ```
    # GRUB_BTRFS_GBTRFS_SEARCH_DIRNAME="\${prefix}"
    ```

    改成：

    ```
    GRUB_BTRFS_GBTRFS_SEARCH_DIRNAME="/@/boot/grub"
    ```

    注意，`/@`必须是你实际的根子卷。

5. 生成`grub.cfg`

    ```
    sudo grub-mkconfig -o /boot/grub/grub.cfg
    ```

大功告成。现在对启动流程来说至关重要的`grub.cfg`就在快照的范围里啦，回档的时候引导也会跟着一起回档，除非btrfs文件系统本身坏掉，否则系统99.9%的情况下都不会再挂啦。

