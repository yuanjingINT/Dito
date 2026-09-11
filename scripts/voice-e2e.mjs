import WebSocket from "ws";
import { readFileSync } from "node:fs";
const [pairUrl] = process.argv.slice(2);
const u = new URL(pairUrl);
const base = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`;
const room = u.pathname.split("/").pop();
const k = u.searchParams.get("k");
const ws = new WebSocket(`${base}/ws/${room}?pair=${k}`);
let deviceToken = "", turnId = "", buf = "";
const timer = setTimeout(() => { console.log("[voice] 超时"); process.exit(4); }, 120000);
ws.on("open", () => ws.send(JSON.stringify({ type: "pair.hello", name: "voice-test", platform: "test" })));
ws.on("message", async (d) => {
  const m = JSON.parse(String(d));
  if (m.type === "pair.ok") {
    deviceToken = m.deviceToken;
    console.log("[voice] 已配对");
    turnId = crypto.randomUUID();
    const b64 = readFileSync("/tmp/voice-test.wav").toString("base64");
    console.log("[voice] 发送语音消息（wav", Math.round(b64.length / 1024), "KB）");
    ws.send(JSON.stringify({ type: "chat.voice", id: turnId, mime: "audio/wav", audioB64: b64 }));
  } else if (m.type === "chat.tool") {
    console.log("[voice] ⚙", m.name, m.argsShort);
  } else if (m.type === "chat.delta") {
    buf += m.delta ?? "";
  } else if (m.type === "chat.end") {
    console.log("[voice] ✓ 回复：", (m.text || buf).trim());
    clearTimeout(timer); process.exit(0);
  } else if (m.type === "chat.error") {
    console.log("[voice] ✗ 错误：", m.message);
    clearTimeout(timer); process.exit(5);
  }
});
