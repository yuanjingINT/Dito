/**
 * Dito 全屏对话 TUI（复用 @earendil-works/pi-tui）。
 *
 * 设计参考 dsh-tui：简洁欢迎 Logo + Markdown 对话 + 单一底部状态栏。
 * 主题色是天青（sky cyan），界面保持克制，只在高亮、品牌、代码/链接上使用。
 *
 * 布局：
 *   中部对话区：Markdown 滚动历史（Logo / 代码 / 引用 / 列表）
 *   底部输入框 + 底部状态栏
 */
import {
  CombinedAutocompleteProvider,
  Editor,
  isKeyRelease,
  Markdown,
  parseKey,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  MODE_DEFS,
  getMode,
  nextMode,
  readOnlyTools,
  setMode,
  type DitoMode,
} from "../extensions/mode.js";
import { sudoModeEnabled, toggleSudoMode } from "../extensions/permission.js";
import { createSession, listSessions, type SessionSummary } from "./session.js";

// ── 天青色系配色 ───────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[38;2;115;135;145m",
  dimmer: "\x1b[38;2;80;95;105m",
  sky: "\x1b[38;2;70;200;230m",
  skyBright: "\x1b[38;2;150;230;255m",
  yellow: "\x1b[38;2;220;190;110m",
  green: "\x1b[38;2;126;216;163m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
};

interface TuiSession {
  /** streamingBehavior："followUp" = 任务进行中时排队，本轮结束自动发送（中途插话）。 */
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<unknown>;
  subscribe(cb: (event: unknown) => void): () => void;
  dispose(): void;
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
  setThinkingLevel(level: string): void;
  /** 是否有任务在跑（流式输出中）。 */
  readonly isStreaming: boolean;
  /** 中断当前任务。 */
  abort(): Promise<void>;
  /** 当前会话文件路径（新会话落盘前为 undefined）。 */
  readonly sessionFile: string | undefined;
  /** 全部历史消息（含恢复的会话）。 */
  readonly messages: unknown[];
}

interface NewSessionResult {
  session: TuiSession;
  modelName: string;
}

const editorTheme = {
  // 输入框边框随运行模式变色（闲聊绿 / 标准青 / 计划紫），像 opencode 的模式染色
  borderColor: (s: string) => `${MODE_DEFS[getMode()].color}${s}${C.reset}`,
  selectList: {
    selectedPrefix: (s: string) => `${C.sky}> ${s}${C.reset}`,
    selectedText: (s: string) => s,
    description: (s: string) => `${C.dim}${s}${C.reset}`,
    scrollInfo: (s: string) => s,
    noMatch: (s: string) => s,
  },
};

// 输入 `/` 时弹出的命令菜单（类似 pi/opencode）。
const slashCommands = [
  { name: "chat", description: "切换到闲聊模式（不调用工具）" },
  { name: "standard", description: "切换到标准模式（完整助手）" },
  { name: "plan", description: "切换到计划模式（只读探索）" },
  { name: "mode", description: "切换运行模式", argumentHint: "chat|standard|plan" },
  { name: "sudo", description: "开启/关闭 sudo 权限模式", argumentHint: "on|off" },
  { name: "sessions", description: "打开会话列表（同 alt+w）" },
  { name: "prev", description: "查看上一个会话（同 alt+a）" },
  { name: "new", description: "开启新会话" },
  { name: "exit", description: "退出 TUI" },
];

