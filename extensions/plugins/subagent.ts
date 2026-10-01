/** 插件：子代理调度。 */
import type { DitoPlugin } from "../plugin-kernel.js";
import subagentExtension from "../subagent.js";

export const subagentPlugin: DitoPlugin = {
  id: "subagent",
  name: "子代理调度",
  description: "按工作内容、模型价格和预算分配隔离子代理，最多支持 100 个任务。",
  icon: "agents",
  version: "1.0.0",
  apply(ctx, config) {
    subagentExtension(ctx.pi, config);
  },
};
