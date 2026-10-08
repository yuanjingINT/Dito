/**
 * 子代理隔离进程入口。
 * 由 extensions/subagent.ts 启动，stdout 只输出 JSON 事件，便于主代理汇总。
 */
import { readFileSync } from "node:fs";
import { createSession } from "./session.js";

interface WorkerPayload {
  task: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function payloadPath(): string {
  const index = process.argv.indexOf("--payload");
  if (index < 0 || !process.argv[index + 1]) throw new Error("missing --payload");
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const payload = JSON.parse(readFileSync(payloadPath(), "utf8")) as WorkerPayload;
  const created = await createSession({
    fresh: true,
    ephemeral: true,
    model: payload.model,
    skipPluginIds: ["subagent"],
  });
  const session = created.session;
  if (payload.tools?.length) session.setActiveToolsByName(payload.tools);

  emit({ type: "subagent_start", model: session.model ? `${session.model.provider}/${session.model.id}` : created.modelName });
  const unsubscribe = session.subscribe((event: unknown) => {
    const e = event as { type: string; message?: any; assistantMessageEvent?: { type: string; delta?: string }; toolName?: string };
    if (e.type === "message_start" && e.message?.role === "assistant") emit({ type: e.type, message: { role: "assistant" } });
    else if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      emit({ type: e.type, assistantMessageEvent: { type: "text_delta", delta: e.assistantMessageEvent.delta } });
    }
    else if (e.type === "tool_execution_start" || e.type === "tool_execution_end") emit({ type: e.type, toolName: e.toolName });
    else if (e.type === "message_end" && e.message?.role === "assistant") {
      emit({ type: e.type, message: { ...e.message, content: e.message.content.filter((block: any) => block.type === "text") } });
    }
  });

  const prompt = [
    payload.systemPrompt?.trim(),
    "你是 Dito 的一个隔离子代理。完成分配的任务后，直接返回可供主代理使用的结果；不要再次创建子代理。",
    payload.task,
  ].filter(Boolean).join("\n\n");
  try {
    await session.prompt(prompt);
    emit({ type: "subagent_end", model: created.modelName });
  } finally {
    unsubscribe?.();
    session.dispose();
  }
}

main().catch((error) => {
  emit({ type: "subagent_error", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
