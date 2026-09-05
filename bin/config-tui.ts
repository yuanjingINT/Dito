/**
 * Dito 配置页面（TUI）—— opencode 风格重写。
 *
 * 观感对齐 opencode，保留 Dito 元素：
 * - 顶栏 `◈ Dito 配置` + 右侧当前模型；面板用 breadcrumb（配置 › 分区 › 子页）与圆角边框。
 * - 列表行右侧显示当前值，选中行整行高亮；底部是按键提示栏，右侧显示位置指示。
 * - 操作反馈用自动消失的 toast；导航 j/k 或方向键，enter 选择/编辑，s 保存，esc 返回。
 * - 保留天青色主题、◈ Dito 字标、中文分区/字段与全部配置项；仍读写
 *   ~/.pi/agent/dito/config.json，改动即时生效。
 *
 * 修复旧版 bug：编辑态把 h/l（vim 左右键）当作移动光标，导致供应商等输入框
 * 打不出字母 h/l；现在编辑态只用方向键/Home/End 移动光标，其余可打印字符原样插入。
 *
 * 用法：dito config
 */
import {
  loadConfig,
  saveConfig,
  listFiles,
  PERSONAS_DIR,
  IDENTITIES_DIR,
  fetchModelList,
  applyFetchedModels,
  backfillPresetModels,
  type DitoConfig,
  type ProviderConfig,
} from "../extensions/util.js";

// ── ANSI 与主题（天青色系，保留 Dito 视觉） ──────────────────────

const ALT = "\x1b[?1049h";
const LEAVE = "\x1b[?1049l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[90m",
  dimmer: "\x1b[38;2;115;135;145m",
  sky: "\x1b[38;2;70;200;230m",
  skyBright: "\x1b[38;2;150;230;255m",
  yellow: "\x1b[38;2;220;190;110m",
  green: "\x1b[38;2;126;216;163m",
  red: "\x1b[38;2;235;130;120m",
  // 选中行：固定暗青底（不用 \x1b[7m 反色，避免黑白闪烁）
  selBg: "\x1b[48;2;22;72;86m",
};

const ENTER = ["\r", "\n"];
const UP = ["\x1b[A", "k"];
const DOWN = ["\x1b[B", "j"];
// 编辑态的光标移动只认方向键与 Home/End，不认 vim 的 h/l——这是旧版打不出 h 的根源
const LEFT_ARROW = "\x1b[D";
const RIGHT_ARROW = "\x1b[C";
const BACKSPACE = ["\x7f", "\x08"];
const DELETE = "\x1b[3~";
const HOME = ["\x1b[H", "\x1b[1~"];
const END = ["\x1b[F", "\x1b[4~"];

// ── 宽度计算（CJK 按 2 列，否则中文行右对齐会错位） ──────────────

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    w += charWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

function padEndVis(s: string, width: number): string {
  const len = visualWidth(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

/** 按显示宽度截断纯文本（无 ANSI），超宽补省略号。 */
function truncPlain(s: string, width: number): string {
  if (width <= 0) return "";
  if (visualWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  const target = width - 1;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > target) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

// ── 按键读取 ─────────────────────────────────────────────────────

let keyQueue: string[] = [];
let keyWaiters: ((k: string) => void)[] = [];

function parseKeys(s: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\x1b") {
      if (s[i + 1] === "[") {
        let j = i + 2;
        while (j < s.length && !/[@-~]/.test(s[j])) j++;
        keys.push(s.slice(i, j + 1));
        i = j + 1;
      } else {
        keys.push("\x1b");
        i++;
      }
    } else {
      keys.push(ch);
      i++;
    }
  }
  return keys;
}

function onData(buf: Buffer): void {
  const keys = parseKeys(buf.toString());
  keyQueue.push(...keys);
  while (keyQueue.length && keyWaiters.length) {
    const k = keyQueue.shift()!;
    keyWaiters.shift()!(k);
  }
}

function startRaw(): void {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
}

function stopRaw(): void {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdin.off("data", onData);
  keyQueue = [];
  keyWaiters = [];
}

function readKey(): Promise<string> {
  return new Promise((resolve) => {
    if (keyQueue.length) resolve(keyQueue.shift()!);
    else keyWaiters.push(resolve);
  });
}

class QuitSignal extends Error {}

function throwIfQuit(key: string): void {
  if (key === "\x03" || key === "\x04") throw new QuitSignal();
}

// ── 绘制基建：整屏重绘 + 圆角面板 + toast ────────────────────────

let needClear = true;
function requestClear(): void {
  needClear = true;
}

/** 当前屏幕的重绘入口（toast 过期 / 终端 resize 时调用）。 */
let drawCurrent: (() => void) | null = null;

interface Toast {
  text: string;
  tone: "info" | "warn" | "error";
  until: number;
}
let toast: Toast | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function notify(text: string, tone: Toast["tone"] = "info"): void {
  toast = { text, tone, until: Date.now() + 2600 };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast = null;
    toastTimer = null;
    drawCurrent?.();
  }, 2700);
  drawCurrent?.();
}

function panelWidth(): number {
  const cols = process.stdout.columns || 80;
  return Math.max(30, Math.min(cols - 2, 94));
}
function panelInnerWidth(): number {
  return panelWidth() - 2;
}

function crumbLine(...parts: string[]): string {
  return parts
    .map((p, i) => (i === parts.length - 1 ? `${C.sky}${p}${C.reset}` : `${C.dimmer}${p}${C.reset}`))
    .join(`${C.dimmer} › ${C.reset}`);
}

function keysHint(segments: [string, string][]): string {
  return segments
    .map(([k, d]) => `${C.skyBright}${k}${C.reset} ${C.dimmer}${d}${C.reset}`)
    .join(`${C.dimmer} · ${C.reset}`);
}

function bgWrap(content: string, width: number): string {
  const pad = Math.max(0, width - visualWidth(content));
  return `${C.selBg}${content}${" ".repeat(pad)}${C.reset}`;
}

function hintRow(hint: string, width: number): string {
  if (!hint) return "";
  return ` ${C.dimmer}${truncPlain(hint, width - 2)}${C.reset}`;
}

