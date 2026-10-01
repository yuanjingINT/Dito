/**
 * 插件：记忆。
 * 知识点 + 短日记：remember / recall 工具 + 自动记忆钩子 + /memory-stats、/memory-clear 命令。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import memoryExtension from "../memory.js";

export const memoryPlugin: DitoPlugin = {
  id: "memory",
  name: "记忆",
  description: "长记忆：短日记整理、知识点/经历升级、自动联想、遗忘衰减与记忆工具。",
  icon: "memory",
  version: "2.0.0",
  apply(ctx) {
    memoryExtension(ctx.pi);
  },
};
