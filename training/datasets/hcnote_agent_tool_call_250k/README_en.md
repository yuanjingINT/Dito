<p align="center">
  <img src="https://img.shields.io/badge/Dataset-248K%2B%20Samples-blue" alt="Dataset Size">
  <img src="https://img.shields.io/badge/Tools-50%20Across%205%20Platforms-green" alt="Tools">
  <img src="https://img.shields.io/badge/Domains-12%20Coverage-orange" alt="Domains">
  <img src="https://img.shields.io/badge/Language-CN%20%7C%20EN-brightgreen" alt="Languages">
  <img src="https://img.shields.io/badge/License-Apache%202.0-green" alt="License">
</p>

<h1 align="center">Agent Tool Call SFT Dataset (250K)</h1>

<p align="center">
  <strong>A Large-Scale Supervised Fine-Tuning Dataset for Training LLM Agents with Tool-Calling Capabilities</strong><br>
  248,215 high-quality instruction-tool call pairs &middot; 50 tools &middot; 12 domains &middot; 5 agent platforms<br>
  <sup>Compatible with Claude Code, OpenCode, OpenClaw, CoPaw, Cline, and more</sup>
</p>

---

## What is this dataset?

Training a language model to **call tools correctly** is one of the most critical steps in building practical AI agents. This dataset provides **248,215 carefully curated instruction-tool call pairs** that teach models how to:

- Select the **right tool** for a given task
- Pass **correct parameters** with proper types and required fields
- Chain **multi-step workflows** (4-6 sequential tool calls for complex tasks)
- Handle **ambiguous/fuzzy** user requests by mapping them to precise tool calls
- Operate under **real-world constraints** (urgency, limited resources, specific environments)

The tool definitions and parameter schemas are extracted from **real, production agent implementations** — not synthetically invented. This means models trained on this data will produce tool calls that **actually work** when deployed.

---

## Agent Platform Compatibility

This dataset is built from and fully compatible with the following mainstream AI agent platforms:

