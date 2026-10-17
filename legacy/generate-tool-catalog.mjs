// Public schemas only. Registration runs with disposable data paths, never user data.
import "./register-loader.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "dito-tool-catalog-"));
process.env.DITO_RESOURCE_DIR = root;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.DITO_USER_DIR = join(scratch, "user");
process.env.DITO_CONFIG_FILE = join(scratch, "config.json");
process.env.DITO_CONFIG_READONLY = "1";
try {
  const { collectTools } = await import("./tool-registry.mjs");
  const actions = JSON.parse(readFileSync(join(root, "extensions/snowluma-actions.json"), "utf8"));
  const readOnly = new Set(actions.filter((action) => action.readOnly).map((action) => `snowluma_${action.tool}`));
  readOnly.add("qq_meme_list");
  const catalog = [];
  for (const group of ["files", "system", "snowluma"]) {
    for (const tool of await collectTools(group, root)) {
      catalog.push({ name: tool.name, description: tool.description, parameters: tool.parameters,
        group, plugin: group === "files" ? null : group,
        host: group !== "system" || tool.name === "get_system_info",
        write: group === "snowluma" && !readOnly.has(tool.name) });
    }
  }
  writeFileSync(join(root, "legacy/tool-catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  console.log(`Generated ${catalog.length} public compatibility tool schemas.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
