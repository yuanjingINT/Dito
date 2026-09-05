#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""根据 dito system_prompt 生成「身份 + 说话方式」强化续训数据。

数据来源：
- dataset/dist/dito_identity_nosys.jsonl   -> 无 system 身份/风格（129 条，重复 6 次）
- dataset/dist/dito_sft_chatml.jsonl       -> 带 system 的完整 dito 数据（466 条，重复 1 次）
"""
import json
import pathlib
import random

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "data"
OUT.mkdir(parents=True, exist_ok=True)

NOSYS = ROOT / "dataset" / "dist" / "dito_identity_nosys.jsonl"
SYS = ROOT / "dataset" / "dist" / "dito_sft_chatml.jsonl"
NOSYS_REPEAT = 6
SEED = 42


def load_jsonl(p):
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def main():
    rng = random.Random(SEED)
    nosys = load_jsonl(NOSYS)
    sys_rows = load_jsonl(SYS)

    rows = []
    for it in nosys:
        for _ in range(NOSYS_REPEAT):
            row = {"messages": [dict(m) for m in it["messages"]],
                   "meta": {"source": "prompt_style", "category": "prompt_style"}}
            for m in row["messages"]:
                m.pop("reasoning_content", None)
            rows.append(row)

    # 带 system 的完整 dito 数据每条一份，保住原有任务能力
    for it in sys_rows:
        row = {"messages": [dict(m) for m in it["messages"]],
               "meta": {"source": "dito_full", "category": it.get("meta", {}).get("category", "")}}
        for m in row["messages"]:
            m.pop("reasoning_content", None)
        rows.append(row)

    rng.shuffle(rows)
    with open(OUT / "dito_identity_style_retrain.jsonl", "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    from collections import Counter
    src = Counter(r["meta"]["source"] for r in rows)
    print("样本总数:", len(rows))
    print("构成:", dict(src))
    print("无system身份/风格占比: %.1f%%" % (100.0 * src.get("prompt_style", 0) / len(rows)))
    print("写出 ->", OUT / "dito_identity_style_retrain.jsonl")


if __name__ == "__main__":
    main()
