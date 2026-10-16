#!/usr/bin/env bash
# Linux native executable/resources plus optional JS compatibility dependencies.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(cat "$ROOT/VERSION")"
arch="$(uname -m)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$ROOT/dist"
bash "$ROOT/packaging/install-native.sh" --prefix "$work/app" "$@"
ln -sfn ../lib/dito/dito "$work/app/bin/dito"
# Whitelist only installed public program resources; exclude installer backups.
tar -C "$work/app" -czf "$ROOT/dist/dito-$version-linux-$arch.tar.gz" bin lib/dito
echo "便携包：$ROOT/dist/dito-$version-linux-$arch.tar.gz（不含 Node 解释器或个人数据）"