/** 列表行：左侧 label，右侧 detail（当前值），选中整行高亮。 */
function menuRow(label: string, detail: string | undefined, sel: boolean, width: number, marked = false): string {
  const prefix = ` ${sel ? ">" : " "} `;
  const labelText = marked ? `${label} *` : label;
  const leftW = visualWidth(prefix) + visualWidth(labelText);
  let right = detail ?? "";
  const avail = width - leftW - 2;
  if (right && visualWidth(right) > avail) right = truncPlain(right, Math.max(0, avail));
  const gap = Math.max(2, width - leftW - visualWidth(right));
  const labelStyled = sel ? `${C.bold}${labelText}${C.reset}` : labelText;
  const rightStyled = right ? `${sel ? C.dim : C.dimmer}${right}${C.reset}` : "";
  const row = `${prefix}${labelStyled}${rightStyled ? `${" ".repeat(gap)}${rightStyled}` : ""}`;
  return sel ? bgWrap(row, width) : padEndVis(row, width);
}

interface ShellOpts {
  crumb: string;
  status: string;
  panelTitle: string;
  body: string[];
  footerLeft: string;
  footerRight: string;
}

function drawShell(o: ShellOpts): void {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const W = panelWidth();
  const Wi = W - 2;
  const lines: string[] = [];

  // 顶栏：◈ Dito 配置 ……… 当前模型
  const brandPlain = " ◈ Dito 配置";
  const statusText = o.status ? truncPlain(o.status, Math.max(0, cols - 2 - visualWidth(brandPlain))) : "";
  const brand = `${C.skyBright}${C.bold} ◈ Dito${C.reset}${C.dimmer} 配置${C.reset}`;
  const headGap = Math.max(1, cols - 1 - visualWidth(brandPlain) - visualWidth(statusText));
  lines.push(`${brand}${" ".repeat(headGap)}${C.dimmer}${statusText}${C.reset}`);

  // breadcrumb
  lines.push(` ${o.crumb}`);
  lines.push("");

  // 圆角面板（标题嵌在上边框里）
  const titleW = visualWidth(o.panelTitle);
  const dashRest = Math.max(0, W - 5 - titleW);
  lines.push(`╭${C.dim}─ ${C.reset}${C.bold}${o.panelTitle}${C.reset}${C.dim} ${"─".repeat(dashRest)}${C.reset}╮`);
  for (const row of o.body) lines.push(`│${padEndVis(row, Wi)}│`);
  lines.push(`╰${"─".repeat(W - 2)}╯`);
  lines.push("");

  // toast 行（无 toast 时留空）
  if (toast && Date.now() < toast.until) {
    const tone = toast.tone === "error" ? C.red : toast.tone === "warn" ? C.yellow : C.sky;
    lines.push(` ${tone}${truncPlain(toast.text, cols - 4)}${C.reset}`);
  } else {
    lines.push("");
  }

  // 底部按键提示栏
  let right = o.footerRight;
  const leftW = visualWidth(o.footerLeft);
  if (leftW + visualWidth(right) + 2 > cols - 1) right = truncPlain(right, Math.max(0, cols - 2 - leftW));
  const footGap = Math.max(1, cols - 1 - leftW - visualWidth(right));
  lines.push(`${o.footerLeft}${" ".repeat(footGap)}${C.dimmer}${right}${C.reset}`);

  frame(lines);
}

function frame(lines: string[]): void {
  const rows = process.stdout.rows || 24;
  let out = needClear ? "\x1b[2J\x1b[H" : "";
  needClear = false;
  const n = Math.max(rows, lines.length);
  for (let i = 0; i < n; i++) {
    out += `\x1b[${i + 1};1H\x1b[2K${lines[i] ?? ""}`;
  }
  process.stdout.write(out);
}

/** 面板内列表可容纳的行数（含 hint 行）。 */
function bodyCapacity(): number {
  const rows = process.stdout.rows || 24;
  return Math.max(1, rows - 8);
}

// ── 通用屏幕：菜单 / 选择 / 表单 ─────────────────────────────────

interface MenuItem {
  label: string;
  detail?: string;
  hint?: string;
  onEnter?: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}

async function menuScreen(opts: {
  crumbParts: string[];
  panelTitle: string;
  items: MenuItem[] | (() => MenuItem[]);
  status?: () => string;
}): Promise<void> {
  let selected = 0;
  const getItems = (): MenuItem[] => (typeof opts.items === "function" ? opts.items() : opts.items);

  const draw = (): void => {
    const items = getItems();
    if (selected >= items.length) selected = Math.max(0, items.length - 1);
    const Wi = panelInnerWidth();
    const cap = bodyCapacity();
    const hint = items[selected]?.hint ?? "";
    let start = 0;
    if (selected >= cap) start = selected - cap + 1;
    if (selected < start) start = selected;
    const body: string[] = [];
    const listCap = Math.max(1, cap - (hint ? 1 : 0));
    for (let i = start; i < items.length && body.length < listCap; i++) {
      body.push(menuRow(items[i].label, items[i].detail, i === selected, Wi));
    }
    if (hint) body.push(hintRow(hint, Wi));
    const hasDelete = items.some((it) => it.onDelete);
    drawShell({
      crumb: crumbLine(...opts.crumbParts),
      status: opts.status?.() ?? "",
      panelTitle: opts.panelTitle,
      body,
      footerLeft: keysHint(
        hasDelete
          ? [["↑↓", "选择"], ["enter", "确认"], ["d", "删除"], ["esc/q", "返回"]]
          : [["↑↓", "选择"], ["enter", "确认"], ["esc/q", "返回"]],
      ),
      footerRight: items.length > 0 ? `${selected + 1}/${items.length}` : "",
    });
  };

  drawCurrent = draw;
  try {
    while (true) {
      draw();
      const key = await readKey();
      throwIfQuit(key);
      const items = getItems();
      if (selected >= items.length) selected = Math.max(0, items.length - 1);
      if (UP.includes(key)) selected = Math.max(0, selected - 1);
      else if (DOWN.includes(key)) selected = Math.min(items.length - 1, selected + 1);
      else if (ENTER.includes(key)) {
        const it = items[selected];
        if (it?.onEnter) {
          drawCurrent = null;
          await it.onEnter();
          drawCurrent = draw;
        }
      } else if (key === "d" || key === "D") {
        const it = items[selected];
        if (it?.onDelete) {
          drawCurrent = null;
          await it.onDelete();
          drawCurrent = draw;
        }
      } else if (key === "\x1b" || key === "q") {
        return;
      }
    }
  } finally {
    drawCurrent = null;
  }
}