// Markdown 主题：天青只做品牌/强调，正文保持中性与克制。
const markdownTheme = {
  heading: (s: string) => `${C.skyBright}${C.bold}${s}${C.reset}`,
  link: (s: string) => `${C.sky}${C.underline}${s}${C.reset}`,
  linkUrl: (s: string) => `${C.dim}${s}${C.reset}`,
  code: (s: string) => `${C.skyBright}${s}${C.reset}`,
  codeBlock: (s: string) => `${C.skyBright}${s}${C.reset}`,
  codeBlockBorder: (s: string) => `${C.dim}${s}${C.reset}`,
  quote: (s: string) => `${C.dim}${C.italic}${s}${C.reset}`,
  quoteBorder: (s: string) => `${C.dim}${s}${C.reset}`,
  hr: (s: string) => `${C.dim}${s}${C.reset}`,
  listBullet: (s: string) => `${C.sky}${C.bold}${s}${C.reset}`,
  bold: (s: string) => `${C.sky}${C.bold}${s}${C.reset}`,
  italic: (s: string) => `${C.italic}${s}${C.reset}`,
  strikethrough: (s: string) => `\x1b[9m${s}${C.reset}`,
  underline: (s: string) => `${C.underline}${s}${C.reset}`,
};

// ── 底部状态栏（唯一常驻栏：品牌/模式/提示 在左，模型/权限 在右） ──
function fitLine(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return left + " ".repeat(gap) + right;
}

function statusLine(mode: DitoMode, modelName: string, width: number, streaming: boolean): string {
  const d = MODE_DEFS[mode];
  const left = streaming
    ? `${C.skyBright}${C.bold}◈ Dito${C.reset} ${C.green}● 运行中${C.reset} ${C.dim}esc 中断 · 可插话排队${C.reset}`
    : `${C.skyBright}${C.bold}◈ Dito${C.reset} ${d.color}${d.label}${C.reset} ${C.dimmer}tab 切模式 · alt+w 会话 · / 命令${C.reset}`;
  const perm = sudoModeEnabled() ? `${C.yellow}sudo 已开${C.reset}` : `${C.dimmer}权限门${C.reset}`;
  const right = `${C.dimmer}${modelName}${C.reset} ${C.dim}${perm}${C.reset}`;
  return truncateToWidth(fitLine(left, right, width), width, "…");
}

function blockQuote(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

interface HistoryLike {
  role?: string;
  content?: unknown;
}

/** 提取消息正文（字符串或 content 块数组里的 text 块，跳过 thinking/工具块）。 */
function messageText(msg: HistoryLike): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}

/** 把会话历史渲染成对话区 Markdown（只取 user/assistant 正文，最多最近 40 条）。 */
function renderHistory(session: TuiSession): { text: string; count: number } {
  const msgs = (session.messages ?? []) as HistoryLike[];
  const convo = msgs.filter((m) => (m.role === "user" || m.role === "assistant") && messageText(m));
  if (convo.length === 0) return { text: "", count: 0 };
  const MAX = 40;
  const shown = convo.slice(-MAX);
  const parts: string[] = [];
  if (convo.length > shown.length) {
    parts.push(`\n> （更早的 ${convo.length - shown.length} 条消息已省略）\n`);
  }
  for (const m of shown) {
    const text = messageText(m);
    if (m.role === "user") parts.push(`\n${blockQuote(`**你**\n${text}`)}\n`);
    else parts.push(`\n\n**蒂特 ›** ${text}\n`);
  }
  return { text: parts.join(""), count: convo.length };
}

function welcomeText(): string {
  return [
    `${C.skyBright}${C.bold}◈ Dito${C.reset} 蒂特 · 你的电脑搭档`,
    `${C.dim}tab 模式 · alt+d 新会话 · alt+a 上一会话 · alt+w 会话列表 · / 命令${C.reset}`,
    "",
  ].join("\n");
}

