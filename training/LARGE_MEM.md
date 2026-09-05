# 大显存机器上的高质量训练（对标 Claude agent 能力）

> 本机 8GB 显存只能做"验证型"训练（seq 128）。要真正训练出接近 Claude 的
> agent / Linux 能力，需要 ≥24GB 显存（推荐 40GB+）。本文件给出补偿配置。

## 为什么本机不够

- 8GB 上 Qwen3.5-4B 的 QLoRA 序列上限只有 ~128 token，连一条完整多轮 agent 轨迹都放不下。
- 要学 agent 能力，必须让模型看完整轨迹（500~2000+ token）——这需要大显存。

## 推荐硬件

- 24GB（RTX 3090 / 4090）：Qwen3.5-4B seq 2048~4096，LoRA r16-32，全 attention+MLP 层
- 40GB+（A100/云GPU）：Qwen3.5-9B 也能训

## 训练命令（大显存）

```bash
cd training
python build_train_data.py          # 生成 data/train_merged.jsonl（含 agent 轨迹）

# 4B，24GB
python train_qlora.py \
  --model-path ../models/Qwen3.5-4B \
  --data-path data/train_merged.jsonl \
  --output-dir output/qwen3.5-4b-dito-lora \
  --max-seq-len 2048 \
  --max-steps 3000 \
  --grad-accum 8 \
  --lora-r 32 --lora-alpha 64 \
  --lr 2e-4

# 9B，40GB+
python train_qlora.py \
  --model-path ../models/Qwen3.5-9B \
  --data-path data/train_merged.jsonl \
  --output-dir output/qwen3.5-9b-dito-lora \
  --max-seq-len 2048 --max-steps 3000 \
  --grad-accum 8 --lora-r 16 --lora-alpha 32
```

## 大显存下建议开启

- 把 `train_qlora.py` 里 `gradient_checkpointing` 改回 `True`（省显存、提高可用 seq）
- LoRA target 增加 MLP 层（`gate/up/down_proj`）以及线性注意力的 `qk_proj/v_proj_l` 等
- `--max-seq-len 2048` 才能覆盖完整 agent 轨迹

## 要真正逼近 Claude agent 能力，还需要

1. **更多 / 更真实的 agent 轨迹数据**：当前只有 16 条精写样本，需要扩大到数百条，
   覆盖：长排障链、跨多工具协作（bash+文件+搜索）、回滚、权限处理、用户中途改需求等。
2. **RL / DPO**：SFT 只能学会"格式和风格"，真正的 agent 能力需要环境反馈的强化学习。
3. **模型容量**：4B 的天花板远低于 Claude。若目标是"媲美"，建议用 ≥70B 的底座 + 大量轨迹。

## 本机验证型产物

`output/qwen3.5-4b-dito-lora` 是在 seq 128 下训练的验证版，可体验 Dito 人格和短 agent 行为，
但 agent 轨迹因为截断只学到片段，属流程验证性质。
