/**
 * Dito 插件目录与首次启动安装器。
 *
 * 插件本体随 Dito 一起发布，安装器负责选择启用哪些模块并持久化选择。
 * 这样频道、能力和终端入口共用同一份插件状态，后续可以在不改主程序的
 * 情况下继续增加插件。
 */
import {
  Key,
  ProcessTerminal,
  TuiAltScreen,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ditoUserDir,
  loadConfig,
  saveConfig,
  type DitoConfig,
} from "../extensions/util.js";

export type PluginKind = "core" | "capability" | "channel" | "integration";

export interface PluginSpec {
  id: string;
  name: string;
  description: string;
  kind: PluginKind;
  /** 对应 config.plugins.<configKey>.enabled 的能力插件。 */
  configKey?: string;
  /** 依赖会随本插件自动选中。 */
  dependencies?: string[];
  /** 核心插件不可停用。 */
  alwaysOn?: boolean;
  /** 首次安装时是否默认勾选。 */
  defaultInstalled?: boolean;
}

/**
 * 所有可安装模块的单一目录。
 * provider/persona 等已经是 DitoPlugin 的能力插件；QQ、Matrix、Bridge
 * 等进程入口也通过同一目录管理，因此用户面对的是一套插件模型。
 */
export const PLUGIN_CATALOG: readonly PluginSpec[] = [
  { id: "tui", name: "终端工作台", description: "浏览器式会话标签、对话区和 Bash 面板。", kind: "core", alwaysOn: true },
  { id: "provider", name: "模型与供应商", description: "模型供应商、聊天模型和视觉模型。", kind: "capability", configKey: "provider", defaultInstalled: true },
  { id: "persona", name: "人格与身份", description: "Dito 人设、身份和系统提示词。", kind: "capability", configKey: "persona", defaultInstalled: true },
  { id: "system", name: "系统工具", description: "文件、命令和会话基础能力。", kind: "capability", configKey: "system", defaultInstalled: true },
  { id: "mode", name: "运行模式", description: "闲聊、标准和计划模式。", kind: "capability", configKey: "mode", defaultInstalled: true },
  { id: "knowledge_base", name: "知识库", description: "本地知识库与检索工具。", kind: "capability", configKey: "knowledge_base", defaultInstalled: true },
  { id: "memory", name: "长期记忆", description: "跨会话记忆和自动日记。", kind: "capability", configKey: "memory", defaultInstalled: true },
  { id: "web_search", name: "网络搜索", description: "联网搜索和网页内容读取。", kind: "capability", configKey: "web_search", defaultInstalled: true },
  { id: "permission", name: "权限门", description: "高危命令确认和 sudo 模式。", kind: "capability", configKey: "permission", defaultInstalled: true },
  { id: "ask", name: "交互提问", description: "工具需要决定时弹出选择和确认。", kind: "capability", configKey: "ask", defaultInstalled: true },
  { id: "voice", name: "语音对话", description: "录音、语音识别和语音合成。", kind: "capability", configKey: "voice", defaultInstalled: true },
  { id: "snowluma", name: "SnowLuma 工具", description: "QQ OneBot 动作、表情和群操作工具。", kind: "integration", configKey: "snowluma", defaultInstalled: false },
  { id: "mcp", name: "MCP", description: "接入外部 MCP，并可运行 MCP 服务端。", kind: "integration", configKey: "mcp", defaultInstalled: true },
  { id: "qq", name: "QQ 频道", description: "通过 OneBot/SnowLuma 收发 QQ 私聊和群消息。", kind: "channel", dependencies: ["snowluma"], defaultInstalled: false },
  { id: "matrix", name: "Matrix 频道", description: "连接 Matrix 房间，支持 E2EE。", kind: "channel", defaultInstalled: false },
  { id: "bridge", name: "QQ ↔ Matrix Bridge", description: "把 QQ 群和 Matrix 房间双向互联。", kind: "channel", dependencies: ["qq", "matrix"], defaultInstalled: false },
  { id: "mobile", name: "手机中继", description: "通过扫码配对把手机接入 Dito。", kind: "channel", defaultInstalled: false },
];

const CATALOG_BY_ID = new Map(PLUGIN_CATALOG.map((plugin) => [plugin.id, plugin]));
const CHANNEL_IDS = new Set(["qq", "matrix", "mobile"]);

export interface PluginPickerResult {
  installed: string[];
  cancelled: boolean;
}

