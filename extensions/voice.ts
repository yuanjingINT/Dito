/**
 * Dito 语音对话引擎。
 *
 * 界面参考 laozhou 的 voice UI：
 * - 上方水波圆球：待机=涟漪、录音=波纹扩散、思考=水滴转圈、说话=随声波动
 *   （用 [' ','░','▒','▓','█','█'] 亮度波 + 环形相位旋转实现）
 * - 圆球下方状态行 + 滚动对话内容区
 * - 空格键手动唤醒/结束录音；q / Esc 退出
 * - 提问或请求许可时自动「朗读 → 录音」
 * - 连续对话可配置（默认关闭）
 *
 * 通过 runVoiceMode(session, config) 调用，session 由 pi SDK 创建。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { setVoiceHandlers, setVoiceModeActive } from "./voice-hooks.js";

// ── 类型 ────────────────────────────────────────────────────────
export interface VoiceConfig {
  enabled: boolean;
  wakeWord: string;
  stt: "whisper" | "xiaomi" | "custom";
  tts: "espeak" | "piper" | "xiaomi" | "custom";
  whisperModel: string;
  whisperLanguage: string;
  espeakVoice: string;
  piperModel: string;
  piperConfig: string;
  xiaomiApiKey: string;
  xiaomiBaseUrl: string;
  xiaomiAsrModel: string;
  xiaomiTtsModel: string;
  xiaomiTtsVoice: string;
  maxRecordSeconds: number;
  autoListenAfterQuestion: boolean;
  continuous: boolean;
  customSttCommand?: string;
  customTtsCommand?: string;
}

type VoiceState = "idle" | "recording" | "thinking" | "speaking";

interface AgentSessionLike {
  prompt(text: string): Promise<unknown>;
  subscribe(cb: (event: unknown) => void): unknown;
}

// ── 工具函数 ────────────────────────────────────────────────────
function expand(path: string): string {
  if (path.startsWith("~")) return join(homedir(), path.slice(1));
  return path;
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
  });
}

function tmpWav(): string {
  const dir = mkdtempSync(join(tmpdir(), "dito-"));
  return join(dir, "rec.wav");
}

function detectRecorder(): string {
  if (existsSync("/usr/bin/pw-record") || existsSync("/usr/local/bin/pw-record")) return "pw-record";
  if (existsSync("/usr/bin/parec")) return "parec";
  return "arecord";
}

function recorderArgs(recorder: string, out: string): string[] {
  if (recorder === "pw-record") return ["--rate", "16000", "--channels", "1", "--format", "s16le", out];
  if (recorder === "parec") return ["--rate=16000", "--channels=1", "--format=s16le", "--file-format=wav", out];
  return ["-f", "S16_LE", "-r", "16000", "-c", "1", out];
}

function asksQuestion(text: string): boolean {
  const t = text.trim();
  return /[？?]$/.test(t) || /要不要|是否|确定吗|可以吗|行吗|你选|你希望|请回答|你决定/.test(t);
}

// ── STT ─────────────────────────────────────────────────────────
async function sttWhisper(wav: string, cfg: VoiceConfig): Promise<string> {
  const model = expand(cfg.whisperModel);
  if (!model || !existsSync(model)) return "";
  const base = wav.replace(/\.wav$/, "");
  await run("whisper-cli", ["-m", model, "-l", cfg.whisperLanguage || "auto", "-np", "-otxt", "-of", base, wav]);
  const txt = base + ".txt";
  if (existsSync(txt)) {
    try {
      return readFileSync(txt, "utf-8").trim();
    } finally {
      try {
        unlinkSync(txt);
      } catch {}
    }
  }
  return "";
}

async function sttXiaomi(wav: string, cfg: VoiceConfig): Promise<string> {
  if (!cfg.xiaomiApiKey.trim()) return "";
  const data = readFileSync(wav);
  const form = new FormData();
  form.append("file", new Blob([data], { type: "audio/wav" }), "rec.wav");
  form.append("model", cfg.xiaomiAsrModel || "mimo-v2.5-asr");
  const resp = await fetch(`${cfg.xiaomiBaseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.xiaomiApiKey.trim()}` },
    body: form,
  });
  if (!resp.ok) return "";
  const json = (await resp.json()) as { text?: string };
  return json.text?.trim() ?? "";
}

async function speechToText(wav: string, cfg: VoiceConfig): Promise<string> {
  if (cfg.stt === "xiaomi") {
    const t = await sttXiaomi(wav, cfg);
    if (t) return t;
  }
  if (cfg.stt === "custom" && cfg.customSttCommand) {
    const r = await run("bash", ["-c", cfg.customSttCommand.replace("{file}", wav)]);
    return r.stdout.trim();
  }
  return sttWhisper(wav, cfg);
}

// ── TTS ─────────────────────────────────────────────────────────
async function playWav(wav: string): Promise<void> {
  const player = existsSync("/usr/bin/paplay") ? "paplay" : existsSync("/usr/bin/aplay") ? "aplay" : "pw-play";
  await run(player, [wav]);
}

async function ttsEspeak(text: string, cfg: VoiceConfig): Promise<void> {
  const out = tmpWav().replace("rec.wav", "tts.wav");
  await run("espeak-ng", ["-v", cfg.espeakVoice || "zh", "-w", out, text]);
  await playWav(out);
  try {
    unlinkSync(out);
  } catch {}
}

async function ttsPiper(text: string, cfg: VoiceConfig): Promise<void> {
  const model = expand(cfg.piperModel);
  if (!model || !existsSync(model)) return;
  const out = tmpWav().replace("rec.wav", "tts.wav");
  const args = ["--model", model, "--output_file", out];
  if (cfg.piperConfig) args.push("--config", expand(cfg.piperConfig));
  await new Promise<void>((resolve) => {
    const child = spawn("piper", args, { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.write(text);
    child.stdin.end();
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  await playWav(out);
  try {
    unlinkSync(out);
  } catch {}
}

async function ttsXiaomi(text: string, cfg: VoiceConfig): Promise<void> {
  if (!cfg.xiaomiApiKey.trim()) return;
  const resp = await fetch(`${cfg.xiaomiBaseUrl.replace(/\/+$/, "")}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.xiaomiApiKey.trim()}` },
    body: JSON.stringify({ model: cfg.xiaomiTtsModel || "mimo-v2.5-tts", input: text, voice: cfg.xiaomiTtsVoice || "冰糖" }),
  });
  if (!resp.ok) return;
  const buf = Buffer.from(await resp.arrayBuffer());
  const out = tmpWav().replace("rec.wav", "tts.mp3");
  writeFileSync(out, buf);
  await playWav(out);
  try {
    unlinkSync(out);
  } catch {}
}

async function textToSpeech(text: string, cfg: VoiceConfig): Promise<void> {
  if (!text.trim()) return;
  try {
    if (cfg.tts === "xiaomi") {
      await ttsXiaomi(text, cfg);
      return;
    }
    if (cfg.tts === "piper") {
      await ttsPiper(text, cfg);
      return;
    }
    if (cfg.tts === "custom" && cfg.customTtsCommand) {
      await run("bash", ["-c", cfg.customTtsCommand.replace("{text}", text)]);
      return;
    }
    await ttsEspeak(text, cfg);
  } catch {
    // 朗读失败不影响对话
  }
}

// ── 水波 UI（参考 laozhou voice/ui.rs）──────────────────────────
const WAVE = [" ", "░", "▒", "▓", "█", "█"];

interface Cursor {
  x: number;
  y: number;
}

/** 计算圆球帧（仅圆球区域），移植自 laozhou 的 build_frame。 */
function buildFrame(
  cols: number,
  orbRows: number,
  orbCol: number,
  radius: number,
  state: VoiceState,
  phase: number,
): string[] {
  const grid: string[][] = Array.from({ length: orbRows }, () => new Array(cols).fill(" "));
  const R = radius;
  const centerCol = orbCol;
  const centerRow = orbRows / 2;

  const ampFor = (s: VoiceState): number => {
    switch (s) {
      case "recording":
        return 0.6;
      case "thinking":
        return 0.25;
      case "speaking":
        return 0.9 + 0.1 * Math.sin(phase * Math.PI * 2 * 10);
      default:
        return 0.35;
    }
  };
  const amp = ampFor(state);

  for (let r = 0; r < orbRows; r++) {
    const cy = r + 0.5;
    for (let c = 0; c < cols; c++) {
      const cx = c + 0.5;
      const dist = Math.sqrt((cx - centerCol) ** 2 + (cy - centerRow) ** 2);
      const distToRing = Math.abs(dist - R);
      if (distToRing < 0.9) {
        // 环形：亮度波随相位旋转（思考时即「水滴转圈」）
        const wave = Math.sin(phase * Math.PI * 2 * 2 + dist);
        const v = Math.max(0, Math.min(0.999, 0.5 + 0.5 * (wave * amp)));
        grid[r][c] = WAVE[Math.floor(v * 5)];
      } else if (dist < R) {
        // 内部填充：思考时空心，其余为水波
        if (state === "thinking") {
          grid[r][c] = WAVE[0];
        } else {
          const centerWave = Math.sin(phase * Math.PI * 2 * 8 - dist * 0.8);
          const falloff = 1 - dist / R;
          let brightness = falloff * (0.55 + 0.45 * centerWave);
          if (state === "speaking") brightness = (0.5 + 0.5 * centerWave) * falloff * 4;
          grid[r][c] = WAVE[Math.min(2, Math.max(0, Math.floor(Math.max(0, Math.min(0.999, brightness)) * 2)))];
        }
      }
    }
  }

  // 说话：向外扩散的声波涟漪
  if (state === "speaking") {
    for (let i = 0; i < 3; i++) {
      const progress = (phase * 2 + i / 3) % 1;
      const rippleR = R * 0.3 + progress * (R + 3);
      paintRipple(grid, cols, orbRows, centerCol, centerRow, rippleR, R * 0.2, 1 - progress);
    }
  }
  // 录音：向外扩散的涟漪环
  if (state === "recording") {
    for (let i = 0; i < 3; i++) {
      const progress = (phase + i / 3) % 1;
      const rippleR = R + progress * 4;
      paintRipple(grid, cols, orbRows, centerCol, centerRow, rippleR, R, 1 - progress);
    }
  }

  return grid.map((row) => row.join(""));
}

