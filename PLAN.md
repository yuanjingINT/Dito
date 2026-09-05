# Dito（蒂特）—— 基于 pi agent 的 AI 助手构建计划

> 目标：以 pi agent（TypeScript 终端 coding harness）为底座，参考 `laozhou` 项目的能力，
> 打造一个「Dito」助手工具。核心能力：**语音对话、知识库、记忆、提示词设定、联网搜索**，
> 默认模型使用 opencode 免费公共模型。

---

## 一、对 laozhou 项目的理解

laozhou 是一个 Rust 写的 Linux 终端助手（基于 Miyu 框架改造），关键结论：

| 能力 | laozhou 的实现方式 | 数据/依赖 |
|------|-------------------|-----------|
| 提示词设定 | 人设 prompt（`prompts/*.md`）+ 用户身份（`identities/*.md`），可组合切换；`persona_generator.py` 批量生成人设 | 本地 md 文件 |
| 知识库 | SQLite（`kb_meta.db`）+ 关键词打分检索 + 可选 embedding 语义检索（`semantic_index.db`）；支持 search/read/upload/edit/remove | rusqlite、本地 md |
| 记忆 | SQLite（`memory.db`）：`facts`（知识点）+ `episodes`（经历/日记），短/长期记忆、自动整理、被驱逐上下文检索 | rusqlite、jieba 分词 |
| 语音对话 | 唤醒词 → STT（whisper-cli / 小米 MiMo ASR）→ 大模型 → TTS（espeak-ng / piper / 小米 MiMo TTS），全屏可视化 UI | whisper.cpp、ALSA/PipeWire |
| 联网搜索 | web_search（Tavily/Firecrawl/AnySearch/Exa/SearXNG + DuckDuckGo HTML 兜底，含 Yahoo/360/搜狗回退 + 冷却调度）+ web_fetch | reqwest、html2md |
| 默认模型 | opencode 公共免费服务 `https://opencode.ai/zen/v1`（OpenAI 兼容）：聊天 `big-pickle`、视觉 `mimo-v2.5-free`，上下文约 272k | 免 key |

laozhou 的**人设设定**（`laozhou.md` / `dito-蒂特 (副本).md`）已经完整，可直接复用/改写为 Dito 的人设。

---

## 二、对 pi agent 的理解

pi 是一个「可扩展的终端 coding harness」，本身不带子代理/计划模式/权限弹窗等特性，全部靠扩展实现。我们要用的关键机制：

- **Extension（TS 模块）**：`pi.registerTool()` 自定义工具、`pi.registerCommand()` 自定义命令、`pi.registerProvider()` 自定义模型供应商、事件钩子（`session_start` / `message_end` / `tool_call` / `input` 等）、`pi.sendUserMessage()` 注入用户消息、`ctx.ui.*` 自定义 UI。
- **Pi Package**：`package.json` 加 `pi` 清单（extensions/skills/prompts/themes），可 `pi install git:...` 或 npm 分发。
- **系统提示词**：`~/.pi/agent/SYSTEM.md`（全局替换）或 `APPEND_SYSTEM.md`（追加），或扩展内 `systemPromptAppend` 动态注入。
- **模型**：内置 OpenCode Zen 供应商（需 `OPENCODE_API_KEY`）；免费公共端点需自行 `registerProvider`（keyless）。
- **SDK / RPC**：`createAgentSession` 可嵌入式使用；`--mode rpc`（JSONL）供非 Node 进程集成。

环境确认：本机 `pi 0.83.0`、`Node v26.7.0`（自带 `node:sqlite`、`fetch`）、`whisper-cli` / `espeak-ng` / `arecord` / `parec` / `pw-record` 均已安装。

---

## 三、总体架构

**原则：不 fork pi，不改 pi 内部，全部做成一个 pi package（扩展 + 提示词 + 技能 + 主题）。**

