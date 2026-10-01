/** 离线交互回归：使用真实 pi-tui 渲染器，模拟键盘、鼠标和窗口缩放。 */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { SessionSummary, TuiSession } from "../bin/session.js";
import { runTui, type TuiSessionSource } from "../bin/tui.js";
import { BashLog, ConversationView, SessionPicker, TabsBar } from "../bin/tui-components.js";
import { getMode, setMode } from "../extensions/mode.js";

const previousMode = getMode();
after(() => setMode(previousMode));
class TestTerminal implements Terminal {
  columns = 140; rows = 30; kittyProtocolActive = false; output = "";
  onInput: ((data: string) => void) | undefined;
  onResize: (() => void) | undefined;
  start(input: (data: string) => void, resize: () => void): void { this.onInput = input; this.onResize = resize; }
  stop(): void { this.onInput = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  send(data: string): void { assert.ok(this.onInput); this.onInput(data); }
  resize(columns: number, rows: number): void { this.output = ""; this.columns = columns; this.rows = rows; this.onResize?.(); }
  text(): string { return stripTerminalSequences(this.output); }
  moveBy(): void {} hideCursor(): void {} showCursor(): void {} clearLine(): void {}
  clearFromCursor(): void {} clearScreen(): void {} setTitle(): void {} setProgress(): void {}
}
class TestSession {
  messages: unknown[] = []; isStreaming = false; disposed = false;
  tools = ["bash", "read", "edit", "ask_question"];
  bound = false; ui: Record<string, any> = {};
  events = new Set<(event: unknown) => void>();
  sent: string[] = [];
  constructor(public sessionFile: string) {}
  extensionRunner = { getUIContext: () => this.ui };
  async bindExtensions(options: any): Promise<void> { this.ui = options.uiContext; this.bound = true; }
  subscribe(cb: (event: unknown) => void): () => void { this.events.add(cb); return () => this.events.delete(cb); }
  emit(event: unknown): void { for (const callback of this.events) callback(event); }
  getActiveToolNames(): string[] { return [...this.tools]; }
  setActiveToolsByName(tools: string[]): void { this.tools = [...tools]; }
  setThinkingLevel(): void {}
  async prompt(text: string): Promise<void> { this.sent.push(text); this.messages.push({ role: "user", content: text }); }
  async abort(): Promise<void> { this.isStreaming = false; }
  dispose(): void { this.disposed = true; this.events.clear(); }
  asTui(): TuiSession { return this as unknown as TuiSession; }
}
function summary(index: number): SessionSummary {
  return { path: `history-${index}`, startedAt: 1760000000000 - index * 3600000, preview: `历史会话 ${index} 中文😀`, messageCount: 2 };
}
const source = (sessions: SessionSummary[], open: TuiSessionSource["open"]): TuiSessionSource => ({ list: () => [...sessions], open });
async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) assert.fail(`timed out: ${label}`); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
async function tick(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 20)); }
function bashHistory(command = "printf hello", output = "hello"): unknown[] {
  return [{ role: "assistant", content: [{ type: "toolCall", id: "bash-old", name: "bash", arguments: { command } }] },
    { role: "toolResult", toolCallId: "bash-old", toolName: "bash", content: [{ type: "text", text: output }], isError: false }];
}

test("tabs always show the active historical conversation and keep Unicode within the viewport", () => {
  const tabs = new TabsBar();
  tabs.setTabs(Array.from({ length: 30 }, (_, i) => summary(i)), "history-29");
  for (const width of [12, 24, 40, 60, 80, 112, 160]) {
    const rendered = tabs.render(width);
    assert.ok(rendered.every((line) => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(Array.from({ length: 9 }, (_, i) => tabs.pathAt(i)).includes("history-29"), `active tab ${width}`);
    const columns = Array.from({ length: width }, (_, i) => tabs.hitAt(i));
    assert.ok(columns.some((hit) => hit?.path === "history-29"));
  }
});

test("Bash restores history, bounds output, streams snapshots and clears on session change", () => {
  const bash = new BashLog();
  bash.restore(bashHistory());
  assert.match(stripTerminalSequences(bash.render(40).join("\n")), /hello/);
  bash.start("live", "echo live");
  assert.equal(bash.running, true);
  bash.update("live", { content: [{ type: "text", text: "progress\x1b[2J" }] });
  assert.match(stripTerminalSequences(bash.render(40).join("\n")), /progress/);
  assert.ok(!bash.render(40).join("\n").includes("\x1b[2J"));
  bash.update("live", { content: [{ type: "text", text: "x\n".repeat(10000) + "last output" }] }, "error");
  assert.equal(bash.running, false);
  const output = stripTerminalSequences(bash.render(40).join("\n"));
  assert.match(output, /last output/);
  assert.match(output, /失败/);
  assert.ok(output.length < 10000);
  bash.restore([]);
  assert.ok(!bash.render(40).join("\n").includes("hello"));
});

test("conversation finishes providers that only emit a final message and caches older messages", () => {
  const view = new ConversationView();
  view.addUser("hello");
  view.beginAssistant();
  view.finishAssistant({ role: "assistant", content: [{ type: "text", text: "final response" }] });
  const first = view.render(80);
  view.beginAssistant();
  view.appendAssistant("next");
  const second = view.render(80);
  assert.match(stripTerminalSequences(second.join("\n")), /final response/);
  assert.deepEqual(second.slice(0, first.length), first);
});

test("the history picker scrolls to the last item and remains usable after resize", () => {
  let rows = 30;
  let opened: string | undefined;
  const picker = new SessionPicker(Array.from({ length: 50 }, (_, i) => summary(i)), "history-0", () => rows, (session) => { opened = session.path; }, () => {}, () => {});
  for (let i = 0; i < 49; i++) picker.handleInput("\x1b[B");
  assert.match(stripTerminalSequences(picker.render(90).join("\n")), /历史会话 49/);
  rows = 12;
  assert.ok(picker.render(40).length <= Math.floor(rows * 0.85));
  picker.handleInput("\r");
  assert.equal(opened, "history-49");
});

test("real TUI streams Bash into the sidebar, hides it in small windows and allows expansion", async () => {
  setMode("standard");
  const session = new TestSession("history-0");
  const terminal = new TestTerminal();
  const running = runTui(session.asTui(), "Offline", async () => { throw new Error("unexpected new session"); }, terminal, source([summary(0)], async () => { throw new Error("unexpected history"); }));
  try {
    await until(() => session.bound && terminal.text().includes("Bash"), "wide sidebar");
    session.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "live", args: { command: "echo streamed" } });
    session.emit({ type: "tool_execution_update", toolName: "bash", toolCallId: "live", partialResult: { content: [{ type: "text", text: "partial-bash-output" }] } });
    await until(() => terminal.text().includes("partial-bash-output"), "streamed Bash output");
    session.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "live", result: { content: [{ type: "text", text: "finished-bash-output" }] }, isError: false });
    await until(() => terminal.text().includes("finished-bash-output"), "finished Bash output");
    terminal.resize(80, 20);
    await tick();
    assert.ok(!terminal.text().includes("finished-bash-output"), "sidebar hidden at 80 columns");
    assert.ok(!terminal.text().includes("Offline"), "model hidden on narrow windows");
    terminal.send("\x1b[98;6u");
    await until(() => terminal.text().includes("finished-bash-output"), "narrow Bash dialog");
    terminal.send("\x1b");
    terminal.resize(140, 12);
    await tick();
    assert.ok(!terminal.text().includes("finished-bash-output"), "sidebar hidden in short windows");
    terminal.resize(140, 30);
    await until(() => terminal.text().includes("finished-bash-output"), "sidebar returns after expansion");
  } finally { terminal.send("\x03"); await running; }
});

