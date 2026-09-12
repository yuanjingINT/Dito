#!/usr/bin/env bash
# Dito 便携包构建：AppImage（Linux）/ 单文件 exe（Windows，Node SEA）/ .app zip（macOS）。
#
# 用法：packaging/build-portable.sh [--skip-download]
# 产物：dist/dito-linux-x64.AppImage、dist/dito-win-x64.zip（内含 dito.exe）、
#       dist/dito-macos-arm64.zip（内含 Dito.app）
# 依赖：网络（下载官方 node 运行时与 appimagetool，缓存在 packaging/.cache/）
# 说明：不发版，产物仅在本地 dist/（.gitignore 已忽略 dist/）。
# GPL-3.0-only，见仓库 LICENSE。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DIST="$ROOT/dist"
CACHE="$ROOT/packaging/.cache"
NODE_VERSION="v26.8.2"
NODE_MIRROR="${NODE_MIRROR:-https://nodejs.org/dist}"
mkdir -p "$DIST" "$CACHE"

echo "── 1/6 构建 bundle ──"
node packaging/build-bundle.mjs

# 运行时数据（ROOT_DIR 布局：bundle 在 dist/ 下）
payload() { # $1 = 目标根
  local d="$1"
  mkdir -p "$d/dist" "$d/extensions"
  cp dist/dito.mjs "$d/dist/"
  cp dist/dito.cjs "$d/dist/"
  cp extensions/snowluma-actions.json "$d/extensions/"
  for dir in personas identities system-prompts kb config skills docs; do
    [ -e "$dir" ] && cp -r "$dir" "$d/"
  done
}

echo "── 2/6 下载 node 运行时 ──"
dl() { # url out
  [ -s "$2" ] && { echo "  缓存命中 $(basename "$2")"; return; }
  curl -fL --retry 3 --progress-bar -o "$2" "$1"
}
NODE_LINUX="$CACHE/node-$NODE_VERSION-linux-x64.tar.xz"
NODE_WIN="$CACHE/node.exe"
NODE_MAC="$CACHE/node-$NODE_VERSION-darwin-arm64.tar.gz"
APPIMAGETOOL="$CACHE/appimagetool-x86_64.AppImage"
dl "$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" "$NODE_LINUX"
dl "$NODE_MIRROR/$NODE_VERSION/win-x64/node.exe" "$NODE_WIN"
dl "$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.gz" "$NODE_MAC"
dl "https://ghfast.top/https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage" "$APPIMAGETOOL"
chmod +x "$APPIMAGETOOL" 2>/dev/null || true

echo "── 3/6 AppImage（Linux x64）──"
APPDIR="$DIST/dito.AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/lib" "$APPDIR/usr/share/icons/hicolor/512x512/apps" "$APPDIR/usr/share/applications"
payload "$APPDIR/usr/lib/dito"
tar -xf "$NODE_LINUX" -C "$CACHE" "node-$NODE_VERSION-linux-x64/bin/node"
cp "$CACHE/node-$NODE_VERSION-linux-x64/bin/node" "$APPDIR/usr/bin/node"
chmod +x "$APPDIR/usr/bin/node"
cat > "$APPDIR/AppRun" << 'EOF'
#!/bin/bash
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export DITO_APPIMAGE=1
exec "$HERE/usr/bin/node" "$HERE/usr/lib/dito/dist/dito.mjs" "$@"
EOF
chmod +x "$APPDIR/AppRun"
cp "$ROOT/packaging/dito.png" "$APPDIR/dito.png"
cp "$ROOT/packaging/dito.png" "$APPDIR/usr/share/icons/hicolor/512x512/apps/dito.png"
cat > "$APPDIR/dito.desktop" << 'EOF'
[Desktop Entry]
Name=Dito
Comment=Dito（蒂特）AI 助手 · 终端对话
Exec=AppRun
Icon=dito
Terminal=true
Type=Application
Categories=Development;Utility;
EOF
(cd "$CACHE" && "$APPIMAGETOOL" --appimage-extract > /dev/null 2>&1)
ARCH=x86_64 "$CACHE/squashfs-root/AppRun" "$APPDIR" "$DIST/dito-linux-x64.AppImage" > /dev/null
echo "  ✓ dist/dito-linux-x64.AppImage ($(du -h "$DIST/dito-linux-x64.AppImage" | cut -f1))"

