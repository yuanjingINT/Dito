/**
 * Dito 扩展入口（pi -e extensions/index.ts 与 SDK 扩展工厂共用）。
 *
 * 架构采用 DeepSeek Harness 的 Cordis 思路：
 * - 内核（plugin-kernel.ts）只负责插件加载、依赖排序与配置启用判断。
 * - 所有能力都是插件（extensions/plugins/*），通过 Context 在 pi 上注册工具/命令/事件钩子。
 * - 配置层自由组合：~/.pi/agent/dito/config.json 的 plugins.<id>.enabled 控制每个插件的启用。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bootDitoPlugins } from "./plugin-kernel.js";
import { DITO_PLUGINS } from "./plugins/index.js";

export default function ditoExtension(pi: ExtensionAPI): void {
  bootDitoPlugins(pi, DITO_PLUGINS);
}

export { DITO_PLUGINS, bootDitoPlugins };
