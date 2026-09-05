#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dito-27B 全量微调脚本（DSW 大显存实例用）
- 全参数 bf16 微调（不是 LoRA），适合 200GB+ 显存
- 使用 8-bit AdamW 控制优化器内存
- 数据：Dito 人格 + Arch Wiki + 网络梗 + 地理 + Agent 工具调用
"""
import argparse
import json
import os
import random

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import torch
from datasets import Dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    Trainer,
    TrainingArguments,
)


class ThinkingCollator:
    IM_START = "<|im_start|>"
    IM_END = "<|im_end|>"

    def __init__(self, tokenizer, max_length=2048):
        self.tokenizer = tokenizer
        self.max_length = max_length

    def _t(self, s):
        return self.tokenizer.encode(s, add_special_tokens=False)

    def _assistant_body(self, m):
        content = m.get("content", "")
        reasoning = m.get("reasoning_content")
        if reasoning and reasoning.strip():
            return f" thinking\n{reasoning}\n response\n\n{content}"
        if "<tool_call>" in content:
            return f" thinking\n\n response\n\n{content}"
        first = " ".join(content.strip().split("\n"))[:60]
        return f" thinking\n这个问题直接答：{first}\n response\n\n{content}"

    def __call__(self, features):
        tok = self.tokenizer
        im_s, im_e = self._t(self.IM_START), self._t(self.IM_END)
        nl = self._t("\n")
        ids_list, lbs_list = [], []
        for f in features:
            ids, lbs = [], []
            for msg in f["messages"]:
                role = msg["role"]
                content = msg.get("content", "")
                if role == "system":
                    seg = im_s + self._t("system") + nl + self._t(content) + im_e + nl
                    ids += seg
                    lbs += [-100] * len(seg)
                elif role == "user":
                    seg = im_s + self._t("user") + nl + self._t(content) + im_e + nl
                    ids += seg
                    lbs += [-100] * len(seg)
                elif role == "tool":
                    seg = im_s + self._t("user") + nl + self._t("<tool_response>\n" + content + "\n</tool_response>") + im_e + nl
                    ids += seg
                    lbs += [-100] * len(seg)
                elif role == "assistant":
                    seg = im_s + self._t("assistant") + self._t(self._assistant_body(msg)) + im_e + nl
                    ids += seg
                    lbs += seg
            if len(ids) > self.max_length:
                # 保留尾部（最后一段 assistant + 最近的上下文），避免长样本把答案截掉
                ids = ids[-self.max_length:]
                lbs = lbs[-self.max_length:]
            ids_list.append(ids)
            lbs_list.append(lbs)
        M = max(len(x) for x in ids_list)
        pad = tok.pad_token_id or 0
        return {
            "input_ids": torch.tensor([x + [pad] * (M - len(x)) for x in ids_list], dtype=torch.long),
            "attention_mask": torch.tensor([[1] * len(x) + [0] * (M - len(x)) for x in ids_list], dtype=torch.long),
            "labels": torch.tensor([x + [-100] * (M - len(x)) for x in lbs_list], dtype=torch.long),
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-path", default="/mnt/workspace/models/Qwen3.8-27B")
    ap.add_argument("--data-path", default="/mnt/workspace/train_full_27b.jsonl")
    ap.add_argument("--output-dir", default="/mnt/workspace/output/dito-27b-full")
    ap.add_argument("--seq-len", type=int, default=2048)
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=16)
    ap.add_argument("--save-steps", type=int, default=2000)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--max-rows", type=int, default=0)
    ap.add_argument("--resume", default="")
    args = ap.parse_args()

    print("GPU:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU")
    print("VRAM GB:", torch.cuda.get_device_properties(0).total_memory / 1e9 if torch.cuda.is_available() else 0)

    rows = []
    with open(args.data_path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    if args.max_rows:
        random.seed(42)
        random.shuffle(rows)
        rows = rows[: args.max_rows]
    print("训练样本:", len(rows), flush=True)

    tokenizer = AutoTokenizer.from_pretrained(args.model_path, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    tokenizer.model_max_length = args.seq_len

    print("加载全量 bf16 模型 ...", flush=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model_path,
        device_map="auto",
        trust_remote_code=True,
        dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )
    model.config.use_cache = False
    model.gradient_checkpointing_enable()
    print("可训练参数:", sum(p.numel() for p in model.parameters() if p.requires_grad) / 1e9, "B", flush=True)

    collator = ThinkingCollator(tokenizer, max_length=args.seq_len)
    dataset = Dataset.from_list(rows)

    max_steps = args.max_steps if args.max_steps > 0 else -1
    train_args = TrainingArguments(
        output_dir=args.output_dir,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        max_steps=max_steps,
        learning_rate=args.lr,
        bf16=True,
        optim="adamw_bnb_8bit",
        logging_steps=1,
        save_strategy="steps",
        save_steps=args.save_steps,
        save_total_limit=2,
        report_to="none",
        remove_unused_columns=False,
        dataloader_pin_memory=False,
        gradient_checkpointing=True,
    )
    trainer = Trainer(
        model=model,
        args=train_args,
        data_collator=collator,
        train_dataset=dataset,
    )
    resume = args.resume if args.resume else None
    trainer.train(resume_from_checkpoint=resume)
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print("完成 ->", args.output_dir)


if __name__ == "__main__":
    main()