export async function runTui(
  session: TuiSession,
  modelName: string,
  newSession: () => Promise<NewSessionResult>,
): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true);

  let currentSession = session;
  let currentModelName = modelName;

  // 标准模式的默认工具集（切换回来时恢复）
  let standardTools = currentSession.getActiveToolNames();

  const applyMode = (mode: DitoMode): void => {
    setMode(mode);
    if (mode === "chat") currentSession.setActiveToolsByName([]);
    else if (mode === "plan") currentSession.setActiveToolsByName(readOnlyTools());
    else currentSession.setActiveToolsByName(standardTools);
    currentSession.setThinkingLevel(MODE_DEFS[mode].thinkingLevel);
  };

  // ── 会话切换与覆盖层状态 ──────────────────────────────────────
  let overlayActive = false;
  let overlaySessions: SessionSummary[] = [];
  let overlaySelected = 0;
  let savedTranscript = "";

  // ── 对话区（Markdown 滚动历史） ───────────────────────────────
  let transcriptText = "";
  const transcript = new Markdown("", 1, 0, markdownTheme);
  const scroll = new ScrollView(transcript, { follow: "end", primary: true, scrollbar: "auto" });

  const appendTranscript = (s: string): void => {
    if (overlayActive) return;
    transcriptText += s;
    transcript.setText(transcriptText);
    tui.requestRender();
  };

  // ── 回合渲染状态 ──────────────────────────────────────────────
  let prefixWritten = false;
  let inThinking = false;
  let thinkingLineStart = false;
  const seenTools = new Set<string>();

  const resetTurnState = (): void => {
    prefixWritten = false;
    inThinking = false;
    thinkingLineStart = false;
    seenTools.clear();
  };

  // 思考内容用引用块展示；流式增量按行首补 `> `。
  const appendThinkingDelta = (delta: string): void => {
    if (!delta) return;
    let out = "";
    for (const ch of delta) {
      if (thinkingLineStart) {
        out += "> ";
        thinkingLineStart = false;
      }
      out += ch;
      if (ch === "\n") thinkingLineStart = true;
    }
    appendTranscript(out);
  };

  const closeThinking = (): void => {
    if (!inThinking) return;
    if (!thinkingLineStart) appendTranscript("\n");
    thinkingLineStart = false;
    inThinking = false;
  };

  // ── 底部状态栏（唯一常驻栏） ──────────────────────────────────
  const status = new Text("", 1, 0);
  const updateStatus = (): void => {
    const width = Math.max(10, terminal.columns - 2);
    status.setText(truncateToWidth(statusLine(getMode(), currentModelName, width, currentSession.isStreaming), width, "…"));
    tui.requestRender();
  };

  // ── 退出控制 ──────────────────────────────────────────────────
  let shutdownRequested = false;
  let resolveShutdown: (() => void) | null = null;
  const shutdown = (): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    resolveShutdown?.();
  };

  // ── 会话事件流式渲染 ──────────────────────────────────────────
  let unsubscribe: (() => void) | null = null;

  const summarizeArgs = (args: unknown): string => {
    if (args == null) return "";
    const s = typeof args === "string" ? args : (() => { try { return JSON.stringify(args); } catch { return String(args); } })();
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > 160 ? flat.slice(0, 160) + "…" : flat;
  };

  const subscribeEvents = (): void => {
    resetTurnState();
    unsubscribe = currentSession.subscribe((event) => {
      const e = event as {
        type: string;
        assistantMessageEvent?: { type: string; delta?: string };
        toolName?: string;
        toolCallId?: string;
        args?: unknown;
        message?: { role?: string; stopReason?: string; errorMessage?: string };
      };
      const ame = e.assistantMessageEvent;

      if (e.type === "message_update" && ame) {
        // 思考中
        if (ame.type === "thinking_start") {
          inThinking = true;
          thinkingLineStart = true;
          appendTranscript("\n> ◇ 思考中…\n");
          return;
        }
        if (ame.type === "thinking_delta") {
          appendThinkingDelta(ame.delta ?? "");
          return;
        }
        if (ame.type === "thinking_end") {
          closeThinking();
          return;
        }
        // 正文
        if (ame.type === "text_delta") {
          closeThinking();
          if (!prefixWritten) {
            appendTranscript("\n\n**蒂特 ›** ");
            prefixWritten = true;
          }
          appendTranscript(ame.delta ?? "");
          return;
        }
        return;
      }

      // 工具调用
      if (e.type === "tool_execution_start" && e.toolName) {
        if (e.toolCallId && seenTools.has(e.toolCallId)) return;
        if (e.toolCallId) seenTools.add(e.toolCallId);
        closeThinking();
        const argStr = summarizeArgs(e.args);
        appendTranscript(
          `\n\n- ⚙ **${e.toolName}**` +
          (argStr ? ` — ${argStr}` : "") + `\n`,
        );
        return;
      }

      // 结束 / 错误
      if (e.type === "message_end" && e.message?.role === "assistant") {
        if (e.message.stopReason === "error" && e.message.errorMessage) {
          closeThinking();
          const msg = e.message.errorMessage;
          if (/429|rate limit|限流/i.test(msg)) {
            appendTranscript(`\n\n> **opencode 免费额度限流**，稍后再试\n`);
          } else {
            appendTranscript(`\n\n> **出错** ${msg}\n`);
          }
        }
        return;
      }
      if (e.type === "agent_end") {
        closeThinking();
        prefixWritten = false;
        seenTools.clear();
        updateStatus();
      }
    });
  };

  // ── 会话切换（/new、tab+a、tab+w 共用同一套逻辑） ─────────────
  const switchToSession = async (
    loader: () => Promise<{ session: TuiSession; modelName: string }>,
    banner: (count: number) => string,
  ): Promise<void> => {
    if (currentSession.isStreaming) {
      appendTranscript(`\n> 当前任务还在运行，等它结束或按 esc 中断后再切换\n`);
      return;
    }
    appendTranscript(`\n> 正在切换会话…\n`);
    try {
      const next = await loader();
      unsubscribe?.();
      currentSession.dispose();
      currentSession = next.session;
      currentModelName = next.modelName;
      standardTools = currentSession.getActiveToolNames();

      transcriptText = welcomeText();
      const hist = renderHistory(currentSession);
      transcriptText += `\n> ${banner(hist.count)}\n`;
      if (hist.count > 0) transcriptText += hist.text;
      transcript.setText(transcriptText);
      tui.requestRender();

      applyMode(getMode());
      subscribeEvents();
      updateStatus();
    } catch (err) {
      appendTranscript(`\n> **会话切换失败** ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  // /new 或 tab+d：清空上下文，开新会话
  const startNewSession = async (): Promise<void> => {
    await switchToSession(newSession, () => "已开启新会话（上下文已清空）");
  };

  // tab+a：查看上一个（更早的）会话并恢复
  const openPreviousSession = async (): Promise<void> => {
    const sessions = listSessions();
    if (sessions.length === 0) {
      appendTranscript(`\n> 还没有历史会话\n`);
      return;
    }
    const cur = currentSession.sessionFile;
    const idx = cur ? sessions.findIndex((s) => s.path === cur) : -1;
    const target = idx >= 0 ? sessions[idx + 1] : sessions[0];
    if (!target) {
      appendTranscript(`\n> 已经是最早的会话了\n`);
      return;
    }
    await switchToSession(() => createSession({ sessionFile: target.path }), () => sessionBanner(target));
  };

  const sessionBanner = (s: SessionSummary): string => {
    const when = new Date(s.startedAt).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `已打开会话（${when} · ${s.messageCount} 条消息）`;
  };

  // tab+w：会话列表覆盖层
  const drawSessionOverlay = (): void => {
    const lines: string[] = ["**会话列表**（↑↓/j-k 移动 · enter 打开 · esc 返回）", ""];
    const cur = currentSession.sessionFile;
    overlaySessions.forEach((s, i) => {
      const when = new Date(s.startedAt).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const curMark = s.path === cur ? "（当前）" : "";
      // 光标用 ● 而不是 > ：">" 会被 Markdown 组件解析成引用块、光标就看不见了
      const cursor = i === overlaySelected ? "●" : " ";
      lines.push(`${cursor} ${when} · ${s.messageCount} 条 · ${s.preview || "（空会话）"}${curMark}`);
    });
    transcriptText = lines.join("\n");
    transcript.setText(transcriptText);
    tui.requestRender();
  };

  const openSessionOverlay = async (): Promise<void> => {
    overlaySessions = listSessions();
    if (overlaySessions.length === 0) {
      appendTranscript(`\n> 还没有历史会话，先聊点什么吧\n`);
      return;
    }
    overlaySelected = 0;
    savedTranscript = transcriptText;
    overlayActive = true;
    drawSessionOverlay();
  };

  const closeSessionOverlay = (): void => {
    overlayActive = false;
    transcriptText = savedTranscript;
    transcript.setText(transcriptText);
    tui.requestRender();
  };

  const openSelectedSession = async (): Promise<void> => {
    const target = overlaySessions[overlaySelected];
    overlayActive = false;
    transcriptText = savedTranscript;
    transcript.setText(transcriptText);
    if (!target) return;
    await switchToSession(() => createSession({ sessionFile: target.path }), () => sessionBanner(target));
  };

  // ── 底部输入框 ────────────────────────────────────────────────
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  const autocomplete = new CombinedAutocompleteProvider(slashCommands, process.cwd());
  editor.setAutocompleteProvider(autocomplete);

  const handleSubmit = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text) return;

    const lower = text.toLowerCase();
    if (lower === "/exit" || lower === "/quit" || lower === "exit") {
      shutdown();
      return;
    }
    if (lower === "/new" || lower === "/新会话") {
      await startNewSession();
      return;
    }
    if (lower === "/sessions" || lower === "/会话列表") {
      await openSessionOverlay();
      return;
    }
    if (lower === "/prev" || lower === "/上一会话" || lower === "/上一个") {
      await openPreviousSession();
      return;
    }
    if (lower === "/chat" || lower === "/闲聊") { applyMode("chat"); updateStatus(); return; }
    if (lower === "/standard" || lower === "/标准") { applyMode("standard"); updateStatus(); return; }
    if (lower === "/plan" || lower === "/计划") { applyMode("plan"); updateStatus(); return; }
    if (lower.startsWith("/mode")) {
      const arg = lower.replace("/mode", "").trim();
      const alias: Record<string, DitoMode> = {
        chat: "chat", standard: "standard", plan: "plan",
        闲聊: "chat", 标准: "standard", 计划: "plan",
      };
      const target = alias[arg];
      if (target) {
        applyMode(target);
        updateStatus();
      } else {
        appendTranscript(`\n> 用法：\`/mode chat | standard | plan\`\n`);
      }
      return;
    }
    if (lower.startsWith("/sudo")) {
      const arg = lower.replace("/sudo", "").trim();
      let next: boolean | undefined;
      if (["on", "1", "开", "开启"].includes(arg)) next = true;
      else if (["off", "0", "关", "关闭"].includes(arg)) next = false;
      else if (arg !== "") {
        appendTranscript(`\n> 用法：\`/sudo on | off\`（开启/关闭 sudo 权限模式）\n`);
        return;
      }
      const on = toggleSudoMode(next);
      appendTranscript(
        `\n> ${on ? "**已开启 sudo 模式**：权限门关闭，需要 root 的命令自动加 sudo" : "**已关闭 sudo 模式**：恢复权限门与危险命令确认"}\n`,
      );
      updateStatus();
      return;
    }

    editor.addToHistory(text);
    appendTranscript(`\n${blockQuote(`**你**\n${text}`)}\n`);
    if (currentSession.isStreaming) {
      // 任务中途插话：排队（followUp），当前轮结束后自动发送
      appendTranscript(`\n> 已排队，当前任务结束后自动发送\n`);
    }
    try {
      await currentSession.prompt(text, { streamingBehavior: "followUp" });
    } catch (err) {
      // 不让并发/预检失败炸掉整个 TUI（旧行为：任务中途回车直接退出）
      appendTranscript(`\n> **发送失败** ${err instanceof Error ? err.message : String(err)}\n`);
    }
    appendTranscript("\n");
    updateStatus();
  };
  editor.onSubmit = (text) => {
    void handleSubmit(text);
  };

  subscribeEvents();

  // ── 布局 ──────────────────────────────────────────────────────
  const layoutRoot = new VStack([
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: editor, basis: "auto", grow: 0, shrink: 1, minSize: 3 },
    { component: status, basis: 1, grow: 0, shrink: 0 },
  ]);
  tui.addChild(scroll);
  tui.addChild(editor);
  tui.addChild(status);
  tui.setLayoutRoot(layoutRoot);
  tui.setFocus(editor);

  // ── 全局按键：覆盖层拦截 / Ctrl+C 退出 / Esc 中断 / Alt 会话键 ─
  // 统一用 parseKey 归一化：兼容 CSI / SS3（应用光标模式）/ kitty CSI-u 等各种终端编码
  tui.addInputListener((data) => {
    // kitty 键盘协议下每次按键有「按下 + 释放」两个事件；pi-tui 只给焦点组件过滤
    // 释放事件，监听器收不到过滤——不过滤的话每个动作都会触发两次（按一次 tab 跳两个模式）
    if (isKeyRelease(data)) return undefined;

    const key = parseKey(data);

    // 会话列表覆盖层：拦截全部按键（编辑器收不到）
    if (overlayActive) {
      if (key === "up" || key === "k") {
        overlaySelected = Math.max(0, overlaySelected - 1);
        drawSessionOverlay();
        return { consume: true };
      }
      if (key === "down" || key === "j") {
        overlaySelected = Math.min(overlaySessions.length - 1, overlaySelected + 1);
        drawSessionOverlay();
        return { consume: true };
      }
      if (key === "enter") {
        void openSelectedSession();
        return { consume: true };
      }
      // escape / 其他键一律关闭
      closeSessionOverlay();
      return { consume: true };
    }

    if (key === "ctrl+c" || key === "ctrl+d") {
      shutdown();
      return { consume: true };
    }

    // 任务进行中：esc 中断当前任务
    if (key === "escape" && currentSession.isStreaming) {
      void currentSession
        .abort()
        .then(() => appendTranscript(`\n> 已中断当前任务\n`))
        .catch(() => {});
      return { consume: true };
    }

    // Alt 组合键管理会话（老式 ESC 前缀与 kitty CSI-u 编码都归一化为 alt+x）
    if (key === "alt+d") {
      void startNewSession(); // alt+d 新会话
      return { consume: true };
    }
    if (key === "alt+a") {
      void openPreviousSession(); // alt+a 上一会话
      return { consume: true };
    }
    if (key === "alt+w") {
      void openSessionOverlay(); // alt+w 会话列表
      return { consume: true };
    }

    if (key === "tab") {
      // 输入 `/` 时把 Tab 交给编辑器处理命令菜单；否则 Tab 循环切换模式。
      const editorText = editor.getText();
      if (editorText.trimStart().startsWith("/")) return undefined;
      applyMode(nextMode(getMode()));
      updateStatus();
      return { consume: true };
    }

    return undefined;
  });

  process.on("SIGINT", shutdown);

  // ── 初始内容与启动（进入主页时恢复上次会话） ──────────────────
  transcriptText = welcomeText();
  const restored = renderHistory(currentSession);
  if (restored.count > 0) {
    transcriptText += `\n> 已恢复上次会话 · ${restored.count} 条消息 · alt+a 上一会话 · alt+w 会话列表\n${restored.text}`;
  }
  transcript.setText(transcriptText);
  updateStatus();

  try {
    tui.start();
    await new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
  } finally {
    process.off("SIGINT", shutdown);
    tui.stop();
    currentSession.dispose();
  }
}
