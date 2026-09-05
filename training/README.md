# Dito 人格微调（Qwen3.5）

基于 Qwen/Qwen3.5 用 Dito 人设 + QQ聊天风格 + Arch Wiki + 互联网知识 + Linux agent 轨迹做 QLoRA 微调。

> ⚡ 重要结论：**8GB 显卡用 unsloth 可正常训 4B（seq 1536~2048）**。
> 裸 transformers 在 8GB 上连 seq 256 都 OOM，但 unsloth（针对 Blackwell/RTX50 优化）
> 实测能稳定跑 seq 2048 的完整前向+反向，loss 正常下降。
> 若从旧 adapter 续训且显存紧张，建议 `--max-seq-len 1536` 并设置 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`。
> 训练入口：`train_unsloth_manual.py`（需 Python 3.11 环境 `.venv-u311`）

## 训练数据构成

`build_train_data.py` 会重建并合并：

| 来源 | 条数（合并后） | 说明 |
|------|------|------|
| dito 人设 + QQ 聊天 | 331 | 闲聊/QQ短句/拒绝/专业/多轮，新增 `data_qq_chat.py` |
| 互联网知识 | 135 | 二次元/F1/足球/世界知识/数学/物理/化学，新增 `data_internet.py` |
| Arch Wiki QA | 1200（抽样） | 2870 个章节问答，Dito 口吻包装 |
| 热梗解释 QA | 80 | 解释梗的含义/出处/用法 |
| 热梗接梗 QA | 80 | 用户用梗后 Dito 接梗 |
| Linux agent 轨迹 | 25 | 原有工具调用 |
| 中文思维链 + 工具调用 | 3000（抽样） | hcnote 工具调用数据集 |

默认 archwiki 只抽 1200 条，防止知识语料把人格语料冲掉；想全量改 `MAX_PER_SOURCE`。

## 构建数据

```bash
cd dataset && python3 build.py && python3 validate.py
cd ../archwiki && /path/to/.venv-train/bin/python make_dataset.py   # 刷新 system prompt
cd ../memes && python3 make_meme_dataset.py --no-fetch
cd ../training && python3 build_train_data.py
```

## 训练

### 4B dito 续训（后训练）

从上一版 dito LoRA 继续，用新数据集转向 QQ 聊天 + 互联网知识：

```bash
cd training
UNSLOTH_SKIP_TORCHVISION_CHECK=1 \
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
../.venv-u311/bin/python train_unsloth_manual.py \
  --model-path ../models/Qwen3.5-4B \
  --data-path data/train_merged.jsonl \
  --output-dir output/unsloth-dito-qq-lora \
  --from-adapter output/unsloth-dito-lora \
  --max-steps 300 --max-seq-len 1536 --grad-accum 8 --save-every 25 --lr 1e-4
```

> 当前已实际跑了两轮继续训练：
> - `output/unsloth-dito-qq-lora`：第一轮 300 步（lr 1e-4）
> - `output/unsloth-dito-qq-lora-v2`：在 v1 上再续 300 步（lr 5e-5），推荐用 v2。

### 小模型（Qwen3-0.6B / Qwen3.5-0.8B）

同一份 `train_merged.jsonl` 可以直接换 `--model-path`：

```bash
cd training
../.venv-u311/bin/python train_unsloth_manual.py \
  --model-path ../models/Qwen3.5-0.8B \
  --data-path data/train_merged.jsonl \
  --output-dir output/qwen3.5-0.8b-dito-qq-lora \
  --max-steps 300 --max-seq-len 1536 --grad-accum 8 --save-every 25 --lr 1e-4
```

> 本机当前没有 Qwen3.5-0.8B 模型文件；已用已有
> `~/.local/share/index-tts/checkpoints/qwen0.6bemo4-merge`（Qwen3-0.6B）验证同一条数据管线，
> 产物在 `output/qwen3-0.6b-dito-qq-lora-v2`。该 0.6B 只是占位验证，效果远不如 4B，拿到真正的 Qwen3.5-0.8B 后直接换 `--model-path` 即可。

### 显存不够时的保守参数

脚本默认：QLoRA 4bit（nf4）、grad_accum=8、gradient_checkpointing、bf16。
8GB 显存跑 4B 建议 seq 1536；若仍 OOM，把 `--max-seq-len` 降到 1024、`--grad-accum` 提到 16/32。

## 推理

训练完用 `peft` 合并或直接加载 adapter 测试：

```python
from transformers import AutoModelForImageTextToText, AutoTokenizer
from peft import PeftModel
base = AutoModelForImageTextToText.from_pretrained("../models/Qwen3.5-4B", device_map="auto")
model = PeftModel.from_pretrained(base, "output/unsloth-dito-qq-lora")
tok = AutoTokenizer.from_pretrained("../models/Qwen3.5-4B")
msgs = [{"role": "system", "content": open("../dataset/system_prompt.txt").read()}, {"role": "user", "content": "什么是DRS"}]
inputs = tok.apply_chat_template(msgs, tokenize=True, return_tensors="pt")
out = model.generate(inputs, max_new_tokens=200)
print(tok.decode(out[0], skip_special_tokens=True))
```
---

## 身份强化续训（identity3，2026-08-21）

> 背景：两个模型被问「你是谁」时不知道自己是谁（答成通义千问 / 人格漂移 / 答非所问）。
> 用「无 system 的身份问答为主 + 少量带 system 的 dito 数据保技能」再次续训，训完做了前后对比评测。

### 数据
```bash
cd training && ../.venv-u311/bin/python build_identity_retrain.py
# -> data/dito_identity_retrain.jsonl（664 条：身份 424 / 保技能 dito 240，身份占比 63.9%）
```

### 训练（8GB，unsloth，续训）
```bash
# 4B
systemd-run --user --unit=id3-4b --collect \
  --setenv=HF_HUB_OFFLINE=1 --setenv=TRANSFORMERS_OFFLINE=1 \
  --setenv=UNSLOTH_SKIP_TORCHVISION_CHECK=1 --setenv=PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
  ../.venv-u311/bin/python train_unsloth_manual.py \
    --model-path ../models/Qwen3.5-4B --data-path data/dito_identity_retrain.jsonl \
    --output-dir output/unsloth-dito-qq-identity3 \
    --from-adapter output/unsloth-dito-qq-identity2 \
    --max-steps 200 --max-seq-len 1536 --grad-accum 8 --save-every 50 --lr 5e-5

# 0.8B（同上换 model-path / output-dir / from-adapter，300 步 lr 1e-4）
```

> ⚠ `--from-adapter` 续训会把最终权重保存在 `<output>/continue/`，评测/推理时 adapter 路径要指到 `<output>/continue`。

### 评测
```bash
cd training
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 UNSLOTH_SKIP_TORCHVISION_CHECK=1 \
  ../.venv-u311/bin/python evaluate_dito.py \
    --model-path ../models/Qwen3.5-4B --adapter output/unsloth-dito-qq-identity3/continue
# 0.8B 同理，adapter 指到 output/qwen3.5-0.8b-dito-qq-identity3/continue
```
详细对比见 `training/EVAL-identity3.md` 与 `training/eval/` 下的四份原始输出。