| Platform | Language | Description | Tools |
|----------|----------|-------------|-------|
| [Claude Code](https://github.com/anthropics/claude-code) | TypeScript | Anthropic's official CLI agent for software engineering | 29 |
| [OpenCode](https://github.com/opencode-ai/opencode) | Go | Open-source terminal-based AI coding assistant | Compatible |
| [OpenClaw (龙虾)](https://github.com/openclaw) | TypeScript | Open-source multi-modal agent framework | 6 |
| [CoPaw (智舱)](https://github.com/CoPaw) | Python | Desktop automation agent with browser/file control | 15 |
| [Cline](https://github.com/cline/cline) | TypeScript | VS Code autonomous coding agent | Compatible |
| Other Agent Frameworks | — | Any tool-calling agent using similar patterns | Adaptable |

> **Note**: The tool call format `[{"name": "...", "parameters": {...}}]` used in this dataset follows the standard function-calling convention. It can be easily adapted to any agent framework that supports structured tool invocation.

---

## Key Features

| Feature | Details |
|---------|---------|
| **Scale** | 248,215 unique instruction-output pairs |
| **Tool Coverage** | 50 tools from 5 production agent codebases |
| **Domain Coverage** | 12 real-world domains (see below) |
| **Bilingual** | ~81% Chinese, ~19% English |
| **Multi-step Workflows** | 4-6 step chained tool calls for complex tasks |
| **Context-aware Scenarios** | Error recovery, debugging chains, deployment pipelines |
| **Constrained Requests** | Instructions with real-world constraints and conditions |
| **Fuzzy Request Handling** | Short/ambiguous requests mapped to precise tool calls |
| **Zero Format Errors** | Every sample validated as correct JSON |

---

## Dataset Format

**JSONL format** (one JSON object per line), compatible with [LlamaFactory](https://github.com/hiyouga/LLaMA-Factory), [Axolotl](https://github.com/OpenAccess-AI-Collective/axolotl), [Unsloth](https://github.com/unslothai/unsloth), and other SFT frameworks.

```json
{
  "instruction": "线上API接口返回500错误，帮我排查",
  "input": "",
  "output": "[{\"name\": \"Bash\", \"parameters\": {\"command\": \"curl -s https://api.example.com/health | jq .\"}}, {\"name\": \"Bash\", \"parameters\": {\"command\": \"tail -200 /var/log/app/error.log | grep '500|Error' | tail -20\"}}, {\"name\": \"Agent\", \"parameters\": {\"prompt\": \"综合分析错误日志和Pod状态，定位根因\", \"description\": \"根因分析\", \"subagent_type\": \"bug-analyzer\"}}]"
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `instruction` | string | User instruction / natural language request |
| `input` | string | Always empty (reserved for framework compatibility) |
| `output` | string | JSON array of tool calls: `[{"name": "...", "parameters": {...}}]` |

---

## Tool Coverage (50 Tools)

### Claude Code Tools (29)

Core software engineering tools from Anthropic's official agent:

`Bash` `Read` `Edit` `Write` `Glob` `Grep` `WebFetch` `WebSearch` `NotebookEdit` `Agent` `TaskCreate` `TaskUpdate` `TaskGet` `TaskList` `TaskOutput` `TaskStop` `AskUserQuestion` `TodoWrite` `CronCreate` `CronDelete` `CronList` `SendMessage` `EnterPlanMode` `ExitPlanMode` `EnterWorktree` `ExitWorktree` `Skill` `ListMcpResources` `ReadMcpResource`

### CoPaw Tools (15)

Desktop automation and multi-modal interaction tools:

`read_file` `write_file` `edit_file` `append_file` `grep_search` `glob_search` `send_file_to_user` `desktop_screenshot` `browser_use` `view_image` `view_video` `memory_search` `get_current_time` `execute_python_code` `execute_shell_command`

### OpenClaw Tools (6)

System-level execution and multi-agent coordination tools:

`exec` `process` `apply_patch` `camera` `sessions` `agents`

---

## Domain Coverage (12 Domains)

| Domain | Samples | Example Scenarios |
|--------|---------|-------------------|
| Web Frontend | ~16,416 | Component debugging, CSS fixes, build errors |
| Backend | ~16,450 | API debugging, database queries, middleware config |
| Data Science | ~16,488 | Data cleaning, visualization, model training |
| DevOps | ~16,572 | CI/CD pipelines, container orchestration, monitoring |
| Security | ~16,455 | Vulnerability scanning, penetration testing, code audit |
| Mobile | ~16,434 | iOS/Android builds, device testing, UI automation |
| AI/ML | ~16,292 | Model deployment, training pipelines, inference optimization |
| Database | ~16,413 | Query optimization, migration, backup/recovery |
| Testing | ~16,225 | Unit/integration tests, coverage analysis, load testing |
| System Ops | ~16,313 | Server management, log analysis, performance tuning |
| Documentation | ~16,382 | API docs, README generation, code comments |
| Game Dev | ~16,332 | Game engine scripting, asset management, debugging |

---

## Sample Distribution

### By Tool Call Complexity

| Category | Count | Percentage |
|----------|-------|------------|
| Single tool call | 212,900 | 85.8% |
| 2-step chain | 29,146 | 11.7% |
| 3-step chain | 5,933 | 2.4% |
| 4+ step workflow | 159 | 0.1% |

### By Scenario Type

| Scenario | Count |
|----------|-------|
| Testing related | 17,758 |
| Security audit | 12,354 |
| Performance optimization | 11,090 |
| Constrained requests | 7,640 |
| Debugging/troubleshooting | 5,760 |
| Refactoring/migration | 4,981 |
| Deployment/release | 3,577 |
| Context-aware (multi-turn) | 417 |
| Urgent/incident response | 280 |

---

## Quick Start

### With LlamaFactory

```yaml
# dataset_info.yaml
- file_name: agent_tool_call_sft_250k.jsonl
  formatting: SHARESPT
  columns:
    prompt: instruction
    response: output
```

### With Axolotl

```yaml
datasets:
  - path: agent_tool_call_sft_250k.jsonl
    type: alpaca
    field_instruction: instruction
    field_output: output
```

### With Unsloth

```python
from unsloth import standardize_data_formats
dataset = standardize_data_formats("agent_tool_call_sft_250k.jsonl")
```

### Direct Loading (Python)

```python
import json

samples = []
with open("agent_tool_call_sft_250k.jsonl", "r", encoding="utf-8") as f:
    for line in f:
        samples.append(json.loads(line))

print(f"Loaded {len(samples)} samples")
# Loaded 248215 samples

# Quick stats
single = sum(1 for s in samples if len(json.loads(s["output"])) == 1)
multi = sum(1 for s in samples if len(json.loads(s["output"])) > 1)
print(f"Single tool calls: {single}, Multi-step chains: {multi}")
```

---

## Data Quality Assurance

| Metric | Result |
|--------|--------|
| **Format Accuracy** | 100% — all samples are valid JSON with correct tool call structure |
| **Parameter Completeness** | 100% — all required parameters included in every tool call |
| **Parameter Names** | Extracted from source code of real agent implementations |
| **Deduplication** | MD5 hash-based deduplication on (instruction, output) pairs |
| **No Placeholder Values** | Zero `value_xxx` placeholder values (cleaned in optimization pass) |
| **Multi-tool Flexibility** | 27.4% of instructions map to multiple different tool combinations |

---

## Use Cases

- **Fine-tune your own coding agent**: Train a model to use tools like Bash, Read, Edit, Write, Grep, etc.
- **Build a desktop automation agent**: Leverage CoPaw-style tools for file, browser, and screen control
- **Create a multi-agent system**: Use the `Agent` tool calls to build hierarchical agent architectures
- **Research on tool-calling**: Study patterns of how models select and chain tools
- **Evaluate tool-calling ability**: Use as a benchmark for tool selection and parameter correctness

---

## Version History

| Version | Date | Samples | Key Changes |
|---------|------|---------|-------------|
| v3.0 | 2026-04-10 | 100,000 | Initial high-diversity generation |
| v5.0 | 2026-04-10 | 247,921 | 12-domain expansion, bilingual, merged |
| v6.1 | 2026-04-10 | 248,215 | Complex workflows, context-aware, constrained requests, debugging chains |

---

## License

This dataset is released under the **Apache License 2.0**.

Copyright (c) 2026 新疆幻城网安科技有限公司 (Xinjiang Huancheng Cybersecurity Technology Co., Ltd.)

---

## Credits

- **Author**: 幻城 (Huancheng)
- **Organization**: 新疆幻城网安科技有限公司 (Xinjiang Huancheng Cybersecurity Technology Co., Ltd.)
- **Website**: [https://hcnsec.cn](https://hcnsec.cn)
- **Blog**: [https://hcnote.cn](https://hcnote.cn)
- **QQ Group**: 253193620
- **WeChat Official Account**: 云城智枢 (YunCheng ZhiShu)

---

## Citation

If you use this dataset in your research or project, please cite:

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

<p align="center">
  Released by <strong>新疆幻城网安科技有限公司</strong><br>
  <sub>Open Source | Cloud City Intelligence Hub | 云城智枢</sub>
</p>
