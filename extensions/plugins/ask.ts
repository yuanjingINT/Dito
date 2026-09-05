/**
 * 插件：提问工具。
 * ask_question：语音模式朗读后自动录音；TUI 模式弹出选择；文本模式把问题展示给用户。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import askExtension from "../ask.js";

export const askPlugin: DitoPlugin = {
  id: "ask",
  name: "提问工具",
  description: "ask_question 工具：语音模式自动朗读问题并录音听取回答，TUI 模式弹出选择。",
  icon: "ask",
  version: "1.0.0",
  apply(ctx) {
    askExtension(ctx.pi);
  },
};