export interface PluginInstallOptions {
  /** 覆盖默认的 TTY 检测，便于测试或由其它 UI 调用。 */
  interactive?: boolean;
  /** 已初始化时再次打开选择器。 */
  force?: boolean;
  terminal?: Terminal;
}

function configSection(cfg: DitoConfig, id: string): { enabled?: boolean } | undefined {
  const plugins = cfg.plugins as unknown as Record<string, { enabled?: boolean } | undefined>;
  return plugins[id];
}

function hasLegacyBridgeConfig(): boolean {
  return existsSync(join(ditoUserDir(), "bridge", "config.json"));
}

/** 根据旧配置推导首次启动时的勾选项，升级用户不会丢失已经启用的频道。 */
export function initialPluginSelection(cfg: DitoConfig): string[] {
  const selected = new Set<string>();
  for (const plugin of PLUGIN_CATALOG) {
    if (plugin.alwaysOn) {
      selected.add(plugin.id);
      continue;
    }
    if (plugin.id === "qq" || plugin.id === "matrix" || plugin.id === "mobile") {
      if (cfg.channels[plugin.id].enabled) selected.add(plugin.id);
      continue;
    }
    if (plugin.id === "bridge") {
      if (hasLegacyBridgeConfig()) selected.add(plugin.id);
      continue;
    }
    const section = configSection(cfg, plugin.configKey ?? plugin.id);
    // defaultInstalled 是首次安装策略；配置节存在并不代表可选插件应该默认启用
    //（例如 snowluma 只有选中 QQ 后才需要）。
    if (plugin.defaultInstalled && section?.enabled !== false) selected.add(plugin.id);
  }
  return [...dependencyClosure(selected)];
}

/** 将依赖补齐，并在移除依赖时同时移除依赖它的插件。 */
export function normalizePluginSelection(ids: Iterable<string>): Set<string> {
  const selected = new Set<string>();
  for (const id of ids) if (CATALOG_BY_ID.has(id)) selected.add(id);
  for (const plugin of PLUGIN_CATALOG) if (plugin.alwaysOn) selected.add(plugin.id);
  return dependencyClosure(selected);
}

function dependencyClosure(input: Set<string>): Set<string> {
  const selected = new Set(input);
  let changed = true;
  while (changed) {
    changed = false;
    for (const plugin of PLUGIN_CATALOG) {
      if (!selected.has(plugin.id)) continue;
      for (const dependency of plugin.dependencies ?? []) {
        if (!selected.has(dependency)) {
          selected.add(dependency);
          changed = true;
        }
      }
    }
  }
  return selected;
}

/**
 * 把选择写回配置。该函数是纯配置变更入口，命令行、Web UI 和测试都可以复用。
 */
export function applyPluginSelection(cfg: DitoConfig, ids: Iterable<string>): string[] {
  const selected = normalizePluginSelection(ids);
  const enabled = (id: string): boolean => selected.has(id);
  for (const plugin of PLUGIN_CATALOG) {
    if (!plugin.configKey) continue;
    const section = configSection(cfg, plugin.configKey);
    if (section) section.enabled = enabled(plugin.id);
  }
  for (const channel of CHANNEL_IDS) {
    cfg.channels[channel as "qq" | "matrix" | "mobile"].enabled = enabled(channel);
  }
  cfg.plugins.manager = {
    version: 1,
    initialized: true,
    installed: PLUGIN_CATALOG.filter((plugin) => selected.has(plugin.id)).map((plugin) => plugin.id),
  };
  return [...cfg.plugins.manager.installed];
}

function currentSelection(cfg: DitoConfig): string[] {
  if (cfg.plugins.manager.initialized && Array.isArray(cfg.plugins.manager.installed)) {
    return cfg.plugins.manager.installed;
  }
  return initialPluginSelection(cfg);
}

const A = "\x1b[38;2;100;210;235m";
const B = "\x1b[38;2;155;235;255m";
const DIM = "\x1b[90m";
const GREEN = "\x1b[38;2;126;216;163m";
const RESET = "\x1b[0m";

class PluginPicker implements Component {
  private cursor = 0;
  private selected: Set<string>;
  private done = false;
  onDone?: (result: PluginPickerResult) => void;

  constructor(initial: Iterable<string>) {
    this.selected = normalizePluginSelection(initial);
    while (this.cursor < PLUGIN_CATALOG.length && PLUGIN_CATALOG[this.cursor]?.alwaysOn) this.cursor++;
    if (this.cursor >= PLUGIN_CATALOG.length) this.cursor = 0;
  }

