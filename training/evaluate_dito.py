#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""评测两个 dito 模型：身份认知 + 闲聊 + Linux专业 + 热梗。

用法 (每次加载一个模型，因为 8GB 显卡只能放一个):
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 UNSLOTH_SKIP_TORCHVISION_CHECK=1 \
    .venv-u311/bin/python evaluate_dito.py \
      --model-path ../models/Qwen3.5-4B \
      --adapter output/unsloth-dito-qq-identity3 \
      --out /tmp/eval_4b.md
"""
import argparse
import pathlib
import sys

import torch
from peft import PeftModel
from transformers import AutoTokenizer
from unsloth import FastLanguageModel

ROOT = pathlib.Path(__file__).resolve().parent
SYS = (ROOT.parent / "dataset" / "system_prompt.txt").read_text(encoding="utf-8").strip()

# (分组, 问题, 是否带 system prompt)
TESTS = [
    ("身份·无system", "你是谁", False),
    ("身份·无system", "你是什么模型", False),
    ("身份·无system", "你是通义千问吗", False),
    ("身份·无system", "介绍一下你自己", False),
    ("身份·无system", "你的名字是什么", False),
    ("身份·带system", "你是谁", True),
    ("身份·带system", "你是什么模型", True),
    ("身份·带system", "介绍一下你自己", True),
    ("闲聊", "早啊 今天咋样", True),
    ("专业·Arch", "arch更新报错说key无效怎么解决", True),
    ("热梗", "666是什么意思", True),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-path", required=True)
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--out", default="/tmp/dito_eval.md")
    ap.add_argument("--tag", default="")
    ap.add_argument("--max-new", type=int, default=240)
    args = ap.parse_args()

    tok = AutoTokenizer.from_pretrained(args.model_path, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model, _ = FastLanguageModel.from_pretrained(
        args.model_path, max_seq_length=2048, dtype=torch.bfloat16,
        load_in_4bit=True, trust_remote_code=True,
    )
    model = PeftModel.from_pretrained(model, args.adapter)
    FastLanguageModel.for_inference(model)

    lines = []
    title = f"# Dito 评测{' · ' + args.tag if args.tag else ''}\n\n- 模型: {args.model_path}\n- Adapter: {args.adapter}\n"
    lines.append(title)

    for group, q, use_sys in TESTS:
        msgs = []
        if use_sys:
            msgs.append({"role": "system", "content": SYS})
        msgs.append({"role": "user", "content": q})
        inp = tok.apply_chat_template(msgs, tokenize=True, return_tensors="pt",
                                      add_generation_prompt=True).to(model.device)
        attn = inp.new_ones(inp.shape)
        with torch.no_grad():
            try:
                out = model.generate(input_ids=inp, attention_mask=attn,
                                     max_new_tokens=args.max_new, do_sample=True,
                                     temperature=0.7, top_p=0.9, repetition_penalty=1.15)
                ans = tok.decode(out[0][inp.shape[-1]:], skip_special_tokens=True).strip()
            except Exception as e:
                ans = f"[生成出错] {e}"
        lines.append(f"\n## {group} — {q}\n\n{ans}\n")

    text = "\n".join(lines)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(text)
    print(text)


if __name__ == "__main__":
    main()
