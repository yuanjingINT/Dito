/**
 * Dito 插件内核（Cordis 风格）。
 *
 * 学习 DeepSeek Harness 的 Cordis 内核设计：
 * - 内核只负责插件的加载、卸载和依赖关系，不承载任何 Agent 能力。
 * - 每个能力（模型、人格、模式、知识库、记忆、搜索、权限、提问、语音）都是一个插件。
 * - 插件通过 Context 上的事件与服务彼此协作；插件可以在配置层启用/停用，自由组合。
 *
 * 与 Cordis 的对应关系：
 *   Cordis Context     -> DitoContext（事件、服务、子插件、销毁）
 *   Cordis plugin fn   -> DitoPlugin.apply(ctx, config)
 *   config 组合        -> ~/.pi/agent/dito/config.json 的 plugins.<id>.enabled
 *   dependency graph   -> DitoPlugin.dependencies + 拓扑排序
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type DitoConfig } from "./util.js";

// ── 类型 ────────────────────────────────────────────────────────

/** 插件可读取的配置节（对应 config.plugins.<id>）。 */
export type PluginConfig = Record<string, unknown> & { enabled?: boolean };

export interface DitoPlugin {
  /** 插件唯一 id，对应 config.plugins.<id>。 */
  id: string;
  name: string;
  description: string;
  /** 前端图标 key（由 web UI 映射为 SVG）。 */
  icon: string;
  version?: string;
  /** 核心插件不可停用（目前全部可停用，保留字段给未来内核服务）。 */
  alwaysOn?: boolean;
  /** 依赖的插件 id 列表：加载时会先于本插件被应用。 */
  dependencies?: string[];
  /** 应用插件：在 pi 上注册工具/命令/事件钩子，或提供 Context 服务。 */
  apply(ctx: DitoContext, config: PluginConfig): void;
}

// ── Context（Cordis Context 的轻量实现） ─────────────────────────

type EventHandler = (payload: unknown) => void;

export class DitoContext {
  readonly pi: ExtensionAPI;
  /** 插件自己的配置节。 */
  readonly config: PluginConfig;
  private eventMap = new Map<string, Set<EventHandler>>();
  private serviceMap = new Map<string, unknown>();
  private children: DitoContext[] = [];
  private disposed = false;

  constructor(pi: ExtensionAPI, config: PluginConfig = {}) {
    this.pi = pi;
    this.config = config;
  }

  /** 订阅事件。返回取消订阅函数（Cordis 风格 ctx.on 返回值）。 */
  on(event: string, handler: EventHandler): () => void {
    if (this.disposed) return () => {};
    let set = this.eventMap.get(event);
    if (!set) {
      set = new Set();
      this.eventMap.set(event, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** 同步派发事件。 */
  emit(event: string, payload: unknown): void {
    const set = this.eventMap.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // 插件事件错误不应让整个内核崩溃
        console.error(`[dito] 插件事件处理失败（${event}）：`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** 提供服务（Cordis ctx.provide）。服务是惰性的，覆盖时后写覆盖先写。 */
  provide(name: string, service: unknown): void {
    this.serviceMap.set(name, service);
  }

  /** 获取服务（Cordis ctx.get / ctx.service 的简化版）。 */
  service<T = unknown>(name: string): T | undefined {
    return this.serviceMap.get(name) as T | undefined;
  }

  /** 加载一个子插件（嵌套组合用）。返回该插件的销毁函数。 */
  plugin(plugin: DitoPlugin): () => void {
    const child = new DitoContext(this.pi, plugin.config as PluginConfig);
    this.children.push(child);
    plugin.apply(child, plugin.config as PluginConfig);
    return () => {
      child.dispose();
      this.children = this.children.filter((c) => c !== child);
    };
  }

  /** 销毁上下文：递归销毁所有子插件，触发 dispose 事件并清空事件/服务。 */
  dispose(): void {
    if (this.disposed) return;
    this.emit("dispose", undefined);
    for (const child of [...this.children]) child.dispose();
    this.children = [];
    this.eventMap.clear();
    this.serviceMap.clear();
    this.disposed = true;
  }
}

// ── 内核（加载器） ──────────────────────────────────────────────

/** 读取插件配置节（带默认值）。 */
export function pluginConfig(cfg: DitoConfig, plugin: DitoPlugin): PluginConfig {
  const plugins = cfg.plugins as Record<string, { enabled?: boolean } | undefined>;
  const section = plugins[plugin.id];
  return (section ?? { enabled: true }) as PluginConfig;
}

/** 插件是否启用：config.plugins.<id>.enabled 默认 true。 */
export function isPluginEnabled(cfg: DitoConfig, plugin: DitoPlugin): boolean {
  if (plugin.alwaysOn) return true;
  return pluginConfig(cfg, plugin).enabled !== false;
}

/** 拓扑排序：依赖插件在前，同层保持声明顺序（稳定）。 */
export function topoSortPlugins(plugins: DitoPlugin[]): DitoPlugin[] {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const out: DitoPlugin[] = [];

  const visit = (p: DitoPlugin): void => {
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

/**
 * 引导 Dito 插件系统。
 * 返回根 Context；调用方可以 ctx.dispose() 卸载全部插件。
 */
export function bootDitoPlugins(pi: ExtensionAPI, plugins: DitoPlugin[]): DitoContext {
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
        err instanceof Error ? err.message : err,
      );
    }
  }
  return root;
}
