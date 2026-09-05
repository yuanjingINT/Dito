#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dito 提示词全量强化续训集：身份/规则/风格/喜好/关系/事实 + 少量 MS agent 保能力。

- dataset/dist/dito_identity_nosys.jsonl : 无 system 全量提示词（205 条，重复 8 次）
- dataset/dist/dito_sft_chatml.jsonl     : 带 system 全量 dito 数据（545 条）
- data/msagent_dito_agent.jsonl          : 抽样 500 条 agent，避免丢失工具能力
"""
import json
import pathlib
import random

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "data"

NOSYS = ROOT / "dataset" / "dist" / "dito_identity_nosys.jsonl"
SYS = ROOT / "dataset" / "dist" / "dito_sft_chatml.jsonl"
AGENT = OUT / "msagent_dito_agent.jsonl"
TARGET = OUT / "dito_prompt_full_retrain.jsonl"
NOSYS_REPEAT = 8
AGENT_SAMPLE = 500
SEED = 42


def load(p):
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def main():
    rng = random.Random(SEED)
    nosys = load(NOSYS)
    sys_rows = load(SYS)
    agent = rng.sample(load(AGENT), min(AGENT_SAMPLE, len(load(AGENT))))

    rows = []
    for it in nosys:
        for _ in range(NOSYS_REPEAT):
            row = {"messages": [dict(m) for m in it["messages"]],
                   "meta": {"source": "prompt_full_nosys", "category": "prompt_full"}}
            rows.append(row)
    for it in sys_rows:
        row = {"messages": [dict(m) for m in it["messages"]],
               "meta": {"source": "dito_full_sys", "category": it.get("meta", {}).get("category", "")}}
        rows.append(row)
    for it in agent:
        row = {"messages": [dict(m) for m in it["messages"]],
               "meta": {"source": "msagent_dito", "tool": it.get("meta", {}).get("tool", "")}}
        rows.append(row)
    rng.shuffle(rows)

    with open(TARGET, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    from collections import Counter
    print("总样本:", len(rows))
    print("构成:", dict(Counter(r["meta"]["source"] for r in rows)))
    print("写出 ->", TARGET)


if __name__ == "__main__":
    main()
