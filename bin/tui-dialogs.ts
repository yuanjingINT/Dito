/** 自定义 TUI 的扩展弹窗：挂载覆盖层、捕获焦点，并在取消/中断时清理。 */
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import {
  Input,
  parseKey,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";

const sky = (text: string): string => `\x1b[38;2;70;200;230m${text}\x1b[0m`;
const dim = (text: string): string => `\x1b[38;2;115;135;145m${text}\x1b[0m`;

/** 使用 Dito 配色，不依赖 SDK 的外部主题 JSON，便携 bundle 也能直接运行。 */
class PromptDialog implements Component, Focusable {
  private title: Text;
  private field: Input | SelectList;
  private hints: Text;
  private timer: ReturnType<typeof setInterval> | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private _focused = false;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    if (this.field instanceof Input) this.field.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    title: string,
    options: string[] | undefined,
    private readonly done: (answer: string | undefined) => void,
    opts?: ExtensionUIDialogOptions,
  ) {
    this.title = new Text(sky(title), 0, 0);
    if (options) {
      const titleRows = this.title.render(Math.max(1, Math.floor(tui.terminal.columns * 0.9) - 4)).length;
      const list = new SelectList(options.map((value) => ({ value, label: value })),
        Math.max(1, Math.min(8, tui.terminal.rows - titleRows - 9)), {
          selectedPrefix: sky, selectedText: sky, description: dim, scrollInfo: dim, noMatch: dim,
        });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      this.field = list;
      this.hints = new Text(dim("↑↓ 选择 · Enter 确认 · Esc 取消"), 0, 0);
    } else {
      const input = new Input();
      input.onSubmit = (value) => done(value);
      input.onEscape = () => done(undefined);
      this.field = input;
      this.hints = new Text(dim("请输入回答 · Enter 提交 · Esc 取消"), 0, 0);
    }
    if (opts?.timeout && opts.timeout > 0) {
      const deadline = Date.now() + opts.timeout;
      const update = (): void => {
        this.title.setText(sky(`${title} (${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s)`));
        tui.requestRender();
      };
      update();
      this.timer = setInterval(update, 1000);
      this.timeout = setTimeout(() => done(undefined), opts.timeout);
    }
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const content = ["", ...this.title.render(inner), "", ...this.field.render(inner), "", ...this.hints.render(inner), ""];
    if (width < 4) return content.map((line) => truncateToWidth(line, width, ""));
    return [
      sky(`┌${"─".repeat(width - 2)}┐`),
      ...content.map((line) => {
        const text = truncateToWidth(line, inner, "");
        return `${sky("│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${sky("│")}`;
      }),
      sky(`└${"─".repeat(width - 2)}┘`),
    ];
  }

  handleInput(data: string): void {
    const key = parseKey(data);
    if (key === "escape" || key === "ctrl+c") this.done(undefined);
    else if (this.field instanceof SelectList && (key === "j" || key === "k")) {
      this.field.handleInput(key === "j" ? "\x1b[B" : "\x1b[A");
    } else if (key === "enter") {
      if (this.field instanceof Input) this.done(this.field.getValue());
      else this.field.handleInput("\r");
    } else this.field.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.title.invalidate();
    this.field.invalidate();
    this.hints.invalidate();
  }

  dispose(): void {
    clearInterval(this.timer);
    clearTimeout(this.timeout);
  }
}

export class TuiDialogs {
  private cancelActive: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly tui: TUI) {}

  select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    if (!options.length) return Promise.resolve(undefined);
    return this.show(title, options, opts);
  }

  input(title: string, _placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.show(title, undefined, opts);
  }

  async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return await this.select(`${title}\n${message}`, ["确认", "取消"], opts) === "确认";
  }

  dispose(): void {
    this.disposed = true;
    this.cancelActive?.();
  }

  private show(
    title: string,
    options: string[] | undefined,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    if (this.disposed || opts?.signal?.aborted) return Promise.resolve(undefined);
    this.cancelActive?.();

    return new Promise((resolve, reject) => {
      let component: PromptDialog | undefined;
      let overlay: OverlayHandle | undefined;
      let settled = false;
      const cleanup = (): void => {
        opts?.signal?.removeEventListener("abort", cancel);
        if (this.cancelActive === cancel) this.cancelActive = undefined;
        overlay?.hide();
        component?.dispose();
        this.tui.requestRender();
      };
      const finish = (answer: string | undefined): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(answer);
      };
      const cancel = (): void => finish(undefined);
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
