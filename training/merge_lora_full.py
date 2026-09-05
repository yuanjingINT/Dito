#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 Dito LoRA 合并进 base，导出纯文本 HF 模型（供转 GGUF / LM Studio 用）。

用法:
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv-u311/bin/python merge_lora.py \
      --model-path ../models/Qwen3.5-4B \
      --adapter output/unsloth-dito-qq-identity3/continue \
      --output-dir merged/unsloth-dito-qq-identity3
"""
import argparse
import json
import os
import pathlib
import shutil
import tempfile

import torch
from peft import PeftModel
from transformers import AutoModelForImageTextToText, AutoTokenizer




def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-path", required=True)
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--output-dir", required=True)
    args = ap.parse_args()

    model_path = os.path.abspath(args.model_path)
    adapter_path = os.path.abspath(args.adapter)
    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)

    print("加载 base（完整多模态, bf16, CPU）...")
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    base = AutoModelForImageTextToText.from_pretrained(
        model_path,
        device_map="cpu",
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
        low_cpu_mem_usage=True,
    )
    print("加载 LoRA:", adapter_path)
    model = PeftModel.from_pretrained(base, adapter_path)
    print("合并 LoRA...")
    model = model.merge_and_unload()
    model.eval()

    # 保存纯文本模型
    print("保存到", output_dir)
    model.save_pretrained(output_dir, safe_serialization=True, max_shard_size="4GB")
    tokenizer.save_pretrained(output_dir)

    # 保留原始完整配置（多模态）
    import shutil
    shutil.copy2(os.path.join(model_path, "config.json"), os.path.join(output_dir, "config.json"))

    # 复制 chat template
    src_ct = os.path.join(model_path, "chat_template.jinja")
    if os.path.exists(src_ct):
        shutil.copy2(src_ct, os.path.join(output_dir, "chat_template.jinja"))
    # 如果有 generation_config 也复制
    src_gc = os.path.join(model_path, "generation_config.json")
    if os.path.exists(src_gc):
        shutil.copy2(src_gc, os.path.join(output_dir, "generation_config.json"))
    for name in ("preprocessor_config.json", "video_preprocessor_config.json"):
        src = os.path.join(model_path, name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(output_dir, name))

    print("完成 ->", output_dir)


if __name__ == "__main__":
    main()
