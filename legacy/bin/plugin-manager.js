import {
  Key,
  ProcessTerminal,
  TuiAltScreen,
  isKeyRelease,
  matchesKey,
  truncateToWidth
} from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ditoUserDir,
  loadConfig,
  saveConfig
} from "../extensions/util.js";
const PLUGIN_CATALOG = [
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
  { id: "dito-re", name: "QQ 智能自动回复", description: "按爱好主题概率回复、识别对 Dito 的直接对话、整合群聊上下文。", kind: "capability", configKey: "dito-re", defaultInstalled: true },
  { id: "subagent", name: "子代理调度", description: "按工作内容、模型价格和预算分配隔离子代理，最多 100 个。", kind: "capability", configKey: "subagent", defaultInstalled: true },
  { id: "mcp", name: "MCP", description: "接入外部 MCP，并可运行 MCP 服务端。", kind: "integration", configKey: "mcp", defaultInstalled: true },
  { id: "qq", name: "QQ 频道", description: "通过 OneBot/SnowLuma 收发 QQ 私聊和群消息。", kind: "channel", dependencies: ["snowluma"], defaultInstalled: false },
  { id: "matrix", name: "Matrix 频道", description: "连接 Matrix 房间，支持 E2EE。", kind: "channel", defaultInstalled: false },
  { id: "bridge", name: "QQ ↔ Matrix Bridge", description: "把 QQ 群和 Matrix 房间双向互联。", kind: "channel", dependencies: ["qq", "matrix"], defaultInstalled: false },
  { id: "mobile", name: "手机中继", description: "通过扫码配对把手机接入 Dito。", kind: "channel", defaultInstalled: false }
];
const CATALOG_BY_ID = new Map(PLUGIN_CATALOG.map((plugin) => [plugin.id, plugin]));
const CHANNEL_IDS = /* @__PURE__ */ new Set(["qq", "matrix", "mobile"]);
function configSection(cfg, id) {
  const plugins = cfg.plugins;
  return plugins[id];
}
function hasLegacyBridgeConfig() {
  return existsSync(join(ditoUserDir(), "bridge", "config.json"));
}
function initialPluginSelection(cfg) {
  const selected = /* @__PURE__ */ new Set();
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
    if (plugin.defaultInstalled && section?.enabled !== false) selected.add(plugin.id);
  }
  return [...dependencyClosure(selected)];
}
function normalizePluginSelection(ids) {
  const selected = /* @__PURE__ */ new Set();
  for (const id of ids) if (CATALOG_BY_ID.has(id)) selected.add(id);
  for (const plugin of PLUGIN_CATALOG) if (plugin.alwaysOn) selected.add(plugin.id);
  return dependencyClosure(selected);
}
function dependencyClosure(input) {
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
function applyPluginSelection(cfg, ids) {
  const selected = normalizePluginSelection(ids);
  const enabled = (id) => selected.has(id);
  for (const plugin of PLUGIN_CATALOG) {
    if (!plugin.configKey) continue;
    const section = configSection(cfg, plugin.configKey);
    if (section) section.enabled = enabled(plugin.id);
  }
  for (const channel of CHANNEL_IDS) {
    cfg.channels[channel].enabled = enabled(channel);
  }
  cfg.plugins.manager = {
    version: 1,
    initialized: true,
    installed: PLUGIN_CATALOG.filter((plugin) => selected.has(plugin.id)).map((plugin) => plugin.id)
  };
  return [...cfg.plugins.manager.installed];
}
function currentSelection(cfg) {
  if (cfg.plugins.manager.initialized && Array.isArray(cfg.plugins.manager.installed)) {
    return cfg.plugins.manager.installed;
  }
  return initialPluginSelection(cfg);
}
const A = "\x1B[38;2;100;210;235m";
const B = "\x1B[38;2;155;235;255m";
const DIM = "\x1B[90m";
const GREEN = "\x1B[38;2;126;216;163m";
const RESET = "\x1B[0m";
class PluginPicker {
  cursor = 0;
  selected;
  done = false;
  onDone;
  constructor(initial) {
    this.selected = normalizePluginSelection(initial);
    while (this.cursor < PLUGIN_CATALOG.length && PLUGIN_CATALOG[this.cursor]?.alwaysOn) this.cursor++;
    if (this.cursor >= PLUGIN_CATALOG.length) this.cursor = 0;
  }
  invalidate() {
  }
  finish(cancelled) {
    if (this.done) return;
    this.done = true;
    this.onDone?.({ installed: [...this.selected], cancelled });
  }
  move(step) {
    const start = this.cursor;
    do {
      this.cursor = (this.cursor + step + PLUGIN_CATALOG.length) % PLUGIN_CATALOG.length;
    } while (PLUGIN_CATALOG[this.cursor]?.alwaysOn && this.cursor !== start);
  }
  toggle() {
    const plugin = PLUGIN_CATALOG[this.cursor];
    if (!plugin || plugin.alwaysOn) return;
    if (this.selected.has(plugin.id)) {
      this.selected.delete(plugin.id);
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
  handleInput(data) {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.space)) this.toggle();
    else if (matchesKey(data, Key.enter)) this.finish(false);
    else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.finish(true);
  }
  render(width) {
    const safeWidth = Math.max(20, width);
    const lines = [
      truncateToWidth(`${B}◈ Dito 插件安装${RESET}`, safeWidth),
      truncateToWidth(`${DIM}首次启动请选择要启用的模块。依赖会自动勾选，Enter 保存，Esc 使用当前选择。${RESET}`, safeWidth),
      ""
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
async function pickPlugins(initial, terminal) {
  const picker = new PluginPicker(initial);
  const tui = new TuiAltScreen(terminal, true);
  tui.addChild(picker);
  tui.setFocus(picker);
  const result = new Promise((resolve) => {
    picker.onDone = resolve;
  });
  tui.start();
  try {
    return await result;
  } finally {
    tui.stop();
  }
}
async function ensurePluginInstallation(options = {}) {
  const cfg = loadConfig();
  const wasInitialized = cfg.plugins.manager.initialized === true;
  const needsInstall = options.force === true || !wasInitialized;
  if (!needsInstall) {
    return { installed: [...cfg.plugins.manager.installed], firstRun: false, changed: false, cancelled: false };
  }
  const initial = currentSelection(cfg);
  const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  let result;
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
    cancelled: result.cancelled
  };
}
export {
  PLUGIN_CATALOG,
  applyPluginSelection,
  ensurePluginInstallation,
  initialPluginSelection,
  normalizePluginSelection
};
