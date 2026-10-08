/** 离线交互回归：使用真实 pi-tui 渲染器，模拟键盘、鼠标和窗口缩放。 */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { SessionSummary, TuiSession } from "../bin/session.js";
import { runTui, type TuiSessionSource } from "../bin/tui.js";
import { BashLog, compactBashProgress, ConversationView, SessionPicker, TabsBar } from "../bin/tui-components.js";
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
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  constructor(public sessionFile: string) {}
  extensionRunner = { getUIContext: () => this.ui };
  async bindExtensions(options: any): Promise<void> { this.ui = options.uiContext; this.bound = true; }
  subscribe(cb: (event: unknown) => void): () => void { this.events.add(cb); return () => this.events.delete(cb); }
  emit(event: unknown): void { for (const callback of this.events) callback(event); }
  getActiveToolNames(): string[] { return [...this.tools]; }
  setActiveToolsByName(tools: string[]): void { this.tools = [...tools]; }
  setThinkingLevel(): void {}
  getContextUsage() { return this.contextUsage; }
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

test("Bash collapses captured spinner progress instead of repeating it", () => {
  assert.equal(compactBashProgress("⠋ 执行中\n⠙ 执行中\n⠹ 执行中\n完成"), "执行中\n完成");
  const bash = new BashLog();
  bash.start("progress", "dito send");
  bash.update("progress", { content: [{ type: "text", text: "执行中\n执行中\n执行中" }] });
  const rendered = stripTerminalSequences(bash.render(40).join("\n"));
  assert.equal((rendered.match(/执行中/g) ?? []).length, 1);
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

test("thinking output is gray and collapsed until its header is clicked", () => {
  const view = new ConversationView();
  view.beginAssistant();
  view.appendThinking("内部推理内容");
  const collapsed = stripTerminalSequences(view.render(80).join("\n"));
  assert.match(collapsed, /思考.*点击展开/);
  assert.doesNotMatch(collapsed, /内部推理内容/);
  assert.equal(view.toggleThinkingAt(1), true);
  assert.match(stripTerminalSequences(view.render(80).join("\n")), /内部推理内容/);
});

test("thinking is restored from history and final snapshots without duplicating streamed text", () => {
  const message = { role: "assistant", content: [{ type: "thinking", thinking: "saved-thinking" }, { type: "text", text: "final answer" }] };
  for (const streaming of [false, true]) {
    const view = new ConversationView();
    if (streaming) { view.appendThinking("saved-"); view.appendAssistant("final"); }
    view.finishAssistant(message);
    assert.doesNotMatch(stripTerminalSequences(view.render(80).join("\n")), /saved-thinking/);
    assert.equal(view.toggleThinkingAt(1), true);
    const expanded = stripTerminalSequences(view.render(80).join("\n"));
    assert.equal((expanded.match(/saved-thinking/g) ?? []).length, 1);
    assert.match(expanded, /final answer/);
    assert.equal(view.isThinkingAt(2), false, "body remains selectable");
    view.reset([message]);
    view.render(80);
    assert.equal(view.toggleThinkingAt(1), true);
    assert.match(stripTerminalSequences(view.render(80).join("\n")), /saved-thinking/);
    view.reset([]);
    assert.equal(view.isExpandableAt(1), false, "reset clears old hit targets");
  }
});

test("search and subagent tools show independent states and expandable results, including history", () => {
  const view = new ConversationView();
  view.addTool("web_search", { query: "first" }, "first");
  view.addTool("web_search", { query: "second" }, "second");
  view.addTool("subagent", { tasks: [{ task: "research" }] }, "agents");
  view.addTool("subagent", {}, "agents");
  view.updateTool("first", { content: [{ type: "text", text: "first-result" }] }, "done");
  view.updateTool("second", { content: [{ type: "text", text: "second-error" }] }, "error");
  view.updateTool("agents", { content: [{ type: "text", text: "子代理 · 完成 1/2\nagent-live-output" }] });
  let rendered = stripTerminalSequences(view.render(80).join("\n"));
  assert.match(rendered, /web_search.*完成/);
  assert.match(rendered, /web_search.*失败/);
  assert.match(rendered, /subagent.*运行中.*完成 1\/2/);
  assert.equal((rendered.match(/◇ subagent/g) ?? []).length, 1);
  assert.doesNotMatch(rendered, /first-result|second-error|agent-live-output/);
  assert.equal(view.toggleDetailsAt(2), true);
  rendered = stripTerminalSequences(view.render(80).join("\n"));
  assert.match(rendered, /agent-live-output/);
  view.updateTool("agents", { content: [{ type: "text", text: "子代理 · 完成 2/2\nagent-final-output" }] }, "done");
  rendered = stripTerminalSequences(view.render(80).join("\n"));
  assert.match(rendered, /subagent.*完成.*完成 2\/2/);
  assert.match(rendered, /agent-final-output/);
  assert.doesNotMatch(rendered, /agent-live-output/);
  view.reset([
    { role: "assistant", content: [{ type: "toolCall", id: "old", name: "subagent", arguments: { task: "saved task" } }] },
    { role: "toolResult", toolCallId: "old", toolName: "subagent", isError: true, content: [{ type: "text", text: "saved-agent-error" }] },
  ]);
  assert.match(stripTerminalSequences(view.render(80).join("\n")), /subagent.*失败/);
  assert.equal(view.toggleDetailsAt(0), true);
  assert.match(stripTerminalSequences(view.render(80).join("\n")), /saved-agent-error/);
});

test("real mouse clicks expand and collapse thinking below the tabs at wide and narrow sizes", async () => {
  setMode("standard");
  const session = new TestSession("history-0");
  session.messages = [{ role: "assistant", content: [{ type: "thinking", thinking: "mouse-thinking-content" }, { type: "text", text: "answer" }] }];
  const terminal = new TestTerminal();
  const running = runTui(session.asTui(), "Offline", async () => { throw new Error("unexpected new session"); }, terminal, source([summary(0)], async () => { throw new Error("unexpected history"); }));
  try {
    await until(() => session.bound && terminal.text().includes("点击展开"), "collapsed thinking");
    terminal.output = "";
    terminal.send("\x1b[<0;120;4M"); terminal.send("\x1b[<0;120;4m");
    await tick();
    assert.ok(!terminal.text().includes("mouse-thinking-content"), "sidebar click does not toggle conversation");
    for (const [columns, rows, headerRow] of [[140, 30, 4], [80, 20, 4], [60, 12, 3]]) {
      terminal.resize(columns, rows);
      await tick();
      terminal.output = "";
      terminal.send(`\x1b[<0;5;${headerRow}M`); terminal.send(`\x1b[<0;5;${headerRow}m`);
      await until(() => terminal.text().includes("mouse-thinking-content"), `thinking expanded at ${columns} columns`);
      terminal.output = "";
      terminal.send(`\x1b[<0;5;${headerRow}M`); terminal.send(`\x1b[<0;5;${headerRow}m`);
      await until(() => terminal.text().includes("点击展开"), "thinking collapsed");
      assert.ok(!terminal.text().includes("mouse-thinking-content"));
    }
  } finally { terminal.send("\x03"); await running; }
});

test("mouse targets follow conversation scroll offsets and keep long thinking headers visible", async () => {
  setMode("standard");
  const session = new TestSession("history-0");
  session.messages = [{ role: "assistant", content: [{ type: "thinking", thinking: "long-thinking-first\n\n" + "thinking-body\n".repeat(50) }, { type: "text", text: "answer\n".repeat(60) }] }];
  const terminal = new TestTerminal();
  const running = runTui(session.asTui(), "Offline", async () => { throw new Error("unexpected new session"); }, terminal, source([summary(0)], async () => { throw new Error("unexpected history"); }));
  try {
    await until(() => session.bound, "binding");
    await tick();
    terminal.output = "";
    for (let i = 0; i < 50; i++) terminal.send("\x1b[<64;5;8M");
    await until(() => terminal.text().includes("◇ 思考"), "scroll to thinking header");
    terminal.output = "";
    terminal.send("\x1b[<0;5;4M"); terminal.send("\x1b[<0;5;4m");
    await until(() => terminal.text().includes("long-thinking-first"), "scrolled thinking expands");
    assert.ok(terminal.text().includes("点击收起"), "expansion keeps its header in view");
  } finally { terminal.send("\x03"); await running; }
});

test("real TUI streams subagent progress and exposes final results through the tool header", async () => {
  setMode("standard");
  const session = new TestSession("history-0");
  const terminal = new TestTerminal();
  const running = runTui(session.asTui(), "Offline", async () => { throw new Error("unexpected new session"); }, terminal, source([summary(0)], async () => { throw new Error("unexpected history"); }));
  try {
    await until(() => session.bound && session.events.size > 0, "event subscription");
    session.emit({ type: "tool_execution_start", toolName: "subagent", toolCallId: "agents", args: { task: "research" } });
    session.emit({ type: "tool_execution_update", toolName: "subagent", toolCallId: "agents", partialResult: { content: [{ type: "text", text: "子代理 · 完成 0/1\n模型：test/model\nagent-live-detail" }] } });
    await until(() => terminal.text().includes("完成 0/1"), "visible progress");
    terminal.output = "";
    terminal.send("\x1b[<0;5;3M"); terminal.send("\x1b[<0;5;3m");
    await until(() => terminal.text().includes("agent-live-detail"), "expanded tool result");
    assert.match(terminal.text(), /test\/model/);
    terminal.output = "";
    session.emit({ type: "tool_execution_end", toolName: "subagent", toolCallId: "agents", result: { content: [{ type: "text", text: "子代理 · 完成 1/1\nagent-final-detail" }] }, isError: false });
    await until(() => terminal.text().includes("agent-final-detail"), "final tool result");
    assert.ok(!terminal.text().includes("agent-live-detail"));
    terminal.output = "";
    terminal.send("\x1b[<0;5;3M"); terminal.send("\x1b[<0;5;3m");
    await until(() => terminal.text().includes("点击展开"), "tool collapsed");
    assert.ok(!terminal.text().includes("agent-final-detail"));
  } finally { terminal.send("\x03"); await running; }
});

test("TUI reflects dynamic context windows and shows unknown metadata without a fake percentage", async () => {
  setMode("standard");
  const session = new TestSession("history-0");
  session.contextUsage = { tokens: 6400, contextWindow: 32000, percent: 20 };
  const terminal = new TestTerminal();
  const running = runTui(session.asTui(), "Offline", async () => { throw new Error("unexpected new session"); }, terminal, source([summary(0)], async () => { throw new Error("unexpected history"); }));
  try {
    await until(() => session.events.size > 0 && terminal.text().includes("6.4k/32k (20.0%)"), "API context shown");
    terminal.output = "";
    session.contextUsage = { tokens: 6400, contextWindow: 64000, percent: 10 };
    session.emit({ type: "model_select", model: { name: "Changed" } });
    await until(() => terminal.text().includes("6.4k/64k (10.0%)"), "model change updates context display");
    terminal.output = "";
    session.contextUsage = { tokens: 6400, contextWindow: Infinity, percent: 0 };
    session.emit({ type: "model_select", model: { name: "Unknown" } });
    await until(() => terminal.text().includes("6.4k/未知 (?)"), "unknown context shown");
    assert.ok(!terminal.text().includes("0.0%"));
  } finally { terminal.send("\x03"); await running; }
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
    session.emit({ type: "tool_execution_update", toolName: "bash", toolCallId: "live", partialResult: { content: [{ type: "text", text: "first-output-line\n" + "middle-output-line\n".repeat(100) + "last-output-line" }] } });
    await until(() => terminal.text().includes("last-output-line"), "dialog follows output");
    terminal.output = "";
    terminal.send("\x1b[H");
    await until(() => terminal.text().includes("first-output-line"), "Home scrolls Bash dialog to start");
    terminal.output = "";
    terminal.send("\x1b[F");
    await until(() => terminal.text().includes("last-output-line"), "End scrolls Bash dialog to end");
    terminal.send("\x1b");
    session.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "live", result: { content: [{ type: "text", text: "finished-bash-output" }] }, isError: false });
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
    terminal.send("\x1b[9;6u");
    await until(() => first.events.size > 0 && first.ui.getEditorText() === "first draft", "draft restored");
    assert.equal(opens, 1, "switching back uses the existing session");
    terminal.send("\x1b[9;5u");
    await until(() => second.events.size > 0 && second.ui.getEditorText() === "second draft", "other draft restored");
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
    terminal.send("\x1b[F");
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
