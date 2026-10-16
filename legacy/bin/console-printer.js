import { MODE_DEFS, getMode } from "../extensions/mode.js";
import { C, argsSummary, markdownTheme, toolOutput } from "./tui-components.js";
import { StreamingMarkdown, terminalText } from "./stream-render.js";
function createPrinter(output = process.stdout) {
  const tty = output.isTTY === true && process.env.TERM !== "dumb";
  const parts = /* @__PURE__ */ new Map();
  const tools = /* @__PURE__ */ new Set();
  let active;
  let legacyIndex = -1;
  let previewRows = 0;
  let previewTimer;
  let spinner;
  let unsubscribe;
  let lineOpen = false;
  const width = () => Math.max(1, (output.columns ?? 80) - 1);
  const writeLine = (text) => {
    output.write(text + "\n");
    lineOpen = false;
  };
  const paint = (text, color) => tty ? color + text + C.reset : text;
  function erasePreview(cancelTimer = true) {
    if (cancelTimer && previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = void 0;
    }
    if (previewRows) {
      output.write(`\x1B[${previewRows}A\r\x1B[J`);
      previewRows = 0;
    }
  }
  function stopSpinner() {
    if (spinner) {
      clearInterval(spinner);
      spinner = void 0;
      output.write("\r\x1B[2K");
    }
  }
  function waiting(label) {
    stopSpinner();
    if (!tty) return;
    let frame = 0;
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    output.write(paint(`${frames[0]} ${label}`, C.dim));
    spinner = setInterval(() => output.write(`\r\x1B[2K${paint(`${frames[++frame % frames.length]} ${label}`, C.dim)}`), 80);
    spinner.unref();
  }
  function writeRows(lines, part) {
    if (lines.length) writeLine(part.kind === "thinking" ? paint(lines.join("\n"), C.dim) : lines.join("\n"));
  }
  function schedulePreview() {
    if (!tty || previewTimer || !active) return;
    previewTimer = setTimeout(() => {
      previewTimer = void 0;
      if (!active) return;
      erasePreview();
      const rows = active.markdown.preview(width(), Math.max(1, Math.min(8, (output.rows ?? 24) - 4)));
      if (rows.length) {
        writeRows(rows, active);
        previewRows = rows.length;
      }
    }, 80);
    previewTimer.unref();
  }
  function finishActive() {
    stopSpinner();
    erasePreview();
    if (active) {
      active.markdown.finish();
      if (tty) writeRows(active.markdown.takeCommitted(width()), active);
    }
    if (lineOpen) writeLine("");
    active = void 0;
  }
  function beginMessage() {
    finishActive();
    parts.clear();
    legacyIndex = -1;
  }
  function partFor(kind, index) {
    if (index === void 0) {
      if (parts.get(legacyIndex)?.kind !== kind) legacyIndex = Math.max(-1, ...parts.keys()) + 1;
      index = legacyIndex;
    }
    let part = parts.get(index);
    if (!part) {
      part = { kind, markdown: new StreamingMarkdown(markdownTheme) };
      parts.set(index, part);
    }
    if (active !== part) {
      finishActive();
      active = part;
      writeLine(kind === "thinking" ? paint("◇ 思考", C.dim) : paint("蒂特 ›", MODE_DEFS[getMode()].color + C.bold));
    }
    return part;
  }
  function append(part, delta) {
    stopSpinner();
    const clean = part.markdown.append(delta);
    if (!clean) return;
    if (tty) {
      const rows = part.markdown.takeCommitted(width());
      if (rows.length) {
        output.write("\x1B[?2026h");
        erasePreview(false);
        writeRows(rows, part);
        output.write("\x1B[?2026l");
      }
      schedulePreview();
    } else {
      output.write(clean);
      lineOpen = !clean.endsWith("\n");
    }
  }
  function reconcile(part, finalText) {
    const clean = terminalText(finalText);
    if (clean.startsWith(part.markdown.text)) append(part, clean.slice(part.markdown.text.length));
  }
  function accept(event) {
    const e = event;
    const ame = e.assistantMessageEvent;
    if (e.type === "agent_start") {
      tools.clear();
      waiting("等待回复…");
    } else if (e.type === "message_start" && e.message?.role === "assistant") beginMessage();
    else if (e.type === "message_update" && ame) {
      const kind = ame.type.startsWith("thinking_") ? "thinking" : ame.type.startsWith("text_") ? "text" : void 0;
      if (!kind) return;
      if (ame.type.endsWith("_delta")) append(partFor(kind, ame.contentIndex), ame.delta ?? "");
      else if (ame.type.endsWith("_end")) {
        const part = partFor(kind, ame.contentIndex);
        if (ame.content !== void 0) reconcile(part, ame.content);
        finishActive();
      }
    } else if (e.type === "message_end" && e.message?.role === "assistant") {
      if (Array.isArray(e.message.content)) {
        const consumed = /* @__PURE__ */ new Set();
        for (const [index, raw] of e.message.content.entries()) {
          const kind = raw?.type === "thinking" ? "thinking" : raw?.type === "text" ? "text" : void 0;
          const text = kind === "thinking" ? raw.thinking : raw?.text;
          if (!kind || typeof text !== "string" || !text) continue;
          let part = parts.get(index);
          if (!part || part.kind !== kind || consumed.has(part)) part = [...parts.values()].find((item) => !consumed.has(item) && item.kind === kind && terminalText(text).startsWith(item.markdown.text));
          if (!part) {
            part = partFor(kind, index);
            append(part, text);
          } else if (terminalText(text) !== part.markdown.text) {
            if (active !== part) {
              finishActive();
              active = part;
            }
            reconcile(part, text);
          }
          consumed.add(part);
        }
      } else if (typeof e.message.content === "string" && !parts.size) append(partFor("text"), e.message.content);
      finishActive();
      if (e.message.stopReason === "error" && e.message.errorMessage) {
        writeLine(paint(/429|rate limit|限流/i.test(e.message.errorMessage) ? "[限流] 模型服务请求过于频繁，稍后再试" : `[出错] ${terminalText(e.message.errorMessage)}`, C.red));
      }
    } else if (e.type === "tool_execution_start" && e.toolName) {
      if (e.toolCallId && tools.has(e.toolCallId)) return;
      if (e.toolCallId) tools.add(e.toolCallId);
      finishActive();
      writeLine(paint(`⚙ 指令：${terminalText(e.toolName)} ${argsSummary(e.args).slice(0, 160)}`, C.yellow));
      waiting("执行中");
    } else if (e.type === "tool_execution_end") {
      stopSpinner();
      writeLine(paint(`${e.isError ? "× 失败" : "✓ 完成"} ${terminalText(e.toolName ?? "工具")}`, e.isError ? C.red : C.dim));
      if (e.isError && e.result) writeLine(toolOutput(e.result));
    } else if (e.type === "compaction_start") {
      finishActive();
      writeLine(paint(e.reason === "overflow" ? "上下文超限，正在压缩后重试…" : "上下文较长，正在自动压缩…", C.dim));
      waiting("压缩中");
    } else if (e.type === "compaction_end") {
      stopSpinner();
      if (e.aborted) writeLine("上下文压缩已取消");
      else if (e.result) writeLine("上下文已压缩，已保留最近对话");
      else if (e.errorMessage) writeLine(`上下文压缩失败：${terminalText(e.errorMessage)}`);
    } else if (e.type === "agent_end" || e.type === "agent_settled") {
      finishActive();
      tools.clear();
    }
  }
  return {
    attach(session) {
      unsubscribe?.();
      const remove = session.subscribe(accept);
      unsubscribe = typeof remove === "function" ? remove : void 0;
    },
    dispose() {
      finishActive();
      unsubscribe?.();
      unsubscribe = void 0;
    }
  };
}
export {
  createPrinter
};