async function selectOverlay(opts: {
  title: string;
  crumbParts: string[];
  choices: string[];
  current: string;
  hint?: string;
}): Promise<string | null> {
  const choices = opts.choices;
  let selected = Math.max(0, choices.indexOf(opts.current));

  const draw = (): void => {
    const Wi = panelInnerWidth();
    const cap = bodyCapacity();
    let start = 0;
    if (selected >= cap) start = selected - cap + 1;
    if (selected < start) start = selected;
    const body: string[] = [];
    const listCap = Math.max(1, cap - (opts.hint ? 1 : 0));
    for (let i = start; i < choices.length && body.length < listCap; i++) {
      body.push(menuRow(choices[i], undefined, i === selected, Wi, choices[i] === opts.current));
    }
    if (opts.hint) body.push(hintRow(opts.hint, Wi));
    drawShell({
      crumb: crumbLine(...opts.crumbParts),
      status: "",
      panelTitle: opts.title,
      body,
      footerLeft: keysHint([["↑↓", "选择"], ["enter", "确认"], ["esc", "取消"]]),
      footerRight: choices.length > 0 ? `${selected + 1}/${choices.length}` : "",
    });
  };

  drawCurrent = draw;
  try {
    while (true) {
      draw();
      const key = await readKey();
      throwIfQuit(key);
      if (UP.includes(key)) selected = Math.max(0, selected - 1);
      else if (DOWN.includes(key)) selected = Math.min(choices.length - 1, selected + 1);
      else if (ENTER.includes(key)) return choices[selected] ?? null;
      else if (key === "\x1b" || key === "q") return null;
    }
  } finally {
    drawCurrent = null;
  }
}

async function confirmOverlay(title: string, message: string): Promise<boolean> {
  const r = await selectOverlay({
    title,
    crumbParts: ["配置"],
    choices: ["取消", "确认"],
    current: "取消",
    hint: message,
  });
  return r === "确认";
}

export interface FormField {
  label: string;
  value: string;
  kind: "text" | "bool" | "choice" | "sensitive" | "number";
  choices?: string[];
  hint?: string;
}

/** 非编辑态的字段显示（敏感字段掩码；$ENV 引用不是机密，直接显示）。 */
function fieldDisplayPlain(f: FormField): string {
  if (f.kind === "bool") return f.value === "true" ? "启用" : "停用";
  if (f.kind === "sensitive") {
    if (/^\$\{?[\w-]+\}?$/.test(f.value)) return f.value;
    return f.value ? "********" : "";
  }
  return f.value;
}

/** 编辑态的横向取窗：保证光标始终可见。 */
function editWindow(value: string, cursor: number, width: number): { text: string; cursorPos: number } {
  const chars = [...value];
  if (width <= 0) return { text: "", cursorPos: 0 };
  if (chars.length < width) return { text: value, cursorPos: Math.max(0, Math.min(cursor, chars.length)) };
  let start = Math.max(0, Math.min(cursor - Math.floor(width / 3), chars.length - width));
  if (cursor < start) start = cursor;
  if (cursor >= start + width) start = cursor - width + 1;
  start = Math.max(0, Math.min(start, Math.max(0, chars.length - width)));
  return { text: chars.slice(start, start + width).join(""), cursorPos: cursor - start };
}

function formRow(
  f: FormField,
  sel: boolean,
  editing: boolean,
  cursor: number,
  labelW: number,
  valueW: number,
): string {
  const prefix = ` ${sel ? ">" : " "} `;
  const labelText = visualWidth(f.label) > labelW - 2 ? truncPlain(f.label, labelW - 2) : f.label;
  const labelPad = " ".repeat(Math.max(0, labelW - visualWidth(labelText)));
  const labelStyled = sel ? `${C.sky}${C.bold}${labelText}${C.reset}` : labelText;

  let valuePart: string;
  if (editing) {
    const win = editWindow(f.value, cursor, valueW);
    const chars = [...win.text];
    const at = win.cursorPos < chars.length ? chars[win.cursorPos] : " ";
    const before = chars.slice(0, win.cursorPos).join("");
    const after = chars.slice(win.cursorPos + 1).join("");
    valuePart = `${before}\x1b[7m${at}\x1b[27m${after}`;
  } else if (f.kind === "bool") {
    valuePart = f.value === "true" ? `${C.green}启用${C.reset}` : `${C.dim}停用${C.reset}`;
  } else if (f.kind === "sensitive") {
    const shown = fieldDisplayPlain(f);
    valuePart = shown ? `${C.yellow}${shown}${C.reset}` : `${C.dimmer}（未设置）${C.reset}`;
  } else {
    const raw = f.value || (f.kind === "choice" ? "（未选择）" : "");
    valuePart = truncPlain(raw, valueW);
  }

  const inner = `${prefix}${labelStyled}${labelPad} ${valuePart}`;
  return sel ? bgWrap(inner, panelInnerWidth()) : padEndVis(inner, panelInnerWidth());
}

/**
 * 表单屏幕。内部在副本上编辑；按 s 返回工作副本（由调用方写回并保存），
 * esc/q 返回 null（放弃修改）。Ctrl+C 直接退出整个配置页面。
 */
