import { loadConfig } from "../util.js";
import { createSnowLumaToolsExtension } from "../snowluma-tools.js";
const snowlumaPlugin = {
  id: "snowluma",
  name: "SnowLuma QQ 工具",
  description: "SnowLuma OneBot 全量动作 + 戳一戳/点赞/表情回应/发空间/表情包库（需 QQ 频道启用）。",
  icon: "model",
  version: "1.0.0",
  apply(ctx) {
    const cfg = loadConfig();
    if (!cfg.channels.qq.enabled) {
      console.log("[dito] SnowLuma 工具未加载：channels.qq 未启用");
      return;
    }
    createSnowLumaToolsExtension()(ctx.pi);
  }
};
export {
  snowlumaPlugin
};