function paintRipple(
  grid: string[][],
  cols: number,
  orbRows: number,
  centerCol: number,
  centerRow: number,
  rippleR: number,
  minDist: number,
  brightness: number,
): void {
  for (let r = 0; r < orbRows; r++) {
    const cy = r + 0.5;
    for (let c = 0; c < cols; c++) {
      const cx = c + 0.5;
      const d = Math.sqrt((cx - centerCol) ** 2 + (cy - centerRow) ** 2);
      if (Math.abs(d - rippleR) < 0.45 && d > minDist) {
        const idx = Math.min(5, Math.floor(brightness * 4) + 1);
        grid[r][c] = WAVE[idx];
      }
    }
  }
}

/** 跳过 ANSI 转义序列，推进光标（处理换行与自动折行）。 */
function advanceCursor(text: string, cursor: Cursor, cols: number, bottom: number): Cursor {
  let { x, y } = cursor;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\x1b") {
      i++;
      if (text[i] === "[") {
        i++;
        while (i < text.length && !/[@-~]/.test(text[i])) i++;
        i++;
      } else {
        i++;
      }
      continue;
    }
    if (ch === "\n") {
      y++;
      x = 0;
      i++;
      continue;
    }
    if (ch === "\r") {
      x = 0;
      i++;
      continue;
    }
    x++;
    if (x >= cols) {
      x = 0;
      y++;
    }
    i++;
  }
  y = Math.min(y, bottom);
  return { x, y };
}

