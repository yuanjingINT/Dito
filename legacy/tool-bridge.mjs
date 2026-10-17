import { readFileSync } from "node:fs";
import { dirname } from "node:path";
const payload = JSON.parse(readFileSync(process.argv[3], "utf8"));
process.env.DITO_RESOURCE_DIR = payload.resource;
process.env.DITO_CONFIG_FILE = payload.config;
process.env.PI_CODING_AGENT_DIR = dirname(payload.dataDir);
process.env.DITO_USER_DIR = payload.userDir;
process.env.DITO_CONFIG_READONLY = "1";
async function run() {
  const catalog = JSON.parse(readFileSync(new URL("./tool-catalog.json", import.meta.url), "utf8"));
  const item = catalog.find((tool) => tool.name === payload.name);
  if (!item) throw new Error("未注册的兼容工具");
  const { loadConfig } = await import("./extensions/util.js");
  const cfg = loadConfig();
  if (item.plugin && cfg.plugins[item.plugin]?.enabled === false) throw new Error("该插件已关闭");
  if (item.group === "snowluma" && !cfg.channels.qq.enabled) throw new Error("QQ 频道未启用");
  const { collectTools } = await import("./tool-registry.mjs");
  const tool = (await collectTools(item.group)).find((definition) => definition.name === payload.name);
  if (!tool) throw new Error("当前平台未注册该工具");
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    setTimeout(() => process.exit(130), 500).unref();
  };
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const result = await tool.execute("native-compat", payload.args, controller.signal, undefined,
    { cwd: process.cwd(), hasUI: false });
  const text = Buffer.from((result.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n"));
  let end = Math.min(text.length, 96 * 1024);
  while (end < text.length && end > 0 && (text[end] & 0xc0) === 0x80) end--;
  await new Promise((resolve) => process.stdout.write(text.subarray(0, end).toString("utf8") +
    (end < text.length ? "\n[后续工具输出已省略]" : "") + "\n", resolve));
  // QQ sockets and SDK handles must not keep a completed one-shot call alive.
  return result.isError || result.details?.isError || result.details?.ok === false ? 1 : 0;
}
try {
  process.exit(await run());
} catch (error) {
  await new Promise((resolve) => process.stderr.write((error?.message || String(error)) + "\n", resolve));
  process.exit(1);
}
