/** 可复用的 TUI 视图：每条消息独立缓存，尺寸变化只影响布局。 */
import {
  Markdown, ScrollView, Text, VStack, parseKey, isKeyRelease,
  stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Terminal,
} from "@earendil-works/pi-tui";
import type { SessionSummary } from "./session.js";

export const C = {
  reset: "\x1b[0m", dim: "\x1b[38;2;140;146;156m", muted: "\x1b[38;2;83;91;105m",
  accent: "\x1b[38;2;118;210;233m", text: "\x1b[38;2;219;224;232m",
  green: "\x1b[38;2;136;204;151m", yellow: "\x1b[38;2;228;194;125m",
  red: "\x1b[38;2;234;142;142m", bold: "\x1b[1m", italic: "\x1b[3m",
  navBg: "\x1b[48;2;22;25;31m", panelBg: "\x1b[48;2;33;38;47m",
};
const color = (code: string) => (text: string): string => `${code}${text}${C.reset}`;
export const markdownTheme = {
  heading: color(C.text + C.bold), link: color(C.accent), linkUrl: color(C.dim),
  code: color(C.accent), codeBlock: color(C.text), codeBlockBorder: color(C.muted),
  quote: color(C.dim), quoteBorder: color(C.muted), hr: color(C.muted),
  listBullet: color(C.accent), bold: color(C.bold), italic: color(C.italic),
  strikethrough: color("\x1b[9m"), underline: color("\x1b[4m"),
};

/** 外部文本不允许改变终端状态；保留换行与缩进。 */
export function plainText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
export function singleLine(text: string): string { return plainText(text).replace(/\s+/g, " ").trim(); }
export function filledLine(text: string, width: number, background = C.navBg): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return `${background}${clipped.replaceAll(C.reset, C.reset + background)}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${C.reset}`;
}
export function balancedLine(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const available = Math.max(0, width - rightWidth - 1);
  const clipped = truncateToWidth(left, available, "…");
  if (rightWidth >= width) return truncateToWidth(left, width, "…");
  return clipped + " ".repeat(Math.max(1, width - visibleWidth(clipped) - rightWidth)) + right;
}
export interface MessageLike {
  role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean;
}
export function messageText(message: MessageLike): string {
  if (typeof message.content === "string") return plainText(message.content);
  if (!Array.isArray(message.content)) return "";
  return message.content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const b = block as Record<string, unknown>;
    return b.type === "text" && typeof b.text === "string" ? plainText(b.text) : "";
  }).filter(Boolean).join("\n");
}
export function argsSummary(args: unknown): string {
  if (args == null) return "";
  try { return singleLine(typeof args === "string" ? args : JSON.stringify(args)); }
  catch { return singleLine(String(args)); }
}
export function isBashTool(name: string): boolean { return /^(bash|pc_bash|shell)$|(?:^|[_-])bash(?:$|[_-])/i.test(name); }
export function bashCommand(args: unknown): string {
  if (typeof args === "string") return plainText(args);
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const key of ["command", "cmd", "script"]) if (typeof a[key] === "string") return plainText(a[key] as string);
  }
  return argsSummary(args);
}
export function toolOutput(result: unknown): string {
  if (typeof result === "string") return plainText(result);
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (typeof r.output === "string") return plainText(r.output);
  if (typeof r.stdout === "string") return plainText(r.stdout + (typeof r.stderr === "string" ? r.stderr : ""));
  return messageText(r);
}

class MessageBlock implements Component {
  readonly body: Markdown;
  private text = "";
  constructor(private readonly kind: "user" | "assistant" | "thinking", text = "") {
    this.body = new Markdown("", 0, 0, markdownTheme);
    this.setText(text);
  }
  setText(text: string): void { this.text = text; this.body.setText(plainText(text)); }
  append(text: string): void { this.setText(this.text + text); }
  invalidate(): void { this.body.invalidate(); }
  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const label = this.kind === "user" ? `${C.accent}${C.bold}你${C.reset}`
      : this.kind === "thinking" ? `${C.dim}◇ 思考${C.reset}` : `${C.text}${C.bold}Dito${C.reset}`;
    const lines = [` ${label}`, ...this.body.render(inner).map((line) => ` ${line}`)];
    if (this.kind === "user") return ["", ...lines.map((line) => filledLine(line, width, C.panelBg)), ""];
    return ["", ...lines.map((line) => truncateToWidth(line, width, "…")), ""];
  }
}

