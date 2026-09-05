# Dito（蒂特）

基于 [pi](https://pi.dev) 打造的个人 AI 助手。参考 laozhou 项目的设计，Dito 拥有：

- **SnowLuma 工具进入终端**：QQ 频道启用时，终端 TUI 里也能让蒂特戳一戳、点赞、发表情回应、发空间说说、查/发表情包库，以及调用 SnowLuma 全部 OneBot 动作（`snowluma_*` 工具）
- **语音对话**：全屏水波界面（待机水波涟漪、录音水波扩散、思考水滴转圈、说话随声波动），提问/请求许可时自动朗读后录音，支持本地/线上 STT/TTS，连续对话可配置
- **知识库**：本地 SQLite + 中文检索，内置 Arch Linux 等 Linux 知识（48 篇）
- **记忆**：知识点 + 历史对话，自动记忆、跨会话持久
- **提示词设定**：Dito 人设 + 用户身份（默认 / linux小白 / 老板），可切换
- **系统检测**：自动识别当前操作系统与 Linux 发行版（Arch / Debian / Ubuntu / Fedora / openSUSE / Gentoo / NixOS / Alpine / Void / macOS / Windows 等），切换对应的专属运维提示词
- **发行版工具**：AUR 搜索 + 「红 / 黄 / 绿」红绿灯审查（拉 PKGBUILD 做危险信号初筛）+ AUR 安装命令生成（paru/yay）、Fedora COPR 仓库检索与启用/安装/更新命令生成
- **联网搜索**：无 key 时走 DuckDuckGo，也可配 Tavily / Exa / SearXNG
- **频道：QQ（SnowLuma）/ Matrix**：`dito qq` 通过 SnowLuma（OneBot 协议）连 QQ——私聊/群聊对话（每聊天独立会话、QQ 专属人设）、被戳自动戳回去、按情绪给消息贴表情回应、**发 QQ 空间说说**，SnowLuma 的 184 个 OneBot action 全部注册为独立工具由模型自主选择，回复超 100 字自动转图片；`dito matrix` 连 Matrix homeserver 收发房间消息。均在 `dito config` → 「频道」里配置
- **权限门 / sudo 权限**：高危命令（rm -rf /、fork bomb、格式化、卸载等）拦截/确认；可一键开启「sudo 权限模式」——权限门关闭，需要 root 的命令自动加 `sudo`（配置 / `/sudo on` 切换）
- **默认模型**：opencode 免费公共模型（`big-pickle`，视觉 `mimo-v2.5-free`）——免 Key 开箱即用；内置智谱 GLM-4-Flash（免费·国内直连）等国内模型可一键切换

## 目录结构

```
Dito/
├── bin/
│   ├── dito             # 终端对话启动器（软链到 ~/.local/bin/dito）
│   └── dito.ts          # REPL 实现（pi SDK）
│   └── prompts/          # 加密提示词包（dito-prompts.bin，AES-256-GCM）
├── extensions/           # pi 扩展（TypeScript）
│   ├── index.ts          # 入口（调用插件内核引导）
│   ├── plugin-kernel.ts  # Cordis 式插件内核：加载/依赖排序/配置启用
│   ├── prompt-crypto.ts  # 提示词加密/解密（AES-256-GCM）
│   ├── plugins/          # 一切皆插件：每个能力一个插件
│   │   ├── provider.ts       # 模型与供应商
│   │   ├── persona.ts        # 提示词设定（人设 + 身份）
│   │   ├── system.ts         # 系统检测（识别系统/发行版，注入专属提示词）
│   │   ├── mode.ts           # 运行模式（闲聊/标准/计划）
│   │   ├── knowledge-base.ts # 知识库
│   │   ├── memory.ts         # 记忆
│   │   ├── web-search.ts     # 联网搜索
│   │   ├── permission.ts     # 权限门
│   │   ├── ask.ts            # 提问工具
│   │   └── voice.ts          # 语音对话引擎
│   ├── provider.ts       # 供应商注册实现
│   ├── persona.ts        # 人设注入实现
│   ├── mode.ts           # 模式实现
│   ├── knowledge-base.ts / memory.ts / web-search.ts / permission.ts / ask.ts / voice.ts
│   └── db.ts / text.ts / util.ts
├── personas/dito.md      # Dito 主人设（开发源文件）
├── system-prompts/       # 各系统/发行版专属运维提示词（开发源文件）
├── identities/           # 用户身份（开发源文件）
├── kb/                   # 默认知识库（首次启动自动导入）
├── config/dito.json      # 配置模板（实际写入 ~/.pi/agent/dito/config.json）
└── .pi/settings.json     # 默认模型设置
```

## 快速开始

### 直接在终端对话（推荐）

```bash
# 单次问答（多种写法均可）
dito "今天天气怎么样"
dito send "今天天气怎么样"     # 也可用 dito msg / dito message
dito -m "今天天气怎么样"       # 也可用 dito --message "今天天气怎么样"

# 从管道直接发消息
echo "帮我看看这个目录" | dito send

# 进入全屏对话 TUI
dito
```

> `dito send <消息>` / `dito msg <消息>` / `dito message <消息>` / `dito -m <消息>` 都是“终端直接发消息”的显式命令：
> 起一个 Dito 会话、发送消息、打印回复后退出，适合脚本与快速问答；加 `--fresh`（或 `-f`）会开新会话再发。

**全屏对话 TUI**（复用 pi 的 `@earendil-works/pi-tui`，opencode 风格布局 + Dito 天青主题）：
- 顶栏 `◈ Dito · 当前模式 …… 当前模型`；底部为按键提示栏（右侧显示权限门/sudo 状态）；Markdown 滚动对话居中
- 启动自动恢复上次会话：历史对话直接显示在对话区（默认续接最近一次对话）
- **单行底部状态栏**：左 `◈ Dito · 当前模式 · 按键提示`，右 `当前模型 · 权限门/sudo`；任务运行中显示「● 运行中 · esc 中断 · 可插话排队」
- **Alt 会话键**：`alt+d` 新会话、`alt+a` 查看上一会话、`alt+w` 会话列表（↑↓/j-k 移动、enter 恢复、esc 返回，当前会话有标记）；**Tab** 循环切换模式：`闲聊`（纯聊天，不调用工具）→ `标准`（完整助手，全部工具）→ `计划`（只读探索、产出计划、不执行）；Alt 不可用时也可用 `/sessions`、`/prev`、`/new` 命令
- **任务中途插话**：任务运行中直接输入并发送即排队（底部状态栏显示「运行中」），当前轮结束自动发送；`esc` 中断当前任务
- 也可用命令切换：`/chat`、`/standard`、`/plan`、`/mode <名称>`、`/sudo on|off`
- 输入框：输入 `/` 自动弹出命令菜单（类似 pi/opencode），`Tab`/`Enter` 选择；`Enter` 提交、`Shift+Enter` 换行、`↑/↓` 翻阅历史；`Ctrl+C` / `Ctrl+D` 退出（`/exit` 亦可）

### sudo 权限模式

默认 Dito 开着**权限门**：fork bomb / `rm -rf /` / 直接格式化设备这类命令硬性拦截，`rm -r`、安装/卸载软件、格式化等危险操作会先向你确认。

如果你希望 Dito 真正拥有 **sudo 权限**（比如让它帮你装/卸系统软件、管理服务、挂载分区），可以开启 **sudo 权限模式**，三种方式任选：

- 聊天里发 `/sudo on`（`/sudo off` 关闭，状态栏会显示当前是 `sudo模式` 还是 `权限门`）
- `dito config` → 「权限与 sudo」分区勾选「sudo 权限模式」

开启后：

- **权限门完全关闭**：不再拦截、不再弹确认（危险与否由 Dito 按人设与你的指示自行判断）
- **自动加 sudo**：需要 root 的命令（pacman/apt/dnf 装卸、systemctl 管理服务、mount、用户管理、分区格式化等）会自动在前面补上 `sudo`；命令已带 `sudo`/`doas`/`pkexec` 或以 `cd` 等内建开头时不会重复加
- 系统提示词会注入「sudo 模式」说明，Dito 知道可以直接执行需要 root 的操作
- `autoSudo` / `sudoCommand` 可调：不需要自动加 sudo 时关掉 `autoSudo`；`sudoCommand` 默认 `sudo`，可改成 `doas`、`sudo -n` 等

> 注意：开启 sudo 模式等于把 root 权限交给 Dito，请只在自己的机器上、信任的场景使用；sudo 需要密码时请先在终端执行过 `sudo`（利用 sudo 时间戳缓存）或配置免密 sudo。

> `dito` 已软链到 `~/.local/bin/dito`。首次使用需在项目目录 `npm install`（安装 pi SDK 依赖）。

### 语音对话

```bash
dito voice          # 全屏水波界面，空格键开始说话
```

- **空格键**：唤醒 / 结束录音；**q** 或 **Esc**：退出
- 待机=水波涟漪，录音=水波扩散，思考=水滴转圈，说话=随声波动
- 提问或请求许可时，自动「朗读 → 录音听取回答」
- STT/TTS 配置分本地与线上（见 `config/dito.json`）：
  - STT：`whisper`（本地 whisper-cli，默认）/ `xiaomi`（小米 MiMo ASR，线上）/ 自定义命令
  - TTS：`espeak`（本地，默认）/ `piper`（本地）/ `xiaomi`（小米 MiMo TTS，线上）/ 自定义命令
- `continuous`：连续对话开关（默认 `false`，设为 `true` 后回答完自动继续监听）
- `autoListenAfterQuestion`：模型回复以问句结尾时自动听取回答（默认 `true`）

### 配置页面

```bash
dito config        # TUI 配置：模型 / 供应商 / 人格 / 知识库 / 记忆 / 搜索 / 语音
```

- **模型与供应商**：切换供应商、聊天模型、视觉模型；**模型列表从供应商 API 实时获取**（`GET {baseUrl}/models`），可一键「刷新模型列表」；管理供应商（新增/编辑/删除，可改 baseUrl、API Key、API 类型）
- 内置供应商：OpenCode 免费（默认）、DeepSeek、Anthropic Claude、OpenAI、Ollama 本地
- 切换供应商后 `dito` 即时生效（API Key 用 `$ENV_VAR` 引用环境变量）
- 界面为 opencode 风格：顶栏 `◈ Dito 配置` + 右侧当前模型、面板标题 breadcrumb、选中行整行高亮、底部按键提示栏、操作 toast 反馈
- 操作：`j/k` 或方向键移动，`Enter` 编辑/选择（布尔项直接切换），`s` 保存，`q` 返回；编辑文本时用方向键/Home/End 移动光标，字母（含 h/l）原样输入；敏感字段（API Key）显示 `********`，进入编辑自动清空

### 频道：QQ（SnowLuma）与 Matrix

Dito 可以作为聊天机器人接入外部 IM，每个聊天（好友/群/房间）拥有独立持久会话，任务进行中收到新消息会自动排队。

**QQ 频道（SnowLuma，`dito qq`）**：

1. 安装 [SnowLuma](https://www.npmjs.com/package/@snowluma/sdk) 本体（QQ 协议端）
2. `dito config` → 「频道」→「QQ（SnowLuma）」：启用、填地址（默认 `ws://127.0.0.1:3001`）与 Token、配置响应范围（私聊默认开；群聊需显式列出群号）
3. `dito qq` 启动——**会自动拉起 SnowLuma**：探测端口未运行时，若 `channels.qq.command` 为空会自动探测启动命令（PATH 里的 `snowluma` → systemd 服务 → docker 容器 → 常见安装目录）并**自动填入配置**，然后拉起（60s 内就绪即用）；`dito qq` 退出时一并关闭。已在运行则直接连接（`autoStart` 可关）

能力：

- 私聊/群聊对话：QQ 有**专属人设**（`personas/dito-qq.md`，与终端对话完全分隔），按 QQ 场景说话——纯文本、不渲染 Markdown、群聊简短玩梗；每个聊天独立持久会话，回复走完整工具链（知识库/记忆/搜索）
- **SnowLuma 全量动作注册**：184 个 OneBot action 每个都是独立工具（`snowluma_*`），模型按需自主选择——查好友/群成员/群公告、群签到、AI 语音、收藏、**QQ 空间全套**（`send_qzone_msg` 发说说、`get_qzone_feeds` 动态、`like_qzone` 点赞说说等）；只读动作直接调，改动类要求先确认
- **戳一戳**：被戳自动戳回去（可关）；模型也可主动戳（`qq_poke`）
- **情绪表情回应**：模型按消息情绪给群消息贴表情（`qq_react`），不用每条都文字回复
- **长回复自动转图片**：回复超过 100 字自动用 ImageMagick 排版成图片发出（QQ 不渲染 Markdown，长文图片更易读；转图失败回退纯文本）
- **发说说**：`qq_qzone_post` 走原生 `send_qzone_msg`，仅主人明确要求时使用
- **群聊响应**：被唤醒（@机器人 或含唤醒词）**必答**；普通群聊消息按概率回复（默认 0.2，`groupReplyChance` 可调），表情回应不受概率影响；私聊不受限
- **表情回应绑定回复**：只有决定要回复的消息才会贴表情（按情绪选：OK 手势 124 / 偷笑 28 / 疑问 32 等，`autoReact` 可关；表情回应仅群聊可用，私聊协议不支持）
- **群聊好感度**：每个群友 0-100 分（初始 50，持久化在 `affinity.json`），分数注入在每条群消息里，模型按对话体验用 `qq_affinity` 自主加减分（单次 ±20），语气随分数变化；**低于 20 分的群友消息直接忽略**
- 好友/群请求默认只打日志，`autoApprove` 可开自动同意

**Matrix 频道（`dito matrix`）**：`dito config` → 「频道」→「Matrix」：启用、填 Homeserver 与 Access Token（Element：设置 → 帮助与关于 → 高级），房间 ID 可留空表示响应所有已加入房间。走明文房间消息（加密房间暂不支持）。

数据位置：频道会话映射存于 `~/.pi/agent/dito/qq-chats.json` / `matrix-chats.json`，会话本体与本地会话同目录。

### RPM 打包

```bash
./packaging/build.sh                 # 生成源码包并构建 CLI/Web RPM
./packaging/build.sh --srpm-only     # 只生成源码 RPM
```

- CLI/Web RPM 产物：`~/rpmbuild/RPMS/x86_64/dito-0.1.0-1.x86_64.rpm`（项目内也复制到 `dist/`）
- 安装后命令：`dito`（终端对话）

### DEB 打包

```bash
./packaging/build-deb.sh              # 生成 Debian 软件包
```

- 产物：`dist/dito_0.1.0_amd64.deb`
- DEB 内同样只携带加密提示词包，不携带明文提示词目录
- 安装后命令同 RPM：`dito`

### 插件架构（一切皆插件，参考 Cordis）

Dito 的功能不再写死在入口里，而是由 **插件内核**（`extensions/plugin-kernel.ts`）统一引导：

- **内核只负责**：插件加载、依赖拓扑排序、按配置启用/停用；内核本身不承载任何 Agent 能力。
- **能力全部由插件提供**：模型、人格、系统检测、模式、知识库、记忆、搜索、权限、提问、语音，各是一个插件（`extensions/plugins/*.ts`），通过 `apply(ctx)` 在 pi 上注册工具/命令/事件钩子。
- **配置层自由组合**：`config.json` 的 `plugins.<id>.enabled` 控制每个插件的启用，Web UI 配置页的「插件总览」卡片可直接开关，保存即时生效。

```jsonc
// ~/.pi/agent/dito/config.json
"plugins": {
  "provider":      { "enabled": true },
  "persona":       { "enabled": true },
  "system":        { "enabled": true },
  "mode":          { "enabled": true },
  "knowledge_base":{ "enabled": true, "dataDir": "" },
  "memory":        { "enabled": true, "autoDiary": true },
  "web_search":    { "enabled": true, "tavilyKeys": [], "searxngUrl": "" },
  "permission":    { "enabled": true, "sudoMode": false, "autoSudo": true, "sudoCommand": "sudo" },
  "ask":           { "enabled": true },
  "voice":         { "enabled": true, "stt": "whisper", "tts": "espeak" }
}
```

**新增插件**：在 `extensions/plugins/` 下新建文件，导出一个 `DitoPlugin`（id / name / description / icon / apply），并在 `extensions/plugins/index.ts` 的 `DITO_PLUGINS` 里登记即可。内核会自动读取 `plugins.<id>.enabled` 并加载。

### 开发模式（直接加载扩展到 pi）

```bash
cd Dito
pi -e extensions/index.ts
```

### 单次问答（pi 原生）

```bash
pi -e extensions/index.ts --model opencode-free/big-pickle -p "你是谁"
```

### 切换人设 / 用户身份（交互模式）

```
/persona          # 选择 AI 人格
/identity         # 选择用户身份
/kb-stats         # 知识库统计
/memory-stats     # 记忆统计
/memory-clear     # 清空记忆
```

## 数据位置

| 用途 | 路径 |
|------|------|
| 配置 | `~/.pi/agent/dito/config.json` |
| 模型供应商 | `~/.pi/agent/dito/models.json`（由 config 自动生成） |
| 知识库 | `~/.pi/agent/dito/kb.db` |
| 记忆 | `~/.pi/agent/dito/memory.db` |

## 默认模型说明

**默认模型 = OpenCode Zen 公共端点（`opencode-free`）**：keyless 的 OpenAI 兼容服务，
**不接受非空 Authorization**，因此 provider 用单个空格作为 apiKey 占位，pi 会发送
`Authorization: Bearer `（空白 key），服务端视为免鉴权——**零注册、零 Key、开箱即用**。
免费额度有限，可能遇到 429 限流，稍后重试即可。注意该端点服务器在海外，国内访问延迟偏高。

想要 **国内直连 + 免费** 的模型时，`dito config` / Web UI 里切换到「智谱 GLM（BigModel）」，
选 **GLM-4-Flash（官方永久免费，128K 上下文）** 或 **GLM-4V-Flash（免费视觉）**：
先在 [open.bigmodel.cn](https://open.bigmodel.cn) 免费注册一个 API Key，填进
「智谱 GLM（BigModel）」供应商（或设置环境变量 `ZHIPUAI_API_KEY`）即可。

其他内置替代供应商（随时可切）：

| 供应商 | 端点 | 说明 |
|--------|------|------|
| 智谱 GLM（`zhipu`） | `open.bigmodel.cn/api/paas/v4` | GLM-4-Flash / 4V-Flash 免费，GLM-5.x 全系；模型列表可从 API 一键刷新 |
| DeepSeek 官方（`deepseek`） | `api.deepseek.com` | V4 Flash/Pro，国内直连，价格低 |
| 阿里云百炼（`dashscope`） | `dashscope.aliyuncs.com/compatible-mode/v1` | Qwen 系列，新用户有免费额度 |
| 月之暗面（`moonshot`） | `api.moonshot.cn/v1` | Kimi 系列 |
| 硅基流动（`siliconflow`） | `api.siliconflow.cn/v1` | 开源模型多，部分免费 |
| 火山方舟（`volcengine`） | `ark.cn-beijing.volces.com/api/v3` | 豆包系列 |
| Ollama（`ollama`） | `localhost:11434` | 本地离线，免费 |
| OpenCode Go（`opencode-go`） | `opencode.ai/zen/go` | 付费中转，模型最强 |

**OpenCode Go（`opencode-go`）** 是 opencode 的付费端点（`https://opencode.ai/zen/go`），
提供 DeepSeek V4、Kimi K3、GLM、MiniMax 等更强模型，需环境变量 `OPENCODE_API_KEY` 鉴权。
`dito config` 里切换到 OpenCode Go 供应商并选择模型即可；它是 pi 内置供应商，模型
定义（含多端点与兼容参数）由 pi 原生提供，Dito 自动沿用。

**OpenCode Go（`opencode-go`）** 是 opencode 的付费端点（`https://opencode.ai/zen/go`），
提供 DeepSeek V4、Kimi K3、GLM、MiniMax 等更强模型，需环境变量 `OPENCODE_API_KEY` 鉴权。
`dito config` 里切换到 OpenCode Go 供应商并选择模型即可；它是 pi 内置供应商，模型
定义（含多端点与兼容参数）由 pi 原生提供，Dito 自动沿用。

如需自己的模型，在 `.pi/settings.json` 或 `~/.pi/agent/settings.json` 里改 `defaultProvider` / `defaultModel`，
或交互模式下用 `/model` 切换。

## 人设文件

- `personas/dito.md`：Dito（蒂特）主人设，由 `dito-蒂特 (副本).md` 改写。
- `identities/*.md`：用户身份，决定 Dito 的回答方式。
- `system-prompts/*.md`：各系统/发行版专属运维提示词。

在 `personas/` 或 `identities/` 目录新增 `.md` 文件后，`/persona`、`/identity` 即可看到并切换。
修改任何提示词后，运行 `npm run desktop:encrypt-prompts` 重新生成加密包。

## 待办（阶段 5）

- 语音对话：唤醒词 → STT（whisper-cli / 小米 MiMo）→ 大模型 → TTS（espeak-ng / piper / 小米 MiMo），全屏 UI。
