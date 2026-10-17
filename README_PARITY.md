# 旧 README 全功能对照

对照基线：[C 默认入口切换前的 README（5fbfa49）](https://github.com/yuanjingINT/Dito/blob/5fbfa49a0d5eb0ca38d3689fa100ac49ede7bf72/README.md)。本表按旧文档全部章节核对代码、入口和已有验证，避免将入口可用等同于全部原生等价。

“原生”指 C 默认入口实现；“兼容”指保留的 JavaScript 实现，需 Node ≥22.5；“部分”说明仍存在原生差异。频道真实账号、语音硬件及其它操作系统未因此获得联调通过的结论。

## 安装、体检、命令和插件

| 旧 README 内容 | 当前状态及入口 |
| --- | --- |
| Node ≥22.5 是程序前提 | C 主程序改用本机库；兼容功能才需要 Node |
| npm `dito-agent@alpha`、根目录 npm install、build-npm | 旧发行链已退役；当前用 `make` 和 `packaging/install-native.sh`，不会把旧 npm 包当作当前 C 版本 |
| 版本 0.2.1-alpha 与 ALPHA 标记 | 当前 0.3.0-alpha；C 和兼容层保留标记 |
| `dito` 全屏；`dito "消息"` 单次；管道输入 | 原生 |
| `dito send` / `msg` / `message` / `-m`，`--fresh` | 原生，沿用原会话数据 |
| 图片 `--image` / `-i` | 原生 PNG/JPEG/WebP，最多 8 张；旧界面还有附件编辑/剪贴板支持 |
| `dito voice` | 兼容 |
| `dito config` | 默认进入旧专用配置页；`dito --native config` 为 C 通用编辑器 |
| `dito qq` / `qqadmin` / `matrix` / `mobile` | 默认桥接旧实现 |
| `dito bridge` / `relay` | 桥接旧实现；relay 源码位于 `legacy/relay/` |
| `dito mcp` | 默认 C HTTP 服务；完整旧服务可用 `dito legacy mcp`，移动端继续使用旧内嵌服务 |
| `dito plugins`、Space 勾选、Enter 保存、Bridge 依赖联动 | 旧插件安装器保留；C 普通启动没有旧版首次安装选择器，需要主动运行 `dito plugins` |
| `dito doctor` 检查模型/录音/STT/TTS/频道/MCP 等 | 部分：默认是 C 离线运行时检查；完整旧检查使用 `dito legacy doctor` / `dito legacy doctor --ci` |
| 安装不覆盖账号、对话、记忆 | 原数据目录沿用；程序安装仅替换公开运行时，旧安装进入本机私有备份 |

## 终端：逐个快捷键

| 原键位/交互 | C 默认界面 |
| --- | --- |
| **Alt+W** 历史会话选择器 | 已实现：↑↓ / j/k 移动，Enter 恢复，Esc 关闭；切换保留草稿，直接读取原 JSONL |
| Alt+A 上一会话 | 已接齐：按历史会话顺序打开上一条；最早时提示 |
| Alt+D / Ctrl+T 新会话 | 已接齐，已有历史不会清空 |
| Ctrl+Tab / Ctrl+Shift+Tab | 按方向循环历史标签；终端需实际发送相应按键序列 |
| Alt+← / Alt+→ | 输入框为空时按方向循环；有草稿时不切换 |
| Alt+1…9 / 点击顶部标签 | 已实现；当前会话与历史标签共同展示 |
| Ctrl+W | 新增的两个工作会话切换键，保留 |
| Tab 模式循环 | 原生；斜杠命令输入时补全命令；提问弹窗中选择选项 |
| 闲聊 / 标准 / 计划 | 原生工具门控；闲聊无工具，计划过滤写工具；旧完整模式提示词通过旧界面保留 |
| Esc 中断 | 只取消当前会话，另一会话继续；历史/侧栏等面板先关闭；ask_question 弹窗中为跳过回答 |
| 运行中插话排队 followUp | 原生保留一条后续消息；更多输入保留为草稿。旧界面的完整队列语义仍在兼容层 |
| 思考/工具标题点击折叠 | 原生；历史工具参数、输出和结果也可展开 |
| Bash 实时侧栏 | 原生；窄窗口隐藏侧栏，正文和侧栏分开滚动 |
| Ctrl+Shift+B | 原生展开 Bash；Ctrl+B 为额外兼容键 |
| Ctrl+V 图片/剪贴板 | 空闲时带会话及文字草稿进入旧界面，由旧实现读取剪贴板；任务运行中保留当前工作并提示 |
| 完整 Markdown、附件栏、富文本编辑和路径补全 | 完整旧界面保留；C 尚未达到完全等价，可用 `dito legacy` 或 `/legacy` |
| 上次会话自动恢复 | 原生，按最近活跃记录恢复，空标签不覆盖已有对话 |
| 已用 token / 上下文窗口 / 百分比 | 原生；窗口未知时显示未知，不按模型名称猜容量 |
| 两个会话同时运行 | 原生独立进程、模型连接、提问、取消、草稿与持久化 |

## 终端命令、压缩、记忆和权限

| 旧功能 | 当前状态 |
| --- | --- |
| `/new`、`/prev`、`/sessions`、`/bash`、`/exit` | 原生；`/history`、`/help`、`/cancel` 也可用 |
| `/chat`、`/standard`、`/plan`、`/mode` | 原生；Tab 继续可切换模式 |
| `/compact` | 已接齐原生手动压缩工作进程，不作为普通消息发给模型；可取消，不阻塞另一会话 |
| 窗口约 80% 触发、尾部保留、响应余量、溢出重试 | C 有相应配置策略和回归；摘要及工具边界兼容原日志。不能视为与 pi 的所有压缩边界完全等价 |
| 模型动态元数据、Ollama `/api/show`、models.dev、6 小时缓存 | 旧实现保留；通过 `dito config` 或旧 `/model` 刷新/切换。C 没有完整等价的自动刷新生命周期 |
| `/model`、`/persona`、`/identity` | 已接齐命令入口：带当前会话进入旧界面并执行原命令 |
| `/image`、`/images`、`/unimage` | 同上，使用旧附件交互 |
| `/system`、`/kb-stats` | 同上，使用旧插件命令 |
| `/memory-stats` | 原生读取当前 scope 的统计 |
| `/memory-clear` | 带会话进入旧界面，保留旧清理流程；未改成安装时自动清理 |
| 短日记→长期整理→自动联想、强化、衰减、按聊天隔离 | C 已实现并兼容旧表；旧记忆算法保留在兼容层，不能声称所有排序和整理策略完全相同 |
| 危险命令拦截/确认 | 原生有权限门及会话内确认；旧完整权限插件也保留 |
| `/sudo on/off`、自动判断需要 root 的命令 | 通过旧界面保留；C 能读取 sudoMode 并切换权限门，自动加 sudo 的完整规则仍属于旧实现 |
| 单个/并行/链式子代理、100 任务上限、选模、预算、状态 | C 单任务；复杂参数接旧调度器。C 显示汇总进度，完整旧任务明细渲染在旧界面 |

## 工具全清单

| 工具 | 当前实现 |
| --- | --- |
| `bash`、`read`、`write`、`edit` | C 原生；`pc_bash` 旧别名向模型注册 |
| `grep`、`find`、`ls` | 已桥接旧 SDK，参数通过固定注册表校验；路径以参数传入，不拼接 shell |
| **`ask_question`** | 原生弹窗支持 options、自定义文本、方向键/Tab/鼠标、Esc 跳过；无 UI 返回问题文本；语音提问走旧 voice |
| `remember_fact`、`recall_memories`、`recall_past_events`、`memory_recall` | 旧名已向模型注册，执行复用 C 记忆；也保留 memory_* 名称 |
| `search_knowledge_base`、`read_knowledge_base`、`list_knowledge_base`、`upload_to_knowledge_base`、`remove_knowledge_base` | 旧名已注册，执行复用 C 知识库；上传 title 仍可省略；也保留 kb_* 名称 |
| `web_search`、`web_fetch` | C 搜索/正文实现；旧实现保留在旧界面 |
| `get_system_info` / `system_info` | 启用兼容层时调用旧完整系统检测；纯 C 有基础系统信息 |
| `aur_search`、`aur_review`、`aur_install`、`copr_search`、`copr_install` | 已桥接旧发行版工具；安装类工具生成命令，由 bash 权限门执行 |
| `snowluma_*` 184 动作 | 已补齐兼容注册，仅在 QQ 及 SnowLuma 插件启用时展示 |
| `qq_affinity`、`qq_react`、`qq_poke`、`qq_send_like`、`qq_qzone_post`、`qq_meme_send`、`qq_meme_list` | 7 个辅助工具保留；表情包读取原 user/qq/memes 数据 |
| `subagent` | C 单任务，旧实现负责复杂调度 |
| `mcp_<服务器>_<工具>` | 原生 HTTP/stdio 客户端可注册；完整 MCP 生命周期与边界仍需对照旧实现 |
| 插件关闭、只读、非主人过滤 | C 注册和执行两次门控；单次旧工具调用配置只读、不执行旧版自动迁移 |

## 语音与配置页面

| 旧功能组 | 当前状态 |
| --- | --- |
| 全屏水波、Space 说话、唤醒词、2.5 秒轮询、连续对话 | `dito voice` 旧实现保留；未执行真实麦克风验收 |
| 问题/许可自动朗读→录音 | voice 旧实现保留；C ask_question 使用终端弹窗 |
| whisper-cli / espeak-ng / piper / MiMo ASR/TTS、音色设计 | 旧实现和配置保留；外部服务/模型可用性不由本次迁移保证 |
| pw-record/parec/arecord、macOS/Windows ffmpeg | 旧平台录音代码保留；当前 C 主程序只在 Linux/POSIX 构建验证 |
| 模型/供应商新增删除、API 刷新 | `dito config` 的旧专用配置页保留 |
| 提示词、知识库、记忆、搜索、语音、权限、频道、MCP、手机、子代理配置 | 同上；`--native config` 为通用 JSON 编辑器，专用交互尚未全部原生化 |

## QQ、管理后台、Matrix、手机

以下默认频道命令都执行旧实现；条目是代码保留状态，不等同于真实账号联调全部通过。

| 旧 README 功能 | 当前入口/状态 |
| --- | --- |
| QQ 探测端口、PATH/systemd/docker 自动拉起、自动填配置 | `dito qq` 保留 |
| 私聊/群聊独立会话、QQ 人设、主人全工具/其他受限 | `dito qq` 保留；纯 C `--native qq` 仍只是文本子集 |
| 被戳回戳、自动表情、长回复转图、随机表情包 | QQ 兼容实现保留 |
| 好感度 0–100、单次 ±20、低分忽略、群白名单、唤醒/@、概率、好友群请求 | QQ 兼容实现保留 |
| dito-re 自由主题、主题概率、群滚动上下文、持久化、动态配置 | QQ 兼容实现与旧 config 界面保留 |
| owners/groups/概率/开关热更新 | QQ 兼容进程仍按消息重读配置 |
| qqadmin 总览、快捷开关、SSE 消息流过滤 | `dito qqadmin` 保留；默认 127.0.0.1:3880 |
| 原始记录+Dito 会话、手动发送、转图 | 管理后台保留 |
| 好友资料/点赞/戳/私信/记录/重置 | 管理后台保留 |
| 群资料/行为/名片/公告/禁言/退群双确认/成员操作/重置 | 管理后台保留 |
| 好感度热同步、表情包预览删除、Matrix 页、QQ 全配置、动作白名单 | 管理后台保留 |
| 后台令牌、局域网访问、`--no-bot`、手机 /qq 隧道、多客户端 | 原参数和校验保留 |
| Matrix Homeserver/Token、房间/主人、受邀自动进房 | `dito matrix` 保留 |
| E2EE、持久 Rust CryptoStore、DM 主人判定、配置热更新、后台状态 | Matrix 兼容实现保留；运行中同步/加密状态不得回滚 |
| 手机二维码、电脑 y 确认、一次性令牌、设备吊销 | `dito mobile` 保留 |
| 多对话、独立记忆、自动标题、流式输出、工具状态 | 旧手机协议保留 |
| 手机语音球、电脑 ASR/TTS、文字重播 | 旧实现保留；需配套手机/PWA 客户端 |
| 局域网内嵌 8787 中继、公网仅出站、pwaDir、Android/iPhone | 旧 mobile/relay 保留；手机客户端位于独立 dito-mobile 仓库 |
| HTTP 隧道 /mcp、/qq、deviceToken | 旧手机实现保留 |
| 手机模拟脚本与协议文档 | 脚本改到 `legacy/scripts/simulate-phone.mjs`；`docs/protocol.md` 保留 |

## MCP、常驻服务、数据、人设、模型、打包与许可

| 旧 README 内容 | 当前状态 |
| --- | --- |
| MCP Server @127.0.0.1:3878、知识库/记忆/搜索/系统工具 | C HTTP 服务兼容 memory_recall/system_info/pc_bash 等旧名；完整旧协议可用 `dito legacy mcp` |
| allowBash 暴露 pc_bash、危险命令门控 | C 与旧服务保留；默认关闭 |
| 移动端内嵌 /mcp、远程 Bearer deviceToken | 旧 mobile 服务保留 |
| MCP Client HTTP/stdio、headers、工具名、超时、坏服务器隔离 | C 有本地契约覆盖；分页、重连、取消等完整兼容仍待完成 |
| systemd QQ/Matrix/qqadmin 服务 | ExecStart 仍使用 `dito qq` / `matrix` / `qqadmin`；兼容启动器按 Node 版本处理 SQLite flag |
| config.json、models.json、共享 auth.json | 原路径沿用；原生与兼容配置读取各有边界，禁止把个人配置打进发行文件 |
| kb.db / memory.db 及各 scope 数据库、sessions/*.jsonl | 原路径及旧格式继续可读写，分支/压缩记录保留 |
| user/qq、user/matrix、user/bridge、affinity、memes、CryptoStore | 本机私有目录保留；工具桥接不迁移/改写它们 |
| mobile-chats、mobile-sessions、DITO_USER_DIR | 旧 mobile 实现及自定义私有路径保留 |
| 自动旧频道迁移并保留源文件 | 完整旧频道初始化仍有迁移代码；本次单次工具桥接禁用迁移，安装器不搬移数据 |
| Dito 人设/QQ 人设、identities 选择、自定义 md | 资源保留；C 读取当前人设/身份，交互选择经旧命令 |
| 自动检测匹配 14 份系统/发行版提示词 | 部分：资源、完整系统工具与旧 before_agent_start 注入保留；C 默认 prompt 尚未实现同等自动注入 |
| OpenCode 默认免 Key、特定免费模型/价格/额度承诺 | 旧配置预设保留；文档里的外部可用性与免费承诺不能作为当前保证，需配置可用模型 |
| 智谱/DeepSeek/百炼/月之暗面/硅基流动/火山/Ollama/OpenCode Go | 配置预设和旧供应商支持保留；C 直接实现三种协议，其余 API/OAuth 自动交给旧 SDK |
| Linux AppImage / Windows SEA exe / macOS app、内置 Node | 当前不等价：现打包入口为 Linux C tar.gz，不携带 Node；Windows/macOS 新 C 包尚未完成 |
| DEB / RPM | 已切换原生构建脚本；不能视为全部发行版安装验证已完成 |
| Android APK/Operit 客户端 | 独立移动端仓库，未被本次 C 迁移替换 |
| GPL-3.0-only、移动端 LGPL/GPL、SnowLuma 自有许可 | LICENSE/NOTICE 与原依赖声明保留；Miyu MIT 动画声明也保留 |

## 验证与剩余差异

原生回归覆盖提问选项/自定义/跳过/鼠标/长列表、跨会话隔离、Alt+W/A/D、草稿、命令识别、工具旧名、真实文件工具进程、模拟 OneBot、只读/身份/插件门控及配置不改写。旧 JavaScript 测试继续覆盖 TUI、图片、记忆/用户目录、模型元数据、子代理和插件。

仍须继续原生迁移：完整编辑器/Markdown/附件、首次插件引导、自动系统提示词注入、全部模式提示词、自动模型元数据生命周期、sudo 自动提权规则、全量 MCP 生命周期、完整频道/后台/语音以及 Windows/macOS 打包。通过兼容入口保留的功能继续标为兼容；没有把它们列为 C 已完成。
