
>扩容可以在系统运行的时候进行

在进行扩容和缩容操作之前要先明确一个概念：块设备。`lsblk -p`列出的每一个`/dev`开头的分区都是一个块设备，文件系统只认块设备，不看这个块设备是在你的硬盘1上还是在硬盘2上又或者在你的移动U盘上。

分两种情况：`调整大小（resize）`和`添加（add）`

- resize

    如果是单个硬盘上的连续空间，使用此方法（单个硬盘但是空间不连续，可以使用gparted移动分区）。

    原理是先调整物理分区大小，再调整btrfs文件系统大小。

    1. cfdisk调整物理分区大小

        ```
        sudo cfdisk /dev/nvme0n1
        ```
        > /dev/nvme0n1替换为你实际的块设备名称

        选中`更改尺寸 resize`扩容分区（直接回车会自动合并连续的空闲空间）；然后选择`写入 Write`，输入`yes`，回车保存更改；`退出 Quit`退出cfdisk。

    2. 调整btrfs文件系统大小

        >`btrfs`命令由`btrfs-progs`提供

        ```
        sudo btrfs filesystem resize max /
        ```
        >`filesystem resize`调整文件系统大小
        
        >`max /` 将根目录所在文件系统扩容至最大物理硬盘空间
    
    3. 确认

        ```
        df -h /
        ```
        通过大小一那列可以看到扩容成功。

    - 减少硬盘空间
  
        缩小的话只需要将过程反过来，先缩小文件系统大小再缩小分区大小。

        先用`df -h /`确认可用空间；然后用`btrfs`调整大小：

        ```
        sudo btrfs filesystem resize -10G /
        ```
        >`resize -10G /`将文件系统缩小了10G
        
        >这里还可以指定缩小到多少G，例如缩小到50G就是 `resize 50 /` 

        现在用`df -h /`就可以看到大小变小了，记住这个数值后用`cfdisk`的resize功能缩小分区大小就行。

- add
    
    如果是多个硬盘上的块设备，使用此方法（未分配空间需要先新建为块设备）。

    原理是将新的块设备加入当前文件系统，btrfs文件系统会智能在多个块设备之间存储数据。

    1. 添加块设备

        ```
        sudo btrfs device add /dev/vda2 /
        ```
        >`/dev/vda2`替换为你实际用来扩容的新块设备名称

        >`device add /dev/vda2 /`添加`/dev/vda2`到根目录所在文件系统

    2. 确认

        ```
        df -h /
        ```
        可以看到空间已经变大。
        ```
        btrfs filesystem show /
        ```
        可以看到该文件系统下有多个块设备。

    - 减少硬盘空间

        把新增的块设备移除即可（要确保移除之后的剩余空间足够存下两个块设备上已有的数据）：

        ```
        sudo btrfs device remove /dev/vda2 / 
        ```
        现在再用`btrfs filesystem show /`，输出结果里就没有那个设备了。

- swap分区（交换分区）

    跨多个设备的文件系统不能使用交换文件，如果你配置了交换文件的话必须更换为交换分区，方法如下：

    1. 删除swapfile
   
        `swapoff`命令关闭现有的交换文件，然后编辑`/etc/fstab`删除交换文件的自动挂载，再用`rm`命令删除交换文件。

    2. 腾出空间

        用上面缩容的方法腾出一块空间用作交换分区。
    
    3. 格式化

        使用`cfdisk`把腾出的空间新建为块设备，`type`选择`Linux Swap`。然后用`mkswap`命令格式化。

    4. 启用和自动挂载

        
        `使用swapon`命令现在启用交换分区。然后使用`lsblk -f`获取swap分区的UUID；编辑`/etc/fstab`加上如下内容：

        ```
        UUID=你的swap分区的UUID  none  swap  defaults 0 0 
        ```
        
- 在跨设备的情况下缩容

    ```
    sudo btrfs filesystem show /
    ```
    示例输出：
    ```
    Label: none  uuid: 7f989f8d-d2ce-4c91-9cf3-db687089ce4e
	Total devices 2 FS bytes used 629.31GiB
	devid    1 size 879.00GiB used 514.02GiB path /dev/nvme0n1p2
	devid    2 size 931.51GiB used 486.00GiB path /dev/nvme1n1
    ```
    记录自己要缩小的硬盘的`devid`，在上面的示例输出中我想要缩容的`/dev/nvme0n1`的`devid`是1。

    用`devid`指定设备，其他的就和单设备缩容差不多了：
    ```
    sudo btrfs filesystem resize 1:-75G /
    
    cfdisk /dev/nvme0n1
    > resize 
    > 879G
    > write
    > yes
    > exit

    sudo btrfs filesystem resize 1:max /
    # 我前面预留了一些空间，所以这里再max一次补全
    ```

