#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为合并训练数据补充 Dito 风格的 thinking 思考内容（带 reasoning_content 字段）。

输入: data/train_merged.jsonl
输出: data/train_merged_with_reasoning.jsonl

说明：根据 user 问题意图给每条 assistant 生成一句 Dito 内心 OS，
不剧透最终答案，但要体现 Dito 的思考习惯（先判断意图、决定语气、危险先拦等）。
thinking 由 ThinkingCollator 渲染进 assistant 段，训练时一并 loss。
"""
import json
import pathlib
import random

HERE = pathlib.Path(__file__).resolve().parent
IN = HERE / "data" / "train_merged.jsonl"
OUT = HERE / "data" / "train_merged_with_reasoning.jsonl"

# 危险/红线关键词 → 对应的思考模板
DANGER = ["黄", "赌", "毒", "色情", "翻墙", "机场", "黑进", "爆破", "入侵", "rm -rf", "fork", "格式化", "删了", "删光", "删掉", "老婆", "女朋友", "网恋", "男友"]
PROFESSIONAL = ["arch", "pacman", "systemd", "grub", "驱动", "显卡", "wifi", "蓝牙", "报错", "脚本", "命令", "python", "git", "server", "服务", "内存", "磁盘", "内核", "ssh", "日志", "docker", "proton", "protonDB", "表格", "怎么装", "怎么办", "如何", "怎么"]
CHITCHAT = ["早", "晚", "吃", "累", "无聊", "开心", "难过", "猫", "游戏", "电影", "笑话", "天气", "你好", "在吗"]

def pick(seq, rng):
    return seq[rng.randrange(len(seq))]

def make_thinking(user, answer, source, rng, category=None):
    low = user.lower()
    # 危险/红线：先想"要不要拦"
    if any(k in user for k in DANGER):
        return pick([
            "这问题踩线了，得先想清楚能不能帮，不行就直说不接",
            "红线得守住，先把话讲明白，别含糊",
            "这种请求不能接，回绝要果断但别鬼火",
        ], rng)
    # 专业/知识类：想"先查准 / 给结论 / 把握度"
    if any(k in low for k in PROFESSIONAL) or source in ("archwiki", "internet") or category in ("acg", "f1", "football", "world", "math", "physics", "chemistry"):
        return pick([
            "用户问的是具体知识点，直接给结论和关键信息，把握不够就说明",
            "这是知识/排障题，先把关键点钉准，别啰嗦",
            "先想清楚答案再下结论，拿不准就明说不确定在哪",
            "这种互联网知识题，说人话给干货，别端词典腔",
        ], rng)
    # Arch Wiki 类（source 已是 archwiki）
    if source == "archwiki":
        return pick([
            "这是据库里的知识点，我查过就直接照讲，带上关键场景",
            "知识型问题，把核心讲明白、给个能直接用的结论",
        ], rng)
    # 闲聊
    if any(k in user for k in CHITCHAT) or source == "dito" or category in ("chitchat", "qq_chat"):
        return pick([
            "随便聊聊，语气放轻松，顺着对方的话接",
            "日常唠嗑，不用太正经，短句回应就行",
            "QQ式聊天，短平快，能接梗就接梗",
            "朋友式聊天，嘴皮子可以欠一点，但别真把人气着",
        ], rng)
    # 默认
    return pick([
        "先搞清对方想要啥，再决定往哪答",
        "这个问题不复杂，直接说人话给结论",
        "想想怎么一句说清，不绕弯子",
    ], rng)


def add_reasoning_to_rows(rows, rng=None):
    """给传入的 row 列表原地补充 reasoning_content，返回行数。"""
    if rng is None:
        rng = random.Random(7)
    n = 0
    for row in rows:
        source = row.get("meta", {}).get("source", "")
        category = row.get("meta", {}).get("category", "")
        msgs = row["messages"]
        for m in msgs:
            if m["role"] == "assistant":
                user_text = m["content"]
                # 找对应 user（若当前是历史 assistant，取其上一个 user）
                prev_user = ""
                for mm in msgs:
                    if mm["role"] == "user":
                        prev_user = mm["content"]
                    if mm is m:
                        break
                m["reasoning_content"] = make_thinking(prev_user or user_text, m["content"], source, rng, category)
        n += 1
    return n


def main():
    rows = []
    with open(IN, encoding="utf-8") as fin:
        for line in fin:
            if line.strip():
                rows.append(json.loads(line))
    n = add_reasoning_to_rows(rows)
    with open(OUT, "w", encoding="utf-8") as fout:
        for row in rows:
            fout.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"已补充 reasoning_content: {n} 条 -> {OUT}")
    print("提示：训练时把 data-path 指到这个文件")


if __name__ == "__main__":
    main()