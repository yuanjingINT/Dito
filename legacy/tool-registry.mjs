// Collect definitions without starting a model, channel, or full legacy session.
export async function collectTools(group, cwd = process.cwd()) {
  const tools = [];
  const pi = { registerTool: (tool) => tools.push(tool), on() {}, registerCommand() {} };
  if (group === "files") {
    const sdk = await import("@earendil-works/pi-coding-agent");
    for (const name of ["Grep", "Find", "Ls"]) tools.push(sdk[`create${name}ToolDefinition`](cwd));
  } else if (group === "system") {
    (await import("./extensions/system.js")).default(pi);
  } else if (group === "snowluma") {
    (await import("./extensions/snowluma-tools.js")).createSnowLumaToolsExtension()(pi);
    const { qqToolsExtension } = await import("./bin/qq.js");
    const { Affinity } = await import("./bin/affinity.js");
    const { ditoChannelDir } = await import("./extensions/util.js");
    const { join } = await import("node:path");
    qqToolsExtension(null, new Affinity(join(ditoChannelDir("qq"), "affinity.json")), null)({
      registerTool: (tool) => { if (tool.name === "qq_affinity") tools.push(tool); }
    });
  } else throw new Error("未知兼容工具组");
  return tools;
}
