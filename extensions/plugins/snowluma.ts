/**
 * 插件：SnowLuma QQ 工具。
 * 把全部 OneBot action 与精选封装注册为工具（终端也能戳人/点赞/发空间/查表情包库）。
 * 依赖 channels.qq.enabled；QQ 频道进程里被 skipPluginIds 跳过（频道自己带依赖版本）。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import { loadConfig } from "../util.js";
import { createSnowLumaToolsExtension } from "../snowluma-tools.js";

export const snowlumaPlugin: DitoPlugin = {
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
  },
};
