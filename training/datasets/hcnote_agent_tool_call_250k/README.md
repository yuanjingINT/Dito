<p align="center">
  <img src="https://img.shields.io/badge/数据集-248K%2B%20样本-blue" alt="数据集规模">
  <img src="https://img.shields.io/badge/工具-50个%20横跨5个平台-green" alt="工具数量">
  <img src="https://img.shields.io/badge/领域-12大方向-orange" alt="领域覆盖">
  <img src="https://img.shields.io/badge/语言-中文%20%7C%20英文-brightgreen" alt="语言支持">
  <img src="https://img.shields.io/badge/许可证-Apache%202.0-green" alt="许可证">
</p>

<h1 align="center">Agent 工具调用 SFT 数据集 (250K)</h1>

<p align="center">
  <strong>大规模监督微调数据集 —— 训练 LLM 智能体掌握工具调用能力</strong><br>
  248,215 条高质量指令-工具调用样本 &middot; 50 个工具 &middot; 12 大领域 &middot; 5 个智能体平台<br>
  <sup>兼容 Claude Code、OpenCode、OpenClaw (龙虾)、CoPaw (智舱)、Cline 等主流智能体框架</sup>
</p>

---

## 这个数据集是什么？

训练语言模型**正确调用工具**是构建实用 AI 智能体最关键的步骤之一。本数据集提供了 **248,215 条精心编排的指令-工具调用样本**，教会模型如何：

- 为给定任务**选择正确的工具**
- 传递**正确的参数**（类型准确、必填字段完整）
- 编排**多步骤工作流**（4-6 步串联工具调用处理复杂任务）
- 处理**模糊/不明确**的用户请求，将其映射为精确的工具调用
- 在**真实约束条件**下操作（紧急情况、有限资源、特定环境）

工具定义和参数 Schema 全部从**真实的生产级智能体实现**中提取，而非人工编造。这意味着基于此数据集训练的模型产出的工具调用**在实际部署时能够真正执行**。

---

## 智能体平台兼容性

本数据集基于以下主流 AI 智能体平台构建，并完全兼容：

