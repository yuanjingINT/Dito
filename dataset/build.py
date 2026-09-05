#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把数据源合并成训练用 JSONL。

输出：
  dist/dito_sft_chatml.jsonl  # OpenAI messages 格式（含 system）
  dist/dito_sft_alpaca.jsonl  # alpaca 格式（instruction/input/output）

用法：python3 build.py
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import data_chitchat
import data_refusal
import data_professional
import data_multiturn
import data_qq_chat
import data_internet
import data_identity
import data_prompt_style
import data_prompt_full


def load_system_prompt() -> str:
    return (HERE / "system_prompt.txt").read_text(encoding="utf-8").strip()


def flat_records():
    """统一展开为 {category, user, assistant} 单轮记录。"""
    records = []
    for it in data_chitchat.ITEMS:
        records.append({"category": "chitchat", "user": it["user"], "assistant": it["assistant"]})
    for it in data_refusal.ITEMS:
        records.append({"category": "refusal", "user": it["user"], "assistant": it["assistant"]})
    for it in data_professional.ITEMS:
        records.append({"category": it.get("category", "professional"), "user": it["user"], "assistant": it["assistant"]})
    for it in data_qq_chat.ITEMS:
        records.append({"category": "chitchat", "user": it["user"], "assistant": it["assistant"]})
    for it in data_internet.ITEMS:
        records.append({"category": it.get("category", "internet"), "user": it["user"], "assistant": it["assistant"]})
    for it in data_identity.ITEMS:
        records.append({"category": "identity", "user": it["user"], "assistant": it["assistant"]})
    for it in data_prompt_style.ITEMS:
        records.append({"category": it.get("category", "style_prompt"), "user": it["user"], "assistant": it["assistant"]})
    for it in data_prompt_full.ITEMS:
        records.append({"category": it.get("category", "prompt_full"), "user": it["user"], "assistant": it["assistant"]})
    return records


def conv_records():
    """多轮对话展开为 {category, messages} 记录。"""
    out = []
    for conv in data_multiturn.CONVS + data_prompt_style.CONVS + data_prompt_full.CONVS:
        msgs = []
        for turn in conv["turns"]:
            msgs.append({"role": "user", "content": turn["user"]})
            msgs.append({"role": "assistant", "content": turn["assistant"]})
        out.append({"category": conv["category"], "messages": msgs})
    return out


def main():
    system = load_system_prompt()
    out_dir = HERE / "dist"
    out_dir.mkdir(exist_ok=True)

    n_single, n_multi = 0, 0
    with open(out_dir / "dito_sft_chatml.jsonl", "w", encoding="utf-8") as f_chat, \
         open(out_dir / "dito_sft_alpaca.jsonl", "w", encoding="utf-8") as f_alpaca:
        for rec in flat_records():
            msgs = [
                {"role": "system", "content": system},
                {"role": "user", "content": rec["user"]},
                {"role": "assistant", "content": rec["assistant"]},
            ]
            f_chat.write(json.dumps({"messages": msgs, "meta": {"category": rec["category"], "type": "single"}}, ensure_ascii=False) + "\n")
            f_alpaca.write(json.dumps({
                "instruction": rec["user"],
                "input": "",
                "output": rec["assistant"],
                "system": system,
                "meta": {"category": rec["category"]},
            }, ensure_ascii=False) + "\n")
            n_single += 1
        for rec in conv_records():
            msgs = [{"role": "system", "content": system}] + rec["messages"]
            f_chat.write(json.dumps({"messages": msgs, "meta": {"category": rec["category"], "type": "multi"}}, ensure_ascii=False) + "\n")
            f_alpaca.write(json.dumps({
                "instruction": rec["messages"][-2]["content"],
                "input": "",
                "output": rec["messages"][-1]["content"],
                "system": system,
                "meta": {"category": rec["category"], "history": rec["messages"][:-2]},
            }, ensure_ascii=False) + "\n")
            n_multi += 1

    # 额外输出无 system 的身份强化数据，防止模型在无系统提示词时自报通义千问
    with open(out_dir / "dito_identity_nosys.jsonl", "w", encoding="utf-8") as f:
        for it in data_identity.ITEMS + data_prompt_style.ITEMS + data_prompt_full.ITEMS:
            msgs = [
                {"role": "user", "content": it["user"]},
                {"role": "assistant", "content": it["assistant"]},
            ]
            f.write(json.dumps({"messages": msgs, "meta": {"category": "identity_nosys", "type": "single"}}, ensure_ascii=False) + "\n")

    total_turns = n_single + sum(len(c["turns"]) for c in data_multiturn.CONVS)
    print(f"单轮 {n_single} 条，多轮对话 {n_multi} 组（{total_turns - n_single} 轮），共 {n_single + n_multi} 条样本")
    print(f"输出: {out_dir / 'dito_sft_chatml.jsonl'}")
    print(f"输出: {out_dir / 'dito_sft_alpaca.jsonl'}")
    print(f"输出: {out_dir / 'dito_identity_nosys.jsonl'}")


if __name__ == "__main__":
    main()
