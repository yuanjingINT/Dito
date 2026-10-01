/** Dito 全屏工作台：浏览器式会话标签、对话区、响应式 Bash 侧栏。 */
import {
  CombinedAutocompleteProvider, Editor, HStack, ProcessTerminal, ScrollView,
  TuiAltScreen, VStack, isKeyRelease, parseKey, type OverlayHandle, type Terminal,
} from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { MODE_DEFS, getMode, nextMode, readOnlyTools, setMode, type DitoMode } from "../extensions/mode.js";
import { sudoModeEnabled, toggleSudoMode } from "../extensions/permission.js";
import { createSession, listSessions, type SessionSummary, type TuiSession } from "./session.js";
import { TuiDialogs } from "./tui-dialogs.js";
import {
  C, BashDialog, BashLog, ConversationView, RenderLine, RoutedTerminal, SessionPicker,
  TabsBar, balancedLine, bashCommand, bashPane, filledLine, isBashTool, messageText,
  singleLine, type MessageLike, type SessionTab,
} from "./tui-components.js";

interface NewSessionResult { session: TuiSession; modelName: string; }
interface SessionSlot extends NewSessionResult { standardTools: string[]; draft: string; bound: boolean; }
/** 可注入历史源，离线交互测试与实际界面使用同一条切换路径。 */
export interface TuiSessionSource {
  list(): SessionSummary[];
  open(path: string): Promise<NewSessionResult>;
}
const defaultSessionSource: TuiSessionSource = {
  list: listSessions,
  open: (path) => createSession({ sessionFile: path }),
};
const slashCommands = [
  { name: "chat", description: "闲聊模式（不调用工具）" },
  { name: "standard", description: "标准模式（完整助手）" },
  { name: "plan", description: "计划模式（只读探索）" },
  { name: "mode", description: "切换运行模式", argumentHint: "chat|standard|plan" },
  { name: "sudo", description: "切换 sudo 权限模式", argumentHint: "on|off" },
  { name: "sessions", description: "选择历史会话标签" },
  { name: "bash", description: "展开 Bash 命令与输出" },
  { name: "prev", description: "上一历史会话" },
  { name: "new", description: "新建会话标签" },
  { name: "exit", description: "退出 TUI" },
];

