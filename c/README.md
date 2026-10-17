# Dito 原生 C 迁移版本

`dito` 现在是默认 C17 程序，直接连接模型、执行工具并管理会话。普通 C 对话无需 Node。整个程序的 C 重写仍未完成；未原生化的频道、语音、插件和专用界面通过 `legacy/` 的 JavaScript 兼容层运行，兼容功能需要 Node ≥22.5。未原生支持的模型协议、SDK 已保存的鉴权和加密提示词包会自动选择旧实现。项目自有 TS 源码已移除，旧安装已退役并备份。

## 构建与运行

当前支持 Linux/POSIX，需要 C17 编译器、CMake、pkg-config，以及 libcurl、json-c、SQLite、OpenSSL、ncursesw、libxml2 的开发文件。

```bash
cmake -S c -B c/build -DCMAKE_BUILD_TYPE=Release
cmake --build c/build --parallel 4
ctest --test-dir c/build --output-on-failure
./c/build/dito --help
./c/build/dito doctor
./c/build/dito animation 5000
./c/build/dito
./c/build/dito send --fresh "你好"
./c/build/dito config
./c/build/dito mcp
```

运行 `bash packaging/install-native.sh` 将 C 程序安装为默认 `~/.local/bin/dito`，资源位于 `~/.local/lib/dito`，同时验证并安装旧功能兼容层。旧启动器和安装保存在本机私有备份目录。只安装 C 功能可加 `--without-legacy`。`dito legacy` 进入完整旧界面；C 终端空闲时输入 `/legacy` 可接续当前历史。`dito --native config` 使用 C 通用配置编辑器，默认 `dito config` 使用旧版专用配置界面。

`DITO_RESOURCE_DIR` 可指定源码/资源根目录；个人配置仍读取 `$PI_CODING_AGENT_DIR/dito/config.json` 或 `~/.pi/agent/dito/config.json`，QQ/Matrix 私有配置读取 `DITO_USER_DIR` 或 `~/.pi/agent/dito/user`。`--config /绝对路径/config.json` 可用于隔离测试；同时设置 `PI_CODING_AGENT_DIR`、`DITO_USER_DIR` 可隔离会话与存储。安装和 `doctor` 不改写个人配置。

原有对话和记忆保持在原数据目录中。默认续接最近使用过的有内容会话，未发送消息的空标签不会抢占续聊；历史列表仍按创建时间排列。QQ 复用原 `qq-chats.json` 映射与会话文件，缺失的旧文件会明确报错；旧版根目录中的频道记忆库仍可原地读取，不会用空库替代。兼容层沿用相同数据位置。

需要独立备份时，在源码目录运行 `python packaging/backup-user-data.py`。默认备份到 `~/.pi/agent/dito-backups/<时间戳>`；文件保留副本，SQLite 使用在线备份以包含 WAL 中已提交的数据，并执行 `quick_check`。原目录不移动、不清空；备份目录仅当前用户可访问。

## 两个会话同时工作

运行 `dito`，在会话 1 发送任务后，按 **Ctrl+T** 打开会话 2，再输入第二个任务。**Alt+1 / Alt+2** 选择会话，**Ctrl+W** 往返切换；支持终端能够编码的 Ctrl+Tab。每个运行中的会话使用独立 C 工作进程，界面持续接收两个进程的事件，切换时不会中断请求。

上下文、会话文件、输入草稿、输出、模式和取消操作各自独立；标题显示运行、未读和等待回答状态。**Esc** 或 `/cancel` 只取消当前会话；**Ctrl+C** 退出时取消两边并恢复终端。当前会话运行时可排队一条后续消息。工具确认和 `ask_question` 在所属会话中等待回答；后者支持选项弹窗、自定义输入和跳过，另一个会话仍可运行。本地工作目录与用户长期记忆保持原有共享范围。

## 原版工作台布局

**Alt+A** 上一历史会话，**Alt+D** 与 Ctrl+T 新建，Ctrl+Tab / Ctrl+Shift+Tab 循环历史，空输入时 Alt+←→ 也可切换。完整旧 README 逐项状态见 [README_PARITY.md](../README_PARITY.md)。

顶部显示带标题的历史标签和“历史 / 新建”，底部恢复模式、上下文用量、模型及权限状态。**Alt+1…9** 或鼠标选择可见标签，**Alt+W**、`/history` 或 `/sessions` 打开历史选择器；方向键或 j/k 移动，Enter 或鼠标打开。打开其它历史时保留本次运行中的输入草稿；同时最多运行两个任务。

历史里的思考和普通工具默认折叠，点击标题展开；只有工具调用的助手消息不会显示空白的 Dito 标题。Bash 命令与实时输出进入右侧栏，滚轮可分别滚动对话和侧栏。终端宽度至少 112 列、高度至少 16 行时显示侧栏；**Ctrl+Shift+B**、**Ctrl+B**、**Alt+B** 或 `/bash` 可展开 Bash，窄屏也可使用。输入框支持括号粘贴协议的多行文字；PgUp/PgDn 翻页，Home/End 到顶部/底部。正文保持终端默认背景，沿用终端本身的透明度设置。

`python c/tests/render_preview.py` 从 C 渲染器生成固定测试内容的图片预览，不读取个人对话。

