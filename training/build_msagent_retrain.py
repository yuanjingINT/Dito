#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 Dito 身份/说话方式数据 与 MSAgent-Pro 转换后的 agent 数据合并成续训集。

- dito_identity_style_retrain.jsonl : 1240（身份/风格 774 + 完整 dito 466）
- msagent_dito_agent.jsonl         : 3000（Dito 风格中文思维链 + XML 工具调用）
"""
import json
import pathlib
import random

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "data"

STYLE = OUT / "dito_identity_style_retrain.jsonl"
AGENT = OUT / "msagent_dito_agent.jsonl"
TARGET = OUT / "dito_identity_style_msagent_retrain.jsonl"
AGENT_KEEP = 2000
SEED = 7


def load(p):
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def main():
    rng = random.Random(SEED)
    style = load(STYLE)
    agent_all = load(AGENT)
    agent = rng.sample(agent_all, min(AGENT_KEEP, len(agent_all)))

    rows = []
    for r in style:
        row = {"messages": [dict(m) for m in r["messages"]],
               "meta": {"source": "dito_style", "category": r.get("meta", {}).get("category", "")}}
        rows.append(row)
    for r in agent:
        row = {"messages": [dict(m) for m in r["messages"]],
               "meta": {"source": "msagent_dito", "tool": r.get("meta", {}).get("tool", "")}}
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
