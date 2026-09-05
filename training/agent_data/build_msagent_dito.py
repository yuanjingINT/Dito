#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 ModelScope iic/MSAgent-Pro 转成「Dito 风格中文思维链 + XML 工具调用」数据。

MSAgent-Pro 原始对话是英文 agent 轨迹，结构为：
  user: 任务 + "What is your thought..."
  assistant: 思考
  user: What is the tool you want to use?
  assistant: 工具名
  user: What are the required parameter names... / What is the value of X...
  assistant: 参数名/参数值
  user: 工具返回 / 下一步思考
  ...

这里提取每轮工具调用，映射到 Dito 已有工具，并套上 Dito agent system prompt + 中文思考。
"""
import json
import pathlib
import random

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
DATASET = ROOT / "training" / "datasets" / "MSAgent-Pro" / "ms-agent-en.jsonl"
OUT = ROOT / "training" / "data" / "msagent_dito_agent.jsonl"

DITO_AGENT_SYS = (
    "你是 dito，中文名蒂特，跑在主人 Linux 电脑上的虚拟生命，忠于主人，是主人的 Linux/Agent 助手。"
    "\n规则："
    "\n- 遇到要实际动手、查证、操作的任务，先在心里想清楚（用中文思考），再调用工具"
    "\n- 工具用 XML 格式：<tool_call>\\n<function=工具名>\\n<parameter=参数名>\\n值\\n</parameter>\\n</function>\\n</tool_call>"
    "\n- 能一把写出工具调用就一把写完，别把简单操作拆成碎调用"
    "\n- 危险/破坏性操作（删除、格式化、卸载）必须先向主人确认"
    "\n- 不用 emoji，不用客服腔，直给结论"
)

TOOL_CN = {
    "bash": "在 Linux 上执行命令", "web_search": "联网搜索", "web_fetch": "抓取网页数据",
    "read": "读取文件", "write": "写文件", "edit": "编辑文件",
    "glob": "按通配符找文件", "grep": "在文件里搜内容",
    "ask_question": "向用户提问", "recall_memories": "回忆长期记忆", "get_system_info": "查询系统信息",
}


def map_tool(name: str):
    """把 MSAgent-Pro 的 API 工具名粗映射到 Dito 已有工具（用词边界避免误判）。"""
    import re
    n = name.lower()
    if re.search(r"\b(search|query|find|lookup|google|youtube|news|search_for)\b", n):
        return "web_search"
    if re.search(r"\b(bash|shell|command|exec|python|ssh|apt|pacman|install|run)\b", n):
        return "bash"
    if re.search(r"\b(read_file|read|open|cat)\b", n):
        return "read"
    if re.search(r"\b(write_file|write|create_file)\b", n):
        return "write"
    if re.search(r"\b(edit|update|append)\b", n):
        return "edit"
    if re.search(r"\b(glob|find_file|list_file|listdir|list)\b", n):
        return "glob"
    if re.search(r"\b(grep|search_in_file|regex)\b", n):
        return "grep"
    if re.search(r"\b(ask|question|confirm|clarify)\b", n):
        return "ask_question"
    if re.search(r"\b(memory|recall|remember)\b", n):
        return "recall_memories"
    if re.search(r"\b(system|time|date|os|info)\b", n):
        return "get_system_info"
    # 其余 API 类默认按“抓取网页/API 数据”处理
    return "web_fetch"


def to_xml(name, params):
    lines = ["<tool_call>", f"<function={name}>"]
    for k, v in params.items():
        lines.append(f"<parameter={k}>")
        lines.append(str(v))
        lines.append("</parameter>")
    lines.append("</function>")
    lines.append("</tool_call>")
    return "\n".join(lines)


def gen_thinking(instruction, tool_name):
    cn = TOOL_CN.get(tool_name, tool_name)
    short = " ".join(instruction.split())[:80]
    return (
        f"用户让我处理「{short}」。\n"
        f"判断：这事需要实际查证/操作，最合适的是 {cn}。\n"
        f"先调用工具拿到结果，再给主人整理成清楚的结论。"
    )


def parse_conversation(conv):
    """返回 (initial_user, list_of_tool_calls). tool_call: dict(name, params, reasoning)"""
    initial_user = ""
    for m in conv:
        if m.get("from") == "user":
            initial_user = m.get("value", "").strip()
            # 去掉 MSAgent 的引导句
            for marker in ["\nBegin!", " Begin!", "\nWhat is your thought"]:
                idx = initial_user.find(marker)
                if idx != -1:
                    initial_user = initial_user[:idx].strip()
            break

    calls = []
    i = 0
    n = len(conv)
    while i < n:
        m = conv[i]
        if m.get("from") == "user" and "tool you want to use" in m.get("value", ""):
            # 前一条 assistant 是思考
            reasoning = ""
            if i > 0 and conv[i-1].get("from") == "assistant":
                reasoning = conv[i-1].get("value", "").strip()
            # 下一条 assistant 是工具名
            if i + 1 < n and conv[i+1].get("from") == "assistant":
                tool_name = conv[i+1].get("value", "").strip()
                # 跳过 Finish/结束
                if tool_name.lower().startswith("finish"):
                    i += 2
                    continue
                # 收集参数名和值
                params = {}
                j = i + 2
                param_names = []
                while j < n:
                    u = conv[j]
                    v = conv[j+1] if j+1 < n else None
                    if u.get("from") != "user":
                        break
                    text = u.get("value", "").strip()
                    if text.startswith("{"):  # 工具返回/新一步
                        break
                    if "required parameter names" in text:
                        if v and v.get("from") == "assistant":
                            param_names = [x.strip() for x in v.get("value", "").split(",") if x.strip()]
                        j += 2
                        continue
                    if text.startswith("What is the value of "):
                        pname = text[len("What is the value of "):].strip().rstrip("?")
                        if v and v.get("from") == "assistant":
                            params[pname] = v.get("value", "").strip()
                        j += 2
                        continue
                    if "tool you want to use" in text or text.lower().startswith("finish"):
                        break
                    break
                # 如果没解析到参数名但有值，就按顺序补
                if not params and param_names:
                    # 一般不会到这里
                    pass
                calls.append({"name": tool_name, "params": params, "reasoning": reasoning})
                i = j
                continue
        i += 1
    return initial_user, calls


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--num", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    random.seed(args.seed)

    if not DATASET.exists():
        raise SystemExit(f"数据集不存在: {DATASET}")

    rows = []
    with open(DATASET, encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            conv = d.get("conversations") or []
            initial_user, calls = parse_conversation(conv)
            if not initial_user or not calls:
                continue
            for c in calls:
                tool = map_tool(c["name"])
                params = c.get("params") or {}
                # 参数名里带空格/不含法的，简单清理
                cleaned = {}
                for k, v in params.items():
                    key = k.strip().replace(" ", "_").replace("-", "_") or "value"
                    cleaned[key] = v
                thinking = gen_thinking(initial_user, tool)
                rows.append({
                    "messages": [
                        {"role": "system", "content": DITO_AGENT_SYS},
                        {"role": "user", "content": initial_user},
                        {"role": "assistant", "reasoning_content": thinking, "content": to_xml(tool, cleaned)},
                    ],
                    "meta": {"source": "msagent_dito", "original_tool": c["name"], "tool": tool},
                })

    random.shuffle(rows)
    rows = rows[:args.num]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"写出 {len(rows)} 条 -> {OUT}")
    print("工具分布:")
    from collections import Counter
    print(Counter(r["meta"]["tool"] for r in rows).most_common())
    print("示例:")
    print(json.dumps(rows[0], ensure_ascii=False, indent=2)[:1500])


if __name__ == "__main__":
    main()
