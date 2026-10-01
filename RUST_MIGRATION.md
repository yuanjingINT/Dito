# Dito Rust 重写方案

## 目标

在保持现有用户行为、配置文件、数据目录、工具名称、频道协议和移动端协议兼容的前提下，把 Dito 的运行时从 Node/TypeScript 迁移到 Rust。

Rust 版本不会重新设计产品语义。现有 `README.md`、`config/dito.json`、`docs/protocol.md`、提示词文件和 OneBot 动作目录是兼容性依据。

## 兼容性边界

以下内容必须保持兼容：

1. CLI 命令：`dito`、`send`、`voice`、`config`、`qq`、`qqadmin`、`matrix`、`mobile`、`mcp`、`doctor`。
2. 配置位置和 JSON 字段：`$PI_CODING_AGENT_DIR/dito/config.json`，未知字段必须保留。
3. 数据位置：知识库、记忆、会话、QQ/Matrix/手机映射和 `affinity.json`。
4. 工具名称和参数：包括 `kb_*`、`memory_*`、`web_*`、`system_info`、`pc_bash`、`snowluma_*` 以及外部 MCP 工具。
5. 手机协议：配对、设备令牌、`chat.delta`、`chat.tool`、`chat.end`、会话管理和 HTTP 隧道，严格遵循 `docs/protocol.md`。
6. 对外 HTTP/MCP 接口：路径、状态码、Bearer 鉴权、SSE/Streamable HTTP 行为。
7. 人设、身份、发行版提示词和权限门规则。

## Rust 工作区结构

```text
rust/
├── crates/dito-core       配置、路径、提示词、会话、事件和工具协议
├── crates/dito-storage    SQLite 知识库、记忆、好感度和会话索引
├── crates/dito-model      OpenAI 兼容供应商、SSE 流和工具调用循环
├── crates/dito-channels   QQ/OneBot、Matrix、手机 host
├── crates/dito-relay      手机中继和 HTTP 隧道
├── crates/dito-web        管理后台 API/SSE
└── crates/dito-cli        CLI、TUI、配置页、语音入口和打包入口
```

第一阶段只引入 `dito-core` 和 `dito-cli`，实现不依赖网络的兼容基础；其它 crate 在契约测试通过后加入。

## 迁移顺序

### 0. 契约冻结

- 为配置、会话 JSONL、MCP、手机 relay 和 OneBot 事件建立输入输出样例。
- 保留 TypeScript 版本作为行为基准，Rust 版本通过同一组样例测试。

### 1. 核心运行时

- `serde_json` 保留未知配置字段。
- 使用 Tokio 统一异步运行时，复用 HTTP/WebSocket 客户端连接。
- SQLite 使用 WAL、预编译语句和 FTS5，知识库和记忆按 scope 隔离。
- 实现 OpenAI 兼容 SSE、工具调用、权限门和会话持久化。

### 2. CLI/TUI 与 MCP

- 先实现 `send`、`doctor`、`config`、普通会话和 `mcp`。
- TUI 使用 `ratatui`/`crossterm`，保留 Tab 模式、会话切换、插话和中断语义。
- MCP Server/Client 保持现有工具清单和鉴权行为。

### 3. 手机与 relay

- Rust relay 直接复用 `docs/protocol.md` 的消息结构。
- 先做配对、重连、流式聊天和 HTTP 隧道，再接入语音与多会话。
- 现有 PWA/Android 客户端无需修改。

### 4. QQ、Matrix、管理后台

- QQ 采用 OneBot WebSocket 协议，保留动作目录和主人/群聊权限策略。
- Matrix 使用 `matrix-sdk` 的持久化 CryptoStore，保证 E2EE 跨重启。
- 管理后台前端继续复用，Rust 只替换 API、SSE 和后台连接层。

### 5. 语音与发布

- 继续调用 whisper-cli、espeak-ng、piper 和 MiMo，先保持外部命令参数兼容。
- 完成 Linux/macOS/Windows 构建、AppImage/deb/rpm/zip 和 systemd 服务。

## 性能策略

- 一个 Tokio runtime 管理所有网络 I/O，避免 Node 子进程和重复连接开销。
- `reqwest::Client`、WebSocket 和 MCP 连接按供应商/服务器复用。
- 流式响应通过有界 channel 传递，避免无限制缓存大消息。
- SQLite 开启 WAL，使用批量事务、FTS5 和 prepared statements。
- 工具注册表、配置快照和会话索引使用读多写少的并发结构。
- 每个阶段都用现有脚本和基准测量启动耗时、首 token 延迟、吞吐、内存和空闲 CPU；性能提升不能改变协议和提示词。

## 验收标准

- 配置文件可与现有版本双向读写，未知字段不丢失。
- 同一模型、同一提示词、同一工具输入下，工具调用轨迹和最终协议事件一致。
- `scripts/test-mcp.mjs`、`scripts/simulate-phone.mjs` 和现有 voice e2e 可切换到 Rust 服务端通过。
- QQ、Matrix、手机和后台可与 Rust/TypeScript 混合运行，便于灰度迁移。
- 在完成全部 parity 测试前，不替换现有 `dito` 启动器。
