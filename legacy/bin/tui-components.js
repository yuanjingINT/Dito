import {
  Markdown,
  ScrollView,
  Text,
  VStack,
  parseKey,
  isKeyRelease,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi
} from "@earendil-works/pi-tui";
import { StreamingMarkdown, terminalText } from "./stream-render.js";
const C = {
  reset: "\x1B[0m",
  dim: "\x1B[38;2;140;146;156m",
  muted: "\x1B[38;2;83;91;105m",
  accent: "\x1B[38;2;118;210;233m",
  text: "\x1B[38;2;219;224;232m",
  green: "\x1B[38;2;136;204;151m",
  yellow: "\x1B[38;2;228;194;125m",
  red: "\x1B[38;2;234;142;142m",
  bold: "\x1B[1m",
  italic: "\x1B[3m",
  navBg: "\x1B[48;2;22;25;31m",
  panelBg: "\x1B[48;2;33;38;47m"
};
const color = (code) => (text) => `${code}${text}${C.reset}`;
const markdownTheme = {
  heading: color(C.text + C.bold),
  link: color(C.accent),
  linkUrl: color(C.dim),
  code: color(C.accent),
  codeBlock: color(C.text),
  codeBlockBorder: color(C.muted),
  quote: color(C.dim),
  quoteBorder: color(C.muted),
  hr: color(C.muted),
  listBullet: color(C.accent),
  bold: color(C.bold),
  italic: color(C.italic),
  strikethrough: color("\x1B[9m"),
  underline: color("\x1B[4m")
};
const thinkingMarkdownTheme = {
  heading: color(C.dim + C.bold),
  link: color(C.dim),
  linkUrl: color(C.muted),
  code: color(C.dim),
  codeBlock: color(C.dim),
  codeBlockBorder: color(C.muted),
  quote: color(C.dim),
  quoteBorder: color(C.muted),
  hr: color(C.muted),
  listBullet: color(C.muted),
  bold: color(C.dim + C.bold),
  italic: color(C.dim + C.italic),
  strikethrough: color("\x1B[9m" + C.dim),
  underline: color("\x1B[4m" + C.dim)
};
function plainText(text) {
  return terminalText(text);
}
function singleLine(text) {
  return plainText(text).replace(/\s+/g, " ").trim();
}
function filledLine(text, width, background = C.navBg) {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return `${background}${clipped.replaceAll(C.reset, C.reset + background)}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${C.reset}`;
}
function balancedLine(left, right, width) {
  const rightWidth = visibleWidth(right);
  const available = Math.max(0, width - rightWidth - 1);
  const clipped = truncateToWidth(left, available, "…");
  if (rightWidth >= width) return truncateToWidth(left, width, "…");
  return clipped + " ".repeat(Math.max(1, width - visibleWidth(clipped) - rightWidth)) + right;
}
function messageText(message) {
  if (typeof message.content === "string") return plainText(message.content);
  if (!Array.isArray(message.content)) return "";
  return message.content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const b = block;
    return b.type === "image" ? "[图片]" : b.type === "text" && typeof b.text === "string" ? plainText(b.text) : "";
  }).filter(Boolean).join("\n");
}
function argsSummary(args) {
  if (args == null) return "";
  try {
    return singleLine(typeof args === "string" ? args : JSON.stringify(args));
  } catch {
    return singleLine(String(args));
  }
}
function isBashTool(name) {
  return /^(bash|pc_bash|shell)$|(?:^|[_-])bash(?:$|[_-])/i.test(name);
}
function bashCommand(args) {
  if (typeof args === "string") return plainText(args);
  if (args && typeof args === "object") {
    const a = args;
    for (const key of ["command", "cmd", "script"]) if (typeof a[key] === "string") return plainText(a[key]);
  }
  return argsSummary(args);
}
function toolOutput(result) {
  if (typeof result === "string") return plainText(result);
  if (!result || typeof result !== "object") return "";
  const r = result;
  if (typeof r.output === "string") return plainText(r.output);
  if (typeof r.stdout === "string") return plainText(r.stdout + (typeof r.stderr === "string" ? r.stderr : ""));
  return messageText(r);
}
function compactBashProgress(text) {
  const lines = text.split("\n");
  const compacted = [];
  let previousProgress = false;
  for (const line of lines) {
    const normalized = line.replace(/^[⠋-⣿]\s*/, "").trim();
    const progress = normalized === "执行中";
    if (progress && previousProgress) continue;
    compacted.push(progress ? line.replace(/^[⠋-⣿]\s*/, "") : line);
    previousProgress = progress;
  }
  return compacted.join("\n");
}
class MessageBlock {
  constructor(kind, text) {
    this.kind = kind;
    this.body = new StreamingMarkdown(kind === "thinking" ? thinkingMarkdownTheme : markdownTheme, text);
  }
  kind;
  body;
  thinkingExpanded = false;
  setText(text) {
    this.body.setText(text);
  }
  append(text) {
    this.body.append(text);
  }
  finish() {
    this.body.finish();
  }
  get isThinking() {
    return this.kind === "thinking";
  }
  toggleThinking() {
    if (this.isThinking) this.thinkingExpanded = !this.thinkingExpanded;
  }
  invalidate() {
    this.body.invalidate();
  }
  render(width) {
    const inner = Math.max(1, width - 4);
    const label = this.kind === "user" ? `${C.accent}${C.bold}你${C.reset}` : this.kind === "thinking" ? `${C.dim}◇ 思考${C.reset}` : `${C.text}${C.bold}Dito${C.reset}`;
    if (this.isThinking && !this.thinkingExpanded) {
      return ["", ` ${label} ${C.muted}（点击展开）${C.reset}`, ""];
    }
    const lines = [` ${label}${this.isThinking ? ` ${C.muted}（点击收起）${C.reset}` : ""}`, ...this.body.render(inner).map((line) => ` ${line}`)];
    if (this.kind === "user") return ["", ...lines.map((line) => filledLine(line, width, C.panelBg)), ""];
    return ["", ...lines.map((line) => truncateToWidth(line, width, "…")), ""];
  }
}
class ToolBlock {
  constructor(name, args, state) {
    this.name = name;
    this.args = args;
    this.state = state;
  }
  name;
  args;
  state;
  body = new Markdown("", 0, 0, markdownTheme);
  expanded = false;
  output = "";
  toggle() {
    this.expanded = !this.expanded;
  }
  update(result, state) {
    if (state) this.state = state;
    this.output = toolOutput(result);
    const cap = 48 * 1024;
    this.body.setText(this.name === "subagent" || this.output.length <= cap ? this.output : `${this.output.slice(0, cap)}

[后续工具输出已省略]`);
  }
  invalidate() {
    this.body.invalidate();
  }
  render(width) {
    const status = this.state === "running" ? `${C.yellow}● 运行中` : this.state === "error" ? `${C.red}× 失败` : `${C.green}✓ 完成`;
    const preview = this.output && (this.state === "running" || this.name === "subagent") ? singleLine(this.output.split("\n")[0]) : argsSummary(this.args);
    const hint = this.expanded ? "点击收起" : "点击展开";
    const header = truncateToWidth(`  ${C.dim}◇ ${this.name}${C.reset} ${status}${C.reset} ${C.muted}（${hint}）${preview ? ` ${preview}` : ""}${C.reset}`, width, "…");
    if (!this.expanded) return [header];
    const inner = Math.max(1, width - 4);
    const args = argsSummary(this.args);
    const lines = args ? wrapTextWithAnsi(`${C.dim}参数：${args}${C.reset}`, inner) : [];
    lines.push(...this.output ? this.body.render(inner) : [`${C.dim}${this.state === "running" ? "等待输出…" : "（无文本输出）"}${C.reset}`]);
    return [header, ...lines.map((line) => truncateToWidth(`    ${line}`, width, "…"))];
  }
}
class ConversationView {
  blocks = [];
  streaming = /* @__PURE__ */ new Map();
  legacyIndex = -1;
  assistantStart = 0;
  thinkingHits = [];
  toolHits = [];
  tools = /* @__PURE__ */ new Map();
  reset(messages) {
    this.blocks = [];
    this.tools.clear();
    this.thinkingHits = [];
    this.toolHits = [];
    this.beginAssistant();
    for (const raw of messages) {
      const message = raw;
      if (message.role === "user") this.addUser(messageText(message));
      else if (message.role === "assistant") {
        this.beginAssistant();
        if (Array.isArray(message.content)) {
          for (const [index, rawBlock] of message.content.entries()) {
            const block = rawBlock;
            if (block?.type === "thinking" && typeof block.thinking === "string") this.streamBlock("thinking", index).setText(block.thinking);
            else if (block?.type === "text" && typeof block.text === "string") this.streamBlock("assistant", index).setText(block.text);
            else if (block?.type === "toolCall" && typeof block.name === "string") {
              this.addTool(block.name, block.arguments, typeof block.id === "string" ? block.id : void 0, "done");
            }
          }
        } else this.appendAssistant(messageText(message));
      } else if (message.role === "toolResult" && message.toolCallId) {
        this.updateTool(message.toolCallId, message, message.isError ? "error" : "done");
      }
    }
    this.beginAssistant();
  }
  addUser(text) {
    this.blocks.push(new MessageBlock("user", text));
  }
  finishStreaming() {
    for (const block of this.streaming.values()) block.finish();
  }
  beginAssistant() {
    this.finishStreaming();
    this.streaming.clear();
    this.legacyIndex = -1;
    this.assistantStart = this.blocks.length;
  }
  streamBlock(kind, index) {
    if (index === void 0) {
      const previous = this.streaming.get(this.legacyIndex);
      if (previous?.kind !== kind) this.legacyIndex = Math.max(-1, ...this.streaming.keys()) + 1;
      index = this.legacyIndex;
    }
    let block = this.streaming.get(index);
    if (!block) {
      block = new MessageBlock(kind);
      this.streaming.set(index, block);
      this.blocks.push(block);
    }
    return block;
  }
  updateAssistant(event) {
    const kind = event.type.startsWith("thinking_") ? "thinking" : event.type.startsWith("text_") ? "assistant" : void 0;
    if (!kind) return;
    if (event.type.endsWith("_delta")) this.streamBlock(kind, event.contentIndex).append(event.delta ?? "");
    else if (event.type.endsWith("_end")) {
      const block = this.streamBlock(kind, event.contentIndex);
      if (event.content !== void 0) block.setText(event.content);
      else block.finish();
    }
  }
  appendAssistant(delta, index) {
    if (!delta) return;
    this.streamBlock("assistant", index).append(delta);
  }
  finishAssistant(message) {
    if (message.content === void 0) {
      this.finishStreaming();
      return;
    }
    const old = new Set(this.streaming.values());
    const ordered = [];
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: messageText(message) }];
    for (const [index, raw] of content.entries()) {
      const kind = raw?.type === "thinking" ? "thinking" : raw?.type === "text" ? "assistant" : void 0;
      const text = kind === "thinking" ? raw.thinking : raw?.text;
      if (!kind || typeof text !== "string" || !text) continue;
      let block = this.streaming.get(index);
      if (!block || block.kind !== kind || ordered.includes(block)) block = [...old].find((item) => item.kind === kind && !ordered.includes(item));
      block ??= new MessageBlock(kind);
      block.setText(text);
      ordered.push(block);
    }
    this.blocks = this.blocks.filter((block) => !old.has(block));
    this.blocks.splice(this.assistantStart, 0, ...ordered);
    this.streaming.clear();
  }
  appendThinking(delta, index) {
    if (!delta) return;
    this.streamBlock("thinking", index).append(delta);
  }
  addTool(name, args, id, state = "running") {
    if (id && this.tools.has(id)) return;
    if (!isBashTool(name)) {
      const block = new ToolBlock(name, args, state);
      this.blocks.push(block);
      if (id) this.tools.set(id, block);
      return;
    }
    const detail = singleLine(bashCommand(args));
    this.blocks.push(new Text(`${C.dim}  ◇ ${name}${detail ? `  ${truncateToWidth(detail, 100, "…")}` : ""}${C.reset}`, 0, 0));
  }
  updateTool(id, result, state) {
    this.tools.get(id)?.update(result, state);
  }
  notice(text) {
    this.blocks.push(new Text(`${C.dim}  ${plainText(text)}${C.reset}`, 0, 0));
  }
  /** Toggle only when the click lands on a thinking header in the rendered content. */
  toggleThinkingAt(row) {
    const hit = this.thinkingHits.find((item) => row >= item.start && row < item.end);
    if (!hit) return false;
    hit.block.toggleThinking();
    this.invalidate();
    return true;
  }
  isThinkingAt(row) {
    return this.thinkingHits.some((item) => row >= item.start && row < item.end);
  }
  isExpandableAt(row) {
    return this.isThinkingAt(row) || this.toolHits.some((hit) => hit.row === row);
  }
  toggleDetailsAt(row) {
    if (this.toggleThinkingAt(row)) return true;
    const hit = this.toolHits.find((item) => item.row === row);
    if (!hit) return false;
    hit.block.toggle();
    this.invalidate();
    return true;
  }
  invalidate() {
    this.blocks.forEach((block) => block.invalidate());
  }
  render(width) {
    if (!this.blocks.length) {
      const logo = `${C.accent}${C.bold}D I T O${C.reset}`;
      const center = (text) => " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) + text;
      const lines2 = ["", "", center(logo), "", center(`${C.dim}你的电脑搭档${C.reset}`), ""];
      if (width >= 55) lines2.push(center(`${C.muted}输入消息开始 · / 命令 · Alt+W 历史${C.reset}`));
      return lines2.map((line) => truncateToWidth(line, width, "…"));
    }
    this.thinkingHits = [];
    this.toolHits = [];
    const lines = [];
    for (const block of this.blocks) {
      const rendered = block.render(width);
      const start = lines.length;
      if (block instanceof MessageBlock && block.isThinking) {
        this.thinkingHits.push({ start: start + 1, end: start + 2, block });
      } else if (block instanceof ToolBlock) this.toolHits.push({ row: start, block });
      lines.push(...rendered);
    }
    return lines;
  }
}
class TabsBar {
  tabs = [];
  currentPath = "";
  hits = [];
  visiblePaths = [];
  setTabs(tabs, currentPath) {
    this.tabs = tabs;
    this.currentPath = currentPath;
  }
  pathAt(index) {
    return this.visiblePaths[index];
  }
  hitAt(column) {
    return this.hits.find((hit) => column >= hit.start && column < hit.end);
  }
  invalidate() {
  }
  render(width) {
    const brand = width >= 60 ? `${C.text}${C.bold} DITO ${C.reset}` : " ";
    const controls = width >= 90 ? `${C.dim} ≡ 历史 ${C.reset}${C.accent} + 新建 ${C.reset}` : `${C.dim} ≡ ${C.reset}${C.accent} + ${C.reset}`;
    const room = Math.max(1, width - visibleWidth(brand) - visibleWidth(controls));
    const count = Math.max(1, Math.min(this.tabs.length, 9, Math.floor(room / (width < 70 ? 20 : 22))));
    const active = Math.max(0, this.tabs.findIndex((tab) => tab.path === this.currentPath));
    const start = Math.max(0, Math.min(active - Math.floor(count / 2), this.tabs.length - count));
    const visible = this.tabs.slice(start, start + count);
    const cellWidth = Math.max(1, Math.floor(room / Math.max(1, visible.length)));
    let line = brand;
    let column = visibleWidth(brand);
    this.hits = [];
    this.visiblePaths = visible.map((tab) => tab.path);
    visible.forEach((tab, index) => {
      const selected = tab.path === this.currentPath;
      const label = singleLine(tab.preview) || (tab.draft ? "新会话" : "空会话");
      const title = truncateToWidth(`${index + 1} ${label}`, Math.max(1, cellWidth - 3), "…");
      const text = ` ${title}${" ".repeat(Math.max(0, cellWidth - visibleWidth(title) - 2))} `;
      line += selected ? filledLine(`${C.accent}${C.bold}${text}${C.reset}`, cellWidth, C.panelBg) : `${C.muted}${text}${C.reset}`;
      this.hits.push({ path: tab.path, start: column, end: column + cellWidth });
      column += cellWidth;
    });
    const controlStart = Math.max(column, width - visibleWidth(controls));
    line += " ".repeat(Math.max(0, controlStart - column)) + controls;
    const newWidth = width >= 90 ? 8 : 3;
    this.hits.push({ action: "history", start: controlStart, end: width - newWidth });
    this.hits.push({ action: "new", start: width - newWidth, end: width });
    return [filledLine(line, width)];
  }
}
class BashLog {
  entries = [];
  get running() {
    return this.entries.some((entry) => entry.state === "running");
  }
  start(id, command) {
    if (this.entries.some((entry) => entry.id === id)) return;
    this.entries.push({ id, command: plainText(command), output: "", state: "running" });
    if (this.entries.length > 30) this.entries.shift();
  }
  update(id, result, state) {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return;
    if (state) entry.state = state;
    const output = compactBashProgress(toolOutput(result).replace(/\r\n?/g, "\n"));
    if (output) {
      const bounded = output.slice(-32e3).split("\n").slice(-300).join("\n");
      entry.output = (bounded.length < output.length ? "…（前面的输出已省略）\n" : "") + bounded;
    }
  }
  restore(messages) {
    this.entries = [];
    for (const raw of messages) {
      const message = raw;
      if (message.role === "assistant" && Array.isArray(message.content)) for (const rawBlock of message.content) {
        const block = rawBlock;
        if (block?.type === "toolCall" && typeof block.name === "string" && isBashTool(block.name) && typeof block.id === "string") {
          this.start(block.id, bashCommand(block.arguments));
          this.update(block.id, null, "done");
        }
      }
      if (message.role === "toolResult" && message.toolCallId) this.update(message.toolCallId, message, message.isError ? "error" : "done");
    }
  }
  invalidate() {
  }
  render(width) {
    const inner = Math.max(1, width - 2);
    if (!this.entries.length) return [`${C.dim} 等待 Bash 执行…${C.reset}`, "", `${C.muted} 命令、实时输出和结果会显示在这里${C.reset}`].map((line) => truncateToWidth(line, width, "…"));
    return this.entries.flatMap((entry) => {
      const state = entry.state === "running" ? `${C.yellow}● 运行中` : entry.state === "error" ? `${C.red}× 失败` : `${C.green}✓ 完成`;
      return [
        "",
        ` ${state}${C.reset}`,
        ...wrapTextWithAnsi(`${C.text}$ ${entry.command}${C.reset}`, inner).map((line) => ` ${line}`),
        ...wrapTextWithAnsi(`${C.dim}${entry.output || (entry.state === "running" ? "等待输出…" : "（无输出）")}${C.reset}`, inner).map((line) => ` ${line}`),
        ""
      ];
    });
  }
}
class RenderLine {
  constructor(content) {
    this.content = content;
  }
  content;
  render(width) {
    return [truncateToWidth(this.content(width), width, "…")];
  }
  invalidate() {
  }
}
function bashPane(log) {
  const scroll = new ScrollView(log, { follow: "end", primary: false, overscroll: "contain", scrollbar: "auto" });
  const component = new VStack([
    { component: new RenderLine((width) => filledLine(`${C.accent} Bash${C.reset}${C.dim}  ${log.running ? "● 运行中" : "○ 空闲"}${C.reset}`, width, C.panelBg)), basis: 1, shrink: 0 },
    { component: scroll, basis: 0, grow: 1, minSize: 0 },
    { component: new RenderLine((width) => filledLine(`${C.muted} 滚轮查看 · Ctrl+Shift+B 展开${C.reset}`, width)), basis: 1, shrink: 0 }
  ]);
  return { component, scroll };
}
class SessionPicker {
  constructor(sessions, currentPath, rows, open, close, redraw) {
    this.sessions = sessions;
    this.rows = rows;
    this.open = open;
    this.close = close;
    this.redraw = redraw;
    this.selected = Math.max(0, sessions.findIndex((session) => session.path === currentPath));
  }
  sessions;
  rows;
  open;
  close;
  redraw;
  selected;
  invalidate() {
  }
  render(width) {
    const count = Math.max(1, Math.min(12, Math.floor(this.rows() * 0.8) - 4));
    const start = Math.max(0, Math.min(this.selected - Math.floor(count / 2), this.sessions.length - count));
    const title = `${C.accent}${C.bold} 会话历史${C.reset}`;
    const lines = [filledLine(title, width, C.panelBg), ""];
    this.sessions.slice(start, start + count).forEach((session, index) => {
      const selected = start + index === this.selected;
      const current = session.path === this.sessions[this.selected]?.path && selected ? "▸" : " ";
      const when = new Date(session.startedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const meta = width >= 65 ? ` ${when} · ${session.messageCount} 条` : "";
      const text = balancedLine(` ${current} ${singleLine(session.preview) || "（空会话）"}`, `${C.muted}${meta}${C.reset}`, width);
      lines.push(filledLine(selected ? `${C.accent}${text}${C.reset}` : `${C.dim}${text}${C.reset}`, width, selected ? C.panelBg : C.navBg));
    });
    lines.push(filledLine(`${C.muted} ↑↓ / j k · Enter 打开 · Esc 返回  ${this.selected + 1}/${this.sessions.length}${C.reset}`, width));
    return lines;
  }
  handleInput(data) {
    if (isKeyRelease(data)) return;
    const key = parseKey(data);
    if (key === "up" || key === "k") this.selected = Math.max(0, this.selected - 1);
    else if (key === "down" || key === "j") this.selected = Math.min(this.sessions.length - 1, this.selected + 1);
    else if (key === "home") this.selected = 0;
    else if (key === "end") this.selected = this.sessions.length - 1;
    else if (key === "pageUp") this.selected = Math.max(0, this.selected - 10);
    else if (key === "pageDown") this.selected = Math.min(this.sessions.length - 1, this.selected + 10);
    else if (key === "enter" && this.sessions[this.selected]) this.open(this.sessions[this.selected]);
    else if (key === "escape") this.close();
    this.redraw();
  }
}
class BashDialog {
  constructor(log, rows, close, redraw) {
    this.log = log;
    this.rows = rows;
    this.close = close;
    this.redraw = redraw;
  }
  log;
  rows;
  close;
  redraw;
  offset;
  lastStart = 0;
  lastEnd = 0;
  invalidate() {
  }
  render(width) {
    const content = this.log.render(width);
    const height = Math.max(1, Math.floor(this.rows() * 0.85) - 2);
    const end = Math.max(0, content.length - height);
    const start = Math.min(this.offset ?? end, end);
    this.lastStart = start;
    this.lastEnd = end;
    return [
      filledLine(`${C.accent}${C.bold} Bash 活动${C.reset}`, width, C.panelBg),
      ...content.slice(start, start + height).map((line) => filledLine(line, width)),
      filledLine(`${C.muted} ↑↓ / PgUp PgDn 滚动 · End 跟随 · Esc 返回${C.reset}`, width)
    ];
  }
  handleInput(data) {
    if (isKeyRelease(data)) return;
    const key = parseKey(data);
    if (key === "escape" || key === "ctrl+shift+b" || key === "shift+ctrl+b") this.close();
    else if (key === "end") this.offset = void 0;
    else if (key === "home") this.offset = 0;
    else if (["up", "down", "pageUp", "pageDown"].includes(key)) {
      const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageUp" ? -10 : 10;
      this.offset = Math.max(0, Math.min(this.lastEnd, (this.offset ?? this.lastStart) + delta));
    }
    this.redraw();
  }
}
class RoutedTerminal {
  constructor(terminal, route) {
    this.terminal = terminal;
    this.route = route;
  }
  terminal;
  route;
  get columns() {
    return this.terminal.columns;
  }
  get rows() {
    return this.terminal.rows;
  }
  get kittyProtocolActive() {
    return this.terminal.kittyProtocolActive;
  }
  start(input, resize) {
    this.terminal.start((data) => {
      if (!this.route(data)) input(data);
    }, resize);
  }
  stop() {
    this.terminal.stop();
  }
  drainInput(maxMs, idleMs) {
    return this.terminal.drainInput(maxMs, idleMs);
  }
  write(data) {
    this.terminal.write(data);
  }
  moveBy(lines) {
    this.terminal.moveBy(lines);
  }
  hideCursor() {
    this.terminal.hideCursor();
  }
  showCursor() {
    this.terminal.showCursor();
  }
  clearLine() {
    this.terminal.clearLine();
  }
  clearFromCursor() {
    this.terminal.clearFromCursor();
  }
  clearScreen() {
    this.terminal.clearScreen();
  }
  setTitle(title) {
    this.terminal.setTitle(title);
  }
  setProgress(active) {
    this.terminal.setProgress(active);
  }
}
export {
  BashDialog,
  BashLog,
  C,
  ConversationView,
  RenderLine,
  RoutedTerminal,
  SessionPicker,
  TabsBar,
  argsSummary,
  balancedLine,
  bashCommand,
  bashPane,
  compactBashProgress,
  filledLine,
  isBashTool,
  markdownTheme,
  messageText,
  plainText,
  singleLine,
  toolOutput
};