class WaterUI {
  private state: VoiceState = "idle";
  private timer: ReturnType<typeof setInterval> | null = null;
  private start = Date.now();
  private cols = process.stdout.columns || 80;
  private rows = process.stdout.rows || 24;
  private contentTop = 14;
  private orbRows = 12;
  private orbCol = 40;
  private orbRadius = 5;
  private cursor: Cursor = { x: 0, y: 14 };

  enter(): void {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    this.layout();
    this.startContent();
    process.on("SIGWINCH", this.onResize);
    this.timer = setInterval(() => this.render(), 66);
  }

  exit(): void {
    if (this.timer) clearInterval(this.timer);
    process.off("SIGWINCH", this.onResize);
    process.stdout.write("\x1b[r\x1b[?25h\x1b[?1049l");
  }

  setState(s: VoiceState): void {
    this.state = s;
  }

  private onResize = (): void => {
    this.layout();
  };

  private layout(): void {
    this.cols = process.stdout.columns || 80;
    this.rows = process.stdout.rows || 24;
    // 内容区起点：rows-6 限制在 [10,14]
    this.contentTop = Math.max(10, Math.min(14, this.rows - 6));
    this.orbRows = Math.max(7, this.contentTop - 2);
    this.orbRadius = Math.max(2, Math.floor(this.orbRows / 2) - 1);
    this.orbCol = Math.floor((this.cols - 1) / 2);
  }

