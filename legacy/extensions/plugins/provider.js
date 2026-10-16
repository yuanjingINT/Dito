import { registerProviders } from "../provider.js";
const providerPlugin = {
  id: "provider",
  name: "模型与供应商",
  description: "把配置里的自定义供应商注册进 pi，模型即插即用；内置供应商由 pi 原生鉴权接管。",
  icon: "model",
  version: "1.0.0",
  apply(ctx) {
    registerProviders(ctx.pi);
  }
};
export {
  providerPlugin
};
