#!/usr/bin/env bash
# Dito 桌面版 RPM 打包脚本。
# 用法：./packaging/build-desktop-rpm.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="dito-desktop"
VERSION="$(node -p "require('$ROOT/package.json').version")"
RPMBUILD="${RPMBUILD_DIR:-$HOME/rpmbuild}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$RPMBUILD"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}

if [ ! -x "$ROOT/dist/linux-unpacked/dito" ]; then
  echo "[build-desktop-rpm] 未找到 dist/linux-unpacked/dito，请先运行：npm run desktop:pack" >&2
  exit 1
fi

# 组装源码树：electron-builder 产出的完整桌面应用 + 图标
SRC="$STAGE/$NAME-$VERSION"
mkdir -p "$SRC"
cp -a "$ROOT/dist/linux-unpacked/." "$SRC/"
cp -a "$ROOT/desktop/icon.png" "$SRC/dito-desktop.png"

# 源码包
tar -C "$STAGE" -czf "$RPMBUILD/SOURCES/$NAME-$VERSION.tar.gz" "$NAME-$VERSION"
echo "[build-desktop-rpm] 源码包：$RPMBUILD/SOURCES/$NAME-$VERSION.tar.gz"

cp -f "$ROOT/packaging/$NAME.spec" "$RPMBUILD/SPECS/$NAME.spec"

rpmbuild -bb "$RPMBUILD/SPECS/$NAME.spec"

echo
echo "[build-desktop-rpm] 完成。产物："
ls -lh "$RPMBUILD/RPMS"/*/*.rpm 2>/dev/null || true