/** 静态消息的 Markdown 缓存保持有效，流式输出只更新当前消息。 */
export class ConversationView implements Component {
  private blocks: Component[] = [];
  private assistant: MessageBlock | undefined;
  private thinking: MessageBlock | undefined;
  reset(messages: readonly unknown[]): void {
    this.blocks = [];
    this.beginAssistant();
    for (const raw of messages) {
      const message = raw as MessageLike;
      if (message.role === "user") this.addUser(messageText(message));
      else if (message.role === "assistant") {
        const text = messageText(message);
        if (text) this.blocks.push(new MessageBlock("assistant", text));
        if (Array.isArray(message.content)) for (const rawBlock of message.content) {
          const block = rawBlock as Record<string, unknown>;
          if (block?.type === "toolCall" && typeof block.name === "string") this.addTool(block.name, block.arguments);
        }
      }
    }
    this.beginAssistant();
  }
  addUser(text: string): void { this.blocks.push(new MessageBlock("user", text)); }
  beginAssistant(): void { this.assistant = undefined; this.thinking = undefined; }
  appendAssistant(delta: string): void {
    if (!delta) return;
    if (!this.assistant) { this.assistant = new MessageBlock("assistant"); this.blocks.push(this.assistant); }
    this.assistant.append(delta);
  }
  finishAssistant(message: MessageLike): void {
    const text = messageText(message);
    if (!text) return;
    if (!this.assistant) { this.assistant = new MessageBlock("assistant", text); this.blocks.push(this.assistant); }
    else this.assistant.setText(text);
  }
  appendThinking(delta: string): void {
    if (!delta) return;
    if (!this.thinking) { this.thinking = new MessageBlock("thinking"); this.blocks.push(this.thinking); }
    this.thinking.append(delta);
  }
  addTool(name: string, args: unknown): void {
    const summary = argsSummary(args);
    const detail = isBashTool(name) ? singleLine(bashCommand(args)) : summary;
    this.blocks.push(new Text(`${C.dim}  ◇ ${name}${detail ? `  ${truncateToWidth(detail, 100, "…")}` : ""}${C.reset}`, 0, 0));
  }
  notice(text: string): void { this.blocks.push(new Text(`${C.dim}  ${plainText(text)}${C.reset}`, 0, 0)); }
  invalidate(): void { this.blocks.forEach((block) => block.invalidate()); }
  render(width: number): string[] {
    if (!this.blocks.length) {
      const logo = `${C.accent}${C.bold}D I T O${C.reset}`;
      const center = (text: string) => " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) + text;
      const lines = ["", "", center(logo), "", center(`${C.dim}你的电脑搭档${C.reset}`), ""];
      if (width >= 55) lines.push(center(`${C.muted}输入消息开始 · / 命令 · Alt+W 历史${C.reset}`));
      return lines.map((line) => truncateToWidth(line, width, "…"));
    }
    return this.blocks.flatMap((block) => block.render(width));
  }
}

