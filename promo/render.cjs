#!/usr/bin/env node
/* dito 宣传片 — CDP 逐帧渲染器
 * 用无头 Chrome 打开 index.html，逐帧调用 window.__render(t) 并截图 PNG。
 * 3 个标签页并行，帧按 worker 取模分配。
 */
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const FPS = 30;
const HTML = path.resolve(__dirname, process.argv[2] || "index.html");
const OUT_DIR = process.argv[3] || "/tmp/dito-promo-frames";
const DUR = parseFloat(process.argv[4] || "57.0");
const TOTAL = Math.round(DUR * FPS);
const WORKERS = 3;
const PORT = 9333;

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------- 启动 Chrome ---------- */
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "dito-cdp-"));
const chrome = spawn("google-chrome-stable", [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  "--no-first-run", "--no-default-browser-check",
  "--mute-audio", "--hide-scrollbars",
  "--force-device-scale-factor=1", "--force-color-profile=srgb",
  "--disable-dev-shm-usage",
  "--window-size=1920,1080",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

let chromeGone = false;
chrome.on("exit", (c) => { chromeGone = true; console.error(`[chrome] exited ${c}`); });
function cleanup() {
  try { chrome.kill("SIGKILL"); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
process.on("SIGINT", () => { cleanup(); process.exit(130); });

/* ---------- 等待 DevTools 端口 ---------- */
async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    if (chromeGone) throw new Error("chrome died");
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("devtools endpoint never came up");
}

/* ---------- 极简 CDP 客户端 ---------- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  onEvent(fn) { this.handlers.push(fn); }
}

/* ---------- 单个渲染 worker（一个标签页） ---------- */
async function worker(cdp, idx) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const loaded = new Promise((resolve) => {
    cdp.onEvent((m) => {
      if (m.method === "Page.loadEventFired" && m.sessionId === sessionId) resolve();
    });
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send("Page.navigate", { url: "file://" + HTML }, sessionId);
  await loaded;
  // 等字体就绪
  for (let i = 0; i < 40; i++) {
    const r = await cdp.send("Runtime.evaluate",
      { expression: "window.__ready instanceof Promise ? 'pending' : 'no'", returnByValue: true }, sessionId);
    await cdp.send("Runtime.evaluate",
      { expression: "window.__ready && window.__ready.then && Promise.race([window.__ready, new Promise(r=>setTimeout(r,50))])", returnByValue: true }, sessionId);
    const done = await cdp.send("Runtime.evaluate",
      { expression: "document.fonts.status", returnByValue: true }, sessionId);
    if (done.result.value === "loaded") break;
  }
  let count = 0;
  for (let i = idx; i < TOTAL; i += WORKERS) {
    if (chromeGone) throw new Error("chrome died mid-render");
    const t = i / FPS;
    await cdp.send("Runtime.evaluate",
      { expression: `window.__render(${t.toFixed(5)})`, returnByValue: true }, sessionId);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true }, sessionId);
    fs.writeFileSync(path.join(OUT_DIR, `f${String(i).padStart(5, "0")}.png`),
      Buffer.from(shot.data, "base64"));
    count++;
    if (count % 60 === 0) {
      console.log(`[w${idx}] ${count} frames (frame ${i}/${TOTAL})`);
    }
  }
  await cdp.send("Target.closeTarget", { targetId });
  console.log(`[w${idx}] done: ${count} frames`);
}

(async () => {
  const t0 = Date.now();
  const wsUrl = await waitForDevtools();
  console.log("devtools:", wsUrl);
  const cdp = await CDP.connect(wsUrl);
  console.log(`rendering ${TOTAL} frames with ${WORKERS} workers -> ${OUT_DIR}`);
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(cdp, i)));
  cleanup();
  console.log(`all done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
