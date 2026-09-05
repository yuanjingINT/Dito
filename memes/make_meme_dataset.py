#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 meme_seed.py 生成互联网热梗数据集。

流程：
  1. 逐条请求萌娘百科 extract 扩充正文（失败不影响）
  2. 生成 meme_entries.jsonl（词条知识库）
  3. 生成 meme_qa.jsonl（Dito 风格解释梗的 ChatML 训练数据）
  4. 生成 meme_usage.jsonl（接梗/用梗对话训练数据）

用法：python3 make_meme_dataset.py [--no-fetch]
"""
import argparse
import json
import pathlib
import re
import time
import urllib.parse

import requests

HERE = pathlib.Path(__file__).resolve().parent
DIST = HERE / "dist"
DIST.mkdir(exist_ok=True)
SYSTEM_PATH = HERE.parent / "dataset" / "system_prompt.txt"

import sys
sys.path.insert(0, str(HERE))
from meme_seed import SEED

MOEGIRL = "https://zh.moegirl.org.cn/api.php"
HEADERS = {"User-Agent": "Dito-meme-dataset/0.1 (educational)"}


def fetch_moegirl(name: str, session: requests.Session, timeout=12):
    """按标题抓萌娘百科纯文本正文，找不到返回空串。"""
    params = {
        "action": "query",
        "titles": name,
        "prop": "extracts",
        "explaintext": "1",
        "format": "json",
        "redirects": "1",
    }
    try:
        r = session.get(MOEGIRL, params=params, timeout=timeout, headers=HEADERS)
        r.raise_for_status()
        data = r.json()
        pages = data.get("query", {}).get("pages", {})
        for page in pages.values():
            if page.get("extract"):
                return page["extract"]
    except Exception:
        pass
    return ""


def make_explain_dito(entry: dict) -> str:
    """把词条字段拼成 Dito 风格的解释。

    规则：像朋友唠嗑、直接说人话、带轻微调侃；不用“出处：/用法：”这种词典格式；
    没有 emoji；解释类可以超过 30 字，但每句都要短平快。
    """
    name = entry["name"]
    cat = entry.get("category", "")
    meaning = entry["meaning"].rstrip("。")
    origin = entry.get("origin", "").rstrip("。")
    usage = entry.get("usage", "").rstrip("。")
    example = entry.get("example", "").rstrip("。")

    # 选开场白，按名字长度轮换，避免每条长一个样
    opening_templates = [
        f"这梗我熟，“{name}”就是",
        f"“{name}”啊，简单说就是",
        f"来了，这题我专业，“{name}”意思是",
        f"这你算问对人了，“{name}”嘛，说白了就是",
        f"“{name}”我知道，就是指",
    ]
    if cat in ("游戏", "编程"):
        opening_templates[0] = f"这梗我熟，“{name}”在我们这圈就是"
    if cat in ("职场", "社会"):
        opening_templates[2] = f"来了，这题我熟，“{name}”就是指"
    opening = opening_templates[len(name) % len(opening_templates)]

    # 连接词也轮换，不要太机械
    origin_conn = ["出处不复杂", "来源也好懂", "最早是", "源头在"]
    usage_conn = ["用的时候就是", "平时说就是", "一般用来", "拿它来形容"]
    example_conn = ["比如", "举个例", "像", "例如"]

    n = len(name)
    sentence = f"{opening}{meaning}。"
    if origin:
        prefix = origin_conn[n % len(origin_conn)]
        sentence += f" {prefix}，{origin}。"
    if usage:
        prefix = usage_conn[n % len(usage_conn)]
        sentence += f" {prefix}{usage}。"
    if example:
        prefix = example_conn[n % len(example_conn)]
        sentence += f" {prefix}：{example}。"

    closings = ["这么一说，懂了吧", "大概就这意思", "这下明白了吧", "不懂再问，我还能给你掰扯"]

    # 若有条目正文，追加 Dito 口吻的补充，让解释更"活"一些
    extract = entry.get("moegirl_extract", "")
    if extract and len(extract) > 40:
        # 取正文里第二段（通常是最接近"含义"的一段），截断成一句补充
        seg = extract.replace("\n", " ")
        seg = re.sub(r"\s+", " ", seg).strip()
        if len(seg) > 180:
            seg = seg[:180]
            # 尽量在句末截断
            cut = max(seg.rfind("。"), seg.rfind("；"), seg.rfind("，"))
            if cut > 60:
                seg = seg[:cut]
        sentence += f" 顺带多说一句，{seg}。"

    sentence += closings[n % len(closings)]
    return sentence


def make_usage_dito(entry: dict) -> str:
    """针对用户用梗场景的 Dito 式回应。短句、口语、玩梗、无 emoji。"""
    name = entry["name"]
    cat = entry.get("category", "")
    replies = [
        f"好活，这波{name}玩明白了",
        f"{name}，懂都懂，不用解释",
        f"这{name}味儿太冲了",
        f"可以，很{name}，跟你学坏了",
        f"你搁这套娃呢，{name}都让你用出花来了",
        f"行啊你，{name}越来越熟练了",
    ]
    if cat in ("游戏", "编程"):
        replies = [
            f"这波{name}操作很标准，懂的人已经懂了",
            f"{name}，经典老番，回味无穷",
            f"好家伙，{name}都让你玩明白了",
            f"可以，这很{name}，换我我也这么干",
        ]
    elif cat in ("情绪", "自嘲", "职场", "社会"):
        replies = [
            f"这{name}，听着就扎心",
            f"真实，{name}本尊发言了",
            f"别说了，{name}到点了，都懂",
            f"你这{name}发言太典了",
        ]
    return replies[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-fetch", action="store_true", help="跳过萌娘百科扩充")
    args = ap.parse_args()

    system_prompt = SYSTEM_PATH.read_text(encoding="utf-8").strip()
    session = requests.Session()
    entries = []
    qa = []
    usage = []
    fetched = 0

    for i, entry in enumerate(SEED, 1):
        item = dict(entry)
        if not args.no_fetch:
            extract = fetch_moegirl(entry["name"], session)
            if extract:
                fetched += 1
                item["moegirl_extract"] = extract[:3000]
            time.sleep(0.15)
        entries.append(item)

        # 解释类 QA
        q_templates = [
            f"帮我解释一下“{entry['name']}”这个梗",
            f"“{entry['name']}”是啥意思",
            f"最近总看到“{entry['name']}”，给我讲讲",
            f"一句话说清“{entry['name']}”是啥梗",
        ]
        q = q_templates[i % len(q_templates)]
        a = make_explain_dito(item)
        qa.append({
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": q},
                {"role": "assistant", "content": a},
            ],
            "meta": {"source": "meme", "type": "explain", "name": entry["name"]},
        })

        # 接梗/用梗对话
        usage.append({
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": entry["example"]},
                {"role": "assistant", "content": make_usage_dito(item)},
            ],
            "meta": {"source": "meme", "type": "usage", "name": entry["name"]},
        })

    # 写入
    with open(DIST / "meme_entries.jsonl", "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    with open(DIST / "meme_qa.jsonl", "w", encoding="utf-8") as f:
        for r in qa:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(DIST / "meme_usage.jsonl", "w", encoding="utf-8") as f:
        for r in usage:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"词条: {len(entries)}，萌娘扩充: {fetched}")
    print(f"输出: {DIST/'meme_entries.jsonl'}")
    print(f"输出: {DIST/'meme_qa.jsonl'}")
    print(f"输出: {DIST/'meme_usage.jsonl'}")


if __name__ == "__main__":
    main()