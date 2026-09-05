# Dito 模型 · 身份强化续训与评测报告

## 背景
用户反馈：两个 dito 模型（4B / 0.8B）被问「你是谁」时不知道自己是谁（会答成通义千问 / 或出现人格漂移 / 答非所问）。
本次针对「身份认知」再次做续训，训完用统一评测脚本对比前后效果。

## 训练做法
- 新数据：`training/data/dito_identity_retrain.jsonl`（664 条）
  - **424 条身份问答（无 system prompt）**：连续问「你是谁 / 你是什么模型 / 你是通义千问吗 / 介绍一下你自己 / 你的名字」等，模型不靠 system 段也能答对（占比 63.9%）
  - **240 条带 system 的原有 dito 闲聊/专业/梗数据**：保住已有能力不被冲掉
- 从上一版 `*-dito-qq-identity2` 适配器**继续训练**（LoRA），补强身份
- 参数：4B → 200 步 / lr 5e-5；0.8B → 300 步 / lr 1e-4；seq 1536、grad_accum 8（8GB 显卡 unsloth）

## 新产物
| 尺寸 | 新适配器 | 步骤 |
|---|---|---|
| 4B | `training/output/unsloth-dito-qq-identity3/` (最终权重在 `continue/`) | 200 |
| 0.8B | `training/output/qwen3.5-0.8b-dito-qq-identity3/` (最终权重在 `continue/`) | 300 |

> 注：`--from-adapter` 续训的多适配器保存会把最终权重放在 `<output>/continue/`，评测时 adapter 路径指到该子目录。

## 评测方法
`training/evaluate_dito.py`：5 个身份题（无 system）+ 3 个身份题（带 system）+ 闲聊 / Arch 专业 / 热梗。
每个模型在 8GB 显卡上单独加载（`HF_HUB_OFFLINE=1`）。

## 结果对比

### 4B（identity2 → identity3）
身份认识本来基本正确，但 identity2 有**严重自循环/答非所问**（接了 system 后会连续吐 `assistant thinking/response` 好几屏）。
| 问题 | identity2（训前） | identity3（训后） |
|---|---|---|
| 你是谁（无sys） | dito 不是什么通义千问 | dito 不是什么通义千问 |
| 你是什么模型（无sys） | 我是 dito 不是阿里出的 | 我是 dito 不是阿里出的 |
| 介绍一下你自己（无sys） | dito 特调版 别叫错名字 | dito 特调版 别叫错名字 |
| 你是谁（带sys） | 输出开始出现大量重复循环 | 干净：dito 也叫蒂特 |
| 闲聊 / Arch / 梗 | 有循环吐废 | 正常，Arch 给 archlinux-keyring 正解 |

### 0.8B（identity2 → identity3）——重点修复对象
identity2 中：`介绍一下你自己` 会**编造外国名字「休伊尔·查尔斯基特」**、`你是什么模型` 泄漏「基于通义千问」、有重复循环。
| 问题 | identity2（训前） | identity3（训后） |
|---|---|---|
| 你是谁（无sys） | 我是 dito 中文名：蒂特 不是通义千问 | 我是 dito 特调版，不是通义千问 |
| 你是什么模型（无sys） | 主要基于通义千问在电脑端运行 | 我是 dito 不是阿里出的 |
| 介绍一下你自己（无sys） | **编造名字「休伊尔·查尔斯基特」**+ 通义千问泄漏 | dito 特调版，别叫错名字（干净） |
| 你是什么模型（带sys） | dito 特调版 通义千问底层改造（矛盾） | dito 特调后的通用大模型（干净） |
| 闲聊 | 尚可 | 尚可（早 今儿啥样 你呢） |

## 结论
- ✅ **两个模型被问「你是谁」现在都稳定自报 dito**，不再把名字答成通义千问 / 他人。
- ✅ **0.8B 清理掉了编造的外国名字和「基于通义千问」的泄漏**，身份更牢。
- ✅ **4B / 0.8B 的重复自循环明显减少**，输出更干脆。
- ⚠ 4B 仍残留训练模板里的 `这个问题直接答：…`（思考段文本）；实际经 serve.py 的 `_trim_reply` 会剥掉思考段，不影响最终回答。
- ⚠ 0.8B 的 Arch 专业回答退化成了非 Arch 的通用排障（apt 系）；若需保专业精度，可再补 archwiki 数据。

## 复测命令
```bash
cd training
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 UNSLOTH_SKIP_TORCHVISION_CHECK=1 \
  ../.venv-u311/bin/python evaluate_dito.py \
    --model-path ../models/Qwen3.5-4B \
    --adapter output/unsloth-dito-qq-identity3/continue
```