  /** 只重绘圆球区与状态行，保留下方内容区（无全屏清屏，无闪烁）。 */
  private render(): void {
    const phase = (Date.now() - this.start) / 1000;
    const frame = buildFrame(this.cols, this.orbRows, this.orbCol, this.orbRadius, this.state, phase);
    let out = "";
    for (let r = 0; r < frame.length; r++) {
      out += `\x1b[${r + 1};1H\x1b[2K${frame[r]}`;
    }
    const statusRow = this.orbRows + 1;
    if (statusRow < this.contentTop) {
      const status = this.statusText();
      const col = Math.max(0, this.orbCol - Math.floor(status.length / 2));
      out += `\x1b[${statusRow + 1};1H\x1b[2K\x1b[${statusRow + 1};${col + 1}H\x1b[2m${status}\x1b[0m`;
    }
    process.stdout.write(out);
  }

  private statusText(): string {
    switch (this.state) {
      case "idle":
        return "按空格跟我说 · q 退出";
      case "recording":
        return "听着呢… 空格键收声";
      case "thinking":
        return "让我想想…";
      case "speaking":
        return "我在说…";
    }
  }

  /** 清空内容区并复位光标。 */
  startContent(): void {
    this.layout();
    this.cursor = { x: 0, y: this.contentTop };
    let out = "";
    for (let row = this.contentTop; row < this.rows; row++) {
      out += `\x1b[${row + 1};1H\x1b[2K`;
    }
    out += `\x1b[${this.contentTop + 1};1H`;
    process.stdout.write(out);
  }

  /** 把流式内容写入下方内容区（滚动区域），并推进光标。 */
  renderContent(text: string): void {
    if (!text) return;
    const regionTop = Math.min(this.contentTop + 1, this.rows);
    const cursor = {
      x: Math.min(this.cursor.x, this.cols - 1),
      y: Math.max(this.contentTop, Math.min(this.cursor.y, this.rows - 1)),
    };
    let out = `\x1b[${regionTop};${this.rows}r`;
    out += `\x1b[${cursor.y + 1};${cursor.x + 1}H`;
    out += text;
    out += "\x1b[r";
    process.stdout.write(out);
    this.cursor = advanceCursor(text, cursor, this.cols, this.rows - 1);
  }
}

