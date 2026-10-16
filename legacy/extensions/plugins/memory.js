import memoryExtension from "../memory.js";
const memoryPlugin = {
  id: "memory",
  name: "记忆",
  description: "长记忆：短日记整理、知识点/经历升级、自动联想、遗忘衰减与记忆工具。",
  icon: "memory",
  version: "2.0.0",
  apply(ctx) {
    memoryExtension(ctx.pi);
  }
};
export {
  memoryPlugin
};
