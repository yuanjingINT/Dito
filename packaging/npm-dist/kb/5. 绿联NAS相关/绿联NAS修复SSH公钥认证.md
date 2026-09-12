# 绿联 NAS SSH 公钥登录配不上：权限被 UGOS 改回去

UGOS 上配 ssh 公钥认证不省心：直接用 `ssh-copy-id` 后，密钥可能时不时失效——因为 UGOS 的 web 界面/系统会重置 `~/.ssh/authorized_keys` 或目录权限，导致服务端拒绝。

## 解法：加一个 systemd 服务盯着权限

SSH 登录后：

1. 建修复脚本（把 `<USER NAME>` 换成你的用户名）：
   ```bash
   sudo nano /usr/local/bin/check_and_fix_ssh_permissions.sh
   sudo chmod +x /usr/local/bin/check_and_fix_ssh_permissions.sh
   ```
   ```bash
   #!/bin/bash
   # 用法：传用户名作为 $1
   USER="$1"
   HOME_DIR="/home/$USER"
   SSH_DIR="$HOME_DIR/.ssh"
   AUTHORIZED_KEYS="$SSH_DIR/authorized_keys"

   set_permissions() {
       [ "$(sudo runuser -l $USER -c "stat -c '%a' $HOME_DIR")" != "700" ] && sudo chmod 700 "$HOME_DIR"
       [ "$(sudo runuser -l $USER -c "stat -c '%a' $SSH_DIR")" != "700" ] && sudo chmod 700 "$SSH_DIR"
       [ "$(sudo runuser -l $USER -c "stat -c '%a' $AUTHORIZED_KEYS")" != "600" ] && sudo chmod 600 "$AUTHORIZED_KEYS"
   }
   set_permissions
   while inotifywait -e attrib "$HOME_DIR" "$SSH_DIR" "$AUTHORIZED_KEYS"; do
       set_permissions
   done
   ```
   需要装 `inotify-tools`。

2. 建 systemd 模板服务 `/etc/systemd/system/ssh-permission-monitor@.service`：
   ```ini
   [Unit]
   Description=Monitor and enforce permissions home directory and .ssh for user %I
   After=network.target

   [Service]
   ExecStart=/usr/local/bin/check_and_fix_ssh_permissions.sh %i
   Restart=always
   User=root
   ExecStartPre=/bin/bash -c 'while ! systemctl is-active ssh || ! [ -d /home/%i ]; do echo "Waiting..."; sleep 5; done'

   [Install]
   WantedBy=multi-user.target
   ```

3. 启用：
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable ssh-permission-monitor@<USER NAME>.service
   sudo systemctl start ssh-permission-monitor@<USER NAME>.service
   sudo systemctl status ssh-permission-monitor@<USER NAME>.service
   ```

这样即使重启或 UGOS web 改了配置，密钥也能继续用。

## 参考

- UGREEN-NASync/community-guide 的 ssh_public_key 一文（源自 ln-12/UGOS_scripts）
