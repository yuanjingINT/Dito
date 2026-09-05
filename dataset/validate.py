#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据集风格校验：按 dito 人设的硬规则检查。

规则（来自 personas/dito.md）：
1. 全部回复：无 emoji
2. 全部回复：无（动作）类舞台指示
3. 闲聊类回复（category=chitchat 的单轮/轮次）：≤30 字、结尾不加句号、单行
4. 全部回复：无加粗 markdown（**）
5. JSON 结构完整性

用法：python3 validate.py   （先跑 build.py）
退出码非 0 表示有问题，方便接 CI。
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist" / "dito_sft_chatml.jsonl"

EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]"
)
ACTION_RE = re.compile(r"[（(](?:.{0,12}?)(?:了|着|地)?(?:眼镜|头发|头|书|眼|手|肩|腰|腿|脸)[^）)]{0,8}[）)]")
CHITCHAT_LIMIT = 30

problems = []
stats = {"total": 0, "chitchat": 0, "professional": 0, "refusal": 0, "multi": 0}


def check_text(text, where, is_chitchat):
    if EMOJI_RE.search(text):
        problems.append(f"[emoji] {where}: {text[:40]}")
    if ACTION_RE.search(text):
        problems.append(f"[动作] {where}: {text[:40]}")
    if "**" in text:
        problems.append(f"[加粗] {where}: {text[:40]}")
    if not is_chitchat:
        return
    if text.endswith("。"):
        problems.append(f"[句号结尾] {where}: {text}")
    if len(text) > CHITCHAT_LIMIT:
        problems.append(f"[超{CHITCHAT_LIMIT}字] {where} ({len(text)}字): {text}")
    if "\n" in text:
        problems.append(f"[多行] {where}: {text[:40]}")


def main():
    if not DIST.exists():
        print("先跑 build.py 生成 dist/dito_sft_chatml.jsonl")
        sys.exit(2)

    with open(DIST, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            row = json.loads(line)
            msgs = row["messages"]
            cat = row["meta"]["category"]
            typ = row["meta"]["type"]
            stats["total"] += 1
            if typ == "multi":
                stats["multi"] += 1
            else:
                stats[cat if cat in stats else "professional"] += 1

            if msgs[0]["role"] != "system":
                problems.append(f"[结构] 行{i} 第一条不是 system")
            for j, m in enumerate(msgs):
                if m["role"] not in ("system", "user", "assistant"):
                    problems.append(f"[结构] 行{i} 非法 role: {m['role']}")
                if m["role"] != "assistant":
                    continue
                where = f"行{i}第{j}条"
                check_text(m["content"], where, cat == "chitchat")

    print("统计:", stats)
    if problems:
        print(f"\n发现 {len(problems)} 个问题:")
        for p in problems:
            print(" ", p)
        sys.exit(1)
    print("全部通过")


if __name__ == "__main__":
    main()
