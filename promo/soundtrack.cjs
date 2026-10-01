#!/usr/bin/env node
/* dito 宣传片 — 程序化配乐（48kHz 立体声 WAV，57s）
 * 结构：环境合成器垫（Am9 → Fmaj7 → Cmaj7 → Gadd9 循环）
 *      + 低频心跳脉冲 + 打字键击（对齐打字窗口）
 *      + dito 回复「啵」声 + 转场风声 + 落版铃音
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SR = 48000, DUR = 57.0, N = Math.round(SR * DUR);
const L = new Float64Array(N), R = new Float64Array(N);

const TAU = Math.PI * 2;
function addSample(i, gl, gr) { if (i >= 0 && i < N) { L[i] += gl; R[i] += gr; } }

/* ---------- 和弦垫 ---------- */
const CHORDS = [
  [110.0, 164.81, 261.63, 392.0, 493.88],   // Am9
  [87.31, 130.81, 220.0, 329.63],           // Fmaj7
  [130.81, 196.0, 329.63, 493.88],          // Cmaj7
  [98.0, 146.83, 246.94, 440.0],            // Gadd9
];
const CD = DUR / 8; // 每个和弦 7.125s，共 8 段
for (let k = 0; k < 8; k++) {
  const chord = CHORDS[k % 4];
  const start = k * CD - 0.6, end = (k + 1) * CD + 1.4; // 交叠
  const i0 = Math.max(0, Math.round(start * SR)), i1 = Math.min(N, Math.round(end * SR));
  chord.forEach((f, vi) => {
    const det = 1 + (vi % 2 ? 0.0012 : -0.0012);
    const pan = vi % 2 === 0 ? -0.4 : 0.4;
    const base = 0.042 * (1.25 - vi * 0.12);
    const ph = vi * 1.7 + k;
    for (let i = i0; i < i1; i++) {
      const t = i / SR;
      // 包络：慢起慢落
      const a = Math.min(1, (t - start) / 2.2, (end - t) / 2.4);
      const env = a * a * (3 - 2 * a); // smoothstep
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
for (let bt = 0.8; bt < DUR - 3; bt += 3.5) {
  const i0 = Math.round(bt * SR), len = Math.round(0.9 * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const env = Math.exp(-t / 0.32);
    const v = Math.sin(TAU * 55 * t) * 0.085 * env;
    addSample(i0 + j, v, v);
  }
}

/* ---------- 打字键击（与画面打字窗口对齐） ---------- */
const TYPE_WINDOWS = [
  [0.9, 2.55],    // S0 systemctl
  [8.4, 9.9],     // S1 pacman -Syu dito
  [12.1, 13.1],   // S1 dito --hello
  [40.3, 41.7],   // S4 step1
  [42.2, 43.9],   // S4 step2
  [44.8, 45.8],   // S4 step3
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

/* ---------- dito 回复「啵」声 ---------- */
const POPS = [13.4, 30.95, 32.95, 35.55, 46.0];
for (const pt of POPS) {
  const i0 = Math.round(pt * SR), len = Math.round(0.22 * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const f = 520 + 300 * Math.min(1, t / 0.09);
    const env = Math.exp(-t / 0.07) * Math.min(1, t / 0.008);
    const v = Math.sin(TAU * f * t) * 0.11 * env;
    addSample(i0 + j, v * 0.55, v * 0.55);
  }
}

/* ---------- 转场风声 ---------- */
const SCENE_CUTS = [5.4, 15.4, 28.2, 38.8, 47.0, 52.6];
let prevNoise = 0;
for (const ct of SCENE_CUTS) {
  const i0 = Math.round((ct - 0.45) * SR), len = Math.round(1.3 * SR);
  let lp = 0;
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const w = Math.sin(Math.PI * t / 1.3) ** 2;
    const noise = rnd() * 2 - 1;
    lp += 0.06 * (noise - lp); // 低通
    const hp = noise - lp;     // 高频分量
    const v = (lp * 0.55 + hp * 0.2) * w * 0.12;
    addSample(i0 + j, v * 0.6, v * 0.5);
  }
  prevNoise = 0;
}

/* ---------- 落版铃音 ---------- */
for (const [bt, f, g] of [[52.95, 880, 0.1], [52.95, 1318.5, 0.05], [53.35, 1760, 0.045]]) {
  const i0 = Math.round(bt * SR), len = Math.round(2.2 * SR);
  for (let j = 0; j < len; j++) {
    const t = j / SR;
    const env = Math.exp(-t / 0.7) * Math.min(1, t / 0.006);
    const v = (Math.sin(TAU * f * t) + 0.35 * Math.sin(TAU * f * 2 * t)) * g * env;
    addSample(i0 + j, v * 0.6, v * 0.45);
  }
}

/* ---------- 总线：软限幅、淡入淡出、归一化 ---------- */
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
const out = path.resolve(__dirname, "soundtrack.wav");
fs.writeFileSync(out, buf);
console.log(`soundtrack: ${out} (${(N / SR).toFixed(1)}s, peak ${(peak * g).toFixed(2)})`);
