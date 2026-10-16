import askExtension from "../ask.js";
const askPlugin = {
  id: "ask",
  name: "提问工具",
  description: "ask_question 工具：语音模式自动朗读问题并录音听取回答，TUI 模式弹出选择。",
  icon: "ask",
  version: "1.0.0",
  apply(ctx) {
    askExtension(ctx.pi);
  }
};
export {
  askPlugin
};