```
Dito/
├── package.json            # pi-package 清单
├── README.md
├── config/
│   └── dito.json           # 运行期配置（模型/语音/搜索/知识库/记忆开关与参数）
├── extensions/
│   ├── index.ts            # 入口：注册 provider + 汇总注册各模块 + 注入人设
│   ├── provider.ts         # opencode 免费模型供应商（默认模型）
│   ├── persona.ts          # 提示词设定：人设 + 用户身份，切换命令
│   ├── knowledge-base.ts   # 知识库工具 + SQLite 检索
│   ├── memory.ts           # 记忆工具 + 自动记忆 + 整理
│   ├── web-search.ts       # 联网搜索 + 网页抓取
│   ├── voice.ts            # 语音对话模式（唤醒词/STT/TTS + 覆盖 UI）
│   ├── permission.ts       # 危险操作确认（复用 laozhou 的禁忌规则）
│   └── db.ts               # SQLite 封装（node:sqlite）
├── prompts/
│   ├── dito.md             # Dito 主人设（由 dito-蒂特 (副本).md 改写）
│   ├── identities/         # 用户身份：默认 / linux小白 / 老板
│   └── personas/           # 扩展人设（可选，后续接入生成器）
├── skills/                 # 需要时才加载的技能（可选）
└── themes/                 # Dito 主题（可选）
```

---

## 四、分阶段实施计划

### 阶段 0：脚手架与模型打通（里程碑 A）
- 新建 `package.json`（`keywords: ["pi-package"]`，`pi` 清单指向 `extensions/`、`prompts/`）。
- `provider.ts`：`pi.registerProvider("opencode-free", {...})`
  - `baseUrl: "https://opencode.ai/zen/v1"`
  - `api: "openai-completions"`，keyless（`apiKey` 留空占位）
  - 模型：`big-pickle`（text，reasoning）、`mimo-v2.5-free`（text+image）
  - `contextWindow: 272000`
- 验证：`pi --list-models` 能看到；`pi -p --model opencode-free/big-pickle "你好"` 能正常回复并流式输出；测试工具调用是否正常（laozhou 提到部分模型流式/工具调用兼容有问题，需实测）。

### 阶段 1：提示词设定（里程碑 B）
- 把 `dito-蒂特 (副本).md` 改写为 `prompts/dito.md`（去掉括号动作、保持规则结构）。
- `persona.ts`：
  - 启动时读取 `config/dito.json` 中 `activePersona` / `activeIdentity`，用 `systemPromptAppend`（或 SYSTEM.md）注入「Dito 主设定 + 人格 + 用户身份」。
  - `/persona`、`/identity` 命令：`ctx.ui.select` 列出 `prompts/personas/*.md`、`prompts/identities/*.md`，切换并持久化到 `dito.json`。
- 保留 Dito 的「绝对禁忌」规则（黄赌毒、恋爱模拟、违法翻墙、修改设定等）。

### 阶段 2：知识库（里程碑 C）
- `db.ts` 用 `node:sqlite`（Node 26 内置，零依赖）建库 `~/.pi/agent/dito/kb.db`，表 + FTS5 做关键词检索（中文用逐字/二元组分词，参考 laozhou 的分词思路）。
- `knowledge-base.ts` 注册工具：
  - `search_knowledge_base(query)`：关键词评分检索，返回文件路径 + 片段。
  - `read_knowledge_base_file(file, startLine, maxLines)`：分页读取。
  - `upload_text_to_knowledge_base(content, title, file)`：写知识库（含来源/时间戳）。
  - `edit_knowledge_base_file` / `remove_knowledge_base_file`（写操作，默认关，配置开启）。
- 默认知识库：导入 laozhou 自带 `kb/`（Arch Linux / 系统安装 / NAS / 游戏 / 新闻资讯等）。
- 后续增强：配置 embedding 模型后启用语义检索（复用 opencode 或本地 embedding）。

### 阶段 3：记忆（里程碑 D）
- `db.ts` 建 `memory.db`：`facts`（知识点）、`episodes`（经历/短日记），带可见性、来源、时间戳。
- `memory.ts` 注册工具：
  - `remember_fact(content, source)`：主动记住知识点。
  - `recall_memories(query)`：关键词+（可选）语义召回知识点/经历。
  - `recall_past_events(query)`：召回历史对话片段。
