#!/usr/bin/env bash
# Dito DEB 打包脚本：在临时目录安装依赖后，用 dpkg-deb 生成 .deb。
# 用法：./packaging/build-deb.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="dito"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCH="amd64"
OUT="$ROOT/dist"
STAGE="$(mktemp -d)"
PKGROOT="$STAGE/pkg"
SRC="$STAGE/src"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT" "$SRC"

# ── 1. 生成加密提示词包（源码包不携带明文提示词）──

# ── 2. 组装源码树（排除明文 personas / identities / system-prompts）──
cp -a \
  bin extensions kb config skills .pi \
  package.json package-lock.json README.md \
  "$SRC"/

# ── 3. 安装生产依赖到源码树 ──
(cd "$SRC" && npm ci --omit=dev --no-audit --no-fund)

# ── 4. 组装 DEB 目录结构 ──
DEBROOT="$PKGROOT/usr/lib/$NAME"
mkdir -p "$PKGROOT/DEBIAN" "$DEBROOT" "$PKGROOT/usr/bin" "$PKGROOT/usr/share/doc/$NAME"
cp -a "$SRC/." "$DEBROOT/"
cp -a "$ROOT/README.md" "$PKGROOT/usr/share/doc/$NAME/"

# 规范化自有文件权限（目录 755、文件 644、可执行脚本保持可执行）
for d in bin extensions kb config skills .pi; do
  chmod -R u=rwX,go=rX "$DEBROOT/$d"
done
chmod 0755 "$DEBROOT/bin/dito"

ln -s "../lib/$NAME/bin/dito" "$PKGROOT/usr/bin/dito"

# ── 5. 生成 control（含 Installed-Size）──
SIZE_KB="$(du -sk --exclude=DEBIAN "$PKGROOT" | cut -f1)"
mkdir -p "$PKGROOT/DEBIAN"
sed \
  -e "s/^Version: .*/Version: ${VERSION}/" \
  -e "s/^Architecture: .*/Architecture: ${ARCH}/" \
  -e "/^Installed-Size:/d" \
  "$ROOT/packaging/debian/control" > "$PKGROOT/DEBIAN/control"
echo "Installed-Size: ${SIZE_KB}" >> "$PKGROOT/DEBIAN/control"

# ── 6. 打包 ──
DEB_FILE="$OUT/${NAME}_${VERSION}_${ARCH}.deb"
rm -f "$DEB_FILE"
fakeroot dpkg-deb --build --root-owner-group "$PKGROOT" "$DEB_FILE"

echo
echo "[build-deb] 完成。产物："
ls -lh "$DEB_FILE"
