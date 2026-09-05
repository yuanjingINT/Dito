/**
 * 插件：运行模式。
 * 闲聊 / 标准 / 计划三模式：切换工具集与思考深度，提供 /mode 命令。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import modeExtension from "../mode.js";

export const modePlugin: DitoPlugin = {
  id: "mode",
  name: "运行模式",
  description: "闲聊（不调工具）、标准（完整工具）、计划（只读探索）三种模式自由切换。",
  icon: "mode",
  version: "1.0.0",
  apply(ctx) {
    modeExtension(ctx.pi);
  },
};
