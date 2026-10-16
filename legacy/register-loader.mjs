import * as module from "node:module";
import { statSync } from "node:fs";
if (typeof module.registerHooks === "function") {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (error.code !== "ERR_MODULE_NOT_FOUND" || !context.parentURL?.includes("/node_modules/@snowluma/")) throw error;
        const url = new URL(specifier, context.parentURL);
        if (url.protocol !== "file:") throw error;
        for (const suffix of [".js", "/index.js"]) {
          const candidate = new URL(url.href + suffix);
          try { if (statSync(candidate).isFile()) return nextResolve(candidate.href, context); }
          catch { /* Try the directory entry. */ }
        }
        throw error;
      }
    },
  });
} else module.register("./resolve-loader.mjs", import.meta.url);
