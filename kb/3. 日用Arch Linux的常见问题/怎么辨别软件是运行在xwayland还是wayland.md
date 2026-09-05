
可以使用`xorg-xeyes`或者`xorg-xlsclients`。

用`xeyes`的话，打开之后在窗口移动鼠标，如果眼睛在动就是xwayland，不动就是wayland。

用`xlsclients`的话，在输出列表里的就是xwayland，不在的就是wayland。

也可以装 `wayland-utils` 然后用 `wayland-info` 命令，能列出当前 Wayland 合成器下的客户端窗口。