async function formScreen(opts: {
  crumbParts: string[];
  panelTitle: string;
  fields: FormField[];
  status?: () => string;
}): Promise<FormField[] | null> {
  const work: FormField[] = opts.fields.map((f) => ({ ...f }));
  const cursors = work.map((f) => [...f.value].length);
  let selected = 0;
  let editing = false;

  const draw = (): void => {
    const Wi = panelInnerWidth();
    const rows = process.stdout.rows || 24;
    const cap = Math.max(1, rows - 8);
    const maxLabel = Math.max(...work.map((f) => visualWidth(f.label)));
    const labelW = Math.max(8, Math.min(maxLabel + 2, Math.floor((Wi - 12) / 2)));
    const valueW = Math.max(4, Wi - 4 - labelW);
    const hint = work[selected]?.hint ?? "";
    let start = 0;
    if (selected >= cap) start = selected - cap + 1;
    if (selected < start) start = selected;
    const body: string[] = [];
    for (let i = start; i < work.length && body.length < cap - 1; i++) {
      body.push(formRow(work[i], i === selected, editing && i === selected, cursors[i], labelW, valueW));
    }
    body.push(hintRow(editing ? `${hint ? `${hint}　` : ""}(enter 完成)` : hint, Wi));

    const f = work[selected];
    const enterWord = f?.kind === "bool" || f?.kind === "choice" ? "切换" : "编辑";
    drawShell({
      crumb: crumbLine(...opts.crumbParts),
      status: opts.status?.() ?? "",
      panelTitle: opts.panelTitle,
      body,
      footerLeft: editing
        ? keysHint([["←→", "光标"], ["home/end", "行首尾"], ["backspace", "删除"], ["enter/esc", "完成"]])
        : keysHint([["↑↓", "选择"], ["enter", enterWord], ["s", "保存返回"], ["esc/q", "返回"]]),
      footerRight: `${selected + 1}/${work.length}`,
    });
  };

  drawCurrent = draw;
  try {
    while (true) {
      draw();
      const key = await readKey();
      throwIfQuit(key);
      const f = work[selected];

      if (editing) {
        if (key === "\x1b" || ENTER.includes(key)) {
          editing = false;
        } else if (key === LEFT_ARROW) {
          cursors[selected] = Math.max(0, cursors[selected] - 1);
        } else if (key === RIGHT_ARROW) {
          cursors[selected] = Math.min([...f.value].length, cursors[selected] + 1);
        } else if (HOME.includes(key)) {
          cursors[selected] = 0;
        } else if (END.includes(key)) {
          cursors[selected] = [...f.value].length;
        } else if (BACKSPACE.includes(key)) {
          if (cursors[selected] > 0) {
            const arr = [...f.value];
            arr.splice(cursors[selected] - 1, 1);
            f.value = arr.join("");
            cursors[selected]--;
          }
        } else if (key === DELETE) {
          const arr = [...f.value];
          arr.splice(cursors[selected], 1);
          f.value = arr.join("");
        } else if (!key.startsWith("\x1b") && [...key].length === 1) {
          // 可打印字符（含 h/l/j/k/q/s 等字母与中文）一律原样插入；
          // 控制字符（如粘贴误入的 \x16/Ctrl+V）拒收——它们混进 baseUrl 会让请求全部失效
          const cp = key.codePointAt(0) ?? 0;
          if (cp >= 0x20 && cp !== 0x7f) {
            const arr = [...f.value];
            arr.splice(cursors[selected], 0, key);
            f.value = arr.join("");
            cursors[selected]++;
          }
        }
        continue;
      }

      if (UP.includes(key)) selected = Math.max(0, selected - 1);
      else if (DOWN.includes(key)) selected = Math.min(work.length - 1, selected + 1);
      else if (ENTER.includes(key)) {
        if (f.kind === "bool") {
          f.value = f.value === "true" ? "false" : "true";
        } else if (f.kind === "choice") {
          if (!f.choices || f.choices.length === 0) {
            notify("没有可选项", "warn");
            continue;
          }
          const picked = await selectOverlay({
            title: f.label,
            crumbParts: [...opts.crumbParts, f.label],
            choices: f.choices,
            current: f.value,
          });
          if (picked !== null) f.value = picked;
        } else {
          if (f.kind === "sensitive" && f.value) {
            // 敏感字段进入编辑先清空，避免在旧值（如 $OPENCODE_API_KEY）末尾追加
            f.value = "";
            cursors[selected] = 0;
            notify("已清空，直接输入新值（旧 Key 不会残留）");
          } else {
            cursors[selected] = [...f.value].length;
          }
          editing = true;
        }
      } else if ((key === LEFT_ARROW || key === RIGHT_ARROW) && f.kind === "bool") {
        f.value = f.value === "true" ? "false" : "true";
      } else if (key === "s" || key === "S") {
        return work;
      } else if (key === "\x1b" || key === "q") {
        return null;
      }
    }
  } finally {
    drawCurrent = null;
  }
}

// ── 配置读写与状态栏 ─────────────────────────────────────────────

function parseBool(v: string): boolean {
  return v === "true";
}
function parseNum(v: string, fallback: number): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function activeProvider(cfg: DitoConfig): ProviderConfig | undefined {
  return cfg.providers.find((p) => p.id === cfg.model.provider) ?? cfg.providers[0];
}

function statusOf(cfg: DitoConfig): string {
  const ap = activeProvider(cfg);
  return `${ap ? ap.name : cfg.model.provider} · ${cfg.model.chat || "无模型"}`;
}

function persist(cfg: DitoConfig, message = "已保存，改动即时生效"): void {
  saveConfig(cfg);
  notify(message);
}

async function refreshModelsFor(p: ProviderConfig): Promise<boolean> {
  notify(`正在从 API 获取「${p.name}」的模型列表…`);
  let list: { id: string; name?: string }[] = [];
  try {
    list = await fetchModelList(p);
  } catch {
    list = [];
  }
  // 免 Key 端点（apiKey 为空/空格）只保留 -free 模型，避免混入需鉴权的付费模型导致 401
  if (p.apiKey.trim() === "") {
    list = list.filter((m) => m.id.endsWith("-free"));
  }
  // 合并而非替换：拉取失败（空列表）绝不清空现有模型
  if (applyFetchedModels(p, list)) {
    notify(`已刷新 ${p.models.length} 个模型`);
    return true;
  }
  // 拉取失败且模型列表为空时，用预置模型兜底（如智谱配好 Key 但还没拉过列表）
  if (backfillPresetModels(p)) {
    notify("API 获取失败，已恢复该供应商的预置模型", "warn");
    return true;
  }
  notify("获取失败（离线或缺少 Key），保留已有列表", "warn");
  return false;
}

// ── 各分区屏幕 ───────────────────────────────────────────────────

async function editProviderScreen(cfg: DitoConfig, index: number): Promise<boolean> {
  const p = cfg.providers[index];
  if (!p) return false;
  const oldId = p.id;
  const result = await formScreen({
    crumbParts: ["配置", "模型与供应商", `编辑 ${oldId}`],
    panelTitle: `编辑供应商 ${oldId}`,
    status: () => statusOf(cfg),
    fields: [
      { label: "ID", value: p.id, kind: "text", hint: "唯一标识；pi 内置供应商 id（anthropic/openai 等）由 pi 原生接管" },
      { label: "名称", value: p.name, kind: "text", hint: "显示名称" },
      { label: "baseUrl", value: p.baseUrl, kind: "text", hint: "OpenAI/Anthropic 兼容端点，如 https://api.example.com/v1" },
      { label: "API Key", value: p.apiKey, kind: "sensitive", hint: "进入编辑即清空，直接输入新值；支持 $ENV_VAR 环境变量引用" },
      {
        label: "API 类型",
        value: p.api,
        kind: "choice",
        choices: ["openai-completions", "anthropic-messages", "openai-responses"],
        hint: "端点协议类型",
      },
      {
        label: "模型 id（逗号分隔）",
        value: p.models.map((m) => m.id).join(", "),
        kind: "text",
        hint: "如 gpt-4o, gpt-4o-mini；已存在的模型配置会保留",
      },
    ],
  });
  if (!result) return false;

  p.id = result[0].value.trim() || "custom";
  p.name = result[1].value.trim() || p.id;
  p.baseUrl = result[2].value.trim();
  p.apiKey = result[3].value.trim();
  p.api = result[4].value;
  const ids = result[5].value
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const existing = new Map(p.models.map((m) => [m.id, m]));
  p.models = ids.map(
    (id) =>
      existing.get(id) ?? {
        id,
        name: id,
        reasoning: false,
        input: ["text"] as ("text" | "image")[],
        contextWindow: 128000,
        maxTokens: 16384,
      },
  );
  if (cfg.model.provider === oldId) {
    cfg.model.provider = p.id;
    cfg.model.chat = p.models[0]?.id ?? "";
    cfg.model.vision = (p.models.find((m) => m.input.includes("image")) ?? p.models[0])?.id ?? "";
  }
  persist(cfg, `供应商 ${p.id} 已保存`);
  return true;
}

