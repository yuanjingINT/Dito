#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 unsloth 正确合并 LoRA 为 16bit HF 模型（供 GGUF/LM Studio）。

unsloth 的 save_pretrained_merged 会处理 4bit base + LoRA 的合并，
避免标准 transformers merge_and_unload 在 unsloth 适配器上的不一致。

用法:
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 UNSLOTH_SKIP_TORCHVISION_CHECK=1 \
    ../.venv-u311/bin/python merge_lora_unsloth.py \
      --model-path ../models/Qwen3.5-0.8B \
      --adapter output/qwen3.5-0.8b-dito-qq-identity3/continue \
      --output-dir merged/qwen3.5-0.8b-dito-qq-identity3
"""
import argparse
import os

import torch
from peft import PeftModel
from transformers import AutoTokenizer
from unsloth import FastLanguageModel


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-path", required=True)
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--max-seq-len", type=int, default=2048)
    args = ap.parse_args()

    model_path = os.path.abspath(args.model_path)
    adapter_path = os.path.abspath(args.adapter)
    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)

    print("加载 base (unsloth 4bit)...")
    model, _ = FastLanguageModel.from_pretrained(
        model_path,
        max_seq_length=args.max_seq_len,
        dtype=None,
        load_in_4bit=True,
        trust_remote_code=True,
    )
    print("加载 LoRA:", adapter_path)
    model = PeftModel.from_pretrained(model, adapter_path)
    FastLanguageModel.for_inference(model)
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    print("合并并保存 16bit 到", output_dir)
    model.save_pretrained_merged(
        output_dir,
        tokenizer=tokenizer,
        save_method="merged_16bit",
        max_shard_size="4GB",
        safe_serialization=True,
    )
    print("完成 ->", output_dir)


if __name__ == "__main__":
    main()
