#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建「身份强化」续训数据集。

目标：修复两个 dito 模型「不知道自己是谁」（问了会答成通义千问/Qwen）的问题。

做法：
- 大量「无 system prompt」的身份问答（这是关键，模型不能依赖 system 段才知道自己是谁）
- 加入「带 system prompt」的 dito 人设闲聊，保住闲聊/专业/梗能力不被冲掉
- 身份样本重复权重高，确保在总数据里占主导，强覆盖掉 base 模型的默认自报身份
"""
import json
import pathlib
import random

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "data"
OUT.mkdir(parents=True, exist_ok=True)

IDENTITY_IDENTITY = OUT / "identity_fix_large.jsonl"   # 53 条无 system 身份 QA
DITO_BASE = ROOT / "dataset" / "dist" / "dito_sft_chatml.jsonl"  # 356 条带 system

IDENTITY_REPEAT = 8         # 每条身份样本重复 8 次（大幅提高权重）
DITO_SAMPLE = 240           # 从带 system 的 dito 数据里抽一部分保住技能
DITO_REPEAT = 1
SEED = 42


def load_jsonl(p):
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def main():
    rng = random.Random(SEED)

    identity = load_jsonl(IDENTITY_IDENTITY)
    dito_all = load_jsonl(DITO_BASE)

    # 身份样本：每个重复，标记 source
    id_rows = []
    for it in identity:
        for _ in range(IDENTITY_REPEAT):
            row = {"messages": [dict(m) for m in it["messages"]],
                   "meta": {"source": "identity", "category": "identity"}}
            # 去掉可能存在的 reasoning（身份题不需要长思考，保持短答）
            for m in row["messages"]:
                m.pop("reasoning_content", None)
            id_rows.append(row)

    # 抽样 dito 带 system 数据（保持技能），去掉 reasoning
    dito_sel = rng.sample(dito_all, min(DITO_SAMPLE, len(dito_all)))
    dito_rows = []
    for it in dito_sel:
        row = {"messages": [dict(m) for m in it["messages"]],
               "meta": {"source": "dito_keep", "category": it.get("meta", {}).get("category", "")}}
        for m in row["messages"]:
            m.pop("reasoning_content", None)
        dito_rows.append(row)

    rows = id_rows + dito_rows
    rng.shuffle(rows)

    # 打乱时确保开头出现身份样本（前 1/4 全放身份，让模型优先学）
    # 直接把前 1/4 固定成身份样本
    n_id = len(id_rows)
    keep = int(len(rows) * 0.25)
    head = rng.sample(id_rows, min(keep, n_id))
    rest = [r for r in rows if id(r) not in [id(h) for h in head]]
    rows = head + rest
    rng.shuffle(rows)  # 再整体打乱，避免顺序偏差

    with open(OUT / "dito_identity_retrain.jsonl", "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    # 统计
    from collections import Counter
    src = Counter(r["meta"]["source"] for r in rows)
    print("样本总数:", len(rows))
    print("构成:", dict(src))
    print("身份占比: %.1f%%" % (100.0 * src.get("identity", 0) / len(rows)))
    print("写出 ->", OUT / "dito_identity_retrain.jsonl")


if __name__ == "__main__":
    main()
