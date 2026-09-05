#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 agent 轨迹样本转成 JSONL，并验证渲染。

输出: dist/agent_sft.jsonl
验证: 用真实 tokenizer 渲染每条，打印 tool 结构，确认格式合法。

用法: python3 build_agent_data.py [--preview N]
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
DIST = HERE / "dist"
DIST.mkdir(exist_ok=True)
sys.path.insert(0, str(HERE))

from agent_samples import SAMPLES

try:
    from agent_samples_extra import EXTRA_SAMPLES
except Exception:
    EXTRA_SAMPLES = []


def main():
    all_samples = list(SAMPLES) + list(EXTRA_SAMPLES)
    out = HERE.parent / "data" / "agent_sft.jsonl"
    out.parent.mkdir(exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for s in all_samples:
            row = {
                "messages": s["messages"],
                "meta": {"source": "agent", "id": s["id"], "task": s.get("task", "")},
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"写入 {len(all_samples)} 条 -> {out}")

    # 校验结构
    from transformers import AutoTokenizer
    try:
        tok = AutoTokenizer.from_pretrained("../models/Qwen3.5-4B", trust_remote_code=True)
    except Exception:
        tok = None
    preview = 1 if "--preview" not in sys.argv else int(sys.argv[sys.argv.index("--preview") + 1])
    if tok is not None:
        for s in SAMPLES[:preview]:
            text = tok.apply_chat_template(s["messages"], tokenize=False, add_generation_prompt=False)
            print("\n===== 样本:", s["id"], "=====")
            print(text[:1500])
            print("...")


if __name__ == "__main__":
    main()