async function providersScreen(cfg: DitoConfig): Promise<void> {
  const items = (): MenuItem[] => [
    ...cfg.providers.map((p, i) => ({
      label: p.name || p.id,
      detail: `${p.id}${p.id === cfg.model.provider ? " · 使用中" : ""}`,
      hint: `${p.baseUrl || "（未设置 baseUrl）"}`,
      onEnter: () => editProviderScreen(cfg, i),
      onDelete: async () => {
        const ok = await confirmOverlay(
          `删除供应商 ${p.name || p.id}？`,
          "删除后不可恢复；若它是当前使用的供应商，会自动切到列表第一个",
        );
        if (!ok) return;
        const removedId = p.id;
        cfg.providers.splice(i, 1);
        if (cfg.model.provider === removedId) {
          const first = cfg.providers[0];
          cfg.model.provider = first?.id ?? "";
          cfg.model.chat = first?.models[0]?.id ?? "";
          cfg.model.vision = (first?.models.find((m) => m.input.includes("image")) ?? first?.models[0])?.id ?? "";
        }
        persist(cfg, `已删除供应商：${removedId}`);
      },
    })),
    {
      label: "＋ 新增供应商",
      detail: "新建并编辑",
      hint: "新建一个自定义供应商并进入编辑",
      onEnter: async () => {
        const p: ProviderConfig = { id: "custom", name: "自定义", baseUrl: "", apiKey: "", api: "openai-completions", models: [] };
        cfg.providers.push(p);
        const ok = await editProviderScreen(cfg, cfg.providers.length - 1);
        if (!ok) {
          cfg.providers.pop();
          notify("已取消新增", "warn");
        }
      },
    },
  ];
  await menuScreen({
    crumbParts: ["配置", "模型与供应商", "管理供应商"],
    panelTitle: "管理供应商",
    items,
    status: () => statusOf(cfg),
  });
}

async function pickModelScreen(cfg: DitoConfig, kind: "chat" | "vision"): Promise<void> {
  const p = activeProvider(cfg);
  if (!p) return;
  await refreshModelsFor(p);
  if (p.models.length === 0) {
    notify("该供应商没有可用模型", "warn");
    return;
  }
  const choices = p.models.map((m) => `${m.name || m.id} (${m.id})`);
  const cur = kind === "chat" ? cfg.model.chat : cfg.model.vision;
  const curIdx = Math.max(0, p.models.findIndex((m) => m.id === cur));
  const picked = await selectOverlay({
    title: kind === "chat" ? "聊天模型" : "视觉模型",
    crumbParts: ["配置", "模型与供应商"],
    choices,
    current: choices[curIdx] ?? "",
  });
  if (picked === null) return;
  const id = p.models[choices.indexOf(picked)]?.id;
  if (!id) return;
  if (kind === "chat") cfg.model.chat = id;
  else cfg.model.vision = id;
  persist(cfg, `已设置${kind === "chat" ? "聊天" : "视觉"}模型：${id}`);
}

async function modelScreen(cfg: DitoConfig): Promise<void> {
  const items = (): MenuItem[] => {
    const ap = activeProvider(cfg);
    return [
      {
        label: "选择供应商",
        detail: ap ? `${ap.name} (${ap.id})` : "—",
        hint: "切换后自动刷新模型列表，并重置聊天/视觉模型为该供应商默认",
        onEnter: async () => {
          if (cfg.providers.length === 0) {
            notify("没有可用的供应商", "warn");
            return;
          }
          const names = cfg.providers.map((p) => `${p.name} (${p.id})`);
          const picked = await selectOverlay({
            title: "选择供应商",
            crumbParts: ["配置", "模型与供应商"],
            choices: names,
            current: ap ? `${ap.name} (${ap.id})` : "",
          });
          if (picked === null) return;
          const p = cfg.providers[names.indexOf(picked)];
          if (!p) return;
          cfg.model.provider = p.id;
          await refreshModelsFor(p);
          cfg.model.chat = p.models[0]?.id ?? "";
          cfg.model.vision = (p.models.find((m) => m.input.includes("image")) ?? p.models[0])?.id ?? "";
          persist(cfg, `已切换供应商：${p.name}`);
        },
      },
      {
        label: "聊天模型",
        detail: cfg.model.chat || "—",
        hint: "日常对话与工具调用使用的模型（先从 API 刷新列表）",
        onEnter: () => pickModelScreen(cfg, "chat"),
      },
      {
        label: "视觉模型",
        detail: cfg.model.vision || "—",
        hint: "看图使用的模型（先从 API 刷新列表）",
        onEnter: () => pickModelScreen(cfg, "vision"),
      },
      {
        label: "刷新模型列表（API）",
        detail: "GET {baseUrl}/models",
        hint: "从当前供应商拉取最新模型列表；免 Key 供应商只保留 -free 模型",
        onEnter: async () => {
          const p = activeProvider(cfg);
          if (!p) return;
          await refreshModelsFor(p);
          persist(cfg);
        },
      },
      {
        label: "管理供应商",
        detail: `${cfg.providers.length} 个`,
        hint: "新增 / 编辑 / 删除供应商（列表页按 d 删除）",
        onEnter: () => providersScreen(cfg),
      },
    ];
  };
  await menuScreen({
    crumbParts: ["配置", "模型与供应商"],
    panelTitle: "模型与供应商",
    items,
    status: () => statusOf(cfg),
  });
}

