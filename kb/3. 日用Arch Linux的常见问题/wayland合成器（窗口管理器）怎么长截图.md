AUR上有一个shorin制作的长截图工具，如果你是Niri、Hyprland之类的Wayland合成器的话可以直接安装这个包：wl-longshot-git

安装后运行 `wl-longshot` 即可打开菜单选择截图方式。它支持三种后端：

- `grim`：逐块截图后拼接，适合复杂页面，还支持只框选一次区域的自动模式。
- `wl-screenrec`：录制屏幕流，滚动鼠标后停止即可。
- `wf-recorder`：兼容性更好的视频后端后备方案。

依赖包括 `slurp`（选区）、`wl-clipboard`（复制到剪贴板）、`python-opencv` 和 `python-numpy`（拼接）、`satty`（编辑图片）等，菜单会自动用 wofi/fuzzel/rofi，没装的话回退到终端文本菜单。
