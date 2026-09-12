tuigreet是极速，基于greetd的纯tty tui显示管理器（如果进入tuigreet之后还有日志输出会导致tuigreet的tui错位）。

1. 安装

    ```
    sudo pacman -S --noconfirm --needed greetd greetd-tuigreet
    ```

2. 简单配置

    ```
    sudo vim /etc/greetd/config.toml
    ```

    ```
    [terminal]
    # 绑定到 TTY1
    vt = 1

    [default_session]
    # 使用 tuigreet 作为前端
    # 自动扫描 /usr/share/wayland-sessions/，支持时间显示、密码星号、记住上次选择
    command = "tuigreet --time --user-menu --remember --remember-user-session --asterisks"
    user = "greeter"
    ```

3. 启用greetd

    ```
    systemctl enable greetd
    ```