// ── 引擎 ────────────────────────────────────────────────────────
export async function runVoiceMode(session: AgentSessionLike, cfg: VoiceConfig): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("语音模式需要真实终端（TTY）。请在终端里运行 `dito voice`。");
    return;
  }

  const ui = new WaterUI();
  ui.enter();
  setVoiceModeActive(true);

  let stopRequested = false;
  let quitRequested = false;
  const stdin = process.stdin;

  const onKey = (buf: Buffer): void => {
    const s = buf.toString();
    if (s === " " || s === "\r" || s === "\n") stopRequested = true;
    if (s === "q" || s === "Q" || s === "\x1b") quitRequested = true;
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onKey);

  const recorder = detectRecorder();

  function record(): Promise<string> {
    const out = tmpWav();
    const child = spawn(recorder, recorderArgs(recorder, out));
    stopRequested = false;
    ui.setState("recording");
    const begin = Date.now();
    return new Promise<string>((resolve) => {
      const poll = setInterval(() => {
        const over = Date.now() - begin > cfg.maxRecordSeconds * 1000;
        if (stopRequested || over) {
          clearInterval(poll);
          child.kill("SIGINT");
        }
      }, 60);
      child.on("exit", () => {
        clearInterval(poll);
        resolve(out);
      });
      child.on("error", () => {
        clearInterval(poll);
        resolve(out);
      });
    });
  }

  function waitForSpace(): Promise<void> {
    ui.setState("idle");
    stopRequested = false;
    return new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (stopRequested || quitRequested) {
          clearInterval(poll);
          resolve();
        }
      }, 60);
    });
  }

  async function listenOnce(): Promise<string> {
    const wav = await record();
    ui.setState("thinking");
    const text = await speechToText(wav, cfg);
    try {
      unlinkSync(wav);
    } catch {}
    return text;
  }

  const askAndRecord = async (q: string): Promise<string> => {
    ui.setState("speaking");
    await textToSpeech(q, cfg);
    return listenOnce();
  };
  const confirmAndRecord = async (q: string): Promise<boolean> => {
    const ans = await askAndRecord(q);
    return /确认|可以|是|好|继续|执行|确定|没问题|yes|ok|行/i.test(ans);
  };
  setVoiceHandlers({ ask: askAndRecord, confirm: confirmAndRecord });

  let currentText = "";
  session.subscribe((event) => {
    const e = event as {
      type: string;
      assistantMessageEvent?: { type: string; delta?: string };
      toolName?: string;
    };
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      currentText += e.assistantMessageEvent.delta ?? "";
      ui.renderContent(e.assistantMessageEvent.delta ?? "");
    } else if (e.type === "tool_execution_start") {
      ui.renderContent(`\x1b[90m〔工具：${e.toolName}〕\x1b[0m\n`);
    }
  });

  try {
    let autoContinue = false;
    while (!quitRequested) {
      if (!autoContinue) {
        await waitForSpace();
        if (quitRequested) break;
      }
      autoContinue = false;

      const text = await listenOnce();
      if (quitRequested) break;
      if (!text.trim()) continue;

      ui.renderContent(`\x1b[36m你：${text.trim()}\x1b[0m\n`);

      ui.setState("thinking");
      currentText = "";
      ui.renderContent("\x1b[35m蒂特：\x1b[0m");
      await session.prompt(text);
      ui.renderContent("\n");
      const answer = currentText.trim();

      if (answer) {
        ui.setState("speaking");
        await textToSpeech(answer, cfg);
      }

      if (cfg.autoListenAfterQuestion && answer && asksQuestion(answer)) {
        autoContinue = true;
      } else if (cfg.continuous) {
        autoContinue = true;
      }
    }
  } finally {
    setVoiceModeActive(false);
    setVoiceHandlers(null);
    ui.exit();
    stdin.setRawMode(false);
    stdin.pause();
    stdin.off("data", onKey);
  }
}