async function personaScreen(cfg: DitoConfig): Promise<void> {
  const personas = listFiles(PERSONAS_DIR, ".md");
  const identities = listFiles(IDENTITIES_DIR, ".md");
  const result = await formScreen({
    crumbParts: ["配置", "提示词设定"],
    panelTitle: "提示词设定",
    status: () => statusOf(cfg),
    fields: [
      {
        label: "AI 人格",
        value: cfg.persona.active,
        kind: "choice",
        choices: personas,
        hint: "personas/ 目录下的人设；桌面版只显示名称（正文已加密）",
      },
      {
        label: "用户身份",
        value: cfg.persona.identity,
        kind: "choice",
        choices: identities,
        hint: "identities/ 目录下的用户身份，决定 Dito 回答的深浅",
      },
    ],
  });
  if (!result) return;
  cfg.persona.active = result[0].value || "dito";
  cfg.persona.identity = result[1].value || "默认";
  persist(cfg);
}

async function kbScreen(cfg: DitoConfig): Promise<void> {
  const kb = cfg.plugins.knowledge_base;
  const result = await formScreen({
    crumbParts: ["配置", "知识库"],
    panelTitle: "知识库",
    status: () => statusOf(cfg),
    fields: [
      {
        label: "启用",
        value: String(kb.enabled),
        kind: "bool",
        hint: "本地 SQLite 知识库（kb.db），首次启动自动导入 kb/ 内置文章",
      },
      { label: "数据目录（空=默认）", value: kb.dataDir, kind: "text", hint: "留空使用 ~/.pi/agent/dito/" },
    ],
  });
  if (!result) return;
  kb.enabled = parseBool(result[0].value);
  kb.dataDir = result[1].value.trim();
  persist(cfg);
}

async function memoryScreen(cfg: DitoConfig): Promise<void> {
  const memory = cfg.plugins.memory;
  const result = await formScreen({
    crumbParts: ["配置", "记忆"],
    panelTitle: "记忆",
    status: () => statusOf(cfg),
    fields: [
      { label: "启用", value: String(memory.enabled), kind: "bool", hint: "知识点 + 历史对话，跨会话持久（memory.db）" },
      { label: "自动日记", value: String(memory.autoDiary), kind: "bool", hint: "每轮任务完成后自动把「用户消息 + 回复」写入短日记（保留 7 天）" },
    ],
  });
  if (!result) return;
  memory.enabled = parseBool(result[0].value);
  memory.autoDiary = parseBool(result[1].value);
  persist(cfg);
}

async function searchScreen(cfg: DitoConfig): Promise<void> {
  const ws = cfg.plugins.web_search;
  const result = await formScreen({
    crumbParts: ["配置", "网络搜索"],
    panelTitle: "网络搜索",
    status: () => statusOf(cfg),
    fields: [
      { label: "启用", value: String(ws.enabled), kind: "bool", hint: "无 Key 时自动走 DuckDuckGo → Yahoo → Bing 兜底" },
      { label: "Tavily Key", value: ws.tavilyKeys.join(","), kind: "sensitive", hint: "多个用英文逗号分隔；配置后优先于免费搜索源" },
      { label: "Firecrawl Key", value: ws.firecrawlKeys.join(","), kind: "sensitive", hint: "" },
      { label: "AnySearch Key", value: ws.anysearchKeys.join(","), kind: "sensitive", hint: "" },
      { label: "Exa Key", value: ws.exaKeys.join(","), kind: "sensitive", hint: "" },
      { label: "Perplexity Key", value: ws.perplexityKey, kind: "sensitive", hint: "sonar 在线搜索，返回合成回答 + 引用" },
      { label: "SearXNG 地址", value: ws.searxngUrl, kind: "text", hint: "如 http://localhost:8888（需开启 JSON 输出）" },
    ],
  });
  if (!result) return;
  ws.enabled = parseBool(result[0].value);
  ws.tavilyKeys = result[1].value.split(",").map((s) => s.trim()).filter(Boolean);
  ws.firecrawlKeys = result[2].value.split(",").map((s) => s.trim()).filter(Boolean);
  ws.anysearchKeys = result[3].value.split(",").map((s) => s.trim()).filter(Boolean);
  ws.exaKeys = result[4].value.split(",").map((s) => s.trim()).filter(Boolean);
  ws.perplexityKey = result[5].value.trim();
  ws.searxngUrl = result[6].value.trim();
  persist(cfg);
}

async function voiceScreen(cfg: DitoConfig): Promise<void> {
  const v = cfg.plugins.voice;
  const result = await formScreen({
    crumbParts: ["配置", "语音"],
    panelTitle: "语音",
    status: () => statusOf(cfg),
    fields: [
      { label: "启用", value: String(v.enabled), kind: "bool", hint: "关闭后 `dito voice` 会提示先在配置里启用" },
      { label: "STT 后端", value: v.stt, kind: "choice", choices: ["whisper", "xiaomi", "custom"], hint: "whisper=本地 whisper-cli；xiaomi=小米 MiMo ASR；custom=自定义命令" },
      { label: "TTS 后端", value: v.tts, kind: "choice", choices: ["espeak", "piper", "xiaomi", "custom"], hint: "espeak=本地 espeak-ng；piper=本地；xiaomi=小米 MiMo TTS；custom=自定义命令" },
      { label: "whisper 模型路径", value: v.whisperModel, kind: "text", hint: "ggml 模型文件，如 ~/.local/share/whisper/models/ggml-small-q5_1.bin" },
      { label: "whisper 语言", value: v.whisperLanguage, kind: "text", hint: "zh / auto 等" },
      { label: "espeak 音色", value: v.espeakVoice, kind: "text", hint: "如 zh" },
      { label: "piper 模型", value: v.piperModel, kind: "text", hint: ".onnx 模型文件路径" },
      { label: "小米 API Key", value: v.xiaomiApiKey, kind: "sensitive", hint: "进入编辑即清空，直接输入新值" },
      { label: "小米 TTS 音色", value: v.xiaomiTtsVoice, kind: "text", hint: "preset 音色名，如 冰糖；配了下方声音设计则不生效" },
      { label: "小米 TTS 声音设计", value: v.xiaomiTtsVoiceDesign ?? "", kind: "text", hint: "音色描述（如：年轻女性，清脆甜美，活泼俏皮）→ 用 voicedesign 模型定制音色；留空用 preset" },
      { label: "最大录音秒数", value: String(v.maxRecordSeconds), kind: "number", hint: "超时自动收声" },
      { label: "问句自动听回答", value: String(v.autoListenAfterQuestion), kind: "bool", hint: "回复以问句结尾时自动继续录音" },
      { label: "连续对话", value: String(v.continuous), kind: "bool", hint: "回答完自动继续监听" },
      { label: "语音唤醒词", value: v.wakeWord, kind: "text", hint: "逗号分隔（如 hey,你好）：待机时本地 whisper 轮询短音频（零 API 成本），听到即应「在的啊」并开始对话；空格键仍可手动唤醒；留空 = 仅空格键" },
    ],
  });
  if (!result) return;
  v.enabled = parseBool(result[0].value);
  v.stt = result[1].value as DitoConfig["plugins"]["voice"]["stt"];
  v.tts = result[2].value as DitoConfig["plugins"]["voice"]["tts"];
  v.whisperModel = result[3].value.trim();
  v.whisperLanguage = result[4].value.trim();
  v.espeakVoice = result[5].value.trim();
  v.piperModel = result[6].value.trim();
  v.xiaomiApiKey = result[7].value.trim();
  v.xiaomiTtsVoice = result[8].value.trim();
  v.xiaomiTtsVoiceDesign = result[9].value.trim();
  v.maxRecordSeconds = parseNum(result[10].value, 8);
  v.autoListenAfterQuestion = parseBool(result[11].value);
  v.continuous = parseBool(result[12].value);
  v.wakeWord = result[13].value.trim();
  persist(cfg);
}

