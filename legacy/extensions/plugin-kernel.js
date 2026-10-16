import { loadConfig } from "./util.js";
class DitoContext {
  pi;
  /** 插件自己的配置节。 */
  config;
  eventMap = /* @__PURE__ */ new Map();
  serviceMap = /* @__PURE__ */ new Map();
  children = [];
  disposed = false;
  constructor(pi, config = {}) {
    this.pi = pi;
    this.config = config;
  }
  /** 订阅事件。返回取消订阅函数（Cordis 风格 ctx.on 返回值）。 */
  on(event, handler) {
    if (this.disposed) return () => {
    };
    let set = this.eventMap.get(event);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.eventMap.set(event, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }
  /** 同步派发事件。 */
  emit(event, payload) {
    const set = this.eventMap.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[dito] 插件事件处理失败（${event}）：`, err instanceof Error ? err.message : err);
      }
    }
  }
  /** 提供服务（Cordis ctx.provide）。服务是惰性的，覆盖时后写覆盖先写。 */
  provide(name, service) {
    this.serviceMap.set(name, service);
  }
  /** 获取服务（Cordis ctx.get / ctx.service 的简化版）。 */
  service(name) {
    return this.serviceMap.get(name);
  }
  /** 加载一个子插件（嵌套组合用）。返回该插件的销毁函数。 */
  plugin(plugin) {
    const child = new DitoContext(this.pi, plugin.config);
    this.children.push(child);
    plugin.apply(child, plugin.config);
    return () => {
      child.dispose();
      this.children = this.children.filter((c) => c !== child);
    };
  }
  /** 销毁上下文：递归销毁所有子插件，触发 dispose 事件并清空事件/服务。 */
  dispose() {
    if (this.disposed) return;
    this.emit("dispose", void 0);
    for (const child of [...this.children]) child.dispose();
    this.children = [];
    this.eventMap.clear();
    this.serviceMap.clear();
    this.disposed = true;
  }
}
function pluginConfig(cfg, plugin) {
  const plugins = cfg.plugins;
  const section = plugins[plugin.id];
  return section ?? { enabled: true };
}
function isPluginEnabled(cfg, plugin) {
  if (plugin.alwaysOn) return true;
  return pluginConfig(cfg, plugin).enabled !== false;
}
function topoSortPlugins(plugins) {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const out = [];
  const visit = (p) => {
    if (visited.has(p.id)) return;
    if (visiting.has(p.id)) {
      throw new Error(`插件依赖存在环：${p.id}`);
    }
    visiting.add(p.id);
    for (const dep of p.dependencies ?? []) {
      const depPlugin = byId.get(dep);
      if (depPlugin) visit(depPlugin);
    }
    visiting.delete(p.id);
    visited.add(p.id);
    out.push(p);
  };
  for (const p of plugins) visit(p);
  return out;
}
function bootDitoPlugins(pi, plugins) {
  const cfg = loadConfig();
  const root = new DitoContext(pi);
  const ordered = topoSortPlugins(plugins);
  for (const plugin of ordered) {
    if (!isPluginEnabled(cfg, plugin)) {
      root.emit("plugin:skip", { id: plugin.id, reason: "disabled" });
      continue;
    }
    root.emit("plugin:before", { id: plugin.id, name: plugin.name });
    try {
      plugin.apply(root, pluginConfig(cfg, plugin));
      root.emit("plugin:after", { id: plugin.id, name: plugin.name });
    } catch (err) {
      root.emit("plugin:error", { id: plugin.id, error: err });
      console.error(
        `[dito] 插件「${plugin.name}(${plugin.id})」加载失败：`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return root;
}
export {
  DitoContext,
  bootDitoPlugins,
  isPluginEnabled,
  pluginConfig,
  topoSortPlugins
};