export interface SessionTab extends SessionSummary { draft?: boolean; }
interface TabHit { path?: string; action?: "new" | "history"; start: number; end: number; }
export class TabsBar implements Component {
  private tabs: SessionTab[] = [];
  private currentPath = "";
  private hits: TabHit[] = [];
  private visiblePaths: string[] = [];
  setTabs(tabs: SessionTab[], currentPath: string): void { this.tabs = tabs; this.currentPath = currentPath; }
  pathAt(index: number): string | undefined { return this.visiblePaths[index]; }
  hitAt(column: number): TabHit | undefined { return this.hits.find((hit) => column >= hit.start && column < hit.end); }
  invalidate(): void {}
  render(width: number): string[] {
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
      line += selected ? filledLine(`${C.accent}${C.bold}${text}${C.reset}`, cellWidth, C.panelBg)
        : `${C.muted}${text}${C.reset}`;
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

interface BashEntry { id: string; command: string; output: string; state: "running" | "done" | "error"; }
export class BashLog implements Component {
  private entries: BashEntry[] = [];
  get running(): boolean { return this.entries.some((entry) => entry.state === "running"); }
  start(id: string, command: string): void {
    if (this.entries.some((entry) => entry.id === id)) return;
    this.entries.push({ id, command: plainText(command), output: "", state: "running" });
    if (this.entries.length > 30) this.entries.shift();
  }
  update(id: string, result: unknown, state?: "done" | "error"): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return;
    if (state) entry.state = state;
    const output = toolOutput(result).replace(/\r\n?/g, "\n");
    if (output) {
      const bounded = output.slice(-32000).split("\n").slice(-300).join("\n");
      entry.output = (bounded.length < output.length ? "…（前面的输出已省略）\n" : "") + bounded;
    }
  }
  restore(messages: readonly unknown[]): void {
    this.entries = [];
    for (const raw of messages) {
      const message = raw as MessageLike;
      if (message.role === "assistant" && Array.isArray(message.content)) for (const rawBlock of message.content) {
        const block = rawBlock as Record<string, unknown>;
        if (block?.type === "toolCall" && typeof block.name === "string" && isBashTool(block.name) && typeof block.id === "string") {
          this.start(block.id, bashCommand(block.arguments));
          this.update(block.id, null, "done");
        }
      }
      if (message.role === "toolResult" && message.toolCallId) this.update(message.toolCallId, message, message.isError ? "error" : "done");
    }
  }
  invalidate(): void {}
  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    if (!this.entries.length) return [`${C.dim} 等待 Bash 执行…${C.reset}`, "", `${C.muted} 命令、实时输出和结果会显示在这里${C.reset}`].map((line) => truncateToWidth(line, width, "…"));
    return this.entries.flatMap((entry) => {
      const state = entry.state === "running" ? `${C.yellow}● 运行中` : entry.state === "error" ? `${C.red}× 失败` : `${C.green}✓ 完成`;
      return ["", ` ${state}${C.reset}`, ...wrapTextWithAnsi(`${C.text}$ ${entry.command}${C.reset}`, inner).map((line) => ` ${line}`),
        ...wrapTextWithAnsi(`${C.dim}${entry.output || (entry.state === "running" ? "等待输出…" : "（无输出）")}${C.reset}`, inner).map((line) => ` ${line}`), ""];
    });
  }
}

export class RenderLine implements Component {
  constructor(private readonly content: (width: number) => string) {}
  render(width: number): string[] { return [truncateToWidth(this.content(width), width, "…")]; }
  invalidate(): void {}
}
export function bashPane(log: BashLog): { component: VStack; scroll: ScrollView } {
  const scroll = new ScrollView(log, { follow: "end", primary: false, overscroll: "contain", scrollbar: "auto" });
  const component = new VStack([
    { component: new RenderLine((width) => filledLine(`${C.accent} Bash${C.reset}${C.dim}  ${log.running ? "● 运行中" : "○ 空闲"}${C.reset}`, width, C.panelBg)), basis: 1, shrink: 0 },
    { component: scroll, basis: 0, grow: 1, minSize: 0 },
    { component: new RenderLine((width) => filledLine(`${C.muted} 滚轮查看 · Ctrl+Shift+B 展开${C.reset}`, width)), basis: 1, shrink: 0 },
  ]);
  return { component, scroll };
}

