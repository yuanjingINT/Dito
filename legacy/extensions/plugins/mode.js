import modeExtension from "../mode.js";
const modePlugin = {
  id: "mode",
  name: "运行模式",
  description: "闲聊（不调工具）、标准（完整工具）、计划（只读探索）三种模式自由切换。",
  icon: "mode",
  version: "1.0.0",
  apply(ctx) {
    modeExtension(ctx.pi);
  }
};
export {
  modePlugin
};
