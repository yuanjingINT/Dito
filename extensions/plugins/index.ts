/**
 * Dito 插件清单。
 * 顺序即默认加载顺序（拓扑排序会在此基础上保证依赖先加载）。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import { providerPlugin } from "./provider.js";
import { personaPlugin } from "./persona.js";
import { systemPlugin } from "./system.js";
import { modePlugin } from "./mode.js";
import { knowledgeBasePlugin } from "./knowledge-base.js";
import { memoryPlugin } from "./memory.js";
import { webSearchPlugin } from "./web-search.js";
import { permissionPlugin } from "./permission.js";
import { askPlugin } from "./ask.js";
import { voicePlugin } from "./voice.js";

export const DITO_PLUGINS: DitoPlugin[] = [
  providerPlugin,
  personaPlugin,
  systemPlugin,
  modePlugin,
  knowledgeBasePlugin,
  memoryPlugin,
  webSearchPlugin,
  permissionPlugin,
  askPlugin,
  voicePlugin,
];
