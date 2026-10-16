import {
  Input,
  parseKey,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth
} from "@earendil-works/pi-tui";
const sky = (text) => `\x1B[38;2;70;200;230m${text}\x1B[0m`;
const dim = (text) => `\x1B[38;2;115;135;145m${text}\x1B[0m`;
class PromptDialog {
  constructor(tui, title, options, done, opts) {
    this.tui = tui;
    this.done = done;
    this.title = new Text(sky(title), 0, 0);
    if (options) {
      const titleRows = this.title.render(Math.max(1, Math.floor(tui.terminal.columns * 0.9) - 4)).length;
      const list = new SelectList(
        options.map((value) => ({ value, label: value })),
        Math.max(1, Math.min(8, tui.terminal.rows - titleRows - 9)),
        {
          selectedPrefix: sky,
          selectedText: sky,
          description: dim,
          scrollInfo: dim,
          noMatch: dim
        }
      );
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(void 0);
      this.field = list;
      this.hints = new Text(dim("↑↓ 选择 · Enter 确认 · Esc 取消"), 0, 0);
    } else {
      const input = new Input();
      input.onSubmit = (value) => done(value);
      input.onEscape = () => done(void 0);
      this.field = input;
      this.hints = new Text(dim("请输入回答 · Enter 提交 · Esc 取消"), 0, 0);
    }
    if (opts?.timeout && opts.timeout > 0) {
      const deadline = Date.now() + opts.timeout;
      const update = () => {
        this.title.setText(sky(`${title} (${Math.max(0, Math.ceil((deadline - Date.now()) / 1e3))}s)`));
        tui.requestRender();
      };
      update();
      this.timer = setInterval(update, 1e3);
      this.timeout = setTimeout(() => done(void 0), opts.timeout);
    }
  }
  tui;
  done;
  title;
  field;
  hints;
  timer;
  timeout;
  _focused = false;
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    if (this.field instanceof Input) this.field.focused = value;
  }
  render(width) {
    const inner = Math.max(1, width - 4);
    const content = ["", ...this.title.render(inner), "", ...this.field.render(inner), "", ...this.hints.render(inner), ""];
    if (width < 4) return content.map((line) => truncateToWidth(line, width, ""));
    return [
      sky(`┌${"─".repeat(width - 2)}┐`),
      ...content.map((line) => {
        const text = truncateToWidth(line, inner, "");
        return `${sky("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${sky("│")}`;
      }),
      sky(`└${"─".repeat(width - 2)}┘`)
    ];
  }
  handleInput(data) {
    const key = parseKey(data);
    if (key === "escape" || key === "ctrl+c") this.done(void 0);
    else if (this.field instanceof SelectList && (key === "j" || key === "k")) {
      this.field.handleInput(key === "j" ? "\x1B[B" : "\x1B[A");
    } else if (key === "enter") {
      if (this.field instanceof Input) this.done(this.field.getValue());
      else this.field.handleInput("\r");
    } else this.field.handleInput(data);
    this.tui.requestRender();
  }
  invalidate() {
    this.title.invalidate();
    this.field.invalidate();
    this.hints.invalidate();
  }
  dispose() {
    clearInterval(this.timer);
    clearTimeout(this.timeout);
  }
}
class TuiDialogs {
  constructor(tui) {
    this.tui = tui;
  }
  tui;
  cancelActive;
  disposed = false;
  select(title, options, opts) {
    if (!options.length) return Promise.resolve(void 0);
    return this.show(title, options, opts);
  }
  input(title, _placeholder, opts) {
    return this.show(title, void 0, opts);
  }
  async confirm(title, message, opts) {
    return await this.select(`${title}
${message}`, ["确认", "取消"], opts) === "确认";
  }
  dispose() {
    this.disposed = true;
    this.cancelActive?.();
  }
  show(title, options, opts) {
    if (this.disposed || opts?.signal?.aborted) return Promise.resolve(void 0);
    this.cancelActive?.();
    return new Promise((resolve, reject) => {
      let component;
      let overlay;
      let settled = false;
      const cleanup = () => {
        opts?.signal?.removeEventListener("abort", cancel);
        if (this.cancelActive === cancel) this.cancelActive = void 0;
        overlay?.hide();
        component?.dispose();
        this.tui.requestRender();
      };
      const finish = (answer) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(answer);
      };
      const cancel = () => finish(void 0);
      this.cancelActive = cancel;
      opts?.signal?.addEventListener("abort", cancel, { once: true });
      try {
        component = new PromptDialog(this.tui, title, options, finish, opts);
        overlay = this.tui.showOverlay(component, { width: "90%", margin: 1 });
        this.tui.requestRender();
      } catch (err) {
        settled = true;
        cleanup();
        reject(err);
      }
    });
  }
}
export {
  TuiDialogs
};
