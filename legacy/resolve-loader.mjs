// SnowLuma publishes extensionless ESM imports. Resolve just that dependency;
// application code uses ordinary .js imports and needs no transpiler.
import { statSync } from "node:fs";
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || !context.parentURL?.includes("/node_modules/@snowluma/")) throw error;
    let url;
    try { url = new URL(specifier, context.parentURL); } catch { throw error; }
    if (url.protocol !== "file:") throw error;
    for (const suffix of [".js", "/index.js"]) {
      const candidate = new URL(url.href + suffix);
      try {
        if (statSync(candidate).isFile()) return await nextResolve(candidate.href, context);
      } catch { /* Try the other documented ESM suffix. */ }
    }
    throw error;
  }
}
