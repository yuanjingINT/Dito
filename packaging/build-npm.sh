#!/usr/bin/env bash
# Dito NPM 打包脚本：组装 dito-agent npm 包树 → 模块冒烟 → 生成 tarball。
# 用法：./packaging/build-npm.sh          # 产物 dist/<name>-<version>.tgz
#       ./packaging/build-npm.sh --publish  # 冒烟通过后直接 npm publish --tag preview
# 包名与描述取自 packaging/npm-dist/package.json；版本取自根 package.json。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NPM_NAME="$(node -p "require('$ROOT/packaging/npm-dist/package.json').name")"
NPM_DESC="$(node -p "require('$ROOT/packaging/npm-dist/package.json').description")"
OUT="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT"
PKG="$STAGE/$NPM_NAME"
mkdir -p "$PKG/docs"

# ── 组装发布树 ──────────────────────────────────────────────
# 私有数据不入包：kb/ 混有个人笔记，docs/ 含私人聊天存档（只带 protocol.md）。
cp -a bin extensions relay personas identities system-prompts skills config "$PKG"/
cp -a docs/protocol.md "$PKG/docs/"
cp -a LICENSE NOTICE README.md "$PKG"/

# package.json：主体用根配置，包名/描述用 npm 发布版；打包树已组装好，去掉 files 白名单
node -e '
  const fs = require("node:fs");
  const root = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
  root.name = process.argv[2];
  root.description = process.argv[3];
  delete root.files;
  fs.writeFileSync(process.argv[4], JSON.stringify(root, null, 2) + "\n");
' "$ROOT/package.json" "$NPM_NAME" "$NPM_DESC" "$PKG/package.json"
# 嵌套 node_modules（如 relay/node_modules）：依赖由包根统一提供，体积冗余剔除
find "$PKG" -name node_modules -prune -exec rm -rf {} +

# ── 冒烟：装生产依赖 + 与 CI 相同的模块加载检查 ──────────────
(cd "$PKG" && npm install --omit=dev --no-audit --no-fund --silent)
(cd "$PKG" && node --import tsx -e "Promise.all([import('./bin/dito.ts'),import('./bin/mobile.ts'),import('./bin/mcp-server.ts'),import('./bin/doctor.ts'),import('./relay/server.mjs')]).then(()=>console.log('[build-npm] modules OK')).catch(e=>{console.error(e);process.exit(1)})")

if [[ "${1:-}" == "--publish" ]]; then
  npm publish "$PKG" --tag preview
  echo "[build-npm] 已发布：$NPM_NAME@$VERSION（tag: preview）"
else
  npm pack "$PKG" --pack-destination "$OUT" >/dev/null
  echo "[build-npm] 完成：$OUT/$NPM_NAME-$VERSION.tgz（加 --publish 直接发布）"
fi
