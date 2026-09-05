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
from transformers import AutoModelForCausalLM, AutoTokenizer


def make_pure_text_config(model_path):
    """生成一个去掉视觉塔的纯文本 config，返回 (config_dict, tmp_config_path)。"""
    cfg = json.load(open(os.path.join(model_path, "config.json"), encoding="utf-8"))
    new_cfg = {
        "architectures": ["Qwen3_5ForCausalLM"],
        "model_type": cfg.get("model_type", "qwen3_5"),
        "transformers_version": cfg.get("transformers_version"),
        "text_config": cfg["text_config"],
    }
    tmp = tempfile.mkdtemp(prefix="merge_cfg_")
    out = os.path.join(tmp, "config.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(new_cfg, f, ensure_ascii=False, indent=2)
    return new_cfg, out


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

    cfg_dict, cfg_path = make_pure_text_config(model_path)
    print("加载 base（纯文本, bf16, CPU）...")
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    base = AutoModelForCausalLM.from_pretrained(
        model_path,
        config=cfg_path,
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

    # 把纯文本 config 写进去（合并后 save_pretrained 可能带 architecture，确认）
    with open(os.path.join(output_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg_dict, f, ensure_ascii=False, indent=2)

    # 复制 chat template
    src_ct = os.path.join(model_path, "chat_template.jinja")
    if os.path.exists(src_ct):
        shutil.copy2(src_ct, os.path.join(output_dir, "chat_template.jinja"))
    # 如果有 generation_config 也复制
    src_gc = os.path.join(model_path, "generation_config.json")
    if os.path.exists(src_gc):
        shutil.copy2(src_gc, os.path.join(output_dir, "generation_config.json"))

    print("完成 ->", output_dir)


if __name__ == "__main__":
    main()
