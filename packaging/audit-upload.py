#!/usr/bin/env python3
"""Audit exactly the Git index, without printing secret values or chat contents."""
import argparse
import json
from pathlib import PurePosixPath
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--tree', action='store_true', help='audit every tracked file, not just staged changes')
args = parser.parse_args()
command = ['git', 'ls-files', '-z'] if args.tree else ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
files = subprocess.check_output(command).decode().split('\0')
violations = []
secret_keys = {'apikey', 'accesstoken', 'refreshtoken', 'password', 'clientsecret', 'privatekey',
               'tavilykeys', 'firecrawlkeys', 'anysearchkeys', 'exakeys', 'perplexitykeys', 'apikeys'}
allowed_literals = {'', 'ollama', 'lm-studio', 'public', 'dummy', 'none'}

def inspect_json(value, name):
    if isinstance(value, dict):
        if value.get('type') == 'session' or (value.get('type') == 'message' and isinstance(value.get('message'), dict)):
            violations.append((name, 'session/chat record'))
        for key, item in value.items():
            if key.lower() in secret_keys:
                candidates = item if isinstance(item, list) else [item]
                for candidate in candidates:
                    if isinstance(candidate, str):
                        clean = candidate.strip()
                        if clean.lower() not in allowed_literals and not clean.startswith('$'):
                            violations.append((name, f'populated credential field: {key}'))
            inspect_json(item, name)
    elif isinstance(value, list):
        for item in value:
            inspect_json(item, name)

checked = 0
for name in filter(None, files):
    path = PurePosixPath(name)
    private_dirs = {'.pi', '.codex', '.agents', '.secrets', 'node_modules', 'sessions', 'backups', 'private'}
    private = bool(private_dirs.intersection(path.parts)) or path.parts[0] == 'docs'
    private |= path.parts[0] == 'user' and name != 'user/README.md'
    private |= any(part.startswith('build') for part in path.parts[1:]) and path.parts[0] == 'c'
    private |= bool(re.search(r'\.(?:jsonl|db(?:-wal|-shm)?|sqlite3?(?:-wal|-shm)?|pem|p12|node)$', name))
    private |= '.bak' in path.name or '.backup' in path.name or path.name.startswith('.env') and path.name != '.env.example'
    private |= path.suffix in {'.ts', '.tsx', '.mts', '.cts'}
    if private:
        violations.append((name, 'private/runtime/retired TypeScript file'))
        continue
    raw = subprocess.check_output(['git', 'show', ':' + name])
    checked += 1
    if b'\x00' in raw:
        continue
    text = raw.decode('utf-8', errors='replace')
    # Exclude machine snapshots even when renamed to innocuous JSON files.
    if path.suffix == '.json' and re.search(r'/(?:home|Users)/[^/\s]+/(?:\.pi|\.codex|\.local)(?:/|$)', text):
        violations.append((name, 'local machine/private backup path'))
    if re.search(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{30,})\b', text):
        violations.append((name, 'possible literal access credential'))
    if path.suffix == '.json':
        try:
            inspect_json(json.loads(text), name)
        except json.JSONDecodeError:
            violations.append((name, 'invalid JSON; cannot audit structured fields'))

if violations:
    for name, reason in sorted(set(violations)):
        print(f'BLOCKED: {name}: {reason}')
    raise SystemExit(1)
print(f'Upload audit passed: {checked} index files; no private data, credentials or own TS files detected.')
