#!/usr/bin/env node
/**
 * Dito 打包构建脚本：产出运行时 bundle。
 *
 *   node packaging/build-bundle.mjs
 *     → dist/dito.mjs  (ESM，源码仓库/便携包用，import.meta 原生可用)
 *     → dist/dito.cjs  (CJS，Node SEA 单文件 exe 用；import.meta.url → __filename shim)
 *
 * 数据目录约定：bundle 放在 <包根>/dist/ 下，ROOT_DIR = <包根>
 * （personas/ identities/ system-prompts/ kb/ config/ skills/ extensions/snowluma-actions.json
 *   需与 dist/ 同级放置）。
 * GPL-3.0-only，见仓库 LICENSE。
 */
import { build } from "esbuild";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const common = {
  entryPoints: [join(root, "bin", "dito.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  logLevel: "warning",
  minify: false,
  sourcemap: false,
};

// ── ESM：import.meta 原生保留；banner 提供 CJS require 桥（外部模块动态 require 用）──
await build({
  ...common,
  format: "esm",
  outfile: join(root, "dist", "dito.mjs"),
  banner: {
    js: `import { createRequire as __cjs_require } from "node:module"; const require = __cjs_require(import.meta.url);`,
  },
});

// ── CJS：import.meta.url / dirname 全局替换为 __filename shim（供 SEA 使用）──
await build({
  ...common,
  format: "cjs",
  outfile: join(root, "dist", "dito.cjs"),
  banner: {
    js: [
      `const __dito_import_meta_url = require("url").pathToFileURL(__filename).href;`,
      `const __dito_import_meta_dirname = require("path").dirname(__filename);`,
    ].join("\n"),
  },
  plugins: [
    {
      name: "import-meta-url-shim",
      setup(build) {
        build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
          const fs = await import("node:fs");
          const src = fs.readFileSync(args.path, "utf-8");
          if (!src.includes("import.meta.url") && !src.includes("import.meta.dirname")) return null;
          const code = src
            .replace(/\bimport\.meta\.dirname\b/g, "__dito_import_meta_dirname")
            .replace(/\bimport\.meta\.url\b/g, "__dito_import_meta_url");
          return { contents: code, loader: "default" };
        });
      },
    },
  ],
});

console.log("bundles built: dist/dito.mjs, dist/dito.cjs");
