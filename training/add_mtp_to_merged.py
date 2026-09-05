#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 base 模型里的 MTP/NextN 权重补进合并后的模型（LoRA merge 会丢 mtp，导致 GGUF 缺 blk.N block）。

用法:
  .venv-u311/bin/python add_mtp_to_merged.py \
      --base-model ../models/Qwen3.5-0.8B \
      --merged-dir merged/qwen3.5-0.8b-dito-qq-identity3
"""
import argparse
import json
import os

import torch
from safetensors import safe_open, torch as safetensors_torch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-model", required=True)
    ap.add_argument("--merged-dir", required=True)
    args = ap.parse_args()

    base = os.path.abspath(args.base_model)
    merged = os.path.abspath(args.merged_dir)

    base_idx_path = os.path.join(base, "model.safetensors.index.json")
    if os.path.exists(base_idx_path):
        with open(base_idx_path, encoding="utf-8") as f:
            base_idx = json.load(f)
        base_wm = base_idx["weight_map"]
    else:
        # single file
        base_wm = {}
        with safe_open(os.path.join(base, "model.safetensors"), framework="pt") as f:
            for k in f.keys():
                base_wm[k] = "model.safetensors"

    mtp_keys = sorted(k for k in base_wm if k.startswith("mtp."))
    if not mtp_keys:
        print("base 没有 mtp.*，无需处理")
        return

    # 读取 mtp tensors
    mtp_tensors = {}
    for k in mtp_keys:
        shard = base_wm[k]
        with safe_open(os.path.join(base, shard), framework="pt") as f:
            mtp_tensors[k] = f.get_tensor(k)
    print(f"从 base 读取 mtp 权重 {len(mtp_tensors)} 个")

    # 确定 merged shards
    merged_idx_path = os.path.join(merged, "model.safetensors.index.json")
    merged_idx = {}
    merged_wm = {}
    shards = ["model.safetensors"]
    if os.path.exists(merged_idx_path) and os.path.getsize(merged_idx_path) > 0:
        with open(merged_idx_path, encoding="utf-8") as f:
            merged_idx = json.load(f)
        if "weight_map" in merged_idx:
            merged_wm = merged_idx["weight_map"]
            shards = sorted(set(merged_wm.values()))

    # 选一个有空余的 shard：优先最后一个（通常最小）
    target_shard = shards[-1]
    with safe_open(os.path.join(merged, target_shard), framework="pt") as f:
        data = {k: f.get_tensor(k) for k in f.keys()}
    # 如果 target 已经包含 mtp 就跳过
    if any(k.startswith("mtp.") for k in data):
        print("merged 已有 mtp，无需处理")
        return

    data.update(mtp_tensors)
    print(f"写入 {len(mtp_tensors)} 个 mtp 到 {target_shard}（现在共 {len(data)} 个 tensor）")
    safetensors_torch.save_file(data, os.path.join(merged, target_shard))

    # 更新 index
    for k in mtp_tensors:
        merged_wm[k] = target_shard
    if merged_idx_path and merged_wm:
        if "weight_map" not in merged_idx:
            merged_idx["weight_map"] = merged_wm
        with open(merged_idx_path, "w", encoding="utf-8") as f:
            json.dump(merged_idx, f, ensure_ascii=False, indent=2)

    print("完成")


if __name__ == "__main__":
    main()
