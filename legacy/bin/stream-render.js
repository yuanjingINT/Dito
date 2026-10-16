import { Markdown } from "@earendil-works/pi-tui";
class TerminalTextStream {
  state = "text";
  carriageReturn = false;
  push(chunk) {
    let out = "";
    for (const char of chunk) {
      const code = char.charCodeAt(0);
      if (this.state === "stringEscape") {
        this.state = char === "\\" || char === "\x07" || char === "" ? "text" : char === "\x1B" ? "stringEscape" : "string";
        continue;
      }
      if (this.state === "string") {
        if (char === "\x1B") this.state = "stringEscape";
        else if (char === "\x07" || char === "") this.state = "text";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 64 && code <= 126) this.state = "text";
        else if (char === "\x1B") this.state = "escape";
        continue;
      }
      if (this.state === "escape") {
        if (char === "[") this.state = "csi";
        else if ("]PX^_".includes(char)) this.state = "string";
        else if (code >= 48 && code <= 126) this.state = "text";
        continue;
      }
      if (char === "\x1B") {
        this.state = "escape";
        continue;
      }
      if (char === "") {
        this.state = "csi";
        continue;
      }
      if (["", "", "", "", ""].includes(char)) {
        this.state = "string";
        continue;
      }
      if (char === "\r") {
        out += "\n";
        this.carriageReturn = true;
        continue;
      }
      if (char === "\n" && this.carriageReturn) {
        this.carriageReturn = false;
        continue;
      }
      this.carriageReturn = false;
      if (char === "\n" || char === "	" || code >= 32 && !(code >= 127 && code <= 159)) out += char;
    }
    return out;
  }
}
function terminalText(text) {
  return new TerminalTextStream().push(text);
}
const PREVIEW_CHARS = 8192;
class StreamingMarkdown {
  constructor(theme, text) {
    this.theme = theme;
    this.tail = new Markdown("", 0, 0, theme);
    if (text !== void 0) this.setText(text);
  }
  theme;
  filter = new TerminalTextStream();
  blocks = [];
  drained = 0;
  line = "";
  pending = "";
  lineTail = "";
  pendingTail = "";
  fence;
  mathCloser;
  finished = false;
  fullText = "";
  previewText = "";
  tail;
  get text() {
    return this.fullText;
  }
  append(delta) {
    const clean = this.filter.push(delta);
    if (!clean) return "";
    this.finished = false;
    this.fullText += clean;
    const lines = clean.split("\n");
    const first = lines.shift();
    this.line += first;
    this.lineTail = (this.lineTail + first).slice(-PREVIEW_CHARS * 2);
    for (const next of lines) {
      const line = this.line;
      this.pendingTail = (this.pendingTail + this.lineTail + "\n").slice(-PREVIEW_CHARS * 2);
      this.line = next;
      this.lineTail = next.slice(-PREVIEW_CHARS * 2);
      this.pending += line + "\n";
      const trimmed = line.trim();
      if (this.fence) {
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
        if (close && close[0] === this.fence.marker && close.length >= this.fence.length) {
          this.fence = void 0;
          this.commit();
        }
      } else if (this.mathCloser) {
        if (trimmed === this.mathCloser) {
          this.mathCloser = void 0;
          this.commit();
        }
      } else {
        const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (open) this.fence = { marker: open[0], length: open.length, opener: line };
        else if (trimmed === "$$" || trimmed === "\\[") this.mathCloser = trimmed === "$$" ? "$$" : "\\]";
        else if (!trimmed) this.commit();
      }
    }
    return clean;
  }
  /** 最终快照权威：一次完整解析，修正流中尚未确定的表格、引用和列表。 */
  setText(text) {
    this.filter = new TerminalTextStream();
    this.fullText = this.filter.push(text);
    this.blocks = this.fullText ? [new Markdown(this.fullText, 0, 0, this.theme)] : [];
    this.drained = 0;
    this.line = this.pending = this.lineTail = this.pendingTail = "";
    this.fence = void 0;
    this.mathCloser = void 0;
    this.finished = true;
  }
  finish() {
    if (this.finished) return;
    this.pending += this.line;
    this.line = "";
    this.lineTail = "";
    this.commit();
    this.finished = true;
  }
  commit() {
    if (this.pending) this.blocks.push(new Markdown(this.pending, 0, 0, this.theme));
    this.pending = "";
    this.pendingTail = "";
  }
  /** 静态终端只消费新落定的块，预览不会消费它们。 */
  takeCommitted(width) {
    const lines = this.blocks.slice(this.drained).flatMap((block) => block.render(width));
    this.drained = this.blocks.length;
    return lines;
  }
  preview(width, maxRows = 8) {
    if (this.finished || maxRows <= 0) return [];
    const pending = this.pendingTail + this.lineTail;
    let text = Array.from(pending.slice(-PREVIEW_CHARS * 2)).slice(-PREVIEW_CHARS).join("");
    if (this.fence && text.length < this.pending.length + this.line.length) text = this.fence.opener + "\n" + text;
    if (text !== this.previewText) {
      this.previewText = text;
      this.tail.setText(text);
    }
    return this.tail.render(width).slice(-maxRows);
  }
  render(width) {
    return [...this.blocks.flatMap((block) => block.render(width)), ...this.preview(width)];
  }
  invalidate() {
    for (const block of this.blocks) block.invalidate();
    this.tail.invalidate();
  }
}
export {
  StreamingMarkdown,
  TerminalTextStream,
  terminalText
};