## 已接入并验证的部分

- JSON 配置合并、未知字段保留、原子保存；QQ/Matrix 凭据分离到私有配置。`--native config` 的 ncurses 配置界面支持对象/数组导航、编辑、新增、删除和保存，并隐藏敏感字段。
- 独立的 libcurl 流式客户端：OpenAI Chat Completions、Responses、Anthropic Messages；SSE 支持任意分片、多行 data、CRLF、Unicode 和取消，HTTP 连接在会话内复用。
- 工具循环、工具结果回传；文本文件读取、原子写入、精确编辑、Bash 权限门、系统信息、单任务隔离子代理。计划模式和非主人权限在执行时再次校验。
- SQLite 知识库、默认 Markdown 知识播种与长记忆，沿用已有表结构与聊天 scope。支持旧表升级、中文双字/ASCII 检索、日记整理与晋升、稳定偏好提取、重复事实强化、检索联想与遗忘衰减；不会自动把认证信息提取为长期事实。
- Tavily、Firecrawl、AnySearch、Exa、Perplexity、SearXNG 的搜索适配，以及 DuckDuckGo/Yahoo/Bing HTML 回退；网页正文用 libxml2 提取并移除脚本。当前集成测试验证了 SearXNG 和正文提取，其它远端源仍需真实端点验收。
- pi JSONL 会话导入/续接/落盘、分支选择、压缩摘要恢复、工具调用与图片记录。支持基于明确窗口的自动摘要与上下文溢出重试；窗口未知时不猜造容量。压缩按用户回合保留尾部，完整历史仍保留在 JSONL 中。
- MCP HTTP 服务和外部 MCP HTTP/stdio 客户端。远端工具使用 `mcp_<服务器>_<工具>` 命名；只读/非主人模式仅放行明确声明只读的外部工具。
- C 全屏双会话并行、Tab 模式、Ctrl+T 新会话、翻页和独立取消；管道不输出 ANSI。Miyu 扫描动画使用 40 ms 帧时钟、七格光点、方向切换、拖尾、两端停顿和变化行重绘，输出 token 不重置动画时钟。
- QQ OneBot WebSocket 文本消息收发和主人工具权限；尚未完成原 SnowLuma/QQ 功能等价验证。

## 尚未完成的范围

Matrix 端到端加密与 CryptoStore 迁移、手机配对/中继/HTTP 隧道、QQ 的完整动作和自动回复策略、频道桥接、网页后台全部接口、语音唤醒和 STT/TTS、模型动态元数据与选模预算、供应商 OAuth、加密提示词包、TUI 附件/完整 Markdown/路径补全/富文本编辑、多平台打包仍需原生迁移和验证；其中原旧版功能可由 JavaScript 兼容层继续运行。长记忆的大规模检索、自动摘要在真实窗口边界和各模型网关的行为也需继续验收。`capabilities` 会明确返回 `migrationComplete:false`；Matrix 原生入口拒绝降级为明文，默认命令转交旧版加密实现。

## 测试与性能

```bash
python c/tests/integration.py
cmake -S c -B c/build-asan -DCMAKE_BUILD_TYPE=Debug -DDITO_SANITIZE=ON
cmake --build c/build-asan --parallel 4
ASAN_OPTIONS=detect_leaks=1 DITO_C_BINARY="$PWD/c/build-asan/dito" python c/tests/integration.py
python c/tests/benchmark.py --runs 7 --output c/benchmark-results.json
```

集成测试使用真实原生二进制、本机模拟 HTTP/SSE/MCP 服务、stdio 子进程与 PTY，不调用真实模型、QQ 或麦克风。核心测试在 Release 构建中也保留断言。

`benchmark-results.json` 记录本机离线 doctor 启动路径的耗时与峰值内存。C 体检检查项目较少，因此该比较只用于观察去除 Node/tsx/SDK 启动链的收益，不能解释为整程序或模型生成速度的倍数提升。

动画参考 [MiyuAgent cc7613d 的 wait_spinner.rs](https://github.com/SHORiN-KiWATA/miyu-agent/blob/cc7613dda387ee365f64cbbcdba17ecaf24095fa/crates/miyu-hosts/src/render/wait_spinner.rs) 与 `live_area.rs`。上游 MIT 声明见 `third_party/MiyuAgent-LICENSE`，Dito 原生代码使用本仓库 GPL-3.0-only。

`/compact`、`/mode`、`/memory-stats` 等常用命令在 C 中执行；专用人设、模型、权限、附件与剪贴板命令可携带会话进入旧交互界面。`legacy/tool-catalog.json` 公开列出尚未原生化工具，缺失工具经固定注册表调用旧执行器，单次桥接不会迁移或改写个人配置。

**复制输出**：F2 / Alt+C 进入冻结画面的复制模式，鼠标拖选后用终端 Ctrl+Shift+C，F2 / Esc 返回；PgUp/PgDn 可翻页，后台会话继续运行。`/copy` 将最近回复或错误复制到本机剪贴板，失败时回退到终端 OSC 52 请求。模型请求的函数定义最多 128 项，其余工具由 tool_search / tool_call 访问，保留原权限限制。
