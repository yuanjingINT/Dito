import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageAttachment } from "../bin/image-input.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { runTui } from "../bin/tui.js";
import { BashLog, compactBashProgress, ConversationView, SessionPicker, TabsBar } from "../bin/tui-components.js";
import { getMode, setMode } from "../extensions/mode.js";
const previousMode = getMode();
after(() => setMode(previousMode));
class TestTerminal {
  columns = 140;
  rows = 30;
  kittyProtocolActive = false;
  output = "";
  onInput;
  onResize;
  start(input, resize) {
    this.onInput = input;
    this.onResize = resize;
  }
  stop() {
    this.onInput = void 0;
  }
  async drainInput() {
  }
  write(data) {
    this.output += data;
  }
  send(data) {
    assert.ok(this.onInput);
    this.onInput(data);
  }
  resize(columns, rows) {
    this.output = "";
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }
  text() {
    return stripTerminalSequences(this.output);
  }
  moveBy() {
  }
  hideCursor() {
  }
  showCursor() {
  }
  clearLine() {
  }
  clearFromCursor() {
  }
  clearScreen() {
  }
  setTitle() {
  }
  setProgress() {
  }
}
class TestSession {
  constructor(sessionFile) {
    this.sessionFile = sessionFile;
  }
  sessionFile;
  messages = [];
  isStreaming = false;
  disposed = false;
  tools = ["bash", "read", "edit", "ask_question"];
  bound = false;
  ui = {};
  events = /* @__PURE__ */ new Set();
  sent = [];
  promptOptions = [];
  model = { input: ["text", "image"] };
  promptError;
  contextUsage;
  extensionRunner = { getUIContext: () => this.ui };
  async bindExtensions(options) {
    this.ui = options.uiContext;
    this.bound = true;
  }
  subscribe(cb) {
    this.events.add(cb);
    return () => this.events.delete(cb);
  }
  emit(event) {
    for (const callback of this.events) callback(event);
  }
  getActiveToolNames() {
    return [...this.tools];
  }
  setActiveToolsByName(tools) {
    this.tools = [...tools];
  }
  setThinkingLevel() {
  }
  getContextUsage() {
    return this.contextUsage;
  }
  async prompt(text, options = {}) {
    if (this.promptError) {
      options.preflightResult?.(false);
      throw this.promptError;
    }
    options.preflightResult?.(true);
    this.sent.push(text);
    this.promptOptions.push(options);
    this.messages.push({ role: "user", content: options.images?.length ? [{ type: "text", text }, ...options.images] : text });
  }
  async abort() {
    this.isStreaming = false;
  }
  dispose() {
    this.disposed = true;
    this.events.clear();
  }
  asTui() {
    return this;
  }
}
function summary(index) {
  return { path: `history-${index}`, startedAt: 176e10 - index * 36e5, preview: `历史会话 ${index} 中文😀`, messageCount: 2 };
}
const source = (sessions, open) => ({ list: () => [...sessions], open });
async function until(predicate, label) {
  const end = Date.now() + 3e3;
  while (!predicate()) {
    if (Date.now() > end) assert.fail(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
function bashHistory(command = "printf hello", output = "hello") {
  return [
    { role: "assistant", content: [{ type: "toolCall", id: "bash-old", name: "bash", arguments: { command } }] },
    { role: "toolResult", toolCallId: "bash-old", toolName: "bash", content: [{ type: "text", text: output }], isError: false }
  ];
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
  bash.update("live", { content: [{ type: "text", text: "progress\x1B[2J" }] });
  assert.match(stripTerminalSequences(bash.render(40).join("\n")), /progress/);
  assert.ok(!bash.render(40).join("\n").includes("\x1B[2J"));
  bash.update("live", { content: [{ type: "text", text: "x\n".repeat(1e4) + "last output" }] }, "error");
  assert.equal(bash.running, false);
  const output = stripTerminalSequences(bash.render(40).join("\n"));
  assert.match(output, /last output/);
  assert.match(output, /失败/);
  assert.ok(output.length < 1e4);
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
    if (streaming) {
      view.appendThinking("saved-");
      view.appendAssistant("final");
    }
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
test("real TUI previews split Markdown and honors content-end and final snapshots", async () => {
  setMode("standard");
  const session = new TestSession("history-0");
  const terminal = new TestTerminal();
  const running = runTui(
    session.asTui(),
    "Offline",
    async () => {
      throw new Error("unexpected new session");
    },
    terminal,
    source([summary(0)], async () => {
      throw new Error("unexpected history");
    })
  );
  try {
    await until(() => session.events.size > 0, "subscription");
    session.emit({ type: "message_start", message: { role: "assistant" } });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "## split-head\n\n```ts\nconst live = " } });
    await until(() => terminal.text().includes("const live"), "open code block preview");
    terminal.resize(60, 12);
    await until(() => terminal.text().includes("const live"), "preview resizes");
    terminal.output = "";
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "## split-head\n\n```ts\nconst live = 42;\n```\nend-only-tail" } });
    await until(() => terminal.text().includes("end-only-tail"), "content-end fills missing delta");
    terminal.output = "";
    session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "authoritative final" }] } });
    session.emit({ type: "agent_end" });
    await until(() => terminal.text().includes("authoritative final"), "final snapshot replaces preview");
    assert.doesNotMatch(terminal.text(), /end-only-tail/);
  } finally {
    terminal.send("");
    await running;
  }
});
test("real TUI filters controls split across deltas and flushes the full body on cancellation", async () => {
  setMode("standard");
  const session = new TestSession("history-0");
  const terminal = new TestTerminal();
  const running = runTui(
    session.asTui(),
    "Offline",
    async () => {
      throw new Error("unexpected new session");
    },
    terminal,
    source([summary(0)], async () => {
      throw new Error("unexpected history");
    })
  );
  try {
    await until(() => session.events.size > 0, "subscription");
    session.emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of ["safe\x1B]0;", "hidden-title\x07\n", ...Array.from({ length: 25 }, (_, i) => `body-line-${i}
`), "last-tail"]) {
      session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
    }
    await until(() => terminal.text().includes("last-tail"), "tail preview");
    session.emit({ type: "agent_end" });
    await tick();
    terminal.output = "";
    for (let i = 0; i < 20; i++) terminal.send("\x1B[<64;5;8M");
    await until(() => terminal.text().includes("body-line-0"), "cancelled body retains earlier lines");
    assert.doesNotMatch(terminal.text(), /hidden-title/);
  } finally {
    terminal.send("");
    await running;
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
    { role: "toolResult", toolCallId: "old", toolName: "subagent", isError: true, content: [{ type: "text", text: "saved-agent-error" }] }
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
  const running = runTui(session.asTui(), "Offline", async () => {
    throw new Error("unexpected new session");
  }, terminal, source([summary(0)], async () => {
    throw new Error("unexpected history");
  }));
  try {
    await until(() => session.bound && terminal.text().includes("点击展开"), "collapsed thinking");
    terminal.output = "";
    terminal.send("\x1B[<0;120;4M");
    terminal.send("\x1B[<0;120;4m");
    await tick();
    assert.ok(!terminal.text().includes("mouse-thinking-content"), "sidebar click does not toggle conversation");
    for (const [columns, rows, headerRow] of [[140, 30, 4], [80, 20, 4], [60, 12, 3]]) {
      terminal.resize(columns, rows);
      await tick();
      terminal.output = "";
      terminal.send(`\x1B[<0;5;${headerRow}M`);
      terminal.send(`\x1B[<0;5;${headerRow}m`);
      await until(() => terminal.text().includes("mouse-thinking-content"), `thinking expanded at ${columns} columns`);
      terminal.output = "";
      terminal.send(`\x1B[<0;5;${headerRow}M`);
      terminal.send(`\x1B[<0;5;${headerRow}m`);
      await until(() => terminal.text().includes("点击展开"), "thinking collapsed");
      assert.ok(!terminal.text().includes("mouse-thinking-content"));
    }
  } finally {
    terminal.send("");
    await running;
  }
});
test("mouse targets follow conversation scroll offsets and keep long thinking headers visible", async () => {
  setMode("standard");
  const session = new TestSession("history-0");
  session.messages = [{ role: "assistant", content: [{ type: "thinking", thinking: "long-thinking-first\n\n" + "thinking-body\n".repeat(50) }, { type: "text", text: "answer\n".repeat(60) }] }];
  const terminal = new TestTerminal();
  const running = runTui(session.asTui(), "Offline", async () => {
    throw new Error("unexpected new session");
  }, terminal, source([summary(0)], async () => {
    throw new Error("unexpected history");
  }));
  try {
    await until(() => session.bound, "binding");
    await tick();
    terminal.output = "";
    for (let i = 0; i < 50; i++) terminal.send("\x1B[<64;5;8M");
    await until(() => terminal.text().includes("◇ 思考"), "scroll to thinking header");
    terminal.output = "";
    terminal.send("\x1B[<0;5;4M");
    terminal.send("\x1B[<0;5;4m");
    await until(() => terminal.text().includes("long-thinking-first"), "scrolled thinking expands");
    assert.ok(terminal.text().includes("点击收起"), "expansion keeps its header in view");
  } finally {
    terminal.send("");
    await running;
  }
});
test("real TUI streams subagent progress and exposes final results through the tool header", async () => {
  setMode("standard");
  const session = new TestSession("history-0");
  const terminal = new TestTerminal();
  const running = runTui(session.asTui(), "Offline", async () => {
    throw new Error("unexpected new session");
  }, terminal, source([summary(0)], async () => {
    throw new Error("unexpected history");
  }));
  try {
    await until(() => session.bound && session.events.size > 0, "event subscription");
    session.emit({ type: "tool_execution_start", toolName: "subagent", toolCallId: "agents", args: { task: "research" } });
    session.emit({ type: "tool_execution_update", toolName: "subagent", toolCallId: "agents", partialResult: { content: [{ type: "text", text: "子代理 · 完成 0/1\n模型：test/model\nagent-live-detail" }] } });
    await until(() => terminal.text().includes("完成 0/1"), "visible progress");
    terminal.output = "";
    terminal.send("\x1B[<0;5;3M");
    terminal.send("\x1B[<0;5;3m");
    await until(() => terminal.text().includes("agent-live-detail"), "expanded tool result");
    assert.match(terminal.text(), /test\/model/);
    terminal.output = "";
    session.emit({ type: "tool_execution_end", toolName: "subagent", toolCallId: "agents", result: { content: [{ type: "text", text: "子代理 · 完成 1/1\nagent-final-detail" }] }, isError: false });
    await until(() => terminal.text().includes("agent-final-detail"), "final tool result");
    assert.ok(!terminal.text().includes("agent-live-detail"));
    terminal.output = "";
    terminal.send("\x1B[<0;5;3M");
    terminal.send("\x1B[<0;5;3m");
    await until(() => terminal.text().includes("点击展开"), "tool collapsed");
    assert.ok(!terminal.text().includes("agent-final-detail"));
  } finally {
    terminal.send("");
    await running;
  }
});
test("TUI reflects dynamic context windows and shows unknown metadata without a fake percentage", async () => {
  setMode("standard");
  const session = new TestSession("history-0");
  session.contextUsage = { tokens: 6400, contextWindow: 32e3, percent: 20 };
  const terminal = new TestTerminal();
  const running = runTui(session.asTui(), "Offline", async () => {
    throw new Error("unexpected new session");
  }, terminal, source([summary(0)], async () => {
    throw new Error("unexpected history");
  }));
  try {
    await until(() => session.events.size > 0 && terminal.text().includes("6.4k/32k (20.0%)"), "API context shown");
    terminal.output = "";
    session.contextUsage = { tokens: 6400, contextWindow: 64e3, percent: 10 };
    session.emit({ type: "model_select", model: { name: "Changed" } });
    await until(() => terminal.text().includes("6.4k/64k (10.0%)"), "model change updates context display");
    terminal.output = "";
    session.contextUsage = { tokens: 6400, contextWindow: Infinity, percent: 0 };
    session.emit({ type: "model_select", model: { name: "Unknown" } });
    await until(() => terminal.text().includes("6.4k/未知 (?)"), "unknown context shown");
    assert.ok(!terminal.text().includes("0.0%"));
  } finally {
    terminal.send("");
    await running;
  }
});
test("the history picker scrolls to the last item and remains usable after resize", () => {
  let rows = 30;
  let opened;
  const picker = new SessionPicker(Array.from({ length: 50 }, (_, i) => summary(i)), "history-0", () => rows, (session) => {
    opened = session.path;
  }, () => {
  }, () => {
  });
  for (let i = 0; i < 49; i++) picker.handleInput("\x1B[B");
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
  const running = runTui(session.asTui(), "Offline", async () => {
    throw new Error("unexpected new session");
  }, terminal, source([summary(0)], async () => {
    throw new Error("unexpected history");
  }));
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
    terminal.send("\x1B[98;6u");
    await until(() => terminal.text().includes("finished-bash-output"), "narrow Bash dialog");
    session.emit({ type: "tool_execution_update", toolName: "bash", toolCallId: "live", partialResult: { content: [{ type: "text", text: "first-output-line\n" + "middle-output-line\n".repeat(100) + "last-output-line" }] } });
    await until(() => terminal.text().includes("last-output-line"), "dialog follows output");
    terminal.output = "";
    terminal.send("\x1B[H");
    await until(() => terminal.text().includes("first-output-line"), "Home scrolls Bash dialog to start");
    terminal.output = "";
    terminal.send("\x1B[F");
    await until(() => terminal.text().includes("last-output-line"), "End scrolls Bash dialog to end");
    terminal.send("\x1B");
    session.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "live", result: { content: [{ type: "text", text: "finished-bash-output" }] }, isError: false });
    terminal.resize(140, 12);
    await tick();
    assert.ok(!terminal.text().includes("finished-bash-output"), "sidebar hidden in short windows");
    terminal.resize(140, 30);
    await until(() => terminal.text().includes("finished-bash-output"), "sidebar returns after expansion");
  } finally {
    terminal.send("");
    await running;
  }
});
test("browser tab mouse selection preserves each editor draft and restores Bash per conversation", async () => {
  setMode("standard");
  const first = new TestSession("history-0");
  const second = new TestSession("history-1");
  first.messages = bashHistory("echo FIRST", "FIRST OUTPUT");
  second.messages = bashHistory("echo SECOND", "SECOND OUTPUT");
  let opens = 0;
  const terminal = new TestTerminal();
  const running = runTui(
    first.asTui(),
    "Offline",
    async () => {
      throw new Error("unexpected new session");
    },
    terminal,
    source([summary(0), summary(1)], async () => {
      opens++;
      return { session: second.asTui(), modelName: "Second" };
    })
  );
  try {
    await until(() => first.bound, "first binding");
    await tick();
    terminal.send("first draft");
    terminal.send("\x1B[<0;85;1M");
    terminal.send("\x1B[<0;85;1m");
    await until(() => second.bound && terminal.text().includes("SECOND OUTPUT"), "mouse selects history");
    assert.equal(second.ui.getEditorText(), "");
    terminal.send("second draft");
    terminal.send("\x1B[9;6u");
    await until(() => first.events.size > 0 && first.ui.getEditorText() === "first draft", "draft restored");
    assert.equal(opens, 1, "switching back uses the existing session");
    terminal.send("\x1B[9;5u");
    await until(() => second.events.size > 0 && second.ui.getEditorText() === "second draft", "other draft restored");
    assert.equal(opens, 1);
  } finally {
    terminal.send("");
    await running;
  }
  assert.equal(first.disposed, true);
  assert.equal(second.disposed, true);
});
test("history opened beyond twelve sessions stays active, and standard tools survive mode switches", async () => {
  setMode("standard");
  const first = new TestSession("history-0");
  const older = new TestSession("history-29");
  const terminal = new TestTerminal();
  const running = runTui(
    first.asTui(),
    "Offline",
    async () => {
      throw new Error("unexpected new session");
    },
    terminal,
    source(Array.from({ length: 30 }, (_, i) => summary(i)), async (path) => {
      assert.equal(path, "history-29");
      return { session: older.asTui(), modelName: "Old" };
    })
  );
  try {
    await until(() => first.bound, "first binding");
    terminal.send("\x1Bw");
    terminal.send("\x1B[F");
    terminal.send("\r");
    await until(() => older.bound && terminal.text().includes("历史会话 29"), "old history opens");
    terminal.send("/chat");
    terminal.send("\r");
    await until(() => older.tools.length === 0, "chat mode");
    terminal.send("/standard");
    terminal.send("\r");
    await until(() => older.tools.includes("bash"), "standard mode tools restored");
  } finally {
    terminal.send("");
    await running;
  }
});
test("switching is serialized and a failed history load leaves the current session usable", async () => {
  setMode("standard");
  const first = new TestSession("history-0");
  let release;
  let opens = 0;
  const terminal = new TestTerminal();
  const running = runTui(
    first.asTui(),
    "Offline",
    async () => {
      throw new Error("unexpected new session");
    },
    terminal,
    source([summary(0), summary(1)], async () => {
      opens++;
      await new Promise((resolve) => {
        release = resolve;
      });
      throw new Error("load failed");
    })
  );
  try {
    await until(() => first.bound, "binding");
    terminal.send("\x1B[1;3C");
    terminal.send("\x1B[1;3C");
    await until(() => Boolean(release), "pending history load");
    assert.equal(opens, 1);
    release?.();
    await until(() => terminal.text().includes("load failed"), "load failure shown");
    terminal.send("still usable");
    terminal.send("\r");
    await until(() => first.sent.includes("still usable"), "current session still usable");
    assert.equal(first.disposed, false);
  } finally {
    release?.();
    terminal.send("");
    await running;
  }
});
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=", "base64");
test("TUI keeps file attachments per tab, removes them and sends pasted images with text or alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dito-tui-images-"));
  const file = join(dir, "图片 sample.png");
  writeFileSync(file, imageBytes);
  const first = new TestSession("history-0"), second = new TestSession("history-1");
  const terminal = new TestTerminal();
  const pasted = imageAttachment(imageBytes, "剪贴板图片");
  const running = runTui(
    first.asTui(),
    "Offline",
    async () => {
      throw new Error("unexpected new");
    },
    terminal,
    source([summary(0), summary(1)], async () => ({ session: second.asTui(), modelName: "Second" })),
    { readClipboard: async () => ({ image: pasted }) }
  );
  try {
    await until(() => first.bound, "binding");
    terminal.send(`/image "${file}"`);
    terminal.send("\r");
    await until(() => terminal.text().includes("待发送图片 1/8"), "file attached");
    assert.equal(first.sent.length, 0);
    terminal.output = "";
    terminal.send("\x1B[9;5u");
    await until(() => second.bound && second.events.size > 0, "switch away");
    await tick();
    assert.doesNotMatch(terminal.text(), /待发送图片/);
    terminal.output = "";
    terminal.send("\x1B[9;6u");
    await until(() => first.events.size > 0 && terminal.text().includes("待发送图片 1/8"), "attachment restored");
    terminal.send("/unimage 1");
    terminal.send("\r");
    await tick();
    terminal.output = "";
    terminal.send("");
    await until(() => terminal.text().includes("待发送图片 1/8"), "clipboard attached");
    first.isStreaming = true;
    terminal.send("解释图片");
    terminal.send("\r");
    await until(() => first.sent.length === 1, "queued image with text");
    assert.equal(first.sent[0], "解释图片");
    assert.deepEqual(first.promptOptions[0].images, [pasted.content]);
    assert.equal(first.promptOptions[0].streamingBehavior, "followUp");
    first.isStreaming = false;
    await tick();
    terminal.output = "";
    terminal.send("");
    await until(() => terminal.text().includes("待发送图片 1/8"), "second clipboard attached");
    terminal.send("\r");
    await until(() => first.sent.length === 2, "image-only sent");
    assert.equal(first.sent[1], "");
    assert.deepEqual(first.promptOptions[1].images, [pasted.content]);
    const history = new ConversationView();
    history.reset(first.messages);
    assert.match(stripTerminalSequences(history.render(80).join("\n")), /\[图片\]/);
  } finally {
    terminal.send("");
    await running;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("TUI preserves image and text on unsupported models or preflight failure, then permits retry", async () => {
  const session = new TestSession("history-0");
  session.model = { input: ["text"] };
  const terminal = new TestTerminal();
  const pasted = imageAttachment(imageBytes, "retry.png");
  const running = runTui(
    session.asTui(),
    "Offline",
    async () => {
      throw new Error("unexpected new");
    },
    terminal,
    source([summary(0)], async () => {
      throw new Error("unexpected history");
    }),
    { readClipboard: async () => ({ image: pasted }) }
  );
  try {
    await until(() => session.bound, "binding");
    terminal.send("");
    await until(() => terminal.text().includes("待发送图片 1/8"), "attached");
    terminal.send("retry text");
    terminal.send("\r");
    await until(() => terminal.text().includes("当前模型不支持图片"), "unsupported model feedback");
    assert.equal(session.ui.getEditorText(), "retry text");
    assert.equal(session.sent.length, 0);
    session.model = { input: ["text", "image"] };
    session.promptError = new Error("preflight failed");
    terminal.send("\r");
    await until(() => terminal.text().includes("preflight failed"), "failure shown");
    assert.equal(session.ui.getEditorText(), "retry text");
    session.promptError = void 0;
    terminal.send("\r");
    await until(() => session.sent.length === 1, "retry sent");
    assert.deepEqual(session.promptOptions[0].images, [pasted.content]);
  } finally {
    terminal.send("");
    await running;
  }
});
test("TUI waits for a pending paste and falls back to pasting clipboard text", async () => {
  const session = new TestSession("history-0");
  const terminal = new TestTerminal();
  let release;
  const running = runTui(
    session.asTui(),
    "Offline",
    async () => {
      throw new Error("unexpected new");
    },
    terminal,
    source([summary(0)], async () => {
      throw new Error("unexpected history");
    }),
    { readClipboard: () => new Promise((resolve) => {
      release = resolve;
    }) }
  );
  try {
    await until(() => session.bound, "binding");
    terminal.send("");
    await until(() => Boolean(release), "pending paste");
    terminal.send("text");
    terminal.send("\r");
    await until(() => terminal.text().includes("图片正在读取"), "pending paste blocks submit");
    assert.equal(session.sent.length, 0);
    assert.equal(session.ui.getEditorText(), "text");
    release?.({ text: " fallback" });
    await until(() => session.ui.getEditorText() === "text fallback", "clipboard text inserted");
    terminal.send("\r");
    await until(() => session.sent.length === 1, "text submitted");
    assert.equal(session.sent[0], "text fallback");
    assert.equal(session.promptOptions[0].images, void 0);
  } finally {
    release?.({});
    terminal.send("");
    await running;
  }
});
