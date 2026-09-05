/**
 * 插件：记忆。
 * 知识点 + 短日记：remember / recall 工具 + 自动记忆钩子 + /memory-stats、/memory-clear 命令。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import memoryExtension from "../memory.js";

export const memoryPlugin: DitoPlugin = {
  id: "memory",
  name: "记忆",
  description: "跨会话记忆：remember_fact、recall_memories、recall_past_events 工具与自动日记。",
  icon: "memory",
  version: "1.0.0",
  apply(ctx) {
    memoryExtension(ctx.pi);
  },
};
