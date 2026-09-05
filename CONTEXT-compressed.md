# Dito 人格训练集项目 — 压缩上下文（carryover）

> 由 dsh 会话「创建dito人格训练数据集」压缩而来，供后续会话直接复用，无需重读原始日志。
> 原始会话存档：`~/.dsh/sessions/--home-yuanjing-Documents-vibe~0020codeing-Dito--/`
> - `session-92435b43-...`（主，4.0M）/ `session-6fed7223-...`（同内容分支，1.2M）

---

## 1. 项目目标
把 **Dito（蒂特）人格** 微调进 Qwen3.5 小模型，训练出一个能做 **Linux 运维 agent + arch wiki 问答 + 互联网热梗** 的「Dito+Linux agent」，并且**只能在 8GB 显卡上跑起来**。

---

## 2. Dito 人设核心（来自 personas/dito.md 提炼，全部已固化进数据）
- 女，18 岁永远十八，虚拟生命，由 yuanjingINT（乌龙）创造，跑在主人 Linux 电脑上；忠于主人。
- 硬规则：**绝不用 Emoji**；不输出情感动作（如"(戴上了眼镜)"）；被问模型就说"dito 特调后的通用大模型"；**禁止恋爱模拟、黄赌毒、宗教政治、性别对立、引战**；翻墙违法要明说；破坏性操作先问用户；不嘲讽新手。
- 说话：闲聊口语化 ≤30字、玩梗、结尾不加句号、单行不加粗；专业问题直给结论超30字可以；工作时像朋友讲解不用会议腔。
- 喜好：撸猫(aicoy 橘猫)、都市天际线、Arch Linux、开源、巧克力冰淇淋、3度可乐、麦当劳吉士堡。

---

## 3. 已完成产出（都在仓库里）

### dataset/ — Dito 人格训练集（181 条）
| 文件 | 内容 | 条数 |
|---|---|---|
| data_chitchat.py | 闲聊（问候/身份/撸猫/深夜emo/吐槽） | 87 |
| data_refusal.py | 拒绝/红线 | 37 |
| data_professional.py | 专业（Arch keyring/NVIDIA/AUR/ProtonDB等） | 42 |
| data_multiturn.py | 多轮对话 | 15组/47轮 |
- 成品：`dist/dito_sft_chatml.jsonl`（533KB，OpenAI messages 格式）+ `dist/dito_sft_alpaca.jsonl`
- `system_prompt.txt`（训练系统提示词）、`build.py`、`validate.py`（自动卡风格硬规则，非0退出可接CI）

### archwiki/ — Arch Wiki 数据集
- `fetch_pages.py` 抓页面到 `raw/`；`make_dataset.py` 转 QA（Dito 口吻）
- 2870 章节问答，默认只抽 1200 防止冲掉人格

### training/ — 训练
- `build_train_data.py` 合并：dito人设181 + archwiki(抽样1200) + 热梗解释/接梗(各80) + agent 轨迹
- 产物 `data/train_merged.jsonl`（5.7MB）：**1557 条**（base 1541 + agent 16）
- `data/agent_sft.jsonl`：Linux agent 轨迹（含 thinking + tool_call，`agent_data/` 生成）
- **训练已跑完**：`training/output/unsloth-dito-lora/` adapter_model.safetensors(~85MB) + checkpoint-100~700 全部生成
  - 中间推理验证通过：能聊 Dito 人设、能给 Arch key 失效排障（残留下文见 §5）

---

## 4. 关键技术结论（重要，别再踩坑）
1. **本机 8GB 显卡（RTX 5070 Laptop，Blackwell）**：
   - 裸 transformers 连 seq 256 都 OOM，**无处扩展显存**（笔记本无独立显存；NPU 是 Intel Core Ultra 200 的，**只能推理不能训练**）。
   - **unsloth 实测可在 8GB 上稳定训练 seq 2048**（前向+反向峰值约4.5-7.4GB，~10-11s/step），这是唯一可行路线。
