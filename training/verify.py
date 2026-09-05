#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""训练完成后，验证 Dito 模型效果。

用法 (Python 3.11 unsloth 环境):
  UNSLOTH_SKIP_TORCHVISION_CHECK=1 .venv-u311/bin/python verify.py [--adapter output/unsloth-dito-lora]

测试:
  1. Dito 闲聊（语气、无emoji、口语化）
  2. Linux 专业回答（Arch 排障、把握度）
  3. agent 工具调用格式（<tool_call>）
"""
import argparse
import sys

import torch
from peft import PeftModel
from transformers import AutoTokenizer
from unsloth import FastLanguageModel

DEFAULT_MODEL = "/home/yuanjing/Documents/vibe codeing/Dito/models/Qwen3.5-4B"
SYS = open("/home/yuanjing/Documents/vibe codeing/Dito/dataset/system_prompt.txt", encoding="utf-8").read().strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-path", default=DEFAULT_MODEL)
    ap.add_argument("--adapter", default="output/unsloth-dito-lora")
    args = ap.parse_args()

    model_path = args.model_path
    tok = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model, _ = FastLanguageModel.from_pretrained(
        model_path, max_seq_length=2048, dtype=torch.bfloat16, load_in_4bit=True, trust_remote_code=True
    )
    model = PeftModel.from_pretrained(model, args.adapter)
    FastLanguageModel.for_inference(model)

    def ask(sys_prompt, user_msg, tool=False):
        msgs = [{"role": "system", "content": sys_prompt}]
        if tool:
            msgs[0] = {"role": "system", "content": sys_prompt + "\n你有 bash 工具，需要操作时用 <tool_call><function=bash><parameter=command>命令</parameter></function></tool_call> 调用"}
        msgs.append({"role": "user", "content": user_msg})
        inputs = tok.apply_chat_template(
            msgs, tokenize=True, return_tensors="pt", add_generation_prompt=True
        ).to(model.device)
        attention_mask = inputs.new_ones(inputs.shape)
        with torch.no_grad():
            out = model.generate(
                input_ids=inputs, attention_mask=attention_mask,
                max_new_tokens=300, do_sample=True, temperature=0.7, top_p=0.9,
                repetition_penalty=1.05,
            )
        return tok.decode(out[0][inputs.shape[-1]:], skip_special_tokens=True)

    print("=" * 40, "① Dito 闲聊", "=" * 40)
    print("Q: 早啊，今天咋样")
    print("A:", ask(SYS, "早啊，今天咋样"))
    print()
    print("=" * 40, "② Linux 专业", "=" * 40)
    print("Q: arch更新报错key无效怎么办")
    print("A:", ask(SYS, "arch更新报错说key无效，怎么解决"))
    print()
    print("=" * 40, "③ agent 工具调用", "=" * 40)
    print("Q: 帮我看看磁盘空间够不够")
    print("A:", ask(SYS, "帮我看看磁盘空间够不够，满了就清理", tool=True))


if __name__ == "__main__":
    main()