test("browser tab mouse selection preserves each editor draft and restores Bash per conversation", async () => {
  setMode("standard");
  const first = new TestSession("history-0");
  const second = new TestSession("history-1");
  first.messages = bashHistory("echo FIRST", "FIRST OUTPUT");
  second.messages = bashHistory("echo SECOND", "SECOND OUTPUT");
  let opens = 0;
  const terminal = new TestTerminal();
  const running = runTui(first.asTui(), "Offline", async () => { throw new Error("unexpected new session"); }, terminal,
    source([summary(0), summary(1)], async () => { opens++; return { session: second.asTui(), modelName: "Second" }; }));
  try {
    await until(() => first.bound, "first binding");
    await tick();
    terminal.send("first draft");
    // 两个标签平分品牌与右侧控制区之间的列；x=85 落在第二个标签。
    terminal.send("\x1b[<0;85;1M");
    terminal.send("\x1b[<0;85;1m");
    await until(() => second.bound && terminal.text().includes("SECOND OUTPUT"), "mouse selects history");
    assert.equal(second.ui.getEditorText(), "");
    terminal.send("second draft");
    terminal.send("\x1b[1;3D");
    await until(() => first.ui.getEditorText() === "first draft", "draft restored");
    assert.equal(opens, 1, "switching back uses the existing session");
    terminal.send("\x1b[1;3C");
    await until(() => second.ui.getEditorText() === "second draft", "other draft restored");
    assert.equal(opens, 1);
  } finally { terminal.send("\x03"); await running; }
  assert.equal(first.disposed, true);
  assert.equal(second.disposed, true);
});

test("history opened beyond twelve sessions stays active, and standard tools survive mode switches", async () => {
  setMode("standard");
  const first = new TestSession("history-0");
  const older = new TestSession("history-29");
  const terminal = new TestTerminal();
  const running = runTui(first.asTui(), "Offline", async () => { throw new Error("unexpected new session"); }, terminal,
    source(Array.from({ length: 30 }, (_, i) => summary(i)), async (path) => {
      assert.equal(path, "history-29"); return { session: older.asTui(), modelName: "Old" };
    }));
  try {
    await until(() => first.bound, "first binding");
    terminal.send("\x1bw");
    for (let i = 0; i < 29; i++) terminal.send("\x1b[B");
    terminal.send("\r");
    await until(() => older.bound && terminal.text().includes("历史会话 29"), "old history opens");
    terminal.send("/chat"); terminal.send("\r");
    await until(() => older.tools.length === 0, "chat mode");
    terminal.send("/standard"); terminal.send("\r");
    await until(() => older.tools.includes("bash"), "standard mode tools restored");
  } finally { terminal.send("\x03"); await running; }
});

test("switching is serialized and a failed history load leaves the current session usable", async () => {
  setMode("standard");
  const first = new TestSession("history-0");
  let release: (() => void) | undefined;
  let opens = 0;
  const terminal = new TestTerminal();
  const running = runTui(first.asTui(), "Offline", async () => { throw new Error("unexpected new session"); }, terminal,
    source([summary(0), summary(1)], async () => { opens++; await new Promise<void>((resolve) => { release = resolve; }); throw new Error("load failed"); }));
  try {
    await until(() => first.bound, "binding");
    terminal.send("\x1b[1;3C");
    terminal.send("\x1b[1;3C");
    await until(() => Boolean(release), "pending history load");
    assert.equal(opens, 1);
    release?.();
    await until(() => terminal.text().includes("load failed"), "load failure shown");
    terminal.send("still usable"); terminal.send("\r");
    await until(() => first.sent.includes("still usable"), "current session still usable");
    assert.equal(first.disposed, false);
  } finally { release?.(); terminal.send("\x03"); await running; }
});
