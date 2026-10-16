// Prepare the one required native crypto dependency, then verify it loads.
// Never enables unrelated package install scripts.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const name = "@matrix-org/matrix-sdk-crypto-nodejs";
try { require(name); }
catch {
  const folder = dirname(require.resolve(`${name}/package.json`));
  const result = spawnSync(process.execPath, [join(folder, "download-lib.js")], { stdio: "inherit", cwd: folder });
  if (result.status !== 0 || result.error) process.exit(1);
  // Some upstream download failures exit with 0, so require is the real check.
  require(name);
}
console.log("Matrix crypto dependency loads successfully.");
