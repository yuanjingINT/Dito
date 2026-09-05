/**
 * 插件：提示词设定。
 * 注入 Dito 人设 + 用户身份，注册 /persona、/identity 切换命令。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import personaExtension from "../persona.js";

export const personaPlugin: DitoPlugin = {
  id: "persona",
  name: "提示词设定",
  description: "把 Dito 人设与用户身份注入系统提示词，并提供 /persona、/identity 切换命令。",
  icon: "persona",
  version: "1.0.0",
  apply(ctx) {
    personaExtension(ctx.pi);
  },
};
