#!/usr/bin/env python3
"""Compare local doctor launch paths. Does not measure LLM generation speed."""
import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--runs", type=int, default=7)
parser.add_argument("--output", type=Path)
args = parser.parse_args()
if not 1 <= args.runs <= 50:
    parser.error("runs must be between 1 and 50")
results = {"measurement": "offline doctor process launch, wall time and peak RSS", "runs": args.runs,
           "limitations": "C doctor currently checks fewer capabilities; not a complete application or LLM throughput comparison"}
with tempfile.TemporaryDirectory(prefix="dito-c-benchmark-") as folder:
    directory = Path(folder)
    config = json.loads((root / "config/dito.json").read_text())
    config.setdefault("plugins", {}).setdefault("voice", {})["enabled"] = False
    config["plugins"].setdefault("mcp", {})["enabled"] = False
    for channel in config.get("channels", {}).values():
        if isinstance(channel, dict):
            channel["enabled"] = False
    agent = directory / "agent/dito"
    agent.mkdir(parents=True)
    (agent / "config.json").write_text(json.dumps(config))
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(directory / "agent"),
               DITO_USER_DIR=str(directory / "user"), DITO_RESOURCE_DIR=str(root), TERM="dumb")
    commands = {
        "legacyJavaScript": ["node", "--import", str(root / "legacy/register-loader.mjs"), str(root / "legacy/entry.mjs"), "doctor", "--ci"],
        "c": [str(root / "c/build/dito"), "doctor"],
    }
    for label, command in commands.items():
        subprocess.run(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=30)
        elapsed, memory = [], []
        for i in range(args.runs):
            start = time.perf_counter_ns()
            actions = [(os.POSIX_SPAWN_OPEN, fd, os.devnull, os.O_WRONLY, 0o600) for fd in (1, 2)]
            pid = os.posix_spawnp(command[0], command, env, file_actions=actions)
            _, status, usage = os.wait4(pid, 0)
            if os.waitstatus_to_exitcode(status):
                raise RuntimeError(f"{label} doctor failed: {status}")
            elapsed.append((time.perf_counter_ns() - start) / 1e6)
            memory.append(usage.ru_maxrss)
        results[label] = {"median_ms": round(statistics.median(elapsed), 3),
                          "min_ms": round(min(elapsed), 3), "max_ms": round(max(elapsed), 3),
                          "median_peak_rss_kib": statistics.median(memory)}
    results["launch_speedup"] = round(results["legacyJavaScript"]["median_ms"] / results["c"]["median_ms"], 2)
    results["peak_rss_reduction_percent"] = round(100 * (1 - results["c"]["median_peak_rss_kib"] / results["legacyJavaScript"]["median_peak_rss_kib"]), 1)
text = json.dumps(results, ensure_ascii=False, indent=2)
print(text)
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text + "\n")
