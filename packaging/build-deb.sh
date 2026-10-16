#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v dpkg-deb >/dev/null || { echo '需要 dpkg-deb' >&2; exit 1; }
version="$(cat "$ROOT/VERSION")"
arch="$(dpkg --print-architecture)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
bash "$ROOT/packaging/install-native.sh" --prefix "$work/pkg/usr" "$@"
rm -rf -- "$work/pkg/usr/share/dito/backups"
# Staging prefixes are temporary; use relocatable launch links in the package.
ln -sfn ../lib/dito/dito "$work/pkg/usr/bin/dito"
chmod -R u=rwX,go=rX "$work/pkg/usr/lib/dito"
mkdir -p "$work/pkg/DEBIAN" "$ROOT/dist"
sed -e "s/^Version: .*/Version: $version/" -e "s/^Architecture: .*/Architecture: $arch/" \
  "$ROOT/packaging/debian/control" > "$work/pkg/DEBIAN/control"
dpkg-deb --build --root-owner-group "$work/pkg" "$ROOT/dist/dito_${version}_${arch}.deb"
