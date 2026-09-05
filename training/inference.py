#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""加载训练好的 LoRA 跑一次 Dito 对话。

用法:
  python3 inference.py \
    --model-path ../models/Qwen3.5-9B \
    --adapter-path output/qwen3.5-9b-dito-lora \
    --question "你好"
"""
import argparse
import pathlib
import sys

import torch
from peft import PeftModel
from transformers import AutoModelForImageTextToText, AutoTokenizer

ROOT = pathlib.Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-path", default="models/Qwen3.5-9B")
    ap.add_argument("--adapter-path", required=True)
    ap.add_argument("--question", default="你好")
    args = ap.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.model_path, trust_remote_code=True, padding_side="left")
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    base = AutoModelForImageTextToText.from_pretrained(
        args.model_path,
        device_map="auto",
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    )
    model = PeftModel.from_pretrained(base, args.adapter_path)
    model.eval()

    system_prompt = (ROOT.parent / "dataset" / "system_prompt.txt").read_text(encoding="utf-8").strip()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": args.question},
    ]
    inputs = tokenizer.apply_chat_template(
        messages, tokenize=True, return_tensors="pt", add_generation_prompt=True
    ).to(model.device)

    with torch.no_grad():
        out = model.generate(
            inputs,
            max_new_tokens=512,
            do_sample=True,
            top_p=0.9,
            temperature=0.7,
            repetition_penalty=1.05,
        )
    generated = out[0][inputs.shape[-1]:]
    print(tokenizer.decode(generated, skip_special_tokens=True))


if __name__ == "__main__":
    main()