/** 历史选择器的可见窗口始终包含选中项，支持任意长度的历史列表。 */
export class SessionPicker implements Component {
  private selected: number;
  constructor(private readonly sessions: SessionSummary[], currentPath: string | undefined,
    private readonly rows: () => number, private readonly open: (session: SessionSummary) => void,
    private readonly close: () => void, private readonly redraw: () => void) {
    this.selected = Math.max(0, sessions.findIndex((session) => session.path === currentPath));
  }
  invalidate(): void {}
  render(width: number): string[] {
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
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const key = parseKey(data);
    if (key === "up" || key === "k") this.selected = Math.max(0, this.selected - 1);
    else if (key === "down" || key === "j") this.selected = Math.min(this.sessions.length - 1, this.selected + 1);
    else if (key === "home") this.selected = 0;
    else if (key === "end") this.selected = this.sessions.length - 1;
    else if (key === "pageup") this.selected = Math.max(0, this.selected - 10);
    else if (key === "pagedown") this.selected = Math.min(this.sessions.length - 1, this.selected + 10);
    else if (key === "enter" && this.sessions[this.selected]) this.open(this.sessions[this.selected]);
    else if (key === "escape") this.close();
    this.redraw();
  }
}

/** 在小窗口中也能查看 Bash；显示窗口可独立滚动。 */
export class BashDialog implements Component {
  private offset: number | undefined;
  constructor(private readonly log: BashLog, private readonly rows: () => number,
    private readonly close: () => void, private readonly redraw: () => void) {}
  invalidate(): void {}
  render(width: number): string[] {
    const content = this.log.render(width);
    const height = Math.max(1, Math.floor(this.rows() * 0.85) - 2);
    const end = Math.max(0, content.length - height);
    const start = Math.min(this.offset ?? end, end);
    return [filledLine(`${C.accent}${C.bold} Bash 活动${C.reset}`, width, C.panelBg),
      ...content.slice(start, start + height).map((line) => filledLine(line, width)),
      filledLine(`${C.muted} ↑↓ / PgUp PgDn 滚动 · End 跟随 · Esc 返回${C.reset}`, width)];
  }
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const key = parseKey(data);
    if (key === "escape" || key === "ctrl+shift+b" || key === "shift+ctrl+b") this.close();
    else if (key === "end") this.offset = undefined;
    else if (key === "home") this.offset = 0;
    else if (["up", "down", "pageup", "pagedown"].includes(key)) {
      // 初次滚动从最新输出开始；实际上界在下一次 render 中按尺寸计算。
      const end = Math.max(0, this.log.render(60).length - Math.max(1, Math.floor(this.rows() * 0.85) - 2));
      const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -10 : 10;
      this.offset = Math.max(0, (this.offset ?? end) + delta);
    }
    this.redraw();
  }
}

/** 标签点击在 pi-tui 的文本选择处理之前路由，其余输入与鼠标事件保持原行为。 */
export class RoutedTerminal implements Terminal {
  constructor(private readonly terminal: Terminal, private readonly route: (data: string) => boolean) {}
  get columns(): number { return this.terminal.columns; }
  get rows(): number { return this.terminal.rows; }
  get kittyProtocolActive(): boolean { return this.terminal.kittyProtocolActive; }
  start(input: (data: string) => void, resize: () => void): void { this.terminal.start((data) => { if (!this.route(data)) input(data); }, resize); }
  stop(): void { this.terminal.stop(); }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> { return this.terminal.drainInput(maxMs, idleMs); }
  write(data: string): void { this.terminal.write(data); }
  moveBy(lines: number): void { this.terminal.moveBy(lines); }
  hideCursor(): void { this.terminal.hideCursor(); }
  showCursor(): void { this.terminal.showCursor(); }
  clearLine(): void { this.terminal.clearLine(); }
  clearFromCursor(): void { this.terminal.clearFromCursor(); }
  clearScreen(): void { this.terminal.clearScreen(); }
  setTitle(title: string): void { this.terminal.setTitle(title); }
  setProgress(active: boolean): void { this.terminal.setProgress(active); }
}
