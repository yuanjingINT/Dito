import assert from "node:assert/strict";
import { test } from "node:test";
import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createPrinter } from "../bin/console-printer.js";
import { markdownTheme, ConversationView } from "../bin/tui-components.js";
import { StreamingMarkdown, TerminalTextStream, terminalText } from "../bin/stream-render.js";
const plain = (rows) => stripTerminalSequences(rows.join("\n"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("terminal controls and CRLF are filtered identically at every chunk boundary", () => {
  const raw = "你好😀\r\nA\x1B[2JB\x1B]0;fake title\x07C\x1BPprivate\x1B\\D31mE\x1B(BF	\0\x07";
  const expected = "你好😀\nABCDEF	";
  assert.equal(terminalText(raw), expected);
  for (let i = 0; i <= raw.length; i++) {
    const filter2 = new TerminalTextStream();
    assert.equal(filter2.push(raw.slice(0, i)) + filter2.push(raw.slice(i)), expected, `split ${i}`);
  }
  const filter = new TerminalTextStream();
  assert.equal(filter.push("text\x1B]"), "text");
  assert.equal(filter.push("still hidden"), "");
  assert.equal(filter.push("\x1B\\visible"), "visible");
});
test("half lines and open code preview live, committed content is consumed only once", () => {
  const body = new StreamingMarkdown(markdownTheme);
  body.append("## Hea");
  assert.match(plain(body.preview(60)), /Hea/);
  assert.deepEqual(body.takeCommitted(60), []);
  body.append("ding\n\n```ts\nconst n = ");
  assert.match(plain(body.takeCommitted(60)), /Heading/);
  const preview = plain(body.preview(60));
  assert.match(preview, /const n/);
  assert.deepEqual(body.takeCommitted(60), [], "peeking never consumes body content");
  body.append("42;\n```\n尾行😀");
  assert.match(plain(body.takeCommitted(60)), /const n = 42/);
  assert.match(plain(body.preview(60)), /尾行😀/);
  body.finish();
  assert.match(plain(body.takeCommitted(60)), /尾行😀/);
  assert.deepEqual(body.takeCommitted(60), []);
  assert.deepEqual(body.preview(60), []);
});
test("large pending code and paragraphs have bounded Unicode previews and retain the final text", () => {
  for (const prefix of ["", "```ts\n"]) {
    const body = new StreamingMarkdown(markdownTheme);
    const text = prefix + "中文😀".repeat(1e4) + "END";
    body.append(text);
    const rows = body.preview(38, 4);
    assert.ok(rows.length <= 4);
    assert.ok(rows.every((row) => visibleWidth(row) <= 38));
    assert.match(plain(rows), /END/);
    assert.doesNotMatch(plain(rows), /\uFFFD/);
    body.finish();
    assert.equal(body.text, text);
    assert.match(plain(body.render(38)), /END/);
  }
});
test("final snapshots restore full Markdown tables, lists and references after arbitrary splits", () => {
  const text = "Intro **bold**\n\n| Key | Value |\n| --- | --- |\n| 中 | 😀 |\n\n- first\n\n  continuation\n- second\n\n[link][ref]\n\n[ref]: https://example.com\n";
  const body = new StreamingMarkdown(markdownTheme);
  for (const char of text) {
    body.append(char);
    body.preview(45);
  }
  body.setText(text);
  for (const width of [18, 45, 100]) {
    assert.deepEqual(body.render(width), new Markdown(text, 0, 0, markdownTheme).render(width));
  }
});
test("interleaved thinking and text keep block order, final snapshots do not duplicate text", () => {
  const view = new ConversationView();
  view.beginAssistant();
  view.updateAssistant({ type: "text_delta", contentIndex: 0, delta: "first-answer" });
  view.updateAssistant({ type: "thinking_delta", contentIndex: 1, delta: "later-thought" });
  view.updateAssistant({ type: "text_delta", contentIndex: 2, delta: "second-answer" });
  let rows = view.render(70);
  const thinkingRow = rows.findIndex((row) => plain([row]).includes("◇ 思考"));
  assert.ok(view.toggleThinkingAt(thinkingRow));
  const message = { role: "assistant", content: [
    { type: "text", text: "first-answer finished" },
    { type: "thinking", thinking: "later-thought finished" },
    { type: "text", text: "second-answer finished" }
  ] };
  view.finishAssistant(message);
  let rendered = plain(view.render(70));
  assert.ok(rendered.indexOf("first-answer") < rendered.indexOf("later-thought"));
  assert.ok(rendered.indexOf("later-thought") < rendered.indexOf("second-answer"));
  assert.equal((rendered.match(/first-answer/g) ?? []).length, 1);
  assert.equal((rendered.match(/second-answer/g) ?? []).length, 1);
  view.reset([message]);
  rows = view.render(70);
  view.toggleThinkingAt(rows.findIndex((row) => plain([row]).includes("◇ 思考")));
  assert.equal(plain(view.render(70)), rendered, "live and restored conversation agree");
});
class Output {
  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }
  isTTY;
  columns = 60;
  rows = 20;
  text = "";
  write(chunk) {
    this.text += chunk;
  }
}
function printerSession() {
  const listeners = /* @__PURE__ */ new Set();
  return {
    listeners,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit(e) {
      for (const cb of listeners) cb(e);
    },
    delta(delta, contentIndex = 0, kind = "text") {
      this.emit({ type: "message_update", assistantMessageEvent: { type: `${kind}_delta`, contentIndex, delta } });
    },
    end(content, stopReason = "stop", errorMessage) {
      this.emit({ type: "message_end", message: { role: "assistant", content, stopReason, errorMessage } });
    }
  };
}
test("piped output streams raw Markdown without ANSI, spinners or duplicate final messages", () => {
  const output = new Output();
  const printer = createPrinter(output);
  const session = printerSession();
  printer.attach(session);
  session.emit({ type: "agent_start" });
  session.emit({ type: "message_start", message: { role: "assistant" } });
  session.delta("**你\x1B[");
  session.delta("2J好**\r");
  session.delta("\nnext");
  assert.match(output.text, /\*\*你好\*\*\nnext/);
  session.end([{ type: "text", text: "**你好**\nnext tail" }]);
  session.emit({ type: "agent_end" });
  assert.equal((output.text.match(/你好/g) ?? []).length, 1);
  assert.match(output.text, /next tail/);
  assert.doesNotMatch(output.text, /\x1b|\r|⠋/);
  printer.dispose();
  assert.equal(session.listeners.size, 0);
});
test("console prints final-only providers and flushes missing or aborted final fragments", () => {
  const output = new Output();
  const printer = createPrinter(output);
  const session = printerSession();
  printer.attach(session);
  session.end([{ type: "thinking", thinking: "thought-only" }, { type: "text", text: "final-only" }]);
  assert.match(output.text, /thought-only[\s\S]*final-only/);
  session.emit({ type: "message_start", message: { role: "assistant" } });
  session.delta("partial");
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "partial-tail" } });
  session.end([{ type: "text", text: "partial-tail" }], "error", "network gone");
  session.emit({ type: "agent_end" });
  assert.equal((output.text.match(/partial-tail/g) ?? []).length, 1);
  assert.match(output.text, /network gone/);
  session.emit({ type: "message_start", message: { role: "assistant" } });
  output.text = "";
  session.end([{ type: "text", text: "repeated-prefix" }, { type: "text", text: "repeated-prefix second-block" }]);
  assert.equal((output.text.match(/repeated-prefix/g) ?? []).length, 2, "distinct final-only blocks remain distinct");
  printer.dispose();
});
test("continuous small deltas paint on the frame clock without waiting for a pause", async () => {
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const output = new Output(true);
  const printer = createPrinter(output);
  const session = printerSession();
  printer.attach(session);
  try {
    session.delta("ongoing-half-line");
    for (let i = 0; i < 4; i++) {
      await sleep(25);
      session.delta(` ${i}`);
    }
    assert.match(plain([output.text]), /ongoing-half-line/, "preview paints while deltas are still arriving");
  } finally {
    printer.dispose();
    if (previousTerm === void 0) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  }
});
test("TTY previews unfinished lines, flushes on tool transitions and cleans timers on dispose", async () => {
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const output = new Output(true);
  const printer = createPrinter(output);
  const session = printerSession();
  printer.attach(session);
  try {
    session.delta("## Live half-line");
    await sleep(110);
    assert.match(plain([output.text]), /Live half-line/);
    output.text = "";
    session.delta(" tail\n\n```ts\nconst n = 4");
    await sleep(110);
    assert.match(plain([output.text]), /const n = 4/);
    assert.match(output.text, /\x1b\[\d+A\r\x1b\[J/, "old preview erased before body lands");
    session.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "tool", args: { command: "echo test" } });
    session.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "tool", isError: false });
    session.emit({ type: "agent_end" });
  } finally {
    printer.dispose();
    if (previousTerm === void 0) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  }
  const atDisposal = output.text;
  await sleep(110);
  assert.equal(output.text, atDisposal, "no delayed paint after disposal");
  assert.equal(session.listeners.size, 0);
});