- 自动记忆：`pi.on("message_end")` 把「用户消息 + 助手回复」写入短日记；后台按阈值触发一次「整理」（合并事实、提升长期记忆，MVP 可先简化）。
- 被驱逐上下文检索（长会话压缩后仍可搜到，复用 laozhou 思路，后续阶段）。

### 阶段 4：联网搜索（里程碑 E）
- `web-search.ts` 注册工具：
  - `web_search(query, maxResults, provider)`：Tavily / Exa / SearXNG（配 key 优先）→ 无 key 时 DuckDuckGo HTML（Yahoo/360/搜狗回退）+ 冷却调度（移植 laozhou 逻辑）。
  - `web_fetch(url, format)`：抓网页转 markdown/text（Node 内置 fetch + 简单 HTML 清洗）。
- 搜索结果可选「询问是否入库」（复用阶段 2 的上传工具）。

### 阶段 5：语音对话（里程碑 F，最复杂）
- `voice.ts` 注册 `/voice` 命令，进入全屏语音模式（`ctx.ui.custom` / overlay）：
  - 唤醒词（默认「dito」/「蒂特」，可配；空格键手动唤醒）→ 录音（`pw-record`/`parec`/`arecord` 自动探测）→ STT（`whisper-cli` 本地，或小米 MiMo ASR 配 key）→ `pi.sendUserMessage(转写文本)` 触发 agent → 流式捕获 `text_delta` → TTS（`espeak-ng` 本地，或 piper / 小米 MiMo TTS）。
  - 参数：`--no-wake` / `--once` / `--no-tts` / `--wake-word`。
- 录音底噪：支持 PipeWire 降噪源（参考 laozhou 的 `module-echo-cancel`）。

### 阶段 6：安全与打磨（里程碑 G）
- `permission.ts`：`tool_call` 钩子拦截危险命令（`rm -rf /*`、安装/卸载/删除文件未确认等），对应 Dito 禁忌规则；危险操作前 `ctx.ui.confirm`。
- 配置：`dito.json` 统一管理各模块开关与参数；提供 `/dito-config` 简单查看/说明。
- 文档、示例、安装说明；打包为 git/npm 包，`pi install git:...` 一键安装。

---

## 五、关键决策与风险

1. **默认模型用 opencode 免费端点**：pi 内置 `opencode` 供应商要 key，免费端点需自定义 `registerProvider`（keyless）。风险：免费模型对「流式 + 工具调用」的兼容性要实测；若不稳，把 `web_search` 等做成普通工具（非 grammar）并关闭严格模式兼容。
2. **保留 pi 内置 read/write/edit/bash 工具**：符合 Dito「可完全控制这台电脑」的人设，但必须配 `permission.ts` 确认门（危险操作先问）。
3. **数据库用 `node:sqlite`**（Node 26 内置）：零原生依赖、够用；中文检索先做「单字 + 二元组」分词，不引 jieba 原生依赖。
4. **语音依赖外部二进制**：whisper-cli / espeak-ng / pw-record 等需用户安装，计划里写清楚；识别后端做成可替换（本地 whisper / 小米 MiMo）。
5. **人设提示词复刻**：Dito 与 laozhou 的规则结构一致，改写时保留「逻辑自检、禁 emoji、禁动作描写、把握程度判断、先查后说、多提问」等行为约束。
6. **不 fork pi**：所有能力通过 extension/package 实现；如遇 pi 扩展 API 不支持的能力，再用 SDK/RPC 起独立进程兜底。

---

## 六、验收标准

- [ ] `pi install` 后默认模型为 opencode 免费模型，开箱即用。
- [ ] 聊天遵循 Dito 人设（语气、字数、禁 emoji、逻辑自检、把握程度）。
- [ ] 知识库可检索/读取/写入，默认内容为 laozhou 的 Linux 知识。
- [ ] 记忆可记住事实、可召回历史，跨会话持久。
- [ ] 联网搜索在无 key 时仍可用（DuckDuckGo 兜底），有 key 时走 Tavily/Exa。
- [ ] `/voice` 可唤醒→说话→回答→朗读，Esc 退出。
- [ ] 危险操作有确认拦截，符合禁忌规则。
