#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""unsloth 低内存模型 + 自定义训练循环（绕开 trl/transformers Trainer 的 bug）。

unsloth 的 model 做了梯度 offload / 双缓冲，8GB 可跑 seq 2048。
但 unsloth 这版对 Qwen3.5-4B 的 Trainer 数据处理有 bug（Qwen3VLProcessor.encode 缺失），
所以这里用自定义循环，只借用 unsloth 的低内存模型。

用法:
  UNSLOTH_SKIP_TORCHVISION_CHECK=1 .venv-u311/bin/python train_unsloth_manual.py \
    --max-steps 500 --max-seq-len 2048
"""
import argparse
import json
import os
import random

import torch
from tqdm import tqdm
from unsloth import FastLanguageModel
from train_qlora import ThinkingCollator

DEFAULT_MODEL = "/home/yuanjing/Documents/vibe codeing/Dito/models/Qwen3.5-4B"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-path", default=DEFAULT_MODEL)
    ap.add_argument("--data-path", default="data/train_merged.jsonl")
    ap.add_argument("--output-dir", default="output/unsloth-dito-lora")
    ap.add_argument("--max-seq-len", type=int, default=2048)
    ap.add_argument("--max-steps", type=int, default=500)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=16)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--save-every", type=int, default=50)
    ap.add_argument("--from-adapter", default=None, help="续训已有 LoRA adapter，用于 dito4b 后训练")
    args = ap.parse_args()

    model_path = os.path.abspath(args.model_path)
    print("加载模型 (unsloth 4bit, seq=%d)..." % args.max_seq_len)
    print("模型路径:", model_path)
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=model_path,
        max_seq_length=args.max_seq_len,
        dtype=None,
        load_in_4bit=True,
        trust_remote_code=True,
    )
    if args.from_adapter:
        print("续训已有 LoRA:", args.from_adapter)
        model = FastLanguageModel.get_peft_model(
            model,
            r=args.lora_r,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            lora_alpha=args.lora_alpha,
            lora_dropout=0.0,
            bias="none",
            use_gradient_checkpointing="unsloth",
            random_state=42,
        )
        # 用旧 adapter 覆盖新建的 default，并只保留旧权重作为活动 adapter
        model.load_adapter(os.path.abspath(args.from_adapter), adapter_name="continue", is_trainable=True)
        model.set_adapter("continue")
        model.delete_adapter("default")
    else:
        model = FastLanguageModel.get_peft_model(
            model,
            r=args.lora_r,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            lora_alpha=args.lora_alpha,
            lora_dropout=0.0,
            bias="none",
            use_gradient_checkpointing="unsloth",
            random_state=42,
        )
    # unsloth 返回 Qwen3VLProcessor（无 .encode）；collator 需要标准 AutoTokenizer
    from transformers import AutoTokenizer
    collator_tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    collator_tokenizer.padding_side = "right"
    collator_tokenizer.model_max_length = args.max_seq_len
    if collator_tokenizer.pad_token is None:
        collator_tokenizer.pad_token = collator_tokenizer.eos_token

    # 数据
    with open(args.data_path, encoding="utf-8") as f:
        rows = [json.loads(l) for l in f if l.strip()]
    print("训练样本:", len(rows))
    collator = ThinkingCollator(collator_tokenizer, max_length=args.max_seq_len)

    # 只训练 LoRA 参数
    trainable = [p for p in model.parameters() if p.requires_grad]
    print("可训练参数数:", sum(p.numel() for p in trainable))
    optim = torch.optim.AdamW(trainable, lr=args.lr, weight_decay=0.0)
    lr_scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optim, T_max=args.max_steps)

    model.train()
    step = 0
    accum = 0
    optim.zero_grad()
    os.makedirs(args.output_dir, exist_ok=True)

    bar = tqdm(total=args.max_steps)
    while step < args.max_steps:
        random.shuffle(rows)
        for row in rows:
            try:
                batch = collator([{"messages": row["messages"]}])
            except Exception as e:
                print("collator 失败，跳过:", e)
                continue
            inputs = {k: v.to(model.device) for k, v in batch.items()}
            out = model(**inputs)
            loss = out.loss
            if loss is None or torch.isnan(loss):
                print("loss 无效，跳过", float(loss) if loss is not None else "None")
                continue
            loss = loss / args.grad_accum
            loss.backward()
            accum += 1
            if accum >= args.grad_accum:
                torch.nn.utils.clip_grad_norm_(trainable, 1.0)
                optim.step()
                lr_scheduler.step()
                optim.zero_grad()
                accum = 0
                step += 1
                bar.update(1)
                bar.set_postfix(loss=float(loss * args.grad_accum))
                if step % args.save_every == 0 or step == args.max_steps:
                    save_dir = os.path.join(args.output_dir, f"checkpoint-{step}")
                    model.save_pretrained(save_dir)
                    print(f"\n已保存 {save_dir}")
                if step >= args.max_steps:
                    break
    bar.close()
    model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print("完成 ->", args.output_dir)


if __name__ == "__main__":
    main()