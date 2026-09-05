# 绿联 NAS Docker 玩法：常用应用部署（compose）

UGOS Pro 自带 Docker，支持 compose 项目管理。通用流程：Docker 应用 → Project → Create → 粘贴 compose 文件 → Deploy Now；或用 SSH 下 `sudo docker compose up -d`。以下是社区 wiki 验证过的玩法。**数据卷一律挂到 `/volume1` 或 `/volume2`（机械盘）放数据、`/volume2/docker` 放配置**，容器删了数据不能没。

## AdGuard Home（全屋去广告 DNS）

- 端口 53 是 DNS，UGOS 默认 dnsmasq 占着 53，**先停掉 dnsmasq**：
  ```bash
  sudo systemctl stop dnsmasq
  sudo systemctl disable dnsmasq
  sudo lsof -i :53   # 确认 53 空了
  ```
- 用 `network_mode: host` 免端口映射，数据挂 `/opt/adguardhome/work` 和 `/conf`。
- 管理面板 `http://<nas>:3000`，配完让路由器/客户端把 DNS 指到 NAS 即可。

## Home Assistant（智能家居）

```yaml
services:
    homeassistant:
        container_name: homeassistant
        image: homeassistant/home-assistant:latest
        restart: always
        network_mode: host
        volumes:
            - ./homeassistant:/config
        environment:
            - TZ=Asia/Shanghai
```
- 访问 `http://<nas>:8123`。
- HACS 插件：在 `docker/homeassistant` 下建 `custom_components`，把 GitHub 下载的 hacs.zip 解压成 `custom_components/hacs`，重启容器后 Settings → Devices & Services 添加集成并绑 GitHub。

## Immich（自托管相册）

- compose 有 4 个服务：server + machine-learning（用 `-openvino` 镜像吃 Intel 核显）+ redis + postgres。数据挂 `./library:/usr/src/app/upload`，把 `/dev/dri` 设备给容器。
- 访问 `http://<nas>:2283`。管理页可开 Quicksync 硬件转码。
- 支持 EXIF 搜索、人脸识别、地理定位、多用户、移动端自动备份。想远程访问配外部域名 + SMTP 通知。

## Nextcloud-AIO（网盘全家桶）

- compose 部署后访问 `http://<nas>:11000`，经 NPM 反代出去。
- 反代高级配置加：`client_body_buffer_size 512k; proxy_read_timeout 86400s; client_max_body_size 0;`
- 跑 occ：`sudo docker exec --user www-data -it nextcloud-aio-nextcloud php occ 命令`
- 时区/语言在 `config/config.php` 里改（`default_timezone`、`default_locale` 等）。

## Nginx Proxy Manager（反代 + 证书）

- 访问 `http://<nas>:8181`，默认账号 `admin@example.com` / `changeme`，登录后立刻改。
- 建 Let's Encrypt 泛域名证书（DuckDNS DNS Challenge），Proxy Host 里转发到各服务。
- **路由器的对外端口只开 NPM 的 443/4443**，别把各服务端口直接暴露到公网。

## OpenWebUI（本地 AI 界面）

- 访问 `http://<nas>:3000`。第一个注册账号是管理员，后续注册默认待审批。
- 数据全在本地，模型默认私有，按组/公开共享。可接 Ollama 和 OpenAI 兼容 API。

## 注意

- 容器尽量用非 root 用户跑，共享路径权限用 `ugacltool` 设（见"容器非 root 运行"条目）。
- 容器总被 OOM 杀就先加 swap（见"加 swap"条目）。
- 以上 compose 文件都在 https://github.com/UGREEN-NASync/community-guide 的 `docs/ugos/install/` 下。
