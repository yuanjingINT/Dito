import {
  CombinedAutocompleteProvider,
  Editor,
  HStack,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  isKeyRelease,
  parseKey
} from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { MODE_DEFS, getMode, nextMode, readOnlyTools, setMode } from "../extensions/mode.js";
import { sudoModeEnabled, toggleSudoMode } from "../extensions/permission.js";
import { DITO_IS_ALPHA, loadConfig, saveConfig } from "../extensions/util.js";
import { createSession, listSessions } from "./session.js";
import { TuiDialogs } from "./tui-dialogs.js";
import { assertImageSupport, MAX_IMAGES, readClipboardInput, readImageAttachment } from "./image-input.js";
import {
  C,
  BashDialog,
  BashLog,
  ConversationView,
  RenderLine,
  RoutedTerminal,
  SessionPicker,
  TabsBar,
  balancedLine,
  bashCommand,
  bashPane,
  filledLine,
  isBashTool,
  messageText,
  singleLine
} from "./tui-components.js";
const defaultSessionSource = {
  list: listSessions,
  open: (path) => createSession({ sessionFile: path })
};
function formatContextTokens(value) {
  if (value == null || !Number.isFinite(value) || value < 0) return "?";
  if (value >= 1e6) {
    const compact = value / 1e6;
    return `${Number.isInteger(compact) ? compact.toFixed(0) : compact.toFixed(1)}M`;
  }
  if (value >= 1e3) {
    const compact = value / 1e3;
    return `${Number.isInteger(compact) ? compact.toFixed(0) : compact.toFixed(1)}k`;
  }
  return String(Math.floor(value));
}
const slashCommands = [
  { name: "model", description: "选择当前模型", argumentHint: "provider/id" },
  { name: "persona", description: "切换 AI 人格" },
  { name: "identity", description: "切换用户身份" },
  { name: "compact", description: "手动压缩上下文" },
  { name: "memory-stats", description: "查看记忆统计" },
  { name: "memory-clear", description: "清空记忆" },
  { name: "system", description: "查看系统信息" },
  { name: "kb-stats", description: "查看知识库统计" },
  { name: "chat", description: "闲聊模式（不调用工具）" },
  { name: "standard", description: "标准模式（完整助手）" },
  { name: "plan", description: "计划模式（只读探索）" },
  { name: "mode", description: "切换运行模式", argumentHint: "chat|standard|plan" },
  { name: "sudo", description: "切换 sudo 权限模式", argumentHint: "on|off" },
  { name: "sessions", description: "选择历史会话标签" },
  { name: "bash", description: "展开 Bash 命令与输出" },
  { name: "prev", description: "上一历史会话" },
  { name: "new", description: "新建会话标签" },
  { name: "image", description: "附加本地图片（也可 Ctrl+V 粘贴截图）", argumentHint: "<图片路径>" },
  { name: "images", description: "查看待发送图片" },
  { name: "unimage", description: "移除待发送图片", argumentHint: "序号|all" },
  { name: "exit", description: "退出 TUI" }
];
async function runTui(session, modelName, newSession, terminal = new ProcessTerminal(), source = defaultSessionSource, imageInput = { readClipboard: readClipboardInput }) {
  const slots = /* @__PURE__ */ new Map();
  let draftId = 0;
  const makeSlot = (bundle) => ({ ...bundle, standardTools: bundle.session.getActiveToolNames(), draft: "", bound: false, images: [], loadingImages: 0 });
  let current = makeSlot({ session, modelName });
  let currentPath = session.sessionFile ?? `draft:${++draftId}`;
  slots.set(currentPath, current);
  let summaries = source.list();
  let switching = false;
  let pendingSwitch;
  let shutdownRequested = false;
  let resolveShutdown;
  let unsubscribe;
  let overlay;
  let overlayComponent;
  const sessionInputRemovers = /* @__PURE__ */ new Set();
  const tabs = new TabsBar();
  const conversation = new ConversationView();
  const bash = new BashLog();
  const routed = new RoutedTerminal(terminal, (data) => {
    if (overlay?.isFocused() && overlayComponent?.handleInput && ["home", "end", "pageUp", "pageDown"].includes(parseKey(data) ?? "")) {
      if (!isKeyRelease(data)) overlayComponent.handleInput(data);
      return true;
    }
    if (tui.hasOverlay() || terminal.rows < 5) return false;
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (!mouse || Number(mouse[1]) !== 0) return false;
    const row = Number(mouse[3]);
    if (row === 1) {
      if (mouse[4] === "M") {
        const hit = tabs.hitAt(Number(mouse[2]) - 1);
        if (hit?.action === "new") void startNewSession();
        else if (hit?.action === "history") openSessionPicker();
        else if (hit?.path) void openPath(hit.path);
      }
      return true;
    }
    const bodyTop = (terminal.rows >= 5 ? 1 : 0) + (terminal.columns >= 80 && terminal.rows >= 18 ? 1 : 0);
    const bodyWidth = terminal.columns - (terminal.columns >= 112 && terminal.rows >= 16 ? 42 : 0);
    const column = Number(mouse[2]) - 1;
    const viewportRow = row - 1 - bodyTop;
    if (viewportRow < 0 || viewportRow >= scroll.viewportHeight || column < 0 || column >= bodyWidth - (scroll.isScrollbarVisible ? 1 : 0)) return false;
    const contentRow = viewportRow + scroll.scrollTop;
    if (conversation.isExpandableAt(contentRow)) {
      if (mouse[4] === "M") {
        const top = scroll.scrollTop;
        conversation.toggleDetailsAt(contentRow);
        scroll.updateLayout(conversation.render(scroll.getContentWidth(bodyWidth)).length, scroll.viewportHeight, redraw);
        scroll.scrollTo(top);
        redraw();
      }
      return true;
    }
    return false;
  });
  const tui = new TuiAltScreen(routed, true);
  const redraw = () => {
    if (!shutdownRequested) tui.requestRender();
  };
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
      noMatch: (text) => `${C.muted}${text}${C.reset}`
    }
  }, { paddingX: 1, autocompleteMaxVisible: 6 });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, process.cwd()));
  const notice = (text) => {
    conversation.notice(text);
    redraw();
  };
  const applyMode = (mode) => {
    setMode(mode);
    current.session.setActiveToolsByName(mode === "chat" ? [] : mode === "plan" ? readOnlyTools() : current.standardTools);
    current.session.setThinkingLevel(MODE_DEFS[mode].thinkingLevel);
    redraw();
  };
  const shutdown = () => {
    shutdownRequested = true;
    resolveShutdown?.();
  };
  const closeOverlay = () => {
    overlay?.hide();
    overlay = void 0;
    overlayComponent = void 0;
    redraw();
  };
  const refreshTabs = (reload = false) => {
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
    const messages = current.session.messages;
    const preview = messages.find((message) => message.role === "user" && messageText(message));
    summaries = summaries.map((item) => item.path === currentPath ? {
      ...item,
      preview: preview ? singleLine(messageText(preview)).slice(0, 80) : item.preview,
      messageCount: messages.filter((message) => message.role === "user" || message.role === "assistant").length
    } : item);
    tabs.setTabs(summaries, currentPath);
    redraw();
  };
  const restoreView = () => {
    conversation.reset(current.session.messages);
    bash.restore(current.session.messages);
    scroll.scrollToEnd();
    bashView.scroll.scrollToEnd();
    refreshTabs();
  };
  const bindSessionUi = async (slot) => {
    if (slot.bound) return;
    const target = slot.session;
    await target.bindExtensions({
      mode: "tui",
      uiContext: {
        ...target.extensionRunner.getUIContext(),
        select: (title, options, opts) => {
          closeOverlay();
          return dialogs.select(title, options, opts);
        },
        input: (title, placeholder, opts) => {
          closeOverlay();
          return dialogs.input(title, placeholder, opts);
        },
        confirm: (title, message, opts) => {
          closeOverlay();
          return dialogs.confirm(title, message, opts);
        },
        notify: (message) => {
          if (target === current.session) notice(message);
        },
        onTerminalInput: (handler) => {
          const remove = tui.addInputListener((data) => target === current.session && !shutdownRequested ? handler(data) : void 0);
          sessionInputRemovers.add(remove);
          return () => {
            remove();
            sessionInputRemovers.delete(remove);
          };
        },
        setTitle: (title) => {
          if (target === current.session) terminal.setTitle(title);
        },
        setEditorText: (text) => {
          if (target === current.session) {
            editor.setText(text);
            redraw();
          } else slot.draft = text;
        },
        getEditorText: () => target === current.session ? editor.getText() : slot.draft,
        pasteToEditor: (text) => {
          if (target === current.session) {
            editor.handleInput(`\x1B[200~${text}\x1B[201~`);
            redraw();
          } else slot.draft += text;
        }
      }
    });
    slot.bound = true;
  };
  const subscribeEvents = () => {
    unsubscribe = current.session.subscribe((event) => {
      const e = event;
      const ame = e.assistantMessageEvent;
      if (e.type === "model_select" && e.model) {
        current.modelName = e.model.name || e.model.id || current.modelName;
      }
      if (e.type === "message_start" && e.message?.role === "assistant") conversation.beginAssistant();
      if (e.type === "message_update" && ame) {
        conversation.updateAssistant(ame);
      } else if (e.type === "tool_execution_start" && e.toolName) {
        conversation.addTool(e.toolName, e.args, e.toolCallId);
        if (isBashTool(e.toolName) && e.toolCallId) bash.start(e.toolCallId, bashCommand(e.args));
      } else if ((e.type === "tool_execution_update" || e.type === "tool_execution_end") && e.toolCallId) {
        const result = e.type === "tool_execution_update" ? e.partialResult : e.result;
        const state = e.type === "tool_execution_end" ? e.isError ? "error" : "done" : void 0;
        conversation.updateTool(e.toolCallId, result, state);
        if (e.toolName && isBashTool(e.toolName)) bash.update(e.toolCallId, result, state);
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        conversation.finishAssistant(e.message);
        if (e.message.stopReason === "error" && e.message.errorMessage) {
          notice(/429|rate limit|限流/i.test(e.message.errorMessage) ? "opencode 免费额度限流，稍后再试" : `出错：${e.message.errorMessage}`);
        }
      } else if (e.type === "compaction_start") {
        notice(e.reason === "overflow" ? "上下文超限，正在压缩后重试…" : "上下文较长，正在自动压缩…");
      } else if (e.type === "compaction_end") {
        if (e.aborted) notice("上下文压缩已取消");
        else if (e.result) notice("上下文已压缩，已保留最近对话");
        else if (e.errorMessage) notice(`上下文压缩失败：${e.errorMessage}`);
      } else if (e.type === "agent_end" || e.type === "agent_settled") {
        conversation.finishStreaming();
        refreshTabs();
      }
      redraw();
    });
  };
  const switchTo = (loader, path) => {
    if (switching || shutdownRequested || path === currentPath) return Promise.resolve();
    if (current.session.isStreaming) {
      notice("当前任务仍在运行，按 Esc 中断后再切换会话");
      return Promise.resolve();
    }
    switching = true;
    redraw();
    pendingSwitch = (async () => {
      let loaded;
      let fresh = false;
      try {
        loaded = path ? slots.get(path) : void 0;
        if (!loaded) {
          loaded = makeSlot(await loader());
          fresh = true;
        }
        if (shutdownRequested) {
          if (fresh) loaded.session.dispose();
          return;
        }
        await bindSessionUi(loaded);
        if (shutdownRequested) {
          if (fresh) loaded.session.dispose();
          return;
        }
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
      } finally {
        switching = false;
        redraw();
      }
    })();
    return pendingSwitch;
  };
  const openPath = (path) => switchTo(() => source.open(path), path);
  const startNewSession = () => switchTo(newSession);
  const switchTabBy = (offset) => {
    const index = Math.max(0, summaries.findIndex((item) => item.path === currentPath));
    const target = summaries[(index + offset + summaries.length) % summaries.length];
    if (target) void openPath(target.path);
  };
  const openPreviousSession = () => {
    refreshTabs(true);
    const index = summaries.findIndex((item) => item.path === currentPath);
    const target = summaries[index + 1];
    if (target) void openPath(target.path);
    else notice("已经是最早的会话了");
  };
  const openSessionPicker = () => {
    refreshTabs(true);
    closeOverlay();
    const picker = new SessionPicker(summaries, currentPath, () => terminal.rows, (target) => {
      closeOverlay();
      void openPath(target.path);
    }, closeOverlay, redraw);
    overlayComponent = picker;
    overlay = tui.showOverlay(picker, { width: "86%", maxHeight: "85%", margin: 1 });
    redraw();
  };
  const openBash = () => {
    closeOverlay();
    overlayComponent = new BashDialog(bash, () => terminal.rows, closeOverlay, redraw);
    overlay = tui.showOverlay(overlayComponent, { width: "90%", maxHeight: "90%", margin: 1 });
    redraw();
  };
  const addImage = async (read) => {
    if (switching) {
      notice("正在切换会话，请稍后添加图片");
      return;
    }
    const slot = current;
    if (slot.images.length + slot.loadingImages >= MAX_IMAGES) {
      notice(`每条消息最多附加 ${MAX_IMAGES} 张图片`);
      return;
    }
    slot.loadingImages++;
    redraw();
    try {
      const input = await read();
      if (shutdownRequested) return;
      if (input.image) slot.images.push(input.image);
      else if (input.text) {
        if (slot === current) editor.handleInput(`\x1B[200~${input.text}\x1B[201~`);
        else slot.draft += input.text;
      } else if (slot === current) notice("剪贴板没有可读取的图片或文字；可用 /image <路径> 添加图片");
    } catch (error) {
      if (slot === current) notice(`添加图片失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      slot.loadingImages--;
      redraw();
    }
  };
  const handleSubmit = async (raw) => {
    const text = raw.trim();
    if (!text && !current.images.length && !current.loadingImages) return;
    if (switching) {
      editor.setText(raw);
      notice("正在切换会话，输入已保留");
      return;
    }
    const lower = text.toLowerCase();
    if (["/exit", "/quit", "exit"].includes(lower)) {
      shutdown();
      return;
    }
    if (["/new", "/新会话"].includes(lower)) {
      await startNewSession();
      return;
    }
    if (["/sessions", "/会话列表"].includes(lower)) {
      openSessionPicker();
      return;
    }
    if (["/prev", "/上一会话", "/上一个"].includes(lower)) {
      openPreviousSession();
      return;
    }
    if (lower === "/bash") {
      openBash();
      return;
    }
    if (/^\/image(?:\s|$)/i.test(text)) {
      await addImage(async () => ({ image: await readImageAttachment(text.slice(6)) }));
      return;
    }
    if (lower === "/images") {
      notice(current.images.length ? current.images.map((image, i) => `${i + 1}. ${singleLine(image.name)}`).join("\n") : "暂无待发送图片");
      return;
    }
    if (/^\/unimage(?:\s|$)/i.test(text)) {
      const arg = lower.slice(8).trim();
      if (arg === "all") current.images = [];
      else {
        const index = arg ? Number(arg) - 1 : current.images.length - 1;
        if (!Number.isInteger(index) || index < 0 || index >= current.images.length) {
          notice("用法：/unimage [序号|all]（省略序号移除最后一张）");
          return;
        }
        current.images.splice(index, 1);
      }
      redraw();
      return;
    }
    const modes = { "/chat": "chat", "/闲聊": "chat", "/standard": "standard", "/标准": "standard", "/plan": "plan", "/计划": "plan" };
    if (/^\/model(?:\s|$)/.test(lower)) {
      if (current.session.isStreaming) {
        notice("请先完成或取消当前任务，再切换模型");
        return;
      }
      try {
        const cfg = loadConfig();
        const configured = new Set(cfg.providers.map((provider) => provider.id));
        const available = (await current.session.modelRuntime.getAvailable()).filter((model) => configured.has(model.provider));
        if (!available.length) {
          notice("没有可用模型，请先运行 dito config 配置模型供应商");
          return;
        }
        const names = available.map((model) => `${model.provider}/${model.id}`);
        const requested = text.slice(6).trim();
        const chosen = requested || await dialogs.select("选择模型", names);
        if (!chosen) return;
        const model = available.find((item) => `${item.provider}/${item.id}` === chosen || item.id === chosen);
        if (!model) {
          notice(`未找到可用模型：${chosen}`);
          return;
        }
        await current.session.setModel(model);
        const provider = cfg.providers.find((item) => item.id === model.provider);
        if (!provider.models.some((item) => item.id === model.id)) {
          const metadata = { id: model.id, name: model.name || model.id };
          for (const key of ["api", "contextWindow", "maxTokens", "reasoning", "input", "cost"])
            if (model[key] !== undefined) metadata[key] = model[key];
          provider.models.push(metadata);
        }
        cfg.model.provider = model.provider;
        cfg.model.chat = model.id;
        saveConfig(cfg);
        current.modelName = model.name || model.id;
        applyMode(getMode());
        notice(`已切换模型：${current.modelName}`);
      } catch (error) {
        notice(`切换模型失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (modes[lower]) {
      applyMode(modes[lower]);
      return;
    }
    if (["/compact", "/压缩上下文"].includes(lower)) {
      try {
        await current.session.compact();
      } catch (error) {
        notice(`上下文压缩失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (/^\/mode(?:\s|$)/.test(lower)) {
      const arg = lower.slice(5).trim();
      const aliases = { chat: "chat", standard: "standard", plan: "plan", 闲聊: "chat", 标准: "standard", 计划: "plan" };
      if (aliases[arg]) applyMode(aliases[arg]);
      else notice("用法：/mode chat | standard | plan");
      return;
    }
    if (/^\/sudo(?:\s|$)/.test(lower)) {
      const arg = lower.slice(5).trim();
      let next;
      if (["on", "1", "开", "开启"].includes(arg)) next = true;
      else if (["off", "0", "关", "关闭"].includes(arg)) next = false;
      else if (arg) {
        notice("用法：/sudo on | off");
        return;
      }
      const on = toggleSudoMode(next);
      notice(on ? "已开启 sudo 模式：权限门关闭，需要 root 的命令自动加 sudo" : "已关闭 sudo 模式：恢复权限门与危险命令确认");
      return;
    }
    const slot = current;
    const sendImages = !text.startsWith("/");
    if (sendImages && slot.loadingImages) {
      editor.setText(raw);
      notice("图片正在读取，请稍后发送");
      return;
    }
    if (sendImages && slot.images.length > MAX_IMAGES) {
      editor.setText(raw);
      notice(`每条消息最多发送 ${MAX_IMAGES} 张图片，请用 /unimage 移除多余附件`);
      return;
    }
    try {
      assertImageSupport(slot.session, sendImages ? slot.images.length : 0);
    } catch (error) {
      editor.setText(raw);
      notice(error.message);
      return;
    }
    const attachments = sendImages ? slot.images.splice(0) : [];
    if (text) editor.addToHistory(text);
    conversation.addUser([text, ...attachments.map((image) => `[图片：${singleLine(image.name)}]`)].filter(Boolean).join("\n"));
    const target = slot.session;
    if (target.isStreaming) notice("已排队，当前任务结束后自动发送");
    redraw();
    let accepted = false;
    try {
      await target.prompt(text, {
        streamingBehavior: "followUp",
        images: attachments.length ? attachments.map((image) => image.content) : void 0,
        preflightResult: (success) => {
          accepted = success;
        }
      });
    } catch (error) {
      if (!accepted) {
        slot.images.unshift(...attachments);
        if (slot === current && !editor.getText()) editor.setText(raw);
        else if (slot !== current && !slot.draft) slot.draft = raw;
      }
      if (target === current.session) notice(`发送失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (target === current.session) refreshTabs();
  };
  editor.onSubmit = (text) => {
    void handleSubmit(text);
  };
  const status = new RenderLine((width) => {
    const mode = MODE_DEFS[getMode()];
    const state = switching ? `${C.yellow}正在切换…` : current.session.isStreaming ? `${C.green}● 运行中 · Esc 中断` : `${mode.color}${mode.label}`;
    const help = width >= 100 ? "  Tab 模式 · Ctrl+Tab 会话 · Ctrl+V 图片 · /image 路径" : width >= 55 ? "  / 命令 · Ctrl+V 图片" : "";
    const alpha = DITO_IS_ALPHA ? ` ${C.yellow}${C.bold}ALPHA${C.reset}` : "";
    const left = ` ${state}${alpha}${C.reset}${C.muted}${help}${C.reset}`;
    const usage = current.session.getContextUsage?.();
    const contextTokens = formatContextTokens(usage?.tokens);
    const knownWindow = usage?.contextWindow != null && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0;
    const contextWindow = knownWindow ? formatContextTokens(usage.contextWindow) : "未知";
    const percent = !knownWindow || usage?.percent == null ? "?" : `${Math.max(0, Math.min(100, usage.percent)).toFixed(1)}%`;
    const context2 = `${C.dim}上下文 ${contextTokens}/${contextWindow} (${percent})${C.reset}`;
    const right = width >= 85 ? `${context2} ${C.dim}${singleLine(current.modelName)}${C.reset} ${sudoModeEnabled() ? C.yellow + "sudo" : C.muted + "权限门"}${C.reset} ` : "";
    return filledLine(balancedLine(left, right, width), width);
  });
  const context = new RenderLine((width) => filledLine(balancedLine(
    `${C.dim} ${basename(process.cwd())}${C.reset} ${C.muted} / ${singleLine(summaries.find((item) => item.path === currentPath)?.preview || "新会话")}${C.reset}`,
    `${C.muted}Alt+1…9 选择标签${C.reset} `,
    width
  )));
  const body = new HStack([
    { component: scroll, basis: 0, grow: 1, minSize: 0 },
    { component: bashView.component, basis: 40, shrink: 0, visible: ({ width, height }) => width >= 112 && height >= 16 }
  ], { gap: 2 });
  const imageDraft = new RenderLine((width) => filledLine(
    `${C.accent} 待发送图片 ${current.images.length}/${MAX_IMAGES}${C.reset} ${C.dim}${current.images.map((image, i) => `${i + 1}. ${singleLine(image.name)}`).join(" · ")}${current.loadingImages ? " · 读取中…" : ""}  /unimage 移除${C.reset}`,
    width
  ));
  const layout = new VStack([
    { component: tabs, basis: 1, shrink: 0, visible: ({ height }) => height >= 5 },
    { component: context, basis: 1, shrink: 0, visible: ({ width, height }) => width >= 80 && height >= 18 },
    { component: body, basis: 0, grow: 1, minSize: 0 },
    { component: imageDraft, basis: 1, shrink: 0, visible: () => current.images.length > 0 || current.loadingImages > 0 },
    { component: editor, basis: "auto", shrink: 1, minSize: 1 },
    { component: status, basis: 1, shrink: 0, visible: ({ height }) => height >= 7 }
  ]);
  tui.addChild(layout);
  tui.setLayoutRoot(layout);
  tui.setFocus(editor);
  tui.addInputListener((data) => {
    if (isKeyRelease(data)) return void 0;
    const key = parseKey(data);
    if (key === "ctrl+c" || key === "ctrl+d") {
      shutdown();
      return { consume: true };
    }
    if (tui.hasOverlay()) return void 0;
    if (key === "ctrl+v") {
      void addImage(imageInput.readClipboard);
      return { consume: true };
    }
    if (key === "escape" && current.session.isStreaming) {
      void current.session.abort().then(() => notice("已中断当前任务")).catch(() => {
      });
      return { consume: true };
    }
    if (key === "ctrl+t" || key === "alt+d") {
      void startNewSession();
      return { consume: true };
    }
    if (key === "alt+a") {
      openPreviousSession();
      return { consume: true };
    }
    if (key === "alt+w") {
      openSessionPicker();
      return { consume: true };
    }
    if (key === "ctrl+shift+b" || key === "shift+ctrl+b") {
      openBash();
      return { consume: true };
    }
    if (key === "ctrl+tab" || key === "alt+right" && !editor.getText()) {
      switchTabBy(1);
      return { consume: true };
    }
    if (key === "shift+ctrl+tab" || key === "alt+left" && !editor.getText()) {
      switchTabBy(-1);
      return { consume: true };
    }
    if (key && /^alt\+[1-9]$/.test(key)) {
      const path = tabs.pathAt(Number(key.slice(-1)) - 1);
      if (path) void openPath(path);
      return { consume: true };
    }
    if (key === "tab" && !editor.getText().trimStart().startsWith("/")) {
      applyMode(nextMode(getMode()));
      return { consume: true };
    }
    return void 0;
  });
  process.on("SIGINT", shutdown);
  restoreView();
  try {
    const shutdownPromise = new Promise((resolve) => {
      resolveShutdown = resolve;
      if (shutdownRequested) resolve();
    });
    tui.start();
    await bindSessionUi(current);
    applyMode(getMode());
    subscribeEvents();
    const startupCommand = process.env.DITO_STARTUP_COMMAND;
    const startupClipboard = process.env.DITO_STARTUP_CLIPBOARD === "1";
    const startupDraft = process.env.DITO_STARTUP_DRAFT;
    delete process.env.DITO_STARTUP_DRAFT;
    delete process.env.DITO_STARTUP_COMMAND;
    delete process.env.DITO_STARTUP_CLIPBOARD;
    if (startupDraft) editor.setText(startupDraft);
    if (startupCommand) await handleSubmit(startupCommand);
    if (startupClipboard) await addImage(imageInput.readClipboard);
    await shutdownPromise;
  } finally {
    process.off("SIGINT", shutdown);
    closeOverlay();
    dialogs.dispose();
    unsubscribe?.();
    await pendingSwitch;
    for (const remove of sessionInputRemovers) remove();
    try {
      await current.session.abort();
    } finally {
      tui.stop();
      for (const slot of new Set(slots.values())) slot.session.dispose();
    }
  }
}
export {
  runTui
};
