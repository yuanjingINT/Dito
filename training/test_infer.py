#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""加载训练的 LoRA 做推理测试（纯文本方式）。

用法: python3 test_infer.py --adapter <adapter目录> --question "你好"
"""
import argparse
import json
import os
import tempfile

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_BASE = "/home/yuanjing/Documents/vibe codeing/Dito/models/Qwen3.5-4B"
SYSTEM_PATH = "/home/yuanjing/Documents/vibe codeing/Dito/dataset/system_prompt.txt"


def make_pure_text_config(model_path):
    cfg = json.load(open(os.path.join(model_path, "config.json")))
    new_cfg = {
        "architectures": ["Qwen3_5ForCausalLM"],
        "model_type": cfg.get("model_type", "qwen3_5"),
        "transformers_version": cfg.get("transformers_version"),
        "text_config": cfg["text_config"],
    }
    tmp = tempfile.mkdtemp(prefix="infer_cfg_")
    out = os.path.join(tmp, "config.json")
    json.dump(new_cfg, open(out, "w"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--question", default="你好")
    ap.add_argument("--tool", action="store_true", help="附带工具调用测试")
    args = ap.parse_args()

    cfg = make_pure_text_config(MODEL_BASE)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_BASE, trust_remote_code=True)
    base = AutoModelForCausalLM.from_pretrained(
        MODEL_BASE, config=cfg, device_map="auto",
        torch_dtype=torch.bfloat16, trust_remote_code=True, low_cpu_mem_usage=True,
    )
    model = PeftModel.from_pretrained(base, args.adapter)
    model.eval()

    system_prompt = open(SYSTEM_PATH).read().strip()
    msgs = [{"role": "system", "content": system_prompt}]
    if args.tool:
        msgs[0] = {"role": "system", "content": system_prompt + "\n你有 bash 工具，用 <tool_call><function=bash>...</function></tool_call> 调用"}
    msgs.append({"role": "user", "content": args.question})

    inputs = tokenizer.apply_chat_template(
        msgs, tokenize=True, return_tensors="pt", add_generation_prompt=True,
        enable_thinking=False
    ).to(model.device)
    with torch.no_grad():
        out = model.generate(
            inputs, max_new_tokens=400, do_sample=True, top_p=0.9, temperature=0.7,
            repetition_penalty=1.05,
        )
    gen = out[0][inputs.shape[-1]:]
    print(tokenizer.decode(gen, skip_special_tokens=True))


if __name__ == "__main__":
    main()