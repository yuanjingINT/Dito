#!/usr/bin/env bash
# Dito RPM 打包脚本：生成源码包并调用 rpmbuild 构建 .rpm。
# 用法：./packaging/build.sh [--srpm-only]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="dito"
VERSION="$(node -p "require('$ROOT/package.json').version")"
RPMBUILD="${RPMBUILD_DIR:-$HOME/rpmbuild}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$RPMBUILD"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}

# ── 先在本地生成加密提示词包（AES-256-GCM）──
# 源码包只携带加密后的 desktop/prompts/dito-prompts.bin，不携带明文提示词目录。
npm run desktop:encrypt-prompts

# ── 组装源码树（排除 node_modules / docs / 计划文档 / 原始人设副本）──
# node_modules 不打包：COPR 构建时用 --enable-net on 联网跑 npm ci。
SRC="$STAGE/$NAME-$VERSION"
mkdir -p "$SRC"
cp -a \
  bin extensions desktop web-ui scripts kb config skills .pi \
  package.json package-lock.json README.md \
  "$SRC"/
# 不打包明文提示词：personas/identities/system-prompts 不出现在源码包中。

# ── 打包源码 tarball ──
tar -C "$STAGE" -czf "$RPMBUILD/SOURCES/$NAME-$VERSION.tar.gz" "$NAME-$VERSION"
echo "[build] 源码包：$RPMBUILD/SOURCES/$NAME-$VERSION.tar.gz"

cp -f "$ROOT/packaging/$NAME.spec" "$RPMBUILD/SPECS/$NAME.spec"

# ── 构建 ──
if [[ "${1:-}" == "--srpm-only" ]]; then
  rpmbuild -bs "$RPMBUILD/SPECS/$NAME.spec"
else
  rpmbuild -bb "$RPMBUILD/SPECS/$NAME.spec"
fi

echo
echo "[build] 完成。产物："
ls -lh "$RPMBUILD/RPMS"/*/*.rpm 2>/dev/null || true
