#!/usr/bin/env bash
# Native RPM source build. The RPM contains C functionality; optional legacy
# dependencies are supplied by the user installer/portable distribution.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v rpmbuild >/dev/null || { echo '需要 rpmbuild；Linux 便携包请用 build-portable.sh。' >&2; exit 1; }
version="$(tr '-' '~' < "$ROOT/VERSION")"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
rpmroot="${RPMBUILD_DIR:-$ROOT/dist/rpmbuild}"
mkdir -p "$rpmroot"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS} "$work/dito-$version"
for name in c config personas identities system-prompts kb skills web-ui LICENSE NOTICE README.md VERSION; do
  cp -a "$ROOT/$name" "$work/dito-$version/"
done
rm -rf -- "$work/dito-$version/c/build" "$work/dito-$version/c/build-asan"
tar -C "$work" --exclude='c/build*' --exclude='__pycache__' -czf "$rpmroot/SOURCES/dito-$version.tar.gz" "dito-$version"
cp "$ROOT/packaging/dito.spec" "$rpmroot/SPECS/dito.spec"
if [[ "${1:-}" == '--srpm-only' ]]; then mode=-bs; else mode=-bb; fi
rpmbuild --define "_topdir $rpmroot" "$mode" "$rpmroot/SPECS/dito.spec"
