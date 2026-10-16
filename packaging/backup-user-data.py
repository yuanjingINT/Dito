#!/usr/bin/env python3
"""Private, non-destructive backup; use SQLite online snapshots for WAL databases."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def backup(root, destination):
    os.umask(0o077)
    destination.mkdir(parents=True, exist_ok=False)
    files = sorted(root.rglob('*'))
    databases = set()
    for path in files:
        if path.is_file() and not path.is_symlink() and path.suffix == '.db':
            with path.open('rb') as source:
                if source.read(16) == b'SQLite format 3\x00':
                    databases.add(path)
    sidecars = {Path(str(path) + suffix) for path in databases for suffix in ('-wal', '-shm')}
    records = []
    for source in files:
        if source in sidecars:
            continue
        relative = source.relative_to(root)
        target = destination / relative
        if source.is_symlink():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(os.readlink(source), target_is_directory=source.is_dir())
            records.append({'path': str(relative), 'kind': 'symlink', 'target': os.readlink(source)})
        elif source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif source.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            if source in databases:
                with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=15)) as original:
                    with closing(sqlite3.connect(target)) as snapshot:
                        original.backup(snapshot, pages=512, sleep=.01)
                        snapshot.execute('PRAGMA journal_mode=DELETE')
                        if snapshot.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                            raise RuntimeError('数据库快照校验失败: ' + str(relative))
                kind = 'sqlite-online-snapshot'
            else:
                shutil.copy2(source, target)
                kind = 'file-copy'
            records.append({'path': str(relative), 'kind': kind, 'size': target.stat().st_size, 'sha256': digest(target)})
    manifest = {'source': str(root), 'createdAt': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
                'complete': True, 'files': records}
    (destination / 'backup-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return {'backup': str(destination), 'files': len(records), 'sqliteSnapshots': len(databases), 'complete': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    root = args.data_dir or Path(os.environ.get('PI_CODING_AGENT_DIR', str(Path.home() / '.pi/agent'))) / 'dito'
    root = root.resolve()
    if not root.is_dir():
        raise SystemExit('原数据目录不存在，未创建空备份')
    stamp = datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y%m%d-%H%M%S-%f')
    destination = args.destination or root.parent / 'dito-backups' / stamp
    destination = destination.resolve()
    if destination == root or root in destination.parents:
        raise SystemExit('备份目录必须位于原数据目录之外')
    print(json.dumps(backup(root, destination), ensure_ascii=False))
