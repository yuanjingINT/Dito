# 绿联 NAS 外网访问：Tailscale（免公网 IP）

不想开公网端口、没公网 IP 时，用 Tailscale 组虚拟局域网最省事。

```bash
ssh USERNAME@IP
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

## 坑：DNS 被覆盖导致 NAS 上不了网

UGOS 用 `/etc/resolv.conf` 存默认 DNS，而 tailscale 启动时会改写它，导致 NAS 自己上不了外网。解决办法：禁用 tailscale 的 DNS 接管再启动：

```bash
sudo tailscale down
sudo tailscale up --accept-dns=false
```

## 参考

- UGREEN-NASync/community-guide 的 tailscale 一文（源自 ln-12/UGOS_scripts）
