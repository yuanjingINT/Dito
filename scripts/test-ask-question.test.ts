/** 离线回归：真实 pi 会话 + 真实 TUI，模拟终端键盘输入，不调用远程模型。 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Input, stripTerminalSequences, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import askExtension from "../extensions/ask.js";
import { setVoiceHandlers } from "../extensions/voice-hooks.js";
import { TuiDialogs } from "../bin/tui-dialogs.js";

const scratch = mkdtempSync(join(tmpdir(), "dito-ask-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
const { runTui } = await import("../bin/tui.js");
const { getMode, setMode } = await import("../extensions/mode.js");

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  setVoiceHandlers(null);
  rmSync(scratch, { recursive: true, force: true });
});

class TestTerminal implements Terminal {
  columns = 100;
  rows = 35;
  kittyProtocolActive = false;
  output = "";
  onInput: ((data: string) => void) | undefined;
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void { this.onInput = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  send(data: string): void { assert.ok(this.onInput, "terminal is started"); this.onInput(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function makeSession(params: { question: string; options?: string[] }): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: scratch,
    agentDir: scratch,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      askExtension,
      (pi) => pi.registerProvider("dito-ask-test", {
        baseUrl: "http://127.0.0.1:1/unreachable",
        apiKey: "offline-test",
        api: "openai-completions",
        models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple: (model, context) => {
          const stream = createAssistantMessageEventStream();
          const answered = context.messages.some((message) => message.role === "toolResult");
          const message: AssistantMessage = {
            role: "assistant",
            content: answered
              ? [{ type: "text", text: "收到回答" }]
              : [{ type: "toolCall", id: "ask-1", name: "ask_question", arguments: params }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: answered ? "stop" : "toolUse",
            timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
          return stream;
        },
      }),
    ],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(scratch, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(scratch, "models-store.json"),
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd: scratch,
    agentDir: scratch,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(scratch),
    noTools: "builtin",
    model: modelRuntime.getModels()[0],
  });
  const model = modelRuntime.getModel("dito-ask-test", "offline");
  assert.ok(model);
  await session.setModel(model);
  return session;
}

function resultAnswer(session: AgentSession): unknown {
  return session.messages.findLast((message) => message.role === "toolResult")?.details;
}

test("TUI shows a selector, waits for the answer, and returns the chosen option", async () => {
  setMode("standard");
  const session = await makeSession({ question: "选择安装方式？", options: ["源码", "安装包"] });
  const terminal = new TestTerminal();
  const running = runTui(session, "Offline", async () => { throw new Error("unexpected new session"); }, terminal);
  try {
    await until(() => session.extensionRunner.createContext().mode === "tui", "UI binding");
    assert.equal(session.extensionRunner.createContext().hasUI, true);
    terminal.send("帮我安装");
    terminal.send("\r");
    await until(() => stripTerminalSequences(terminal.output).includes("→ 源码"), "visible selector");
    assert.equal(session.isStreaming, true, "agent waits while the question is open");
    assert.equal(resultAnswer(session), undefined, "no answer fabricated before input");
    terminal.send("\t");
    terminal.send("\x1bd");
    assert.equal(getMode(), "standard", "dialog keys do not switch modes/sessions");
    terminal.send("\x1b[B");
    terminal.send("\r");
    await until(() => !session.isStreaming, "answer completes the agent turn");
    assert.deepEqual(resultAnswer(session), { answer: "安装包", via: "tui" });
  } finally {
    terminal.send("\x03");
    await running;
  }
});

test("free-text input and the binding survive creating a new session", async () => {
  setMode("standard");
  const first = await makeSession({ question: "旧会话" });
  const next = await makeSession({ question: "你在哪个城市？" });
  const terminal = new TestTerminal();
  const running = runTui(first, "Offline", async () => ({ session: next, modelName: "Offline" }), terminal);
  try {
    await until(() => first.extensionRunner.createContext().mode === "tui", "initial binding");
    terminal.send("/new");
    terminal.send("\r");
    await until(() => next.extensionRunner.createContext().mode === "tui" && stripTerminalSequences(terminal.output).includes("已开启新会话"), "new session binding");
    terminal.send("帮我查询天气");
    terminal.send("\r");
    await until(() => stripTerminalSequences(terminal.output).includes("Enter 提交"), "text input dialog");
    terminal.send("北京");
    terminal.send("\r");
    await until(() => !next.isStreaming, "text answer completes the turn");
    assert.deepEqual(resultAnswer(next), { answer: "北京", via: "tui" });
    const result = next.messages.findLast((message) => message.role === "toolResult");
    assert.match(JSON.stringify(result?.content), /用户回答：北京/);
  } finally {
    terminal.send("\x03");
    await running;
    next.dispose();
  }
});

test("Escape cancels the question and Ctrl+C exits while an answer is pending", async () => {
  setMode("standard");
  const session = await makeSession({ question: "继续吗？", options: ["继续", "返回"] });
  const terminal = new TestTerminal();
  const running = runTui(session, "Offline", async () => { throw new Error("unexpected new session"); }, terminal);
  try {
    await until(() => session.extensionRunner.createContext().mode === "tui", "UI binding");
    terminal.send("提问");
    terminal.send("\r");
    await until(() => stripTerminalSequences(terminal.output).includes("→ 继续"), "pending question");
    terminal.send("\x1b");
    await until(() => !session.isStreaming, "cancelled question completes");
    assert.deepEqual(resultAnswer(session), { answer: null, via: "tui" });
    assert.ok(!stripTerminalSequences(terminal.output).includes("已中断当前任务"), "Escape is delivered to the dialog");
    const question = session.extensionRunner.getUIContext().input("待回答的问题");
    terminal.send("\x03");
    assert.equal(await question, undefined);
    await running;
    assert.equal(terminal.onInput, undefined);
  } finally {
    if (terminal.onInput) { terminal.send("\x03"); await running; }
  }
});

test("dialog cancellation by AbortSignal restores keyboard focus to the editor", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal);
  const editor = new Input();
  tui.addChild(editor);
  tui.setFocus(editor);
  const dialogs = new TuiDialogs(tui);
  tui.start();
  try {
    const controller = new AbortController();
    const answer = dialogs.input("取消测试", undefined, { signal: controller.signal });
    assert.equal(tui.hasOverlay(), true);
    controller.abort();
    assert.equal(await answer, undefined);
    assert.equal(tui.hasOverlay(), false);
    terminal.send("已恢复焦点");
    assert.equal(editor.getValue(), "已恢复焦点");
    assert.equal(await dialogs.select("已中断", ["选项"], { signal: controller.signal }), undefined);
    assert.equal(tui.hasOverlay(), false);
  } finally {
    dialogs.dispose();
    tui.stop();
  }
});

test("aborting a real agent turn dismisses its pending ask_question", async () => {
  setMode("standard");
  const session = await makeSession({ question: "等待中断？" });
  const terminal = new TestTerminal();
  const running = runTui(session, "Offline", async () => { throw new Error("unexpected new session"); }, terminal);
  try {
    await until(() => session.extensionRunner.createContext().mode === "tui", "UI binding");
    terminal.send("开始");
    terminal.send("\r");
    await until(() => stripTerminalSequences(terminal.output).includes("Enter 提交"), "pending agent question");
    await session.abort();
    assert.equal(session.isStreaming, false);
    assert.deepEqual(resultAnswer(session), { answer: null, via: "tui" });
    // 回答被取消后，Tab 已回到主页并恢复切换模式的功能。
    terminal.send("\t");
    assert.equal(getMode(), "plan");
  } finally {
    terminal.send("\x03");
    await running;
    setMode("standard");
  }
});

test("timeout and confirmation dialogs clean up their overlays", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal);
  const editor = new Input();
  tui.addChild(editor);
  tui.setFocus(editor);
  const dialogs = new TuiDialogs(tui);
  tui.start();
  try {
    assert.equal(await dialogs.select("超时测试", ["选项"], { timeout: 20 }), undefined);
    assert.equal(tui.hasOverlay(), false);
    const reject = dialogs.confirm("确认操作", "继续？");
    terminal.send("\x1b[B");
    terminal.send("\r");
    assert.equal(await reject, false);
    const approve = dialogs.confirm("确认操作", "继续？");
    terminal.send("\r");
    assert.equal(await approve, true);
    assert.equal(tui.hasOverlay(), false);
  } finally {
    dialogs.dispose();
    tui.stop();
  }
});

test("non-interactive fallback and voice handling keep working", async () => {
  const session = await makeSession({ question: "文本提问" });
  try {
    const tool = session.extensionRunner.getToolDefinition("ask_question");
    assert.ok(tool);
    const ctx = session.extensionRunner.createContext();
    assert.equal(ctx.hasUI, false);
    const result = await tool.execute("text-1", { question: "文本提问", options: ["甲", "乙"] }, undefined, undefined, ctx);
    assert.deepEqual(result.details, { answer: null, via: "text" });
    assert.match(JSON.stringify(result.content), /请回答：文本提问/);
    setVoiceHandlers({ ask: async () => "语音答案", confirm: async () => true });
    const voice = await tool.execute("voice-1", { question: "语音提问" }, undefined, undefined, ctx);
    assert.deepEqual(voice.details, { answer: "语音答案", via: "voice" });
  } finally {
    setVoiceHandlers(null);
    session.dispose();
  }
});
