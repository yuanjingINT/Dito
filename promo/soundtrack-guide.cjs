#!/usr/bin/env node
/* dito 使用说明视频 — 程序化配乐（48kHz 立体声 WAV，204s）
 * 与 guide.html 时间轴对齐：打字键击 / 回复啵声 / 章节转场风声 / 落版铃音
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SR = 48000, DUR = 204.0, N = Math.round(SR * DUR);
const L = new Float64Array(N), R = new Float64Array(N);
const TAU = Math.PI * 2;
function addSample(i, gl, gr) { if (i >= 0 && i < N) { L[i] += gl; R[i] += gr; } }

/* ---------- 和弦垫（Am9 → Fmaj7 → Cmaj7 → Gadd9 循环） ---------- */
const CHORDS = [
  [110.0, 164.81, 261.63, 392.0, 493.88],
  [87.31, 130.81, 220.0, 329.63],
  [130.81, 196.0, 329.63, 493.88],
  [98.0, 146.83, 246.94, 440.0],
];
const CD = 7.0;
const NCH = Math.ceil(DUR / CD);
for (let k = 0; k < NCH; k++) {
  const chord = CHORDS[k % 4];
  const start = k * CD - 0.6, end = (k + 1) * CD + 1.4;
  const i0 = Math.max(0, Math.round(start * SR)), i1 = Math.min(N, Math.round(end * SR));
  chord.forEach((f, vi) => {
    const det = 1 + (vi % 2 ? 0.0012 : -0.0012);
    const pan = vi % 2 === 0 ? -0.4 : 0.4;
    const base = 0.042 * (1.25 - vi * 0.12);
    const ph = vi * 1.7 + k;
    for (let i = i0; i < i1; i++) {
      const t = i / SR;
      const a = Math.min(1, (t - start) / 2.2, (end - t) / 2.4);
      const env = a * a * (3 - 2 * a);
      const shim = 0.82 + 0.18 * Math.sin(TAU * 0.13 * t + ph);
      const s =
        Math.sin(TAU * f * det * t) * 0.62 +
        Math.sin(TAU * f * 2 * 1.003 * t + 0.5) * 0.24 +
        Math.sin(TAU * f * 3 * 0.997 * t + 1.1) * 0.09;
      const v = s * base * env * shim;
      addSample(i, v * (0.5 - pan * 0.5), v * (0.5 + pan * 0.5));
    }
  });
}

/* ---------- 低频心跳 ---------- */
for (let bt = 0.8; bt < DUR - 4; bt += 3.5) {
  const i0 = Math.round(bt * SR), len = Math.round(0.9 * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const v = Math.sin(TAU * 55 * t) * 0.085 * Math.exp(-t / 0.32);
    addSample(i0 + j, v, v);
  }
}

/* ---------- 打字键击 ---------- */
const TYPE_WINDOWS = [
  [0.9, 1.8],       // 片头 dito --help
  [9.4, 11.0],      // npm i -g dito
  [13.0, 14.0],     // dito doctor
  [39.2, 41.6],     // dito "帮我看看哪些包能升级"
  [45.2, 45.8],     // dito
  [81.0, 82.0],     // dito voice
  [103.0, 104.4],   // dito qq
  [112.4, 114.2],   // qqadmin URL
  [133.2, 134.6],   // dito matrix
  [151.2, 152.6],   // dito mobile
  [173.2, 174.4],   // dito mcp
  [180.6, 182.6],   // systemctl
];
let seed = 987654321;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (const [w0, w1] of TYPE_WINDOWS) {
  let ct = w0 + rnd() * 0.03;
  while (ct < w1) {
    const i0 = Math.round(ct * SR);
    const len = Math.round(0.009 * SR);
    const g = 0.028 + rnd() * 0.03;
    for (let j = 0; j < len; j++) {
      const t = j / SR;
      const env = Math.exp(-t / 0.0016);
      const noise = (rnd() * 2 - 1);
      const tick = Math.sin(TAU * (1700 + rnd() * 500) * t);
      const v = (noise * 0.7 + tick * 0.5) * env * g;
      const p = rnd() * 0.3;
      addSample(i0 + j, v * (0.5 - p * 0.4), v * (0.5 + p * 0.4));
    }
    ct += 0.055 + rnd() * 0.05;
  }
}

/* ---------- 回复/事件「啵」声 ---------- */
const POPS = [43.0, 51.8, 60.6, 104.8, 105.6, 106.4, 135.0, 135.8, 153.0, 161.2, 174.8, 183.2];
for (const pt of POPS) {
  const i0 = Math.round(pt * SR), len = Math.round(0.22 * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const f = 520 + 300 * Math.min(1, t / 0.09);
    const env = Math.exp(-t / 0.07) * Math.min(1, t / 0.008);
    const v = Math.sin(TAU * f * t) * 0.1 * env;
    addSample(i0 + j, v * 0.55, v * 0.55);
  }
}

/* ---------- 章节转场风声 ---------- */
const SCENE_CUTS = [6, 36, 78, 100, 130, 148, 170, 192];
for (const ct of SCENE_CUTS) {
  const i0 = Math.round((ct - 0.45) * SR), len = Math.round(1.3 * SR);
  let lp = 0;
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const w = Math.sin(Math.PI * t / 1.3) ** 2;
    const noise = rnd() * 2 - 1;
    lp += 0.06 * (noise - lp);
    const hp = noise - lp;
    const v = (lp * 0.55 + hp * 0.2) * w * 0.12;
    addSample(i0 + j, v * 0.6, v * 0.5);
  }
}

/* ---------- 落版铃音 ---------- */
for (const [bt, f, g] of [[195.8, 880, 0.1], [195.8, 1318.5, 0.05], [196.2, 1760, 0.045]]) {
  const i0 = Math.round(bt * SR), len = Math.round(2.4 * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const env = Math.exp(-t / 0.7) * Math.min(1, t / 0.006);
    const v = (Math.sin(TAU * f * t) + 0.35 * Math.sin(TAU * f * 2 * t)) * g * env;
    addSample(i0 + j, v * 0.6, v * 0.45);
  }
}

/* ---------- 总线 ---------- */
let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.1);
  R[i] = Math.tanh(R[i] * 1.1);
  const fin = Math.min(1, (i / SR) / 1.6);
  const fout = Math.min(1, (DUR - i / SR) / 2.6);
  L[i] *= fin * fout; R[i] *= fin * fout;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const g = 0.82 / peak;
for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; }

/* ---------- 写 WAV ---------- */
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
}
const out = path.resolve(__dirname, "soundtrack-guide.wav");
fs.writeFileSync(out, buf);
console.log(`soundtrack-guide: ${out} (${(N / SR).toFixed(1)}s, peak ${(peak * g).toFixed(2)})`);
