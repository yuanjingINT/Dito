#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重建训练数据：dito（含 QQ 聊天 + 互联网知识）/ archwiki / meme / agent / 中文思维链工具调用。

输出:
  training/data/train_merged_with_reasoning.jsonl  # 人格/知识基座（含 reasoning_content）
  training/data/train_merged.jsonl                 # 最终训练集（基座 + agent + cot）
  training/data/train_merged_stats.json
"""
import json
import pathlib
import random
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "data"
OUT.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(HERE))

from add_reasoning import add_reasoning_to_rows  # noqa: E402

# 权重：来源 -> 采样上限
MAX_PER_SOURCE = {
    "dito": 1000,
    "identity_nosys": 200,
    "archwiki": 1200,
    "meme_qa": 100,
    "meme_usage": 100,
    "agent": 300,          # 原有 Linux 工具轨迹
    "agent_cot": 3000,     # 中文思维链 + 工具调用（重点增强 agent，给足量）
}


def load_jsonl(path: pathlib.Path):
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def sample(items, limit, seed):
    if not items:
        return []
    return random.Random(seed).sample(items, min(limit, len(items)))


def main():
    random.seed(42)
    stats = {}

    # 1) 人格 / QQ 聊天 / 互联网知识（dataset/dist，system prompt 已统一）
    dito_items = load_jsonl(ROOT / "dataset" / "dist" / "dito_sft_chatml.jsonl")
    limit = MAX_PER_SOURCE["dito"]
    dito_selected = sample(dito_items, limit, 42)
    for item in dito_selected:
        meta = dict(item.get("meta", {}))
        meta["source"] = "dito"
        meta["_dito_category"] = meta.get("category", "")
        item["meta"] = meta
    stats["dito"] = {"total": len(dito_items), "selected": len(dito_selected)}

    # 1.5) 无 system 的身份强化（防止自报通义千问）
    identity_items = load_jsonl(ROOT / "dataset" / "dist" / "dito_identity_nosys.jsonl")
    identity_selected = sample(identity_items, MAX_PER_SOURCE["identity_nosys"], 42)
    for item in identity_selected:
        meta = dict(item.get("meta", {}))
        meta["source"] = "identity_nosys"
        item["meta"] = meta
    stats["identity_nosys"] = {"total": len(identity_items), "selected": len(identity_selected)}

    # 2) Arch Wiki QA（本地知识）
    arch_items = load_jsonl(ROOT / "archwiki" / "dist" / "archwiki_qa.jsonl")
    arch_selected = sample(arch_items, MAX_PER_SOURCE["archwiki"], 42)
    for item in arch_selected:
        meta = dict(item.get("meta", {}))
        meta["source"] = "archwiki"
        item["meta"] = meta
    stats["archwiki"] = {"total": len(arch_items), "selected": len(arch_selected)}

    # 3) 互联网热梗解释 / 接梗（meme）
    meme_qa_items = load_jsonl(ROOT / "memes" / "dist" / "meme_qa.jsonl")
    meme_qa_selected = sample(meme_qa_items, MAX_PER_SOURCE["meme_qa"], 42)
    for item in meme_qa_selected:
        meta = dict(item.get("meta", {}))
        meta["source"] = "meme_qa"
        item["meta"] = meta
    stats["meme_qa"] = {"total": len(meme_qa_items), "selected": len(meme_qa_selected)}

    meme_usage_items = load_jsonl(ROOT / "memes" / "dist" / "meme_usage.jsonl")
    meme_usage_selected = sample(meme_usage_items, MAX_PER_SOURCE["meme_usage"], 42)
    for item in meme_usage_selected:
        meta = dict(item.get("meta", {}))
        meta["source"] = "meme_usage"
        item["meta"] = meta
    stats["meme_usage"] = {"total": len(meme_usage_items), "selected": len(meme_usage_selected)}

    # 构造基座并补 reasoning
    base_items = (
        [{"messages": item["messages"], "meta": dict(item.get("meta", {}))} for item in dito_selected]
        + [{"messages": item["messages"], "meta": dict(item.get("meta", {}))} for item in identity_selected]
        + [{"messages": item["messages"], "meta": dict(item.get("meta", {}))} for item in arch_selected]
        + [{"messages": item["messages"], "meta": dict(item.get("meta", {}))} for item in meme_qa_selected]
        + [{"messages": item["messages"], "meta": dict(item.get("meta", {}))} for item in meme_usage_selected]
    )
    add_reasoning_to_rows(base_items)
    stats["base"] = {"total": len(base_items), "selected": len(base_items)}

    # 写出基座（保持旧语义：train_merged_with_reasoning 只含人格/知识基座）
    with open(OUT / "train_merged_with_reasoning.jsonl", "w", encoding="utf-8") as f:
        for row in base_items:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    # 4) 原有 Linux agent 轨迹
    agent_items = load_jsonl(OUT / "agent_sft.jsonl")
    agent_selected = sample(agent_items, MAX_PER_SOURCE["agent"], 7)
    for item in agent_selected:
        meta = dict(item.get("meta", {}))
        meta["source"] = "agent"
        item["meta"] = meta
    stats["agent"] = {"total": len(agent_items), "selected": len(agent_selected)}

    # 5) 中文思维链 + 工具调用（hcnote 工具调用数据集转换）
    cot_items = load_jsonl(OUT / "agent_tool_call_cot.jsonl")
    cot_selected = sample(cot_items, MAX_PER_SOURCE["agent_cot"], 7)
    for item in cot_selected:
        meta = dict(item.get("meta", {}))
        meta["source"] = "agent_cot"
        item["meta"] = meta
    stats["agent_cot"] = {"total": len(cot_items), "selected": len(cot_selected)}

    rows = base_items + [{"messages": item["messages"], "meta": dict(item.get("meta", {}))} for item in agent_selected]
    rows += [{"messages": item["messages"], "meta": dict(item.get("meta", {}))} for item in cot_selected]
    random.shuffle(rows)

    with open(OUT / "train_merged.jsonl", "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(OUT / "train_merged_stats.json", "w", encoding="utf-8") as f:
        json.dump({"total": len(rows), "sources": stats}, f, ensure_ascii=False, indent=2)
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    print(f"基座 {len(base_items)} 条 -> {OUT / 'train_merged_with_reasoning.jsonl'}")
    print(f"共 {len(rows)} 条 -> {OUT / 'train_merged.jsonl'}")


if __name__ == "__main__":
    main()