  invalidate(): void {}

  private finish(cancelled: boolean): void {
    if (this.done) return;
    this.done = true;
    this.onDone?.({ installed: [...this.selected], cancelled });
  }

  private move(step: number): void {
    const start = this.cursor;
    do {
      this.cursor = (this.cursor + step + PLUGIN_CATALOG.length) % PLUGIN_CATALOG.length;
    } while (PLUGIN_CATALOG[this.cursor]?.alwaysOn && this.cursor !== start);
  }

  private toggle(): void {
    const plugin = PLUGIN_CATALOG[this.cursor];
    if (!plugin || plugin.alwaysOn) return;
    if (this.selected.has(plugin.id)) {
      this.selected.delete(plugin.id);
      // 依赖仍被其它已选插件使用时保留，否则一并移除。
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of PLUGIN_CATALOG) {
          if (!this.selected.has(candidate.id) || !candidate.dependencies?.length) continue;
          if (candidate.dependencies.some((dependency) => !this.selected.has(dependency))) {
            this.selected.delete(candidate.id);
            changed = true;
          }
        }
      }
    } else {
      this.selected = normalizePluginSelection([...this.selected, plugin.id]);
    }
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.space)) this.toggle();
    else if (matchesKey(data, Key.enter)) this.finish(false);
    else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.finish(true);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const lines: string[] = [
      truncateToWidth(`${B}◈ Dito 插件安装${RESET}`, safeWidth),
      truncateToWidth(`${DIM}首次启动请选择要启用的模块。依赖会自动勾选，Enter 保存，Esc 使用当前选择。${RESET}`, safeWidth),
      "",
    ];
    for (let i = 0; i < PLUGIN_CATALOG.length; i++) {
      const plugin = PLUGIN_CATALOG[i];
      const active = this.selected.has(plugin.id);
      const focused = i === this.cursor;
      const mark = active ? `${GREEN}[x]${RESET}` : `${DIM}[ ]${RESET}`;
      const pointer = focused ? `${A}›${RESET}` : " ";
      const dependency = plugin.dependencies?.length ? ` ${DIM}· 依赖 ${plugin.dependencies.join(", ")}${RESET}` : "";
      const line = `${pointer} ${mark} ${focused ? B : ""}${plugin.name}${RESET} ${DIM}(${plugin.id})${RESET} ${DIM}${plugin.description}${RESET}${dependency}`;
      lines.push(truncateToWidth(line, safeWidth));
    }
    lines.push("", truncateToWidth(`${DIM}↑/↓ 移动  Space 选择  Enter 保存  Esc 保持当前选择${RESET}`, safeWidth));
    return lines;
  }
}

async function pickPlugins(initial: string[], terminal: Terminal): Promise<PluginPickerResult> {
  const picker = new PluginPicker(initial);
  const tui = new TuiAltScreen(terminal, true);
  tui.addChild(picker);
  tui.setFocus(picker);
  const result = new Promise<PluginPickerResult>((resolve) => { picker.onDone = resolve; });
  tui.start();
  try {
    return await result;
  } finally {
    tui.stop();
  }
}

/** 确保插件安装状态存在；默认启动只在第一次进入时显示一次选择器。 */
export async function ensurePluginInstallation(options: PluginInstallOptions = {}): Promise<PluginInstallResult> {
  const cfg = loadConfig();
  const wasInitialized = cfg.plugins.manager.initialized === true;
  const needsInstall = options.force === true || !wasInitialized;
  if (!needsInstall) {
    return { installed: [...cfg.plugins.manager.installed], firstRun: false, changed: false, cancelled: false };
  }
  const initial = currentSelection(cfg);
  const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  let result: PluginPickerResult;
  if (interactive) {
    result = await pickPlugins(initial, options.terminal ?? new ProcessTerminal());
  } else {
    result = { installed: initial, cancelled: false };
    if (options.force) {
      console.error("插件选择需要真实终端；已保持当前插件选择。请在终端运行 `dito plugins`。 ");
    }
  }
  const before = wasInitialized ? [...cfg.plugins.manager.installed] : [];
  const installed = applyPluginSelection(cfg, result.installed);
  saveConfig(cfg);
  return {
    installed,
    firstRun: !wasInitialized,
    changed: before.join("\0") !== installed.join("\0"),
    cancelled: result.cancelled,
  };
}

export interface PluginInstallResult {
  installed: string[];
  firstRun: boolean;
  changed: boolean;
  cancelled: boolean;
}
