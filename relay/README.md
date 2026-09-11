# Dito 中继服务

手机 / PWA 与桌面端不在同一网络时的转发枢纽。桌面端与手机都只做出站 WebSocket
连接，因此家里的电脑无需公网 IP、无需端口转发。中继只转发加密前令牌鉴权后的
消息，本身不保存聊天内容（内存转发，不落盘）。

- 协议细节见桌面仓库 `docs/protocol.md`
- 许可证 GPL-3.0-only（见上级目录 LICENSE）

## 本地运行（局域网模式）

桌面端 `dito mobile` 在未配置远程中继时会自动内嵌启动本服务（监听
`0.0.0.0:8787`，二维码直接给局域网 IP），无需手动运行。手动运行仅用于调试：

```bash
cd relay
npm install
npm start            # 默认 0.0.0.0:8787
npm start -- --port 9000 --base-url http://192.168.1.10:9000
```

- `--port`：监听端口（默认 8787）
- `--base-url`：配对二维码 URL 的对外基址；缺省自动取本机局域网 IP
- `--pwa-dir`：可选。指向 PWA 构建产物目录后，配对页 `/p/<room>` 会服务
  PWA；不配则使用内置极简聊天测试页

## 公网部署（VPS）

1. 任意一台有公网 IP 的 VPS（1 核 512MB 起步足够），装 Node ≥ 22：

```bash
scp -r relay/ user@vps:/opt/dito-relay
ssh user@vps "cd /opt/dito-relay && npm install --omit=dev"
```

2. systemd 常驻（`/etc/systemd/system/dito-relay.service`）：

```ini
[Unit]
Description=Dito Relay
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/dito-relay/server.mjs --port 8787
Restart=always
User=nobody
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=-/tmp

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now dito-relay
```

3. TLS（强烈建议公网必须 wss/https，配对二维码里的令牌不应明文过网）。
   用 Caddy 最省事（自动签发证书）：

```
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

4. 桌面端配置 `~/.pi/agent/dito/config.json`：

```jsonc
{
  "channels": {
    "mobile": {
      "relayUrl": "https://relay.example.com"   // 指向你的中继
    }
  }
}
```

之后 `dito mobile` 的二维码即为 `https://relay.example.com/p/<房间>?k=<令牌>`，
任何网络下的手机扫码都能连回家。

## 安全模型

- 房间 ID 与 hostToken、deviceToken 均为 128 位随机数；配对令牌一次性使用。
- 新设备配对必须经桌面端人工确认（或配置 `autoApprove`）。
- deviceToken 列表的权威保存在桌面端配置里，中继重启不丢信任关系
  （中继会向桌面端核实）。
- HTTP 隧道仅放行已配对设备的 Bearer 令牌，请求/响应体上限 10MB。
- 需要更强隐私时，可把中继部署在自控 VPS 并启用 wss；聊天内容端到端
  加密为后续版本规划。