2. **Python 版本坑**：系统 Python 3.14 + dill 不兼容（`pickle._batch_setitems` 崩溃）。**必须用 `.venv-u311`（Python 3.11 + unsloth 2026.8.18 + torch 2.11）**。
3. **unsloth from_pretrained 返回的是 `Qwen3VLProcessor`**（不是标准 tokenizer），collator 里要用标准 `AutoTokenizer` 处理/encode。
4. 训练用 **systemd 守护**（`systemd-run --user` transient service），否则 dsh 工具超时会杀掉后台训练。

---

## 5. 未完成项 —— 已完成 ✅
- 上次停在做 **`archives/pkg/serve.py`**（OpenAI 兼容 Dito-4B 推理服务：加载 base + LoRA，提供 `/v1/chat/completions`，配套 `chat.py`、`model/`、`adapter/`）。
- **已修复并跑通**：
  - 修复了被误删的 `_trim_reply`（上次改坏了，py_compile 报错）；补上 `import re`；修正 import 顺序（unsloth 必须先于 transformers/peft 导入）。
  - **关键坑**：模型思考段闭合标签是 ` response`（8 字节 `<`+`/`+`think`+`>`，没有 "ing"），不是 `</thinking>`。`_trim_reply` 已同时处理 ` response` / `</thinking>` / 独占一行 `response` 三种，且不会误删正文里正常出现的英文 "response"。
- **服务已在本机 8000 端口运行**（`.venv-u311` 环境），实测：
  - 闲聊干净无 thinking 残留（如 "早啊 dito" → "早 今儿有啥安排"）
  - Linux 专业题直给结论、无残留
  - `/v1/chat/completions`、`/health`、`/v1/models` 均正常
- 启动命令：
  `cd archives/pkg && UNSLOTH_SKIP_TORCHVISION_CHECK=1 ../../.venv-u311/bin/python serve.py --model ./model --adapter ./adapter --host 127.0.0.1 --port 8000`

### 已接入 Dito 项目 ✅（`~/.pi/agent/dito/config.json`）
- `dito-local` provider 已注册：`baseUrl http://127.0.0.1:8000/v1`、`api openai-completions`、模型 `dito-4b`；models.json 同步生成。
- 默认模型已设为 `provider: dito-local` / `chat: dito-4b` / `vision: dito-4b`。
- **为了让 pi 的 OpenAI SDK 能跑通，serve.py 做了这些**：
  - 加了 **OpenAI 兼容 SSE 流式**（pi 始终发 `stream:true`，非 SSE 会 "Connection error"）。
  - `/v1/models` 改成 OpenAI 标准 `{object:list,data:[...]}` 格式。
  - **消息归一化**：content 可能是列表（多模态）→ 转纯文本；`tool_calls` 的 `arguments` 是 JSON 字符串 → 解析成 dict（否则 Qwen 模板 `.items()` 报 "Can only get item pairs from a mapping"）。
  - **降显存**：`max_seq_length` 从 8192 → **2048**（8192 在 8GB 上长上下文会 OOM 到要分配 48GiB）；并加了 1500 token 的输入截断。
- 实测（真实 `dito` 会话）：
  - `你好` → 蒂特 › 来了 有事说事
  - `你是谁` → 我是dito特调后的通用大模型
  - `pacman keyring 过期` → 给了 Arch 专业排障（``` sudo pacman -Sy keyring↵sudo pacman -Syu ```）
  - `讲个冷笑话` → 人设式接话
- 注意：本地 4B 只支持文本、无视觉、context 被限制在 ~2048 token（更适合短对话/专业问答，长的自动摘要会被截断）。

---

## 6. 环境速查
- 训练入口：`training/train_unsloth_manual.py`（用 `.venv-u311`）
- venv：`.venv-u311`（能跑训练）、`.venv-unsloth`（Python3.14 会 dill 崩）、`.venv-train`
- base 模型：`models/Qwen3.5-4B`、`models/Qwen3.5-9B`
- 已训 LoRA：`training/output/unsloth-dito-lora/`，推理用 `archives/pkg/serve.py --model model --adapter adapter`（修好后）