| 平台 | 语言 | 说明 | 工具数 |
|------|------|------|--------|
| [Claude Code](https://github.com/anthropics/claude-code) | TypeScript | Anthropic 官方 CLI 编程智能体 | 29 |
| [OpenCode](https://github.com/opencode-ai/opencode) | Go | 开源终端 AI 编程助手 | 兼容 |
| [OpenClaw (龙虾)](https://github.com/openclaw) | TypeScript | 开源多模态智能体框架 | 6 |
| [CoPaw (智舱)](https://github.com/CoPaw) | Python | 桌面自动化智能体（浏览器/文件控制） | 15 |
| [Cline](https://github.com/cline/cline) | TypeScript | VS Code 自主编码智能体 | 兼容 |
| 其他 Agent 框架 | — | 任何支持结构化工具调用的智能体 | 可适配 |

> **说明**：本数据集使用的工具调用格式 `[{"name": "...", "parameters": {...}}]` 遵循标准 function-calling 规范，可轻松适配到任何支持结构化工具调用的智能体框架。

---

## 核心特性

| 特性 | 详情 |
|------|------|
| **规模** | 248,215 条去重的指令-输出样本对 |
| **工具覆盖** | 来自 5 个生产级智能体代码库的 50 个工具 |
| **领域覆盖** | 12 大真实业务领域（详见下文） |
| **双语支持** | ~81% 中文、~19% 英文 |
| **多步骤工作流** | 4-6 步串联工具调用处理复杂任务 |
| **上下文感知场景** | 错误恢复、调试链路、部署流水线 |
| **约束条件请求** | 带有真实世界约束和条件的指令 |
| **模糊请求处理** | 短文本/模糊请求映射为精确工具调用 |
| **零格式错误** | 每条样本均通过 JSON 格式校验 |

---

## 数据集格式

**JSONL 格式**（每行一个 JSON 对象），兼容 [LlamaFactory](https://github.com/hiyouga/LLaMA-Factory)、[Axolotl](https://github.com/OpenAccess-AI-Collective/axolotl)、[Unsloth](https://github.com/unslothai/unsloth) 等主流 SFT 框架。

```json
{
  "instruction": "线上API接口返回500错误，帮我排查",
  "input": "",
  "output": "[{\"name\": \"Bash\", \"parameters\": {\"command\": \"curl -s https://api.example.com/health | jq .\"}}, {\"name\": \"Bash\", \"parameters\": {\"command\": \"tail -200 /var/log/app/error.log | grep '500|Error' | tail -20\"}}, {\"name\": \"Agent\", \"parameters\": {\"prompt\": \"综合分析错误日志和Pod状态，定位根因\", \"description\": \"根因分析\", \"subagent_type\": \"bug-analyzer\"}}]"
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `instruction` | string | 用户指令 / 自然语言请求 |
| `input` | string | 始终为空（保留字段，用于框架兼容） |
| `output` | string | 工具调用 JSON 数组：`[{"name": "...", "parameters": {...}}]` |

---

## 工具覆盖范围 (50 个工具)

### Claude Code 工具 (29个)

来自 Anthropic 官方智能体的核心软件工程工具：

`Bash` `Read` `Edit` `Write` `Glob` `Grep` `WebFetch` `WebSearch` `NotebookEdit` `Agent` `TaskCreate` `TaskUpdate` `TaskGet` `TaskList` `TaskOutput` `TaskStop` `AskUserQuestion` `TodoWrite` `CronCreate` `CronDelete` `CronList` `SendMessage` `EnterPlanMode` `ExitPlanMode` `EnterWorktree` `ExitWorktree` `Skill` `ListMcpResources` `ReadMcpResource`

### CoPaw 智舱工具 (15个)

桌面自动化和多模态交互工具：

`read_file` `write_file` `edit_file` `append_file` `grep_search` `glob_search` `send_file_to_user` `desktop_screenshot` `browser_use` `view_image` `view_video` `memory_search` `get_current_time` `execute_python_code` `execute_shell_command`

### OpenClaw 龙虾工具 (6个)

系统级执行和多智能体协调工具：

`exec` `process` `apply_patch` `camera` `sessions` `agents`

---

## 领域覆盖 (12 大领域)

| 领域 | 样本数 | 典型场景 |
|------|--------|----------|
| Web 前端 | ~16,416 | 组件调试、CSS 修复、构建错误 |
| 后端开发 | ~16,450 | API 调试、数据库查询、中间件配置 |
| 数据科学 | ~16,488 | 数据清洗、可视化、模型训练 |
| DevOps | ~16,572 | CI/CD 流水线、容器编排、监控告警 |
| 安全 | ~16,455 | 漏洞扫描、渗透测试、代码审计 |
| 移动开发 | ~16,434 | iOS/Android 构建、设备测试、UI 自动化 |
| AI/ML | ~16,292 | 模型部署、训练流水线、推理优化 |
| 数据库 | ~16,413 | 查询优化、迁移、备份恢复 |
| 测试 | ~16,225 | 单元/集成测试、覆盖率分析、压力测试 |
| 系统运维 | ~16,313 | 服务器管理、日志分析、性能调优 |
| 文档 | ~16,382 | API 文档、README 生成、代码注释 |
| 游戏开发 | ~16,332 | 游戏引擎脚本、资源管理、调试 |

---

## 样本分布

### 按工具调用复杂度

| 类别 | 数量 | 占比 |
|------|------|------|
| 单步工具调用 | 212,900 | 85.8% |
| 2 步串联调用 | 29,146 | 11.7% |
| 3 步串联调用 | 5,933 | 2.4% |
| 4 步以上工作流 | 159 | 0.1% |

### 按场景类型

| 场景 | 数量 |
|------|------|
| 测试相关 | 17,758 |
| 安全审计 | 12,354 |
| 性能优化 | 11,090 |
| 约束条件请求 | 7,640 |
| 调试/排障 | 5,760 |
| 重构/迁移 | 4,981 |
| 部署/发布 | 3,577 |
| 上下文感知（多轮） | 417 |
| 紧急事件响应 | 280 |

---

## 快速开始

### 使用 LlamaFactory

```yaml
# dataset_info.yaml
- file_name: agent_tool_call_sft_250k.jsonl
  formatting: SHARESPT
  columns:
    prompt: instruction
    response: output
```

### 使用 Axolotl

```yaml
datasets:
  - path: agent_tool_call_sft_250k.jsonl
    type: alpaca
    field_instruction: instruction
    field_output: output
```

### 使用 Unsloth

```python
from unsloth import standardize_data_formats
dataset = standardize_data_formats("agent_tool_call_sft_250k.jsonl")
```

### 直接加载 (Python)

```python
import json

samples = []
with open("agent_tool_call_sft_250k.jsonl", "r", encoding="utf-8") as f:
    for line in f:
        samples.append(json.loads(line))

print(f"已加载 {len(samples)} 条样本")
# 已加载 248215 条样本

# 统计分析
single = sum(1 for s in samples if len(json.loads(s["output"])) == 1)
multi = sum(1 for s in samples if len(json.loads(s["output"])) > 1)
print(f"单步调用: {single}, 多步串联: {multi}")
```

---

## 数据质量保证

| 指标 | 结果 |
|------|------|
| **格式准确率** | 100% — 所有样本均为合法 JSON，工具调用结构正确 |
| **参数完整性** | 100% — 每个工具调用均包含全部必填参数 |
| **参数命名** | 从真实智能体实现的源代码中提取，非人工编造 |
| **去重处理** | 基于 MD5 哈希的 (instruction, output) 对去重 |
| **无占位符** | 零 `value_xxx` 占位符值（已在优化阶段清除） |
| **多工具灵活性** | 27.4% 的指令可映射为多种不同的工具组合 |

---

## 典型应用场景

- **训练自己的编程智能体**：让模型学会使用 Bash、Read、Edit、Write、Grep 等工具
- **构建桌面自动化智能体**：利用 CoPaw 风格工具实现文件、浏览器和屏幕控制
- **创建多智能体系统**：使用 `Agent` 工具调用构建层级式智能体架构
- **工具调用研究**：研究模型如何选择和编排工具的模式
- **评估工具调用能力**：作为工具选择和参数正确性的基准测试

---

## 版本历史

| 版本 | 日期 | 样本数 | 主要变更 |
|------|------|--------|----------|
| v3.0 | 2026-04-10 | 100,000 | 初始高多样性生成 |
| v5.0 | 2026-04-10 | 247,921 | 12 领域扩展、双语支持、数据合并 |
| v6.1 | 2026-04-10 | 248,215 | 复杂工作流、上下文感知、约束条件请求、调试链路 |

---

## 许可证

本数据集在 **Apache License 2.0** 许可下发布。

Copyright (c) 2026 新疆幻城网安科技有限公司 (Xinjiang Huancheng Cybersecurity Technology Co., Ltd.)

---

## 致谢

- **作者**：幻城 (Huancheng)
- **机构**：新疆幻城网安科技有限公司 (Xinjiang Huancheng Cybersecurity Technology Co., Ltd.)
- **官网**：[https://hcnsec.cn](https://hcnsec.cn)
- **博客**：[https://hcnote.cn](https://hcnote.cn)
- **QQ 群**：253193620
- **微信公众号**：云城智枢 (YunCheng ZhiShu)

---

## 引用

如果您在研究或项目中使用了本数据集，请引用：

```bibtex
@dataset{agent_tool_call_sft_250k,
  title     = {Agent Tool Call SFT 250K: A Large-Scale Dataset for Training Tool-Calling LLM Agents},
  author    = {Huancheng},
  organization = {新疆幻城网安科技有限公司},
  url       = {https://hcnsec.cn},
  year      = {2026},
  month     = {April},
  note      = {248,215 instruction-output pairs covering 50 tools across 12 domains}
}
```

---

## 联系方式

- 官网：[https://hcnsec.cn](https://hcnsec.cn)
- 技术博客：[https://hcnote.cn](https://hcnote.cn)
- QQ 群：253193620
- 微信公众号：云城智枢

---

<p align="center">
  由 <strong>新疆幻城网安科技有限公司</strong> 发布<br>
  <sub>开源共享 | 云城智枢 | Cloud City Intelligence Hub</sub>
</p>
