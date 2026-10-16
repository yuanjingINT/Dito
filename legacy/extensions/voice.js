import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { setVoiceHandlers, setVoiceModeActive } from "./voice-hooks.js";
function expand(path) {
  if (path.startsWith("~")) return join(homedir(), path.slice(1));
  return path;
}
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => stdout += d.toString());
    child.stderr.on("data", (d) => stderr += d.toString());
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
  });
}
function tmpWav() {
  const dir = mkdtempSync(join(tmpdir(), "dito-"));
  return join(dir, "rec.wav");
}
function detectRecorder() {
  const platform = process.platform;
  if (platform === "win32") {
    return existsSync("C:\\ffmpeg\\bin\\ffmpeg.exe") || whichSync("ffmpeg") ? "ffmpeg-dshow" : "";
  }
  if (platform === "darwin") {
    return whichSync("ffmpeg") ? "ffmpeg-avfoundation" : "";
  }
  if (existsSync("/usr/bin/pw-record") || existsSync("/usr/local/bin/pw-record")) return "pw-record";
  if (existsSync("/usr/bin/parec")) return "parec";
  return "arecord";
}
function whichSync(cmd) {
  const pathEnv = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}
function recorderArgs(recorder, out, ms) {
  if (recorder === "pw-record") return ["--rate", "16000", "--channels", "1", "--format", "s16", "--container", "wav", out];
  if (recorder === "parec") return ["--rate=16000", "--channels=1", "--format=s16le", "--file-format=wav", out];
  if (recorder === "ffmpeg-avfoundation") {
    const args = ["-y", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", "-ar", "16000", "-ac", "1"];
    if (ms) args.push("-t", (ms / 1e3).toFixed(2));
    args.push(out);
    return args;
  }
  if (recorder === "ffmpeg-dshow") {
    const args = ["-y", "-loglevel", "error", "-f", "dshow", "-i", `audio=${dshowDevice || "默认设备"}`, "-ar", "16000", "-ac", "1"];
    if (ms) args.push("-t", (ms / 1e3).toFixed(2));
    args.push(out);
    return args;
  }
  return ["-f", "S16_LE", "-r", "16000", "-c", "1", out];
}
let dshowDevice = "";
async function resolveDshowDevice() {
  if (process.platform !== "win32" || dshowDevice) return;
  const r = await run("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]).catch(() => ({ stderr: "" }));
  const m = r.stderr.match(/DirectShow audio devices[^\n]*\n\s+"([^"]+)"/);
  dshowDevice = m?.[1] ?? "";
}
function asksQuestion(text) {
  const t = text.trim();
  return /[？?]$/.test(t) || /要不要|是否|确定吗|可以吗|行吗|你选|你希望|请回答|你决定/.test(t);
}
async function sttWhisper(wav, cfg) {
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
      } catch {
      }
    }
  }
  return "";
}
async function sttXiaomi(wav, cfg) {
  if (!cfg.xiaomiApiKey.trim()) return "";
  const b64 = readFileSync(wav).toString("base64");
  const resp = await fetch(`${cfg.xiaomiBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.xiaomiApiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.xiaomiAsrModel || "mimo-v2.5-asr",
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: b64, format: "wav" } }]
        }
      ]
    }),
    signal: AbortSignal.timeout(6e4)
  });
  if (!resp.ok) {
    console.error("[dito voice] MiMo ASR 失败：HTTP", resp.status);
    return "";
  }
  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}
async function speechToText(wav, cfg) {
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
async function transcribeRemoteAudio(audio, mime, cfg) {
  const dir = mkdtempSync(join(tmpdir(), "dito-voice-"));
  const ext = mime.includes("wav") ? "wav" : mime.includes("webm") ? "webm" : mime.includes("mp4") || mime.includes("aac") ? "m4a" : mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("ogg") ? "ogg" : "bin";
  const src = join(dir, `remote.${ext}`);
  const wav = join(dir, "remote.wav");
  writeFileSync(src, audio);
  try {
    if (ext === "wav") {
      return await speechToText(src, cfg);
    }
    if (ext !== "bin") {
      const conv = await run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", wav]);
      if (conv.code === 0 && existsSync(wav)) {
        return await speechToText(wav, cfg);
      }
    }
    if (ext === "bin") {
      throw new Error(`不支持的音频类型：${mime || "未知"}（且本机没有 ffmpeg 可转码）`);
    }
    return await speechToText(src, cfg);
  } finally {
    try {
      unlinkSync(src);
    } catch {
    }
    try {
      unlinkSync(wav);
    } catch {
    }
  }
}
async function playWav(wav) {
  const player = existsSync("/usr/bin/paplay") ? "paplay" : existsSync("/usr/bin/aplay") ? "aplay" : "pw-play";
  await run(player, [wav]);
}
async function synthEspeak(text, cfg) {
  const out = tmpWav().replace("rec.wav", "tts.wav");
  await run("espeak-ng", ["-v", cfg.espeakVoice || "zh", "-w", out, text]);
  return out;
}
async function synthPiper(text, cfg) {
  const model = expand(cfg.piperModel);
  if (!model || !existsSync(model)) return null;
  const out = tmpWav().replace("rec.wav", "tts.wav");
  const args = ["--model", model, "--output_file", out];
  if (cfg.piperConfig) args.push("--config", expand(cfg.piperConfig));
  await new Promise((resolve) => {
    const child = spawn("piper", args, { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.write(text);
    child.stdin.end();
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  return out;
}
async function synthXiaomi(text, cfg) {
  if (!cfg.xiaomiApiKey.trim()) return null;
  const design = cfg.xiaomiTtsVoiceDesign?.trim();
  const resp = await fetch(`${cfg.xiaomiBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.xiaomiApiKey.trim()}` },
    body: JSON.stringify({
      model: design ? "mimo-v2.5-tts-voicedesign" : cfg.xiaomiTtsModel || "mimo-v2.5-tts",
      modalities: ["text", "audio"],
      audio: design ? { format: "wav" } : { voice: cfg.xiaomiTtsVoice || "冰糖", format: "wav" },
      messages: design ? [
        { role: "user", content: design },
        { role: "assistant", content: text }
      ] : [{ role: "assistant", content: text }]
    }),
    signal: AbortSignal.timeout(12e4)
  });
  if (!resp.ok) {
    console.error("[dito voice] MiMo TTS 失败：HTTP", resp.status);
    return null;
  }
  const json = await resp.json();
  const audio = json.choices?.[0]?.message?.audio;
  if (!audio?.data) return null;
  return { format: audio.format || "wav", base64: audio.data };
}
async function synthesizeSpeech(text, cfg) {
  const clean = text.trim();
  if (!clean) return null;
  let file = null;
  try {
    if (cfg.tts === "xiaomi") {
      const hit = await synthXiaomi(clean, cfg);
      if (!hit) return null;
      return { mime: `audio/${hit.format === "mp3" ? "mpeg" : hit.format}`, audio: Buffer.from(hit.base64, "base64") };
    }
    if (cfg.tts === "piper") file = await synthPiper(clean, cfg);
    else if (cfg.tts !== "custom") file = await synthEspeak(clean, cfg);
    if (!file) return null;
    return { mime: "audio/wav", audio: readFileSync(file) };
  } catch {
    return null;
  } finally {
    if (file) {
      try {
        unlinkSync(file);
      } catch {
      }
    }
  }
}
async function textToSpeech(text, cfg) {
  if (!text.trim()) return;
  try {
    if (cfg.tts === "xiaomi") {
      const hit = await synthXiaomi(text, cfg);
      if (!hit) return;
      const out = tmpWav().replace("rec.wav", `tts.${hit.format}`);
      writeFileSync(out, Buffer.from(hit.base64, "base64"));
      await playWav(out);
      try {
        unlinkSync(out);
      } catch {
      }
      return;
    }
    if (cfg.tts === "piper") {
      const file2 = await synthPiper(text, cfg);
      if (file2) {
        await playWav(file2);
        try {
          unlinkSync(file2);
        } catch {
        }
      }
      return;
    }
    if (cfg.tts === "custom" && cfg.customTtsCommand) {
      await run("bash", ["-c", cfg.customTtsCommand.replace("{text}", text)]);
      return;
    }
    const file = await synthEspeak(text, cfg);
    if (file) {
      await playWav(file);
      try {
        unlinkSync(file);
      } catch {
      }
    }
  } catch {
  }
}
const WAVE = [" ", "░", "▒", "▓", "█", "█"];
function buildFrame(cols, orbRows, orbCol, radius, state, phase) {
  const grid = Array.from({ length: orbRows }, () => new Array(cols).fill(" "));
  const R = radius;
  const centerCol = orbCol;
  const centerRow = orbRows / 2;
  const ampFor = (s) => {
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
        const wave = Math.sin(phase * Math.PI * 2 * 2 + dist);
        const v = Math.max(0, Math.min(0.999, 0.5 + 0.5 * (wave * amp)));
        grid[r][c] = WAVE[Math.floor(v * 5)];
      } else if (dist < R) {
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
  if (state === "speaking") {
    for (let i = 0; i < 3; i++) {
      const progress = (phase * 2 + i / 3) % 1;
      const rippleR = R * 0.3 + progress * (R + 3);
      paintRipple(grid, cols, orbRows, centerCol, centerRow, rippleR, R * 0.2, 1 - progress);
    }
  }
  if (state === "recording") {
    for (let i = 0; i < 3; i++) {
      const progress = (phase + i / 3) % 1;
      const rippleR = R + progress * 4;
      paintRipple(grid, cols, orbRows, centerCol, centerRow, rippleR, R, 1 - progress);
    }
  }
  return grid.map((row) => row.join(""));
}
function paintRipple(grid, cols, orbRows, centerCol, centerRow, rippleR, minDist, brightness) {
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
function advanceCursor(text, cursor, cols, bottom) {
  let { x, y } = cursor;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\x1B") {
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
  state = "idle";
  timer = null;
  start = Date.now();
  cols = process.stdout.columns || 80;
  rows = process.stdout.rows || 24;
  contentTop = 14;
  orbRows = 12;
  orbCol = 40;
  orbRadius = 5;
  cursor = { x: 0, y: 14 };
  enter() {
    process.stdout.write("\x1B[?1049h\x1B[?25l");
    this.layout();
    this.startContent();
    process.on("SIGWINCH", this.onResize);
    this.timer = setInterval(() => this.render(), 66);
  }
  exit() {
    if (this.timer) clearInterval(this.timer);
    process.off("SIGWINCH", this.onResize);
    process.stdout.write("\x1B[r\x1B[?25h\x1B[?1049l");
  }
  setState(s) {
    this.state = s;
  }
  onResize = () => {
    this.layout();
  };
  layout() {
    this.cols = process.stdout.columns || 80;
    this.rows = process.stdout.rows || 24;
    this.contentTop = Math.max(10, Math.min(14, this.rows - 6));
    this.orbRows = Math.max(7, this.contentTop - 2);
    this.orbRadius = Math.max(2, Math.floor(this.orbRows / 2) - 1);
    this.orbCol = Math.floor((this.cols - 1) / 2);
  }
  /** 只重绘圆球区与状态行，保留下方内容区（无全屏清屏，无闪烁）。 */
  render() {
    const phase = (Date.now() - this.start) / 1e3;
    const frame = buildFrame(this.cols, this.orbRows, this.orbCol, this.orbRadius, this.state, phase);
    let out = "";
    for (let r = 0; r < frame.length; r++) {
      out += `\x1B[${r + 1};1H\x1B[2K${frame[r]}`;
    }
    const statusRow = this.orbRows + 1;
    if (statusRow < this.contentTop) {
      const status = this.statusText();
      const col = Math.max(0, this.orbCol - Math.floor(status.length / 2));
      out += `\x1B[${statusRow + 1};1H\x1B[2K\x1B[${statusRow + 1};${col + 1}H\x1B[2m${status}\x1B[0m`;
    }
    process.stdout.write(out);
  }
  idleHint = "按空格跟我说 · q 退出";
  /** 待机提示（配置了唤醒词时由引擎改写） */
  setIdleHint(hint) {
    this.idleHint = hint;
  }
  statusText() {
    switch (this.state) {
      case "idle":
        return this.idleHint;
      case "recording":
        return "听着呢… 空格键收声";
      case "thinking":
        return "让我想想…";
      case "speaking":
        return "我在说…";
    }
  }
  /** 清空内容区并复位光标。 */
  startContent() {
    this.layout();
    this.cursor = { x: 0, y: this.contentTop };
    let out = "";
    for (let row = this.contentTop; row < this.rows; row++) {
      out += `\x1B[${row + 1};1H\x1B[2K`;
    }
    out += `\x1B[${this.contentTop + 1};1H`;
    process.stdout.write(out);
  }
  /** 把流式内容写入下方内容区（滚动区域），并推进光标。 */
  renderContent(text) {
    if (!text) return;
    const regionTop = Math.min(this.contentTop + 1, this.rows);
    const cursor = {
      x: Math.min(this.cursor.x, this.cols - 1),
      y: Math.max(this.contentTop, Math.min(this.cursor.y, this.rows - 1))
    };
    let out = `\x1B[${regionTop};${this.rows}r`;
    out += `\x1B[${cursor.y + 1};${cursor.x + 1}H`;
    out += text;
    out += "\x1B[r";
    process.stdout.write(out);
    this.cursor = advanceCursor(text, cursor, this.cols, this.rows - 1);
  }
}
async function runVoiceMode(session, cfg) {
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
  const onKey = (buf) => {
    const s = buf.toString();
    if (s === " " || s === "\r" || s === "\n") stopRequested = true;
    if (s === "q" || s === "Q" || s === "\x1B") quitRequested = true;
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onKey);
  const recorder = detectRecorder();
  if (recorder === "ffmpeg-dshow") {
    await resolveDshowDevice();
  }
  const wakeWords = (cfg.wakeWord ?? "").split(/[,，\s]+/).map((w) => w.trim()).filter(Boolean);
  if (wakeWords.length > 0) {
    ui.setIdleHint(`说 ${wakeWords.join(" / ")} 唤醒 · 空格也可以 · q 退出`);
  }
  async function waitForWake() {
    if (wakeWords.length === 0) {
      await waitForSpace();
      return;
    }
    stopRequested = false;
    ui.setState("idle");
    while (!quitRequested) {
      if (stopRequested) {
        stopRequested = false;
        return;
      }
      const wav = await record(2500);
      if (quitRequested) return;
      const heard = await sttWhisper(wav, cfg);
      try {
        unlinkSync(wav);
      } catch {
      }
      if (heard && wakeWords.some((w) => heard.toLowerCase().includes(w.toLowerCase()))) {
        ui.setState("idle");
        await textToSpeech("在的啊", cfg).catch(() => {
        });
        return;
      }
    }
  }
  function record(ms) {
    const out = tmpWav();
    if (!recorder) {
      return Promise.reject(new Error("没有可用的音频录制器：请安装 ffmpeg（Windows/macOS）或 pw-record/parec/arecord（Linux）"));
    }
    const child = spawn(recorder, recorderArgs(recorder, out, ms ?? cfg.maxRecordSeconds * 1e3));
    stopRequested = false;
    ui.setState("recording");
    const begin = Date.now();
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        const over = Date.now() - begin > (ms ?? cfg.maxRecordSeconds * 1e3);
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
  function waitForSpace() {
    ui.setState("idle");
    stopRequested = false;
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (stopRequested || quitRequested) {
          clearInterval(poll);
          resolve();
        }
      }, 60);
    });
  }
  async function listenOnce() {
    const wav = await record();
    ui.setState("thinking");
    const text = await speechToText(wav, cfg);
    try {
      unlinkSync(wav);
    } catch {
    }
    return text;
  }
  const askAndRecord = async (q) => {
    ui.setState("speaking");
    await textToSpeech(q, cfg);
    return listenOnce();
  };
  const confirmAndRecord = async (q) => {
    const ans = await askAndRecord(q);
    return /确认|可以|是|好|继续|执行|确定|没问题|yes|ok|行/i.test(ans);
  };
  setVoiceHandlers({ ask: askAndRecord, confirm: confirmAndRecord });
  let currentText = "";
  session.subscribe((event) => {
    const e = event;
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      currentText += e.assistantMessageEvent.delta ?? "";
      ui.renderContent(e.assistantMessageEvent.delta ?? "");
    } else if (e.type === "tool_execution_start") {
      ui.renderContent(`\x1B[90m〔工具：${e.toolName}〕\x1B[0m
`);
    }
  });
  try {
    let autoContinue = false;
    while (!quitRequested) {
      if (!autoContinue) {
        await waitForWake();
        if (quitRequested) break;
      }
      autoContinue = false;
      const text = await listenOnce();
      if (quitRequested) break;
      if (!text.trim()) continue;
      ui.renderContent(`\x1B[36m你：${text.trim()}\x1B[0m
`);
      ui.setState("thinking");
      currentText = "";
      ui.renderContent("\x1B[35m蒂特：\x1B[0m");
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
export {
  detectRecorder,
  expand,
  runVoiceMode,
  synthesizeSpeech,
  transcribeRemoteAudio
};