async function permissionScreen(cfg: DitoConfig): Promise<void> {
  const p = cfg.plugins.permission;
  const result = await formScreen({
    crumbParts: ["配置", "权限与 sudo"],
    panelTitle: "权限与 sudo",
    status: () => statusOf(cfg),
    fields: [
      { label: "启用权限门插件", value: String(p.enabled), kind: "bool", hint: "关闭后高危命令不再拦截与确认（不推荐）" },
      { label: "sudo 权限模式", value: String(p.sudoMode), kind: "bool", hint: "开启后权限门关闭、Dito 获得 root 权限，请只在自己的机器上开启" },
      { label: "自动加 sudo", value: String(p.autoSudo), kind: "bool", hint: "仅 sudo 模式下生效：装/卸软件、管理服务等命令自动补 sudo" },
      { label: "提权命令（默认 sudo）", value: p.sudoCommand, kind: "text", hint: "可改成 doas / sudo -n 等" },
    ],
  });
  if (!result) return;
  p.enabled = parseBool(result[0].value);
  p.sudoMode = parseBool(result[1].value);
  p.autoSudo = parseBool(result[2].value);
  p.sudoCommand = result[3].value.trim() || "sudo";
  persist(cfg);
}

function parseNumberList(v: string): number[] {
  return v
    .split(/[,，\s]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

async function channelsScreen(cfg: DitoConfig): Promise<void> {
  const items = (): MenuItem[] => [
    {
      label: "QQ（SnowLuma）",
      detail: cfg.channels.qq.enabled ? `已启用 · ${cfg.channels.qq.url}` : "停用",
      hint: "连接 SnowLuma OneBot 收发 QQ；支持戳一戳、点赞、发空间说说；`dito qq` 启动",
      onEnter: () => qqChannelScreen(cfg),
    },
    {
      label: "Matrix",
      detail: cfg.channels.matrix.enabled ? `已启用 · ${cfg.channels.matrix.homeserver}` : "停用",
      hint: "连接 Matrix homeserver 收发房间消息（需 Access Token）；`dito matrix` 启动",
      onEnter: () => matrixChannelScreen(cfg),
    },
  ];
  await menuScreen({
    crumbParts: ["配置", "频道"],
    panelTitle: "频道",
    items,
    status: () => statusOf(cfg),
  });
}

async function qqChannelScreen(cfg: DitoConfig): Promise<void> {
  const qq = cfg.channels.qq;
  const result = await formScreen({
    crumbParts: ["配置", "频道", "QQ（SnowLuma）"],
    panelTitle: "QQ 频道",
    status: () => statusOf(cfg),
    fields: [
      { label: "启用", value: String(qq.enabled), kind: "bool", hint: "启用后用 `dito qq` 启动频道进程" },
      { label: "OneBot WS 地址", value: qq.url, kind: "text", hint: "SnowLuma 的 WebSocket 端口（config/onebot_<uin>.json）" },
      { label: "Access Token", value: qq.accessToken, kind: "sensitive", hint: "进入编辑即清空；与 SnowLuma 的 accessToken 一致，留空表示无鉴权" },
      { label: "启动命令", value: qq.command, kind: "text", hint: "SnowLuma 本体的启动命令；留空则 dito qq 启动时自动探测（PATH/systemd/docker/常见目录）并填入" },
      { label: "自动拉起 SnowLuma", value: String(qq.autoStart), kind: "bool", hint: "dito qq 时探测端口，未运行就按启动命令拉起，退出时一并关闭" },
      { label: "主人 QQ（逗号分隔）", value: qq.owners.join(","), kind: "text", hint: "这些号的私聊拥有全部能力（含电脑控制）；其余会话仅保留搜索/知识库/记忆/娱乐" },
      { label: "响应群号（逗号分隔）", value: qq.groups.join(","), kind: "text", hint: "留空 = 不响应任何群聊；群聊始终按受限工具集运行" },
      { label: "群聊唤醒词（逗号分隔）", value: qq.wakeKeywords.join(","), kind: "text", hint: "留空 = 只有 @机器人 能唤醒；填了关键词则喊关键词也能唤醒（唤醒必答）" },
      { label: "群聊回复概率", value: String(qq.groupReplyChance ?? 0.2), kind: "text", hint: "0-1 小数（0.2 = 20%）：未被唤醒的群消息按此概率回复；表情回应不受影响" },
      { label: "响应私聊", value: String(qq.friends), kind: "bool", hint: "关闭后忽略所有私聊消息" },
      { label: "自动表情回应", value: String(qq.autoReact !== false), kind: "bool", hint: "每条群消息按情绪自动贴表情；模型也可用 qq_react 精准追加" },
      { label: "回复附带表情包概率", value: String(qq.memeChance ?? 0.3), kind: "text", hint: "0-1 小数（0.3 = 30%），回复后按概率补一张随机表情包；库空自动跳过" },
      { label: "被戳戳回去", value: String(qq.pokeBack), kind: "bool", hint: "收到戳一戳时自动戳回去" },
      { label: "自动同意请求", value: String(qq.autoApprove), kind: "bool", hint: "自动同意好友/群邀请（默认关，请求只打日志）" },
    ],
  });
  if (!result) return;
  qq.enabled = parseBool(result[0].value);
  qq.url = result[1].value.trim() || "ws://127.0.0.1:3001";
  qq.accessToken = result[2].value.trim();
  qq.command = result[3].value.trim();
  qq.autoStart = parseBool(result[4].value);
  qq.owners = parseNumberList(result[5].value);
  qq.groups = parseNumberList(result[6].value);
  qq.wakeKeywords = result[7].value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const replyChanceNum = Number(result[8].value);
  qq.groupReplyChance = Number.isFinite(replyChanceNum) ? Math.max(0, Math.min(1, replyChanceNum)) : 0.2;
  qq.friends = parseBool(result[9].value);
  qq.autoReact = parseBool(result[10].value);
  const chanceNum = Number(result[11].value);
  qq.memeChance = Number.isFinite(chanceNum) ? Math.max(0, Math.min(1, chanceNum)) : 0.3;
  qq.pokeBack = parseBool(result[12].value);
  qq.autoApprove = parseBool(result[13].value);
  persist(cfg);
}

async function matrixChannelScreen(cfg: DitoConfig): Promise<void> {
  const mx = cfg.channels.matrix;
  const result = await formScreen({
    crumbParts: ["配置", "频道", "Matrix"],
    panelTitle: "Matrix 频道",
    status: () => statusOf(cfg),
    fields: [
      { label: "启用", value: String(mx.enabled), kind: "bool", hint: "启用后用 `dito matrix` 启动频道进程" },
      { label: "Homeserver", value: mx.homeserver, kind: "text", hint: "如 https://matrix.org" },
      { label: "Access Token", value: mx.accessToken, kind: "sensitive", hint: "进入编辑即清空；Element：设置 → 帮助与关于 → 高级 → Access Token" },
      { label: "响应房间（逗号分隔）", value: mx.rooms.join(","), kind: "text", hint: "房间 ID 如 !xxx:server；留空 = 所有已加入房间" },
    ],
  });
  if (!result) return;
  mx.enabled = parseBool(result[0].value);
  mx.homeserver = result[1].value.trim() || "https://matrix.org";
  mx.accessToken = result[2].value.trim();
  mx.rooms = result[3].value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  persist(cfg);
}

// ── 主菜单 ───────────────────────────────────────────────────────

async function mainMenu(cfg: DitoConfig): Promise<void> {
  const searchSources = (): number => {
    const ws = cfg.plugins.web_search;
    return (
      (ws.tavilyKeys.length ? 1 : 0) +
      (ws.firecrawlKeys.length ? 1 : 0) +
      (ws.anysearchKeys.length ? 1 : 0) +
      (ws.exaKeys.length ? 1 : 0) +
      (ws.perplexityKey ? 1 : 0) +
      (ws.searxngUrl ? 1 : 0)
    );
  };

  const items = (): MenuItem[] => [
    {
      label: "模型与供应商",
      detail: `${activeProvider(cfg)?.name ?? "未配置"} · ${cfg.model.chat || "—"}`,
      hint: "切换供应商、聊天/视觉模型，管理自定义供应商",
      onEnter: () => modelScreen(cfg),
    },
    {
      label: "提示词设定",
      detail: `${cfg.persona.active} / ${cfg.persona.identity}`,
      hint: "Dito 人设与用户身份，切换后下一轮对话生效",
      onEnter: () => personaScreen(cfg),
    },
    {
      label: "知识库",
      detail: cfg.plugins.knowledge_base.enabled ? "启用" : "停用",
      hint: "本地 SQLite + 中文检索，内置 Arch Linux 等 Linux 知识",
      onEnter: () => kbScreen(cfg),
    },
    {
      label: "记忆",
      detail: cfg.plugins.memory.enabled
        ? `启用 · 自动日记${cfg.plugins.memory.autoDiary ? "开" : "关"}`
        : "停用",
      hint: "知识点 + 历史对话，自动记忆、跨会话持久",
      onEnter: () => memoryScreen(cfg),
    },
    {
      label: "网络搜索",
      detail: !cfg.plugins.web_search.enabled
        ? "停用"
        : searchSources() > 0
          ? `启用 · ${searchSources()} 个搜索源`
          : "启用 · 无 Key（DuckDuckGo 兜底）",
      hint: "Tavily / Firecrawl / Exa / Perplexity / SearXNG，无 Key 走免费源",
      onEnter: () => searchScreen(cfg),
    },
    {
      label: "语音",
      detail: cfg.plugins.voice.enabled ? `STT ${cfg.plugins.voice.stt} · TTS ${cfg.plugins.voice.tts}` : "停用",
      hint: "whisper / espeak / piper / 小米 MiMo，`dito voice` 全屏水波界面",
      onEnter: () => voiceScreen(cfg),
    },
    {
      label: "权限与 sudo",
      detail: cfg.plugins.permission.sudoMode ? "sudo 模式（权限门关闭）" : "权限门开启",
      hint: "高危命令拦截/确认；sudo 模式下需要 root 的命令自动加 sudo",
      onEnter: () => permissionScreen(cfg),
    },
    {
      label: "频道（QQ / Matrix）",
      detail: cfg.channels.qq.enabled ? "QQ 已启用" : cfg.channels.matrix.enabled ? "Matrix 已启用" : "停用",
      hint: "dito qq 连 SnowLuma 收发 QQ（含戳一戳/空间）；dito matrix 连 Matrix 房间",
      onEnter: () => channelsScreen(cfg),
    },
    {
      label: "保存并退出",
      detail: "~/.pi/agent/dito/config.json",
      hint: "所有改动在每一步都已即时写入，这里只是体面的出口",
      onEnter: () => {
        throw new QuitSignal();
      },
    },
  ];

  await menuScreen({
    crumbParts: ["配置"],
    panelTitle: "Dito 配置",
    items,
    status: () => statusOf(cfg),
  });
}

// ── 入口 ─────────────────────────────────────────────────────────

export async function runConfigTui(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("配置页面需要真实终端（TTY）。请在终端里运行 `dito config`。");
    return;
  }
  const cfg = loadConfig();
  process.stdout.write(ALT + HIDE);
  startRaw();
  const onResize = (): void => {
    requestClear();
    drawCurrent?.();
  };
  process.on("SIGWINCH", onResize);
  try {
    // 正常返回（esc/q）与 QuitSignal（保存并退出 / Ctrl+C）都走这里收尾
    await mainMenu(cfg);
  } catch (err) {
    if (!(err instanceof QuitSignal)) throw err;
  } finally {
    process.off("SIGWINCH", onResize);
    stopRaw();
    process.stdout.write(SHOW + LEAVE);
    console.log("配置已存到 ~/.pi/agent/dito/config.json，改动即时生效");
  }
}