export async function runTui(
  session: TuiSession, modelName: string, newSession: () => Promise<NewSessionResult>,
  terminal: Terminal = new ProcessTerminal(), source: TuiSessionSource = defaultSessionSource,
): Promise<void> {
  const slots = new Map<string, SessionSlot>();
  let draftId = 0;
  const makeSlot = (bundle: NewSessionResult): SessionSlot => ({ ...bundle, standardTools: bundle.session.getActiveToolNames(), draft: "", bound: false });
  let current = makeSlot({ session, modelName });
  let currentPath = session.sessionFile ?? `draft:${++draftId}`;
  slots.set(currentPath, current);
  let summaries: SessionTab[] = source.list();
  let switching = false;
  let pendingSwitch: Promise<void> | undefined;
  let shutdownRequested = false;
  let resolveShutdown: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let overlay: OverlayHandle | undefined;
  const sessionInputRemovers = new Set<() => void>();
  const tabs = new TabsBar();
  const conversation = new ConversationView();
  const bash = new BashLog();

  // 鼠标点击标签先于 pi-tui 的文本选择器处理，正文仍使用原生滚动/选择。
  const routed = new RoutedTerminal(terminal, (data) => {
    if (tui.hasOverlay() || terminal.rows < 5) return false;
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (!mouse || Number(mouse[3]) !== 1 || (Number(mouse[1]) & 3) !== 0 || Number(mouse[1]) >= 32) return false;
    if (mouse[4] === "M") {
      const hit = tabs.hitAt(Number(mouse[2]) - 1);
      if (hit?.action === "new") void startNewSession();
      else if (hit?.action === "history") openSessionPicker();
      else if (hit?.path) void openPath(hit.path);
    }
    return true;
  });
  const tui = new TuiAltScreen(routed, true);
  const redraw = (): void => { if (!shutdownRequested) tui.requestRender(); };
  const scroll = new ScrollView(conversation, { follow: "end", primary: true, scrollbar: "auto" });
  const bashView = bashPane(bash);
  const dialogs = new TuiDialogs(tui);
  const editor = new Editor(tui, {
    borderColor: (text) => `${MODE_DEFS[getMode()].color}${text}${C.reset}`,
    selectList: {
      selectedPrefix: (text) => `${C.accent}${text}${C.reset}`,
      selectedText: (text) => `${C.accent}${text}${C.reset}`,
      description: (text) => `${C.dim}${text}${C.reset}`,
      scrollInfo: (text) => `${C.muted}${text}${C.reset}`,
      noMatch: (text) => `${C.muted}${text}${C.reset}`,
    },
  }, { paddingX: 1, autocompleteMaxVisible: 6 });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, process.cwd()));

  const notice = (text: string): void => { conversation.notice(text); redraw(); };
  const applyMode = (mode: DitoMode): void => {
    setMode(mode);
    current.session.setActiveToolsByName(mode === "chat" ? [] : mode === "plan" ? readOnlyTools() : current.standardTools);
    current.session.setThinkingLevel(MODE_DEFS[mode].thinkingLevel);
    redraw();
  };
  const shutdown = (): void => { shutdownRequested = true; resolveShutdown?.(); };
  const closeOverlay = (): void => { overlay?.hide(); overlay = undefined; redraw(); };

  /** 不在每个 token / 工具回合扫描所有 jsonl；仅更新当前会话的标签。 */
  const refreshTabs = (reload = false): void => {
    if (reload) summaries = source.list();
    const path = current.session.sessionFile ?? currentPath;
    if (path !== currentPath) {
      slots.delete(currentPath);
      summaries = summaries.filter((item) => item.path !== currentPath);
      currentPath = path;
      slots.set(path, current);
    }
    for (const [slotPath, slot] of slots) {
      if (!summaries.some((item) => item.path === slotPath)) {
        summaries.unshift({ path: slotPath, preview: "", messageCount: 0, startedAt: Date.now(), draft: !slot.session.sessionFile });
      }
    }
    const messages = current.session.messages as MessageLike[];
    const preview = messages.find((message) => message.role === "user" && messageText(message));
    summaries = summaries.map((item) => item.path === currentPath ? {
      ...item, preview: preview ? singleLine(messageText(preview)).slice(0, 80) : item.preview,
      messageCount: messages.filter((message) => message.role === "user" || message.role === "assistant").length,
    } : item);
    tabs.setTabs(summaries, currentPath);
    redraw();
  };
  const restoreView = (): void => {
    conversation.reset(current.session.messages);
    bash.restore(current.session.messages);
    scroll.scrollToEnd();
    bashView.scroll.scrollToEnd();
    refreshTabs();
  };

  const bindSessionUi = async (slot: SessionSlot): Promise<void> => {
    if (slot.bound) return;
    const target = slot.session;
    await target.bindExtensions({
      mode: "tui",
      uiContext: {
        ...target.extensionRunner.getUIContext(),
        select: (title, options, opts) => { closeOverlay(); return dialogs.select(title, options, opts); },
        input: (title, placeholder, opts) => { closeOverlay(); return dialogs.input(title, placeholder, opts); },
        confirm: (title, message, opts) => { closeOverlay(); return dialogs.confirm(title, message, opts); },
        notify: (message) => { if (target === current.session) notice(message); },
        onTerminalInput: (handler) => {
          const remove = tui.addInputListener((data) => target === current.session && !shutdownRequested ? handler(data) : undefined);
          sessionInputRemovers.add(remove);
          return () => { remove(); sessionInputRemovers.delete(remove); };
        },
        setTitle: (title) => { if (target === current.session) terminal.setTitle(title); },
        setEditorText: (text) => { if (target === current.session) { editor.setText(text); redraw(); } else slot.draft = text; },
        getEditorText: () => target === current.session ? editor.getText() : slot.draft,
        pasteToEditor: (text) => {
          if (target === current.session) { editor.handleInput(`\x1b[200~${text}\x1b[201~`); redraw(); }
          else slot.draft += text;
        },
      },
    });
    slot.bound = true;
  };

  const subscribeEvents = (): void => {
    unsubscribe = current.session.subscribe((event) => {
      const e = event as {
        type: string; message?: MessageLike & { stopReason?: string; errorMessage?: string };
        assistantMessageEvent?: { type: string; delta?: string };
        toolName?: string; toolCallId?: string; args?: unknown; partialResult?: unknown; result?: unknown; isError?: boolean;
      };
      const ame = e.assistantMessageEvent;
      if (e.type === "message_start" && e.message?.role === "assistant") conversation.beginAssistant();
      if (e.type === "message_update" && ame) {
        if (ame.type === "thinking_delta") conversation.appendThinking(ame.delta ?? "");
        else if (ame.type === "text_delta") conversation.appendAssistant(ame.delta ?? "");
      } else if (e.type === "tool_execution_start" && e.toolName) {
        conversation.addTool(e.toolName, e.args);
        if (isBashTool(e.toolName) && e.toolCallId) bash.start(e.toolCallId, bashCommand(e.args));
      } else if ((e.type === "tool_execution_update" || e.type === "tool_execution_end") && e.toolCallId && e.toolName && isBashTool(e.toolName)) {
        bash.update(e.toolCallId, e.type === "tool_execution_update" ? e.partialResult : e.result,
          e.type === "tool_execution_end" ? e.isError ? "error" : "done" : undefined);
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        conversation.finishAssistant(e.message);
        if (e.message.stopReason === "error" && e.message.errorMessage) {
          notice(/429|rate limit|限流/i.test(e.message.errorMessage) ? "opencode 免费额度限流，稍后再试" : `出错：${e.message.errorMessage}`);
        }
      } else if (e.type === "agent_end" || e.type === "agent_settled") refreshTabs();
      redraw();
    });
  };

  const switchTo = (loader: () => Promise<NewSessionResult>, path?: string): Promise<void> => {
    if (switching || shutdownRequested || path === currentPath) return Promise.resolve();
    if (current.session.isStreaming) { notice("当前任务仍在运行，按 Esc 中断后再切换会话"); return Promise.resolve(); }
    switching = true;
    redraw();
    pendingSwitch = (async () => {
      let loaded: SessionSlot | undefined;
      let fresh = false;
      try {
        loaded = path ? slots.get(path) : undefined;
        if (!loaded) { loaded = makeSlot(await loader()); fresh = true; }
        if (shutdownRequested) { if (fresh) loaded.session.dispose(); return; }
        await bindSessionUi(loaded);
        if (shutdownRequested) { if (fresh) loaded.session.dispose(); return; }
        current.draft = editor.getText();
        unsubscribe?.();
        current = loaded;
        currentPath = path ?? loaded.session.sessionFile ?? `draft:${++draftId}`;
        slots.set(currentPath, current);
        editor.setText(current.draft);
        applyMode(getMode());
        restoreView();
        subscribeEvents();
        notice(path ? "已打开历史会话" : "已开启新会话（上下文已清空）");
      } catch (error) {
        if (fresh && loaded && loaded !== current) loaded.session.dispose();
        notice(`会话切换失败：${error instanceof Error ? error.message : String(error)}`);
      } finally { switching = false; redraw(); }
    })();
    return pendingSwitch;
  };
  const openPath = (path: string): Promise<void> => switchTo(() => source.open(path), path);
  const startNewSession = (): Promise<void> => switchTo(newSession);
  const switchTabBy = (offset: number): void => {
    const index = Math.max(0, summaries.findIndex((item) => item.path === currentPath));
    const target = summaries[(index + offset + summaries.length) % summaries.length];
    if (target) void openPath(target.path);
  };
  const openPreviousSession = (): void => {
    refreshTabs(true);
    const index = summaries.findIndex((item) => item.path === currentPath);
    const target = summaries[index + 1];
    if (target) void openPath(target.path);
    else notice("已经是最早的会话了");
  };
  const openSessionPicker = (): void => {
    refreshTabs(true);
    closeOverlay();
    const picker = new SessionPicker(summaries, currentPath, () => terminal.rows, (target) => {
      closeOverlay(); void openPath(target.path);
    }, closeOverlay, redraw);
    overlay = tui.showOverlay(picker, { width: "86%", maxHeight: "85%", margin: 1 });
    redraw();
  };
  const openBash = (): void => {
    closeOverlay();
    overlay = tui.showOverlay(new BashDialog(bash, () => terminal.rows, closeOverlay, redraw), { width: "90%", maxHeight: "90%", margin: 1 });
    redraw();
  };

  const handleSubmit = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text) return;
    if (switching) { editor.setText(raw); notice("正在切换会话，输入已保留"); return; }
    const lower = text.toLowerCase();
    if (["/exit", "/quit", "exit"].includes(lower)) { shutdown(); return; }
    if (["/new", "/新会话"].includes(lower)) { await startNewSession(); return; }
    if (["/sessions", "/会话列表"].includes(lower)) { openSessionPicker(); return; }
    if (["/prev", "/上一会话", "/上一个"].includes(lower)) { openPreviousSession(); return; }
    if (lower === "/bash") { openBash(); return; }
    const modes: Record<string, DitoMode> = { "/chat": "chat", "/闲聊": "chat", "/standard": "standard", "/标准": "standard", "/plan": "plan", "/计划": "plan" };
    if (modes[lower]) { applyMode(modes[lower]); return; }
    if (/^\/mode(?:\s|$)/.test(lower)) {
      const arg = lower.slice(5).trim();
      const aliases: Record<string, DitoMode> = { chat: "chat", standard: "standard", plan: "plan", 闲聊: "chat", 标准: "standard", 计划: "plan" };
      if (aliases[arg]) applyMode(aliases[arg]); else notice("用法：/mode chat | standard | plan");
      return;
    }
    if (/^\/sudo(?:\s|$)/.test(lower)) {
      const arg = lower.slice(5).trim();
      let next: boolean | undefined;
      if (["on", "1", "开", "开启"].includes(arg)) next = true;
      else if (["off", "0", "关", "关闭"].includes(arg)) next = false;
      else if (arg) { notice("用法：/sudo on | off"); return; }
      const on = toggleSudoMode(next);
      notice(on ? "已开启 sudo 模式：权限门关闭，需要 root 的命令自动加 sudo" : "已关闭 sudo 模式：恢复权限门与危险命令确认");
      return;
    }
    editor.addToHistory(text);
    conversation.addUser(text);
    const target = current.session;
    if (target.isStreaming) notice("已排队，当前任务结束后自动发送");
    redraw();
    try { await target.prompt(text, { streamingBehavior: "followUp" }); }
    catch (error) { if (target === current.session) notice(`发送失败：${error instanceof Error ? error.message : String(error)}`); }
    if (target === current.session) refreshTabs();
  };
  editor.onSubmit = (text) => { void handleSubmit(text); };

  const status = new RenderLine((width) => {
    const mode = MODE_DEFS[getMode()];
    const state = switching ? `${C.yellow}正在切换…` : current.session.isStreaming ? `${C.green}● 运行中 · Esc 中断` : `${mode.color}${mode.label}`;
    const help = width >= 100 ? "  Tab 模式 · Ctrl+Tab 会话 · Ctrl+Shift+B Bash" : width >= 55 ? "  / 命令 · Alt+W 历史" : "";
    const left = ` ${state}${C.reset}${C.muted}${help}${C.reset}`;
    const right = width >= 85 ? `${C.dim}${singleLine(current.modelName)}${C.reset} ${sudoModeEnabled() ? C.yellow + "sudo" : C.muted + "权限门"}${C.reset} ` : "";
    return filledLine(balancedLine(left, right, width), width);
  });
  const context = new RenderLine((width) => filledLine(balancedLine(
    `${C.dim} ${basename(process.cwd())}${C.reset} ${C.muted} / ${singleLine(summaries.find((item) => item.path === currentPath)?.preview || "新会话")}${C.reset}`,
    `${C.muted}Alt+1…9 选择标签${C.reset} `, width)));
  const body = new HStack([
    { component: scroll, basis: 0, grow: 1, minSize: 0 },
    { component: bashView.component, basis: 40, shrink: 0, visible: ({ width, height }) => width >= 112 && height >= 16 },
  ], { gap: 2 });
  const layout = new VStack([
    { component: tabs, basis: 1, shrink: 0, visible: ({ height }) => height >= 5 },
    { component: context, basis: 1, shrink: 0, visible: ({ width, height }) => width >= 80 && height >= 18 },
    { component: body, basis: 0, grow: 1, minSize: 0 },
    { component: editor, basis: "auto", shrink: 1, minSize: 1 },
    { component: status, basis: 1, shrink: 0, visible: ({ height }) => height >= 7 },
  ]);
  tui.addChild(layout);
  tui.setLayoutRoot(layout);
  tui.setFocus(editor);
  tui.addInputListener((data) => {
    if (isKeyRelease(data)) return undefined;
    const key = parseKey(data);
    if (key === "ctrl+c" || key === "ctrl+d") { shutdown(); return { consume: true }; }
    // 所有弹窗拥有其自己的焦点和键盘，不被主页快捷键吞掉。
    if (tui.hasOverlay()) return undefined;
    if (key === "escape" && current.session.isStreaming) {
      void current.session.abort().then(() => notice("已中断当前任务")).catch(() => {});
      return { consume: true };
    }
    if (key === "ctrl+t" || key === "alt+d") { void startNewSession(); return { consume: true }; }
    if (key === "alt+a") { openPreviousSession(); return { consume: true }; }
    if (key === "alt+w") { openSessionPicker(); return { consume: true }; }
    if ((key === "ctrl+shift+b" || key === "shift+ctrl+b")) { openBash(); return { consume: true }; }
    // Alt+←/→ normally是编辑器的词移动；编辑器有内容时保留该行为。
    if (key === "ctrl+tab" || (key === "alt+right" && !editor.getText())) { switchTabBy(1); return { consume: true }; }
    if (key === "shift+ctrl+tab" || (key === "alt+left" && !editor.getText())) { switchTabBy(-1); return { consume: true }; }
    if (key && /^alt\+[1-9]$/.test(key)) {
      const path = tabs.pathAt(Number(key.slice(-1)) - 1);
      if (path) void openPath(path);
      return { consume: true };
    }
    if (key === "tab" && !editor.getText().trimStart().startsWith("/")) { applyMode(nextMode(getMode())); return { consume: true }; }
    return undefined;
  });

  process.on("SIGINT", shutdown);
  restoreView();
  try {
    const shutdownPromise = new Promise<void>((resolve) => { resolveShutdown = resolve; if (shutdownRequested) resolve(); });
    tui.start();
    await bindSessionUi(current);
    applyMode(getMode());
    subscribeEvents();
    await shutdownPromise;
  } finally {
    process.off("SIGINT", shutdown);
    closeOverlay();
    dialogs.dispose();
    unsubscribe?.();
    await pendingSwitch;
    for (const remove of sessionInputRemovers) remove();
    try { await current.session.abort(); }
    finally { tui.stop(); for (const slot of new Set(slots.values())) slot.session.dispose(); }
  }
}
