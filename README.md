# Dito（蒂特）

Dito 0.3.0-alpha 以 **C17 程序作为 `dito` 默认入口**。终端对话、流式模型请求、工具循环、知识库、记忆和双会话并行由 C 运行时处理。未完成原生迁移的功能通过 `legacy/` 中的 JavaScript 兼容层运行；项目自有 TypeScript 源码、tsx 启动链和根目录 npm 发行包已移除。

这次切换改变默认实现，**不代表所有功能都已用 C 重写**。兼容频道和旧界面仍需 Node ≥22.5。详细边界见 [迁移记录](C_MIGRATION.md)。

## 构建与安装

当前原生版本支持 Linux/POSIX。需要 C17 编译器、CMake、pkg-config，以及 libcurl、json-c、SQLite、ncursesw、OpenSSL 和 libxml2 的开发文件。

```bash
git clone https://github.com/yuanjingINT/Dito.git
cd Dito
make
bash packaging/install-native.sh
dito
```

默认安装到 `~/.local/bin/dito`，程序与公开资源位于 `~/.local/lib/dito`。安装器会验证 C 核心和兼容模块，保留旧安装与启动器的私有备份，然后替换默认命令。已有 `dito-c` 安装会退役。已经打开的进程需退出后重新运行 `dito`。

默认包含旧功能兼容层；首次安装需要 Node、npm 和网络来安装锁定版本的兼容依赖及 Matrix 加密库。只安装 C 功能可运行：

```bash
bash packaging/install-native.sh --without-legacy
# 自定义位置
bash packaging/install-native.sh --prefix /绝对路径
```

源码目录可用 `./bin/dito` 启动已构建的 C 程序。`cmake --install c/build --prefix /绝对路径` 提供只含原生功能的安装。Linux 便携包可用 `bash packaging/build-portable.sh` 构建，不携带 Node 解释器。

## 使用

| 命令 | 实现 |
| --- | --- |
| `dito` / `dito send "你好"` | C 终端、流式请求和工具循环 |
| `dito send --image 图片路径 "描述图片"` | C 图片请求；支持 PNG/JPEG/WebP |
| `dito sessions` | C 历史会话列表 |
| `dito config get model` / `dito config set 路径 JSON` | C 配置读取和保存，保留未知字段 |
| `dito config` / `dito plugins` | 旧版专用配置、模型元数据和插件界面的 JavaScript 兼容层 |
| `dito --native config` | C ncurses 通用配置编辑器 |
| `dito qq` / `dito qqadmin` | 旧版完整 QQ 频道和网页后台兼容层 |
| `dito matrix` / `dito mobile` / `dito bridge` | 旧版加密频道、手机配对和频道桥接兼容层 |
| `dito voice` / `dito relay` | 旧版语音和中继兼容层 |
| `dito mcp` / `dito web` | C 本机 MCP / 部分 JSON、SSE 管理接口 |
| `dito legacy` | 完整旧版终端界面，含附件、Markdown 和专用交互 |
| `dito legacy config` / `dito legacy doctor --ci` | 显式调用旧版功能 |
| `dito doctor` / `dito capabilities` | C 本地运行时检查 / 原生及兼容功能状态 |

`--native` 禁止默认命令转交兼容层；未实现的原生功能会明确报错。`DITO_DISABLE_LEGACY=1` 可在整个进程中关闭兼容层。普通 C 终端不加载 Node；选择未原生支持的模型协议、使用 SDK 保存的 OAuth 鉴权或启用加密提示词包时，会自动转交兼容实现。子代理单任务默认使用 C 子进程；传入并行 tasks、chain、选模或预算参数时，由 JavaScript 兼容调度器执行，并保留 C 权限与取消门控。

C 终端恢复原版工作台布局：历史标签、可展开的思考/工具、Bash 实时侧栏、边框输入和模型/上下文状态。Ctrl+T 新建，Alt+1…9 选标签，Ctrl+W 或终端支持的 Ctrl+Tab 切换。两个会话可同时运行，提问、输入草稿和取消操作各自独立。Alt+W 打开历史，鼠标点击展开记录，滚轮分别滚动正文与 Bash；Ctrl+B / Ctrl+Shift+B 展开 Bash。空闲时输入 `/legacy` 可恢复当前会话的完整旧界面，运行中的两个任务不会被静默中断。

## 配置、对话与记忆

原数据目录继续沿用 `~/.pi/agent/dito/`；兼容层和 C 运行时读取同一份会话、配置及 SQLite 记忆。QQ/Matrix 私有凭据仍位于 `~/.pi/agent/dito/user/`。`PI_CODING_AGENT_DIR` 和 `DITO_USER_DIR` 可指定其它位置；`DITO_RESOURCE_DIR` 指向公开程序资源，`--config` 可指定独立配置文件。

API Key 应在个人配置中设置，或使用配置里的 `$环境变量` / `${环境变量}` 引用。仓库的 `config/dito.json` 仅为公开默认模板。模型上下文窗口未知时显示未知，不使用按名称猜测的容量。

安装器不搬移、不清空对话或记忆，也不把它们打进程序目录。需要额外备份可运行 `python3 packaging/backup-user-data.py`：SQLite 使用在线备份以包含 WAL 已提交数据，并校验快照；备份只保存在本机私有目录。

**GitHub 仅上传源码和公开资源。** 对话 JSONL、记忆数据库、私有配置、凭据、用户目录、机器校验快照和旧安装备份均排除。`python3 packaging/audit-upload.py` 检查暂存区；加 `--tree` 检查整个已跟踪文件集合。

## 验证与许可

```bash
make test
node --import ./legacy/register-loader.mjs --test legacy/tests/*.test.js
cmake -S c -B c/build-asan -DCMAKE_BUILD_TYPE=Debug -DDITO_SANITIZE=ON
cmake --build c/build-asan --parallel 4
ASAN_OPTIONS=detect_leaks=1 ctest --test-dir c/build-asan --output-on-failure
ASAN_OPTIONS=detect_leaks=1 DITO_C_BINARY="$PWD/c/build-asan/dito" python3 c/tests/integration.py
```

测试使用临时用户目录和本机模拟模型、HTTP/SSE、MCP、OneBot 及 PTY，不调用真实模型、QQ 或麦克风。Matrix 兼容模块的加载检查包括加密库，真实账号端到端联调仍需另行验收。C17 实现与旧功能兼容层的具体说明见 [c/README.md](c/README.md) 和 [legacy/README.md](legacy/README.md)。

项目许可证为 GPL-3.0-only，见 [LICENSE](LICENSE)。第三方声明见 [NOTICE](NOTICE)。扫描动画参考 MiyuAgent 的 MIT 许可实现，保留上游声明。
