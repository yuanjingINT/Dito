#!/usr/bin/env bash
# Install the C entry and optional JavaScript bridge; never copies user data.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_prefix="${HOME}/.local"
with_legacy=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) [[ $# -ge 2 ]] || exit 2; install_prefix="$2"; shift 2 ;;
    --without-legacy) with_legacy=false; shift ;;
    *) echo '用法：install-native.sh [--prefix 绝对路径] [--without-legacy]' >&2; exit 2 ;;
  esac
done
[[ "$install_prefix" == /* ]] || { echo 'prefix 必须是绝对路径' >&2; exit 2; }
target="$install_prefix/lib/dito"
launcher="$install_prefix/bin/dito"
cmake -S "$ROOT/c" -B "$ROOT/c/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$ROOT/c/build" --parallel 4
ctest --test-dir "$ROOT/c/build" --output-on-failure
mkdir -p "$install_prefix/lib" "$install_prefix/bin"
stage="$(mktemp -d "$install_prefix/lib/.dito.new-XXXXXX")"
probe="$(mktemp -d)"
trap '[[ -z "${stage:-}" ]] || rm -rf -- "$stage"; rm -rf -- "$probe"' EXIT
chmod 700 "$stage" "$probe"
install -m 755 "$ROOT/c/build/dito" "$stage/dito"
for name in config personas identities system-prompts kb skills web-ui; do
  [[ ! -d "$ROOT/$name" ]] || cp -a "$ROOT/$name" "$stage/$name"
done
mkdir -p "$stage/third_party" "$stage/extensions"
cp "$ROOT/LICENSE" "$ROOT/NOTICE" "$ROOT/VERSION" "$ROOT/README.md" "$stage/"
cp "$ROOT/c/third_party/MiyuAgent-LICENSE" "$stage/third_party/"
cp "$ROOT/extensions/snowluma-actions.json" "$stage/extensions/"
if $with_legacy; then
  command -v node >/dev/null || { echo '旧功能兼容层需要 Node ≥22.5，纯 C 安装可加 --without-legacy。' >&2; exit 1; }
  cp -a "$ROOT/legacy" "$stage/legacy"
  if [[ ! -d "$stage/legacy/node_modules" ]]; then
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$stage/legacy"
  fi
  node "$stage/legacy/prepare.mjs"
  PI_CODING_AGENT_DIR="$probe/agent" DITO_USER_DIR="$probe/user" DITO_RESOURCE_DIR="$stage" \
    node "$stage/legacy/check.mjs"
fi
PI_CODING_AGENT_DIR="$probe/agent" DITO_USER_DIR="$probe/user" DITO_RESOURCE_DIR="$stage" \
  "$stage/dito" doctor --ci
stamp="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)-$$"
backup="$install_prefix/share/dito/backups/install-$stamp"
mkdir -p "$backup/launchers"
chmod 700 "$backup" "$backup/launchers"
old_entry="$(readlink -f "$launcher" 2>/dev/null || true)"
for name in dito dito-c dito-relay dito-desktop; do
  path="$install_prefix/bin/$name"
  if [[ -e "$path" || -L "$path" ]]; then cp -a "$path" "$backup/launchers/$name"; fi
done
if [[ -e "$target" ]]; then mv "$target" "$backup/previous-native"; fi
if ! mv "$stage" "$target"; then
  [[ ! -e "$backup/previous-native" ]] || mv "$backup/previous-native" "$target"
  exit 1
fi
stage=""
ln -sfn "$target/dito" "$launcher"
install -m 755 "$ROOT/bin/dito-relay" "$install_prefix/bin/dito-relay.new"
mv -f "$install_prefix/bin/dito-relay.new" "$install_prefix/bin/dito-relay"
install -m 755 "$ROOT/bin/dito-desktop" "$install_prefix/bin/dito-desktop.new"
mv -f "$install_prefix/bin/dito-desktop.new" "$install_prefix/bin/dito-desktop"
old_c="$install_prefix/bin/dito-c"
if [[ -L "$old_c" && "$(readlink -f "$old_c")" == "$install_prefix/lib/dito-native/dito-c" ]]; then
  rm -- "$old_c"
  [[ ! -d "$install_prefix/lib/dito-native" ]] || mv "$install_prefix/lib/dito-native" "$backup/previous-dito-c"
fi
# Keep already-running old processes' dynamic resource paths valid via a symlink.
old_npm="$install_prefix/lib/node_modules/dito"
if [[ "$old_entry" == "$old_npm/bin/dito" && -d "$old_npm" && ! -L "$old_npm" ]]; then
  mv "$old_npm" "$backup/previous-typescript-install"
  ln -s "$backup/previous-typescript-install" "$old_npm"
fi
"$launcher" --version
"$launcher" doctor --ci
echo "默认 dito 已切换为 C 程序：$launcher"
echo "旧安装与启动器备份：$backup"
