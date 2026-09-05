#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""基于 unsloth 的 Dito + Linux agent QLoRA 训练。

unsloth 针对低显存 Blackwell 卡（RTX 50 系列）做了大量省显存优化，
实测本机 8GB 显存可跑 seq 2048 的 4B 完整训练（裸 transformers 只能 128）。

用法:
  UNSLOTH_SKIP_TORCHVISION_CHECK=1 .venv-unsloth/bin/python train_unsloth.py \
      --data-path data/train_merged.jsonl --max-seq-len 2048 --max-steps 500
"""
import argparse
import json
import os

import torch
from transformers import Trainer, TrainingArguments
from unsloth import FastLanguageModel, is_bfloat16_supported
from train_qlora import ThinkingCollator  # 复用已修复的 assistant-only collator

MODEL = "/home/yuanjing/Documents/vibe codeing/Dito/models/Qwen3.5-4B"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-path", default="data/train_merged.jsonl")
    ap.add_argument("--output-dir", default="output/unsloth-dito-lora")
    ap.add_argument("--max-seq-len", type=int, default=2048)
    ap.add_argument("--max-steps", type=int, default=500)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=16)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--save-steps", type=int, default=50)
    args = ap.parse_args()

    print(f"数据库: {args.data_path}, seq={args.max_seq_len}, steps={args.max_steps}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=MODEL,
        max_seq_length=args.max_seq_len,
        dtype=None,
        load_in_4bit=True,
        trust_remote_code=True,
    )
    tokenizer.model_max_length = args.max_seq_len
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_r,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=42,
        use_rslora=False,
        loftq_config=None,
    )
    print("LoRA 已构建")

    import json as _json
    from datasets import Dataset
    rows = []
    with open(args.data_path, encoding="utf-8") as fh:
        for line in fh:
            rows.append(_json.loads(line))
    dataset = Dataset.from_list(rows)

    training_args = TrainingArguments(
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        max_steps=args.max_steps,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=5,
        save_strategy="steps",
        save_steps=args.save_steps,
        save_total_limit=3,
        output_dir=args.output_dir,
        optim="adamw_8bit",
        bf16=is_bfloat16_supported(),
        report_to="none",
        remove_unused_columns=False,
        dataloader_pin_memory=False,
        dataloader_num_workers=0,
        seed=42,
        gradient_checkpointing=True,
    )

    collator = ThinkingCollator(tokenizer, max_length=args.max_seq_len)
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        data_collator=collator,
    )
    print("开始训练...")
    trainer.train()
    model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print("完成: ", args.output_dir)


if __name__ == "__main__":
    main()