# -*- coding: utf-8 -*-
"""面向 agent 能力的 Linux 工具调用轨迹数据集（手工精写，质量优先）。

目标：让模型学会「当 Linux agent」——
- 收到目标后先思考拆步骤
- 用 Qwen 官方 tool_call 格式调用 bash 等工具
- 读工具输出、继续行动，危险操作先确认
- 最后给用户清晰结论

格式说明（对齐 Qwen3.5 chat_template）：
  - system 可带 <tools>...</tools> 工具清单
  - assistant 消息：thinking … response，然后要么 <tool_call><function=命令><parameter=command>…</parameter></function></tool_call>，要么直接给用户回答
  - 工具结果用 {"role":"tool","content":"<tool_response>…</tool_response>"}，由模板渲染成 user/tool 段
  - 每条是完整轨迹，供训练模型模仿多步工具调用

每个样本结构：
  {"id":.., "task":.., "messages":[system, user, assistant(tool_call), tool, assistant(...), ...]}
"""

TOOLS_BLOCK = (
    "<tools>\n"
    "{\"type\": \"tool\", \"function\": {\"name\": \"bash\", \"description\": \"在 Linux 上执行 shell 命令并返回 stdout/stderr。用于系统维护、文件操作、包管理、排障等。\", \"parameters\": {\"type\": \"object\", \"properties\": {\"command\": {\"type\": \"string\", \"description\": \"要执行的 shell 命令\"}}, \"required\": [\"command\"]}}}\n"
    "</tools>"
)

SYSTEM_AGENT = (
    "你是 dito，中文名蒂特，18岁，跑在主人的 Linux 电脑上，可以完全控制这台电脑的虚拟生命，忠于主人。"
    "\n你是系统自动配给的 Linux 运维 agent，负责完成主人的操作请求。"
    "\n规则："
    "\n- 分析目标后，如需执行命令就用工具调用的 XML 格式；能把命令一把写完就一把写完，别把简单操作拆成一堆碎调用"
    "\n- 先想清楚要查什么、改什么、有什么风险，再调用工具"
    "\n- 危险操作（删除、格式化、卸载、覆盖系统文件、rm 等）必须先用文字向主人确认，得到确认再执行"
    "\n- 不使用 emoji，不用客服腔，说话像给朋友讲，直接给结论"
    "\n- 需要判断时，若把握不足就明说不确定在哪"
)


def agent_sample(sid, task, user_msg, turns):
    """
    组装 Qwen 工具调用轨迹。

    turns: 元素为 ("tool_call", dict{thinking,command})
            或 ("tool_result", output_str)
            或 ("assistant", text)
            或 ("user", text)

    assistant 消息用 reasoning_content（思考）+ content（调用或回答），
    由 chat_template 渲染成正确的 thinking/response 与 tool_call 结构。
    """
    messages = [{"role": "system", "content": SYSTEM_AGENT + "\n" + TOOLS_BLOCK}]
    messages.append({"role": "user", "content": user_msg})
    for kind, payload in turns:
        if kind == "tool_call":
            thinking = payload.get("thinking", "先看一下具体情况，用命令查证再决定怎么处理")
            command = payload["command"]
            tool_call_str = (
                "<tool_call>\n<function=bash>\n<parameter=command>\n"
                + command
                + "\n</parameter>\n</function>\n</tool_call>"
            )
            messages.append({
                "role": "assistant",
                "reasoning_content": thinking,
                "content": tool_call_str,
            })
        elif kind == "tool_result":
            # 模板会自己包 <tool_response>，这里只放原始输出
            messages.append({"role": "tool", "content": payload})
        elif kind == "assistant":
            messages.append({
                "role": "assistant",
                "reasoning_content": "查完收尾，把结论说清楚给主人",
                "content": payload,
            })
        elif kind == "user":
            messages.append({"role": "user", "content": payload})
    return {"id": sid, "task": task, "messages": messages}
