import { readFileSync } from "node:fs";
import { dirname } from "node:path";
const payload = JSON.parse(readFileSync(process.argv[3], "utf8"));
process.env.DITO_RESOURCE_DIR = payload.resource;
process.env.DITO_CONFIG_FILE = payload.config;
process.env.PI_CODING_AGENT_DIR = dirname(payload.dataDir);
process.env.DITO_USER_DIR = payload.userDir;
const { createSession } = await import("./bin/session.js");
const { loadConfig } = await import("./extensions/util.js");
const { default: registerSubagent } = await import("./extensions/subagent.js");
const { session } = await createSession({ ephemeral: true, memoryScope: payload.scope || undefined });
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
try {
  let definition;
  registerSubagent({ registerTool: (tool) => { definition = tool; }, on() {} }, loadConfig().plugins.subagent);
  const models = await session.modelRuntime.getAvailable();
  let previous = "", lastProgress = 0, progressBytes = 0;
  const result = await definition.execute("native-compat", payload.args, controller.signal,
    (update) => {
      const results = update?.details?.results || [];
      const counts = new Map();
      for (const item of results) counts.set(item.state, (counts.get(item.state) || 0) + 1);
      const summary = [...counts].map(([state, count]) => `${state}: ${count}`).join(" | ");
      if (summary !== previous && Date.now() - lastProgress >= 120 && progressBytes < 8192) {
        console.log(summary);
        progressBytes += Buffer.byteLength(summary + "\n");
        previous = summary;
        lastProgress = Date.now();
      }
    }, { cwd: process.cwd(), hasUI: false, modelRegistry: { getAvailable: () => models } });
  const text = Buffer.from((result.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n"));
  let end = Math.min(text.length, 96 * 1024);
  while (end < text.length && end > 0 && (text[end] & 0xc0) === 0x80) end--;
  await new Promise((resolve) => process.stdout.write(text.subarray(0, end).toString("utf8") +
    (end < text.length ? "\n[后续子代理输出已省略]" : "") + "\n", resolve));
  process.exitCode = result.isError || result.details?.isError ? 1 : 0;
} finally {
  session.dispose();
}
// Provider/MCP handles may stay alive; all requested subagent workers have settled.
process.exit(process.exitCode || 0);
