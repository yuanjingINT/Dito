# Dito（蒂特）

基于 [pi](https://pi.dev) 打造的个人 AI 助手——跑在你电脑里的虚拟生命。

- **多端接入**：终端 TUI、QQ（SnowLuma）、Matrix（E2EE 加密房间）、手机 App / iPhone PWA（扫码配对、公网中继）
- **网页管理后台**（`dito qqadmin`）：QQ 频道与 Matrix 频道的图形化管理——状态总览、实时消息流、聊天查看与手动发送、好友/群深度配置、好感度、表情包库、频道配置表单、OneBot 动作台
- **MCP 双向**：MCP Server 把 Dito 的工具（知识库/记忆/联网搜索/系统信息/命令行）暴露给手机和其他客户端；MCP Client 接入外部 MCP 服务器扩充 Dito 自己的工具箱
- **语音对话**：全屏水波界面，唤醒词 → STT（whisper-cli / 小米 MiMo）→ 大模型 → TTS（espeak-ng / piper / 小米 MiMo），Windows/macOS/Linux 三平台录音适配
- **知识库**：本地 SQLite + 中文检索，内置 Arch Linux 等 Linux 知识；**记忆**：知识点 + 历史对话，按聊天隔离、跨会话持久
- **人设系统**：Dito 人设 + 用户身份可切换；系统检测自动匹配 14 份发行版专属运维提示词
- **权限门 / sudo 模式**：高危命令拦截/确认；sudo 模式下需要 root 的命令自动提权
- **默认模型免 Key 开箱即用**：opencode 免费公共模型；内置智谱 GLM-4-Flash（免费·国内直连）等可一键切换

## 目录

- [安装与体检](#安装与体检)
- [命令总览](#命令总览)
- [终端对话](#终端对话)
- [语音对话](#语音对话)
- [配置页面](#配置页面)
- [QQ 频道（SnowLuma）](#qq-频道snowluma)
- [QQ / 频道管理后台（dito qqadmin）](#qq--频道管理后台dito-qqadmin)
- [Matrix 频道](#matrix-频道)
- [手机频道（扫码配对）](#手机频道扫码配对)
- [MCP（双向）](#mcp双向)
- [常驻服务（systemd）](#常驻服务systemd)
- [数据位置](#数据位置)
- [默认模型说明](#默认模型说明)
- [人设与提示词文件](#人设与提示词文件)
- [打包与全平台](#打包与全平台)
- [许可证](#许可证)

## 安装与体检

要求 Node ≥ 22.5（`node:sqlite`）。三种安装方式：

```bash
npm i -g dito                    # npm 安装（推荐）
./packaging/build-portable.sh    # 或本地打包 AppImage / exe / .app（见下文打包章节）
git clone ... && npm install && ./bin/dito   # 源码直接跑
```

装完先体检一次，任何环境问题都会给出修复提示：

```bash
dito doctor          # Node 版本/配置/模型连通性/录音/STT/TTS/频道/MCP/外部命令 全项检查
dito doctor --ci     # CI/脚本用：失败项不改变退出码
```

## 命令总览

| 命令 | 作用 |
|---|---|
| `dito` | 全屏对话 TUI（无参数）；`dito "消息"` 单次问答 |
| `dito send` / `msg` / `message` / `-m` | 显式单次问答（支持管道输入、`--fresh` 开新会话） |
| `dito voice` | 全屏语音对话（水波界面 + 唤醒词） |
| `dito config` | 终端配置界面（模型/供应商/人设/知识库/记忆/搜索/语音/权限/频道/MCP/手机连接） |
| `dito qq` | QQ 频道守护进程（自动拉起 SnowLuma） |
| `dito qqadmin` | **网页管理后台**（QQ + Matrix，默认 http://127.0.0.1:3880/） |
| `dito matrix` | Matrix 频道守护进程（E2EE 加密房间） |
| `dito mobile` | 手机频道（终端显示二维码，扫码配对；自动内嵌中继与 MCP 隧道） |
| `dito mcp` | MCP Server 独立运行（默认 `dito mobile` 会内嵌启动） |
| `dito doctor` | 环境体检 |

## 终端对话

```bash
dito "今天天气怎么样"          # 单次问答，打印回复后退出
echo "看看这个目录" | dito send # 管道输入
dito                           # 进入全屏对话 TUI
```

**TUI 快捷键**：

- **Tab** 循环切换运行模式：`闲聊`（纯聊天不调用工具）→ `标准`（完整助手）→ `计划`（只读探索、产出计划、不执行）
- **alt+d** 新会话；**alt+a** 上一会话；**alt+w** 会话列表（↑↓ 移动、enter 恢复）
- **esc** 中断当前任务；任务运行中可直接打字插话（排队为 followUp）
- `/sudo on` / `/sudo off` 切换 sudo 权限模式；`/persona`、`/identity` 切换人设与用户身份；`/model` 切换模型
- 启动自动恢复上次会话；底部状态栏显示模式/模型/权限状态

**权限门**：`rm -rf /`、fork 炸弹、格式化等高危命令直接拦截；改动类命令弹确认。sudo 模式（`/sudo on`）下权限门关闭、需要 root 的命令自动加 `sudo`（Windows 无 sudo，自动跳过）。

## 语音对话

```bash
dito voice
```

- 空格键手动说话；配置唤醒词后待机本地 whisper 轮询 2.5 秒短音频（零 API 成本），命中后蒂特应一声「在的啊」进入对话
- 提问/请求许可时自动「朗读 → 录音」听取回答；`continuous` 开连续对话
- STT/TTS 均可选：本地 whisper-cli / espeak-ng / piper，或小米 MiMo 云端（`mimo-v2.5-asr` / `mimo-v2.5-tts`，支持音色设计）；按平台自动探测录音器（Linux pw-record→parec→arecord，macOS/Windows 走 ffmpeg）
- 配置都在 `dito config` →「语音」

## 配置页面

```bash
dito config
```

分区：**模型与供应商**（模型列表从 API 实时刷新，可增删供应商）、**提示词设定**、**知识库**、**记忆**、**网络搜索**（Tavily/Exa/SearXNG/免 Key DuckDuckGo）、**语音**、**权限与 sudo**、**频道**（QQ / Matrix / 手机连接）、**MCP 服务**。全部改动即时写盘。

## QQ 频道（SnowLuma）

1. 安装 [SnowLuma](https://www.npmjs.com/package/@snowluma/sdk) 本体（QQ 协议端）
2. `dito config` →「频道」→「QQ（SnowLuma）」：启用、填地址（默认 `ws://127.0.0.1:3001`）与 Token、配置响应范围
3. `dito qq` 启动——**自动拉起 SnowLuma**（探测端口 → 自动找启动命令 PATH/systemd/docker → 拉起 → 自动填配置；已在运行则直连）

能力：

- 私聊/群聊对话，每聊天独立持久会话，QQ 专属人设（纯文本风格）；主人私聊全量工具，其余会话受限（屏蔽电脑控制/凭据类，保留搜索/知识库/记忆/娱乐）
- **184 个 OneBot 动作**注册为独立工具（`snowluma_*`）由模型自主选择：查好友/群成员/群公告、群签到、AI 语音、**QQ 空间全套**（发说说/动态/点赞）等
- 被戳自动戳回去；按消息情绪自动贴表情回应；回复超 100 字自动转图片；概率附赠随机表情包
- **群聊好感度**：每个群友 0-100 分，模型自主加减（单次 ±20），语气随分数变化；**低于 20 分直接忽略其消息**
- 群聊白名单 + 唤醒词 + 概率回复（被 @/唤醒词必答）；好友/群请求自动同意可选
- **行为字段（owners/groups/概率/开关）后台改动即时生效**——频道进程每条消息重读配置，无需重启

## QQ / 频道管理后台（dito qqadmin）

```bash
dito qqadmin                # http://127.0.0.1:3880/（channels.qq.admin.port 可改）
dito qqadmin --port 9000 --token xxx --host 0.0.0.0   # 局域网开放必须配令牌
dito qqadmin --no-bot       # SnowLuma 离线时纯管理本地数据
```

页面与 QQ 频道深度管理：

| 页面 | 功能 |
|---|---|
| 总览 | 登录号/在线状态/数据统计（表情包·好感度·会话数）、快捷开关（私聊/戳回/自动表情/自动同意） |
| 消息流 | SSE 实时推送所有 QQ 消息/通知/请求，按私聊/群/通知/请求过滤 |
| 聊天 | 会话列表 → **OneBot 原始记录 + Dito 会话合并展示**，底部手动发送（超 100 字自动转图） |
| 好友 | 列表；**点击好友打开深度配置**：资料/点赞×10/戳一戳/发私信/查看记录/重置 Dito 会话 |
| 群列表 | 列表；**点击群打开深度配置**：群信息、Dito 行为开关（响应此群/仅唤醒响应）、机器人群名片、群公告查看+发布、全员禁言、退群（双重确认）、发消息、会话重置、**成员逐人操作**（设名片/禁言 N 分钟/戳一戳） |
| 好感度 | 按群分组表格，行内 ±/设定，低于 20 标红；**改动热同步到 dito qq 进程**（互不覆盖） |
| 表情包 | 网格预览 + 元信息 + 删除 |
| Matrix | 见下节 |
| 配置 | QQ 频道全部字段表单化保存 |
| 动作台 | OneBot 动作白名单透传（21 个常用动作；凭据类动作永不暴露） |

- **安全**：默认只绑 127.0.0.1；`channels.qq.admin.token` 非空时非本机访问强制 `?token=` / Bearer
- **手机远程管理**：mobile 频道启用时自动挂载隧道 `/qq`，配对设备经 `https://<中继>/t/<房间>/qq/` 打开同一个后台
- 多客户端并存：后台自建一条 SnowLuma 连接，与 `dito qq`、终端 TUI 互不干扰

## Matrix 频道

1. 在 Matrix 客户端（如 Element）里创建机器人账号，取 Access Token（Element：设置 → 帮助与关于 → 高级）
2. `dito config` →「频道」→「Matrix」，或 **后台「Matrix」页** 填写：启用、Homeserver、Access Token、响应房间（留空 = 所有已加入房间）、主人列表
3. `dito matrix` 启动

- **E2EE 端到端加密房间支持**（Rust crypto store 持久化于 `matrix-crypto-store/`，跨重启稳定）；受邀自动进房
- 主人判定：DM 且成员仅 bot + 主人 → 全量工具；其余房间受限（与 QQ 语义一致）
- 行为字段（rooms/owners/enabled）后台改动即时生效；Homeserver/Token 改动需重启 `dito matrix`
- 后台「Matrix」页可看：守护进程运行状态（PID/时长）、令牌有效性、机器人账号、全部已加入房间（名称/人数/是否响应中）

## 手机频道（扫码配对）

让手机（Android App / iPhone PWA）连上电脑上的 Dito——局域网直连，或经公网中继连回家。

1. 电脑运行 `dito mobile`，终端显示**配对二维码**
2. 手机扫码（或浏览器打开二维码地址）→ 电脑端按 `y` 确认 → 配对成功
3. 手机上直接和 Dito 对话：流式回复、工具执行可见，每设备独立持久会话（主人级权限）

- **局域网模式**（默认）：电脑内嵌中继监听 8787，无需任何外部服务
- **公网模式**：把 `relay/` 部署到 VPS（见 `relay/README.md`，单文件仅依赖 `ws`），`channels.mobile.relayUrl` 填中继地址——无需公网 IP/端口转发，电脑侧只做出站连接
- **Android App**：见 [dito-mobile 仓库](https://github.com/yuanjingINT/dito-mobile)（「电脑」屏幕粘贴配对链接即连）
- **iPhone PWA**：把移动端仓库 `pwa/` 目录配到 `channels.mobile.pwaDir`，扫码即用（支持语音按住说话→电脑 MiMo ASR），Safari「添加到主屏幕」成独立应用
- **安全**：配对令牌一次性；deviceToken 可在 `dito config` →「手机连接」→「已配对设备」随时吊销
- **HTTP 隧道**：`channels.mobile.tunnel` 把公网请求转发到本机服务——自动挂载 `/mcp`（手机调 Dito 工具）与 `/qq`（手机开管理后台）
- 调试：`node scripts/simulate-phone.mjs "<配对URL>"` 模拟全流程；协议规格见 `docs/protocol.md`

## MCP（双向）

**MCP Server**——把 Dito 能力暴露给手机和其他客户端：

```bash
dito mcp        # 独立运行，streamable HTTP @127.0.0.1:3878
```

- 工具集：`kb_search` / `kb_read` / `kb_list` / `kb_upload`（知识库）、`memory_remember` / `memory_recall`（记忆）、`web_search` / `web_fetch`（联网）、`system_info`
- `allowBash: true` 额外暴露 `pc_bash`（在电脑上执行命令，内置危险命令拦截）
- `dito mobile` 启动时自动内嵌并挂载隧道 `/mcp`——手机 MCP 客户端配置端点 `https://<中继>/t/<房间>/mcp/`、Bearer = deviceToken 即可调用电脑工具
- 本机客户端（Claude Desktop 等）直接连 `http://127.0.0.1:3878/`

**MCP Client**——Dito 接入外部 MCP 服务器：`dito config` →「MCP 服务」→「外部 MCP 服务器」，或直接编辑 config：

```jsonc
"mcp": {
  "enabled": true,
  "server": { "enabled": true, "port": 3878, "token": "", "allowBash": false },
  "clients": [
    { "name": "github", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "enabled": true },
    { "name": "remote", "transport": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer xxx" }, "enabled": true }
  ]
}
```

远端工具以 `mcp_<服务器>_<工具>` 命名注册进对话，与内置工具同等参与；连接 15s 超时，单个坏服务器不阻塞对话。

## 常驻服务（systemd）

```ini
# ~/.config/systemd/user/dito-qq.service
[Unit]
Description=Dito QQ Channel
After=network-online.target

[Service]
ExecStart=/usr/bin/env dito qq
Restart=on-failure
Environment=NODE_OPTIONS=--experimental-sqlite

[Install]
WantedBy=default.target
```

同理可写 `dito-matrix.service`（ExecStart 换 `dito matrix`）、`dito-qqadmin.service`（换 `dito qqadmin`）。启用：`systemctl --user enable --now dito-qq`。（Node ≥23.4 可去掉 NODE_OPTIONS 行。）

## 数据位置

| 用途 | 路径 |
|---|---|
| 配置 | `~/.pi/agent/dito/config.json` |
| 供应商模型表 | `~/.pi/agent/dito/models.json`（自动生成） |
| pi 共享鉴权 | `~/.pi/agent/auth.json` |
| 知识库 | `~/.pi/agent/dito/kb.db`（每聊天隔离：`kb-<scope>.db`） |
| 记忆 | `~/.pi/agent/dito/memory.db`（每聊天隔离：`memory-<scope>.db`） |
| 终端会话 | `~/.pi/agent/dito/sessions/*.jsonl` |
| QQ 会话映射 / 会话 | `~/.pi/agent/dito/qq-chats.json` / `qq-sessions/` |
| Matrix 会话映射 / 会话 / 加密库 | `matrix-chats.json` / `matrix-sessions/` / `matrix-crypto-store/` |
| 手机会话映射 / 会话 | `~/.pi/agent/dito/mobile/mobile-chats.json` / `mobile/mobile-sessions/` |
| 群聊好感度 | `~/.pi/agent/dito/affinity.json` |
| 表情包库 | `~/.pi/agent/dito/memes/`（索引 `memes.json`） |

## 默认模型说明

**默认 = OpenCode Zen 公共端点（`opencode-free`）**：keyless OpenAI 兼容服务，零注册零 Key 开箱即用（聊天 `big-pickle`，视觉 `mimo-v2.5-free`）。免费额度有限可能 429 限流，稍后重试即可；服务器在海外，国内延迟偏高。

**国内直连 + 免费**：`dito config` 切到「智谱 GLM（BigModel）」，选 GLM-4-Flash（官方永久免费，128K）或 GLM-4V-Flash（免费视觉）。在 [open.bigmodel.cn](https://open.bigmodel.cn) 免费注册 Key 填入即可。

其他内置供应商随时可切：

| 供应商 | 端点 | 说明 |
|--------|------|------|
| 智谱 GLM（`zhipu`） | `open.bigmodel.cn/api/paas/v4` | GLM-4-Flash / 4V-Flash 免费，GLM-5.x 全系 |
| DeepSeek 官方（`deepseek`） | `api.deepseek.com` | V4 Flash/Pro，国内直连 |
| 阿里云百炼（`dashscope`） | `dashscope.aliyuncs.com/compatible-mode/v1` | Qwen 系列 |
| 月之暗面（`moonshot`） | `api.moonshot.cn/v1` | Kimi 系列 |
| 硅基流动（`siliconflow`） | `api.siliconflow.cn/v1` | 开源模型多，部分免费 |
| 火山方舟（`volcengine`） | `ark.cn-beijing.volces.com/api/v3` | 豆包系列 |
| Ollama（`ollama`） | `localhost:11434` | 本地离线，免费 |
| OpenCode Go（`opencode-go`） | `opencode.ai/zen/go` | 付费中转（DeepSeek V4 / Kimi K3 / GLM / MiniMax），需 `OPENCODE_API_KEY` |

## 人设与提示词文件

- `personas/dito.md`：Dito 主人设；`personas/dito-qq.md`：QQ 专属人设
- `identities/*.md`：用户身份（默认 / linux小白 / 老板），决定回答方式
- `system-prompts/*.md`：14 份系统/发行版专属运维提示词（arch/debian/fedora/windows/macos…）

在 `personas/` 或 `identities/` 新增 `.md` 后，`/persona`、`/identity` 即可看到并切换。

## 打包与全平台

```bash
packaging/build-portable.sh       # 三平台产物，见下
```

- `dist/dito-linux-x64.AppImage`（55M，双击即用，内置 Node）
- `dist/dito-win-x64.zip`（解压 `dito.exe` 为 SEA 单文件可执行 + `dito.cmd`）
- `dist/dito-macos-arm64.zip`（`Dito.app`；首启需 `xattr -cr Dito.app`）
- Linux 另有 `packaging/build.sh`（RPM）/ `packaging/build-deb.sh`（DEB）
- Android APK：[dito-mobile 仓库](https://github.com/yuanjingINT/dito-mobile)（本地 `./gradlew :app:assembleDebug` 或其 GitHub Actions）

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| 终端对话 / 频道 / 管理后台 / MCP / 手机连接 | ✓ | ✓ | ✓ |
| 系统提示词 | 按发行版 14 份 | macos.md | windows.md |
| AUR / COPR 工具 | ✓（仅 Linux 注册） | — | — |
| 语音录音 | pw-record → parec → arecord | ffmpeg avfoundation | ffmpeg dshow |
| sudo 权限模式 | ✓ | ✓ | 无 sudo，自动跳过提权 |

QQ 频道依赖的 @snowluma/* 包为其自有许可（源可见、非 OSI 开源、非商业使用），不装它或停用 snowluma 插件即可规避；详见 NOTICE。

## 许可证

本项目采用 [GPL-3.0-only](LICENSE)（GNU General Public License v3.0）开源发布。
源码仓库即官方分发渠道，二进制打包（deb/rpm/npm 包）随包附同一许可证文本。
Android 移动端（dito-mobile 仓库）基于 Operit（LGPL-3.0）修改，依 LGPL §3 以 GPL-3.0 发布。
