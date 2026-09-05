#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Qwen3.5-9B dito 人格 QLoRA 微调脚本。

用法:
  python3 train_qlora.py \
      --model-path ../models/Qwen3.5-9B \
      --data-path data/train_merged.jsonl \
      --output-dir output/qwen3.5-9b-dito-lora

显存只有 8GB，默认采用 QLoRA 4bit + 梯度累积 + 梯度检查点的保守配置。
"""
import argparse
import json
import os
import tempfile

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
)


class ThinkingCollator:
    """对 assistant 段（含 thinking + response + tool_call）计算 loss，支持 agent 轨迹。

    采用逐条消息编码 + 手动拼接的方式，对截断稳健：
    - 每条消息单独 encode（add_special_tokens=False，避免截断破坏 offset 映射）
    - 记录每个 assistant 消息的 token 区间，直接在该区间标 loss
    - 拼接时插入 ChatML 分隔符，最后统一截断（从右侧），并保证至少保留尾部的 assistant 段
    """

    IM_START = "<|im_start|>"
    IM_END = "<|im_end|>"

    def __init__(self, tokenizer, max_length=2048):
        self.tokenizer = tokenizer
        self.max_length = max_length
        # 记录分隔 token 并缓存
        self._sp_tok = {}

    def _tok(self, text: str):
        return self.tokenizer.encode(text, add_special_tokens=False)

    def _assistant_body(self, msg):
        content = msg.get("content", "")
        reasoning = msg.get("reasoning_content")
        has_tool_call = "<tool_call>" in (content or "")
        if reasoning is not None and reasoning.strip():
            body = f" thinking\n{reasoning}\n response\n\n{content}"
        elif has_tool_call:
            body = f" thinking\n\n response\n\n{content}"
        else:
            first = " ".join(content.strip().split("\n"))[:60]
            body = f" thinking\n这个问题直接答：{first}\n response\n\n{content}"
        return body

    def __call__(self, features):
        tok = self.tokenizer
        im_s, im_e = self._tok(self.IM_START), self._tok(self.IM_END)
        nl = self._tok("\n")
        batch_ids, batch_labels, batch_attn = [], [], []
        max_allowed = self.max_length

        for f in features:
            ids, labels = [], []
            for msg in f["messages"]:
                role = msg["role"]
                content = msg.get("content", "")
                if role == "system":
                    seg_ids = im_s + self._tok("system") + nl + self._tok(content) + im_e + nl
                    ids.extend(seg_ids); labels.extend([-100] * len(seg_ids))
                elif role == "user":
                    seg_ids = im_s + self._tok("user") + nl + self._tok(content) + im_e + nl
                    ids.extend(seg_ids); labels.extend([-100] * len(seg_ids))
                elif role == "tool":
                    seg_ids = im_s + self._tok("user") + nl + self._tok("<tool_response>\n" + content + "\n</tool_response>") + im_e + nl
                    ids.extend(seg_ids); labels.extend([-100] * len(seg_ids))
                elif role == "assistant":
                    body = self._assistant_body(msg)
                    seg_ids = im_s + self._tok("assistant") + self._tok(body) + im_e + nl
                    # assistant 段计 loss
                    ids.extend(seg_ids); labels.extend(seg_ids)
                else:
                    raise ValueError(f"未知 role: {role}")
            # 截断（右侧），保留至少最后一段 assistant（保证有 loss）
            if len(ids) > max_allowed:
                # 先找最后一个 assistant 起点
                last_asst = -1
                # 找最后的 "<|im_start|>assistant" 标记位置
                for i in range(len(ids) - 1, -1, -1):
                    if i + len(im_s) <= len(ids) and ids[i:i+len(im_s)] == im_s and (i+len(im_s)) < len(ids) and ids[i+len(im_s):i+len(im_s)+len(self._tok("assistant"))] == self._tok("assistant"):
                        last_asst = i
                        break
                cut = max_allowed
                if last_asst >= 0 and last_asst <= len(ids) - 1:
                    # 优先让最后一段 assistant 落下：截断到 assistant 起点的后面一点点（至少留 8 token）
                    start_of_last = last_asst
                    if start_of_last + 8 <= max_allowed:
                        cut = max(start_of_last + 8, max_allowed)
                    else:
                        cut = start_of_last + 8
                if cut > len(ids):
                    cut = len(ids)
                ids = ids[:cut]; labels = labels[:cut]
            batch_ids.append(ids); batch_labels.append(labels)
            batch_attn.append([1] * len(ids))

        max_len = max(len(x) for x in batch_ids)
        pad_id = tok.pad_token_id if tok.pad_token_id is not None else 0
        padded_ids, padded_labels, attn = [], [], []
        for ids, lbs in zip(batch_ids, batch_labels):
            pad_n = max_len - len(ids)
            padded_ids.append(ids + [pad_id] * pad_n)
            padded_labels.append(lbs + [-100] * pad_n)
            attn.append([1] * len(ids) + [0] * pad_n)
        return {
            "input_ids": torch.tensor(padded_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attn, dtype=torch.long),
            "labels": torch.tensor(padded_labels, dtype=torch.long),
        }

def _make_pure_text_config(model_path: str) -> str:
    """为多模态 Qwen3.5 生成一个去除视觉塔的纯文本 config，返回临时 config.json 路径。"""
    cfg_path = os.path.join(model_path, "config.json")
    with open(cfg_path, encoding="utf-8") as f:
        base = json.load(f)
    new_cfg = {
        "architectures": ["Qwen3_5ForCausalLM"],
        "model_type": base.get("model_type", "qwen3_5"),
        "transformers_version": base.get("transformers_version"),
        "text_config": base["text_config"],
    }
    tmp = tempfile.mkdtemp(prefix="puretext_cfg_")
    out = os.path.join(tmp, "config.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(new_cfg, f, ensure_ascii=False, indent=2)
    return out



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-path", default="models/Qwen3.5-9B")
    ap.add_argument("--data-path", default="training/data/train_merged.jsonl")
    ap.add_argument("--output-dir", default="training/output/qwen3.5-9b-dito-lora")
    ap.add_argument("--max-seq-len", type=int, default=2048, help="8GB 只能塞下 ~128（学习无效）；要有效训练 agent 轨迹需 2048+，即 ≥24GB 显存")
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=16)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--max-steps", type=int, default=-1)
    ap.add_argument("--no-quant", action="store_true", help="不量化（8GB 以下不建议）")
    args = ap.parse_args()

    model_path = os.path.abspath(args.model_path)
    data_path = os.path.abspath(args.data_path)

    print(f"模型: {model_path}")
    print(f"数据: {data_path}")

    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # 8GB 显存场景：默认 4bit QLoRA，加载纯文本（去除视觉塔的 config）
    pure_text_config_path = _make_pure_text_config(model_path)

    if args.no_quant:
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            config=pure_text_config_path,
            torch_dtype=torch.bfloat16,
            device_map="auto",
            trust_remote_code=True,
        )
    else:
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            config=pure_text_config_path,
            quantization_config=bnb_config,
            device_map={"": 0},
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
            low_cpu_mem_usage=True,
        )

    print("模型加载完成（纯文本 Qwen3_5ForCausalLM），准备 LoRA...")
    model.config.use_cache = False
    # 注意：不用 prepare_model_for_kbit_training，它会把 lm_head 解量化成 fp32/bf16，
    # 在 8GB 上直接多占 ~2GB 峰值。保持 4bit、只冻结 base、开梯度检查点即可。

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
        ],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    dataset = load_dataset("json", data_files=data_path, split="train")
    train_len = len(dataset)
    print(f"训练样本数: {train_len}")

    collator = ThinkingCollator(tokenizer, max_length=args.max_seq_len)

    training_args = TrainingArguments(
        output_dir=os.path.abspath(args.output_dir),
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=10,
        save_strategy="steps",
        save_steps=200,
        save_total_limit=2,
        bf16=True,
        gradient_checkpointing=False,
        optim="paged_adamw_8bit",
        report_to="none",
        remove_unused_columns=False,
        dataloader_pin_memory=False,
        seed=42,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        data_collator=collator,
    )

    print("开始训练...")
    trainer.train()
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    with open(os.path.join(args.output_dir, "training_config.json"), "w", encoding="utf-8") as f:
        json.dump(vars(args), f, ensure_ascii=False, indent=2)
    print("完成")


if __name__ == "__main__":
    main()