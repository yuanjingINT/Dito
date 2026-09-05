# -*- coding: utf-8 -*-
"""把 ModelScope hcnote/agent_tool_call_sft_250k 数据集转换成 Dito 可训练的
「中文思维链 + 工具调用」样本。

每条样本：
  user:    instruction（用户请求）
  assistant: reasoning_content=中文思考(CoT)，content=<tool_call>...Dito XML 工具调用...</tool_call>

目的：给 Dito 4B 加上「先想清楚再调工具」的思维链，并学会调用 Dito 已有的工具
（bash / web_search / web_fetch / read / write / edit / grep / glob / ask_question /
 recall_memories / get_system_info 等）。
"""
import json
import os
import random
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
DATASET = ROOT / "training" / "datasets" / "hcnote_agent_tool_call_250k" / "agent_tool_call_sft_250k.jsonl"
OUT = ROOT / "training" / "data" / "agent_tool_call_cot.jsonl"

# 数据集工具 -> Dito 工具名 映射（全部能落到 Dito 已有的工具）
TOOL_MAP = {
    "Bash": "bash", "execute_shell_command": "bash", "exec": "bash",
    "execute_python_code": "bash", "Shell": "bash",
    "WebSearch": "web_search", "WebFetch": "web_fetch",
    "Read": "read", "read_file": "read",
    "Write": "write", "write_file": "write",
    "Edit": "edit", "edit_file": "edit", "append_file": "edit", "NotebookEdit": "edit",
    "Glob": "glob", "glob_search": "glob",
    "Grep": "grep", "grep_search": "grep",
    "Agent": "ask_question", "AskUserQuestion": "ask_question", "ask_question": "ask_question",
    "memory_search": "recall_memories", "send_file_to_user": "ask_question",
    "get_current_time": "get_system_info", "GetCurrentTime": "get_system_info",
}

# 工具中文名（用于生成思维链）
TOOL_CN = {
    "bash": "在 Linux 上执行命令", "web_search": "联网搜索", "web_fetch": "抓取网页",
    "read": "读取文件", "write": "写文件", "edit": "编辑文件",
    "glob": "按通配符找文件", "grep": "在文件里搜内容",
    "ask_question": "向用户提问", "recall_memories": "回忆长期记忆",
    "get_system_info": "查询本机系统信息",
}

DITO_AGENT_SYS = (
    "你是 dito，中文名蒂特，跑在主人 Linux 电脑上的虚拟生命，忠于主人，是主人的 Linux/Agent 助手。"
    "\n规则："
    "\n- 遇到要实际动手、查证、操作的任务，先在心里想清楚（用中文思考），再调用工具"
    "\n- 工具用 XML 格式：<tool_call>\\n<function=工具名>\\n<parameter=参数名>\\n值\\n</parameter>\\n</function>\\n</tool_call>"
    "\n- 能一把写出工具调用就一把写完，别把简单操作拆成碎调用"
    "\n- 危险/破坏性操作（删除、格式化、卸载）必须先向主人确认"
    "\n- 不用 emoji，不用客服腔，直给结论"
)


def to_xml(calls):
    """把 [{name,parameters}] 转成 Dito XML 工具调用块。"""
    blocks = []
    for c in calls:
        name = c["name"]
        params = c.get("parameters") or {}
        lines = ["<tool_call>", f"<function={name}>"]
        for k, v in params.items():
            lines.append(f"<parameter={k}>")
            lines.append(str(v))
            lines.append("</parameter>")
        lines.append("</function>")
        lines.append("</tool_call>")
        blocks.append("\n".join(lines))
    return "\n".join(blocks)


def gen_thinking(instruction, calls):
    """基于指令 + 工具调用序列，生成一段中文思维链（CoT）。"""
    names = [c["name"] for c in calls]
    cn = [TOOL_CN.get(n, n) for n in names]
    if len(calls) == 1:
        sel = cn[0]
        why = ("用户想做的事比较明确，我先做这个占位动作，看清楚情况再说" if "ListMcp" in names[0] or "Task" in names[0]
               else f"这个任务需要{sel}，一动就行，我直接调")
        think = (
            f"用户让我「{instruction[:40]}」。\n"
            f"判断：这事要实际动手查证/操作，不能光靠嘴说。最合适的是 {sel}。"
            f"{why}。\n先把工具调用了，看返回结果再决定下一步。"
        )
    else:
        steps = "、".join(cn)
        think = (
            f"用户让我「{instruction[:40]}」。\n"
            f"这活儿不是一步能成的，得按顺序来：先 {steps}。\n"
            f"我先逐个把工具调用起来，每步看返回再往下走，最后给主人一个清楚的结论。"
        )
    return think


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--num", type=int, default=4000, help="采样条数（可调，8GB 上 4B 建议几千条）")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    random.seed(args.seed)
    if not DATASET.exists():
        raise SystemExit(f"数据集不存在: {DATASET}")

    picked = []
    with open(DATASET, encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            instruction = (d.get("instruction") or "").strip()
            if not instruction:
                continue
            try:
                calls = json.loads(d.get("output") or "[]")
            except Exception:
                continue
            if not calls or not isinstance(calls, list):
                continue
            # 只保留全部工具都能映射到 Dito 的样本
            mapped = []
            ok = True
            for c in calls:
                src = (c.get("name") or "").strip()
                if src not in TOOL_MAP:
                    ok = False
                    break
                params = c.get("parameters") or {}
                mapped.append({"name": TOOL_MAP[src], "parameters": params})
            if not ok:
                continue
            picked.append((instruction, mapped))

    random.shuffle(picked)
    picked = picked[: args.num]

    rows = []
    for instruction, calls in picked:
        thinking = gen_thinking(instruction, calls)
        xml = to_xml(calls)
        rows.append({
            "messages": [
                {"role": "system", "content": DITO_AGENT_SYS},
                {"role": "user", "content": instruction},
                {"role": "assistant", "reasoning_content": thinking, "content": xml},
            ],
            "meta": {"source": "agent_tool_call_cot"},
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"写出 {len(rows)} 条 -> {OUT}")
    print("示例：")
    print(json.dumps(rows[0], ensure_ascii=False, indent=2)[:1200])


if __name__ == "__main__":
    main()
