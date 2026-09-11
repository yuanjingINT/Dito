#!/usr/bin/env node
/**
 * 模拟手机客户端：验证「扫码 → 配对 → 流式对话」全链路。
 *
 * 用法：
 *   node scripts/simulate-phone.mjs "<配对URL>" [--text "消息"] [--name 名称]
 *   node scripts/simulate-phone.mjs --reconnect <wss基址> <room> <deviceToken> [--text "消息"]
 *
 * 配对 URL 来自 `dito mobile` 终端二维码下方打印的地址。
 * 需要电脑端允许配对（终端 y/n 或配置 channels.mobile.autoApprove）。
 */
import WebSocket from "ws";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

let base, room, pairToken, deviceToken;
if (has("--reconnect")) {
  base = argv[argv.indexOf("--reconnect") + 1];
  room = argv[argv.indexOf("--reconnect") + 2];
  deviceToken = argv[argv.indexOf("--reconnect") + 3];
  if (!base || !room || !deviceToken) {
    console.error("用法：--reconnect <wss基址> <room> <deviceToken>");
    process.exit(2);
  }
} else {
  const url = argv.find((a) => a.includes("/p/"));
  if (!url) {
    console.error('用法：node scripts/simulate-phone.mjs "<配对URL>" [--text 消息]');
    process.exit(2);
  }
  const u = new URL(url);
  base = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`;
  room = u.pathname.split("/").pop();
  pairToken = u.searchParams.get("k");
  if (!pairToken) {
    console.error("配对 URL 缺少 k 参数");
    process.exit(2);
  }
}

const text = arg("--text", "你好，用一句话介绍你自己");
const name = arg("--name", "模拟手机");
const wsUrl = `${base}/ws/${room}${deviceToken ? `?device=${deviceToken}` : `?pair=${pairToken}`}`;
console.log(`[sim] 连接 ${wsUrl.replace(/(\?pair=|\?device=)(.{8}).*/, "$1$2…")}`);

const ws = new WebSocket(wsUrl);
let turnId = null;
let buf = "";
let done = false;

const timer = setTimeout(() => {
  console.error("[sim] 超时（120s）退出");
  process.exit(4);
}, 120_000);

function send(obj) {
  ws.send(JSON.stringify(obj));
}

ws.on("open", () => {
  console.log("[sim] WS 已连接");
  if (!deviceToken) send({ type: "pair.hello", name, platform: "linux-test" });
  else {
    console.log("[sim] 以已配对设备身份重连");
    sendChat();
  }
});

function sendChat() {
  turnId = globalThis.crypto.randomUUID();
  console.log(`[sim] 发送：${text}`);
  send({ type: "chat.user", id: turnId, text });
}

ws.on("message", (data) => {
  let m;
  try { m = JSON.parse(String(data)); } catch { return; }
  switch (m.type) {
    case "pair.ok":
      console.log(`[sim] ✓ 配对成功，deviceToken=${m.deviceToken}`);
      sendChat();
      break;
    case "pair.rejected":
      console.error("[sim] 电脑端拒绝了配对");
      process.exit(5);
      break;
    case "device.ok":
      break;
    case "replaced":
      console.log("[sim] 本连接被顶替");
      break;
    case "host.lost":
      console.error("[sim] 电脑端掉线");
      process.exit(6);
      break;
    case "chat.delta":
      buf += m.delta ?? "";
      break;
    case "chat.tool":
      console.log(`[sim] ⚙ ${m.name} ${m.argsShort ?? ""}`);
      break;
    case "chat.error":
      console.error(`[sim] 对话出错：${m.message}`);
      finish(7);
      break;
    case "chat.end":
      console.log(`[sim] ✓ 回复完整文本：\n${m.text ?? buf}`);
      finish(0);
      break;
    default:
      break;
  }
});

ws.on("close", (code, reason) => {
  if (!done) console.error(`[sim] 连接关闭：${code} ${reason}`);
});

function finish(code) {
  done = true;
  clearTimeout(timer);
  ws.close();
  setTimeout(() => process.exit(code), 200);
}
