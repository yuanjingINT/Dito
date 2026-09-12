先确认`XMODIFIERS=@im=fcitx`变量有没有正确设置，kde plasma桌面记得启用设置里的`fcitx5 wayland启动器`（虚拟键盘）。

>在 Wayland 下，fcitx5 官方建议**不要**设置 `GTK_IM_MODULE` 和 `QT_IM_MODULE` 环境变量，只保留 `XMODIFIERS=@im=fcitx`，让输入法通过 Wayland 的 text-input 协议工作。详见 [Using Fcitx 5 on Wayland](https://fcitx-im.org/wiki/Using_Fcitx_5_on_Wayland)。

如果还是不行的话编辑.desktop文件修改`Exec=`后面的命令。

这些文件存放在`/usr/share/applications`和`~/.local/share/applications`。不要直接修改`/usr/share/applications`里的文件，复制一份到用户空间再改。

- 对于QT和GTK应用

  如果是 XWayland 应用，可以试试用环境变量启动：

  ```
  Exec= env GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx 
  ```

  `env`设置启动时的环境变量。注意纯 Wayland 原生应用不需要这样设置。

- 对于chromium和electron应用

  以qq为例，在linuxqq 【此处】%U添加命令行参数

  ```
  --ozone-platform=wayland
  ```

  不行的话设置：

  ```
  --enable-features=UseOzonePlatform --ozone-platform=wayland --enable-wayland-ime
  ```

  如果候选框位置偏移或者还是打不出中文，再加上：

  ```
  --wayland-text-input-version=3
  ```

  示例：

  ```
  Exec=env DESKTOPINTEGRATION=false /usr/bin/linuxqq --no-sandbox --ozone-platform=wayland --enable-wayland-ime %U
  ```

  >对于 QQ，也可以把 electron 参数写到 `~/.config/qq-electron-flags.conf` 里，每行一个参数，这样不用改 desktop 文件。
