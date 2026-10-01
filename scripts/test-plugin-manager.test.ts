import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_CATALOG,
  applyPluginSelection,
  ensurePluginInstallation,
  initialPluginSelection,
  normalizePluginSelection,
} from "../bin/plugin-manager.js";
import { defaultConfig, loadConfig } from "../extensions/util.js";

const root = mkdtempSync(join(tmpdir(), "dito-plugin-manager-"));
process.env.PI_CODING_AGENT_DIR = root;
const cfg = defaultConfig();
const initial = initialPluginSelection(cfg);
assert.ok(initial.includes("tui"));
assert.ok(initial.includes("provider"));
assert.ok(!initial.includes("qq"));
assert.ok(!initial.includes("matrix"));
assert.ok(!initial.includes("snowluma"));

const bridgeSelection = normalizePluginSelection(["bridge"]);
assert.ok(bridgeSelection.has("bridge"));
assert.ok(bridgeSelection.has("qq"));
assert.ok(bridgeSelection.has("matrix"));
assert.ok(bridgeSelection.has("snowluma"));

const installed = applyPluginSelection(cfg, ["bridge"]);
assert.deepEqual(installed, PLUGIN_CATALOG.filter((p) => bridgeSelection.has(p.id)).map((p) => p.id));
assert.equal(cfg.channels.qq.enabled, true);
assert.equal(cfg.channels.matrix.enabled, true);
assert.equal(cfg.channels.mobile.enabled, false);
assert.equal(cfg.plugins.snowluma.enabled, true);
assert.equal(cfg.plugins.manager.initialized, true);
assert.ok(cfg.plugins.manager.installed.includes("bridge"));

try {
  const result = await ensurePluginInstallation({ interactive: false });
  assert.equal(result.firstRun, true);
  assert.equal(result.cancelled, false);
  assert.equal(loadConfig().plugins.manager.initialized, true);
  assert.ok(loadConfig().plugins.manager.installed.includes("provider"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("plugin manager tests passed");