echo "── 4/6 Windows 单文件 exe（Node SEA）──"
mkdir -p "$DIST/win"
cat > "$DIST/win/sea-config.json" << 'EOF'
{ "main": "dito.cjs", "output": "sea-prep.blob", "disableExperimentalSEAWarning": true }
EOF
cp dist/dito.cjs "$DIST/win/dito.cjs"
(cd "$DIST/win" && node --experimental-sea-config sea-config.json)
cp "$NODE_WIN" "$DIST/win/dito.exe"
npx -y postject "$DIST/win/dito.exe" NODE_SEA_BLOB "$DIST/win/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 > /dev/null
# 数据目录与启动器随 exe 放置（ROOT_DIR = exe 所在目录）
mkdir -p "$DIST/win/app"
payload "$DIST/win/app"
cat > "$DIST/win/dito.cmd" << 'EOF'
@echo off
"%~dp0dito.exe" %*
EOF
cat > "$DIST/win/README.txt" << 'EOF'
Dito（蒂特）Windows 版
=====================
1. 双击 dito.cmd 或在终端运行：dito.exe doctor   （先体检）
2. 常用：dito.exe（对话）  dito.exe mobile（手机配对）  dito.exe send "消息"
3. 语音功能需要 ffmpeg（加入 PATH）；app/ 目录是提示词与知识库数据，勿删。
说明：dito.exe 内嵌 Node 运行时（SEA）。app/ 里的 dito.cjs 供排障：
  也可用系统 Node 运行 app\dito.cjs。
EOF
(cd "$DIST" && python3 -c "import shutil; shutil.make_archive('dito-win-x64', 'zip', '.', 'win')") && echo "  ✓ dist/dito-win-x64.zip ($(du -h "$DIST/dito-win-x64.zip" | cut -f1))"

echo "── 5/6 macOS .app（arm64）──"
APP="$DIST/Dito.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
payload "$APP/Contents/Resources/dito"
tar -xzf "$NODE_MAC" -C "$CACHE" "node-$NODE_VERSION-darwin-arm64/bin/node"
mkdir -p "$APP/Contents/Resources/node/bin"
cp "$CACHE/node-$NODE_VERSION-darwin-arm64/bin/node" "$APP/Contents/Resources/node/bin/node"
cat > "$APP/Contents/MacOS/dito" << 'EOF'
#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/../Resources/node/bin/node" "$HERE/../Resources/dito/dist/dito.mjs" "$@"
EOF
chmod +x "$APP/Contents/MacOS/dito"
cat > "$APP/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Dito</string>
  <key>CFBundleDisplayName</key><string>Dito</string>
  <key>CFBundleIdentifier</key><string>fun.dito.desktop</string>
  <key>CFBundleVersion</key><string>0.2.0</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>dito</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
EOF
(cd "$DIST" && python3 -c "import shutil; shutil.make_archive('dito-macos-arm64', 'zip', '.', 'Dito.app')") && echo "  ✓ dist/dito-macos-arm64.zip ($(du -h "$DIST/dito-macos-arm64.zip" | cut -f1))"

echo "── 6/6 验证 ──"
rm -rf "$CACHE/verify"
mkdir -p "$CACHE/verify"
(cd "$CACHE/verify" && "$DIST/dito-linux-x64.AppImage" --appimage-extract > /dev/null && \
  ./squashfs-root/AppRun doctor --ci | tail -1 | sed 's/\x1b\[[0-9;]*m//g' || true)
ls -la "$DIST" | grep -E "AppImage|zip|exe" || true
echo "完成（未发布：产物仅在本地 dist/）"
