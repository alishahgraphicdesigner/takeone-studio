#!/usr/bin/env python3
"""merge-shards.py — merge Wan 2.2 TI2V-5B's sharded diffusion weights
into ONE .safetensors file ComfyUI's UNETLoader can load.

Why: the pinned ComfyUI's UNETLoader loads a single .safetensors file
(comfy/utils.py load_torch_file — no sharded-index support anywhere in
the pinned tree), but Wan-AI/Wan2.2-TI2V-5B ships 3 shards + an index
json. This script runs ONCE after the verified HF download (the shards'
sha256s are already checked by the install path) and writes
    <toolDir>/diffusion_pytorch_model.safetensors
plus a <toolDir>/merged.json sidecar (tensor count + merged sha256).

How it stays light: it NEVER decodes a tensor. A safetensors file is
an 8-byte header length + a JSON header (dtype/shape/byte offsets per
tensor) + raw tensor bytes, so merging is header surgery + byte
concatenation with plain stdlib Python — no torch, no numpy, no
safetensors library, and peak RAM is one 64 MB copy chunk, not 20 GB
of weights. The merged header is verified by re-reading it (key set,
dtypes, shapes, and offsets all match the index) before success.

Idempotent: if merged.json already records the same tensor count for
the same shards, it exits 0 without rewriting 20 GB.

Usage: python merge-shards.py <toolDir>
  <toolDir> = Models/video/video-studio (the HF snapshot dir, holding
  diffusion_pytorch_model-0000X-of-00003.safetensors and
  diffusion_pytorch_model.safetensors.index.json).

Exit 0 on success (or already-merged); exit 1 with a plain reason on
stderr otherwise. Never prints tensor data, only counts and paths.
"""
import hashlib
import json
import os
import struct
import sys

CHUNK = 64 * 1024 * 1024


def fail(msg):
    print("merge-shards: " + msg, file=sys.stderr)
    return 1


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def read_header(path):
    """Return (header_dict, data_start_offset) for a safetensors file."""
    with open(path, "rb") as f:
        raw_len = f.read(8)
        if len(raw_len) != 8:
            raise ValueError("file too short for a safetensors header: " + path)
        (header_len,) = struct.unpack("<Q", raw_len)
        header_raw = f.read(header_len)
        if len(header_raw) != header_len:
            raise ValueError("truncated safetensors header: " + path)
        return json.loads(header_raw.decode("utf-8")), 8 + header_len


def main(argv):
    if len(argv) != 2 or argv[1] in ("-h", "--help"):
        print("usage: python merge-shards.py <toolDir>", file=sys.stderr)
        return 2
    tool_dir = argv[1]
    index_path = os.path.join(tool_dir, "diffusion_pytorch_model.safetensors.index.json")
    out_path = os.path.join(tool_dir, "diffusion_pytorch_model.safetensors")
    sidecar_path = os.path.join(tool_dir, "merged.json")
    if not os.path.isfile(index_path):
        return fail("index not found: " + index_path)
    with open(index_path, "r", encoding="utf-8") as f:
        index = json.load(f)
    weight_map = index.get("weight_map") or {}
    if not weight_map:
        return fail("index has no weight_map: " + index_path)
    shards = sorted(set(weight_map.values()))
    for s in shards:
        if not os.path.isfile(os.path.join(tool_dir, s)):
            return fail("shard missing: " + s)
    # Idempotent: a previous merge for this exact index is reused.
    if os.path.isfile(out_path) and os.path.isfile(sidecar_path):
        try:
            with open(sidecar_path, "r", encoding="utf-8") as f:
                old = json.load(f)
            if old.get("tensors") == len(weight_map) and old.get("shards") == shards:
                if os.path.getsize(out_path) > 0:
                    print("merge-shards: already merged (%d tensors)" % len(weight_map))
                    return 0
        except Exception:
            pass  # a corrupt sidecar falls through to a fresh merge
    # Collect every tensor's location: (shard file, byte range, dtype, shape).
    # A key must live in exactly the shard the index names — anything else
    # is a corrupt download, not something to paper over.
    locations = {}
    try:
        for shard in shards:
            header, data_start = read_header(os.path.join(tool_dir, shard))
            for key, spec in header.items():
                if key == "__metadata__":
                    continue
                offs = spec.get("data_offsets") or []
                if len(offs) != 2:
                    return fail("tensor %s in %s has no data_offsets" % (key, shard))
                if key in locations:
                    return fail("tensor %s appears in two shards" % key)
                locations[key] = (shard, data_start + offs[0], data_start + offs[1],
                                  spec.get("dtype"), spec.get("shape"))
    except (ValueError, KeyError, TypeError) as e:
        return fail("unreadable shard header: %s" % e)
    missing = [k for k in weight_map if k not in locations]
    if missing:
        return fail("tensors missing from shards: %d (e.g. %s)" % (len(missing), missing[0]))
    wrong_shard = [k for k in weight_map if locations[k][0] != weight_map[k]]
    if wrong_shard:
        return fail("tensor %s is not in its indexed shard" % wrong_shard[0])
    extra = [k for k in locations if k not in weight_map]
    if extra:
        return fail("unexpected tensors in shards: %d (e.g. %s)" % (len(extra), extra[0]))
    # Build the merged header (index order = deterministic) with fresh offsets.
    merged_header = {"__metadata__": {"format": "pt"}}
    offset = 0
    plan = []
    for key in weight_map:
        shard, start, end, dtype, shape = locations[key]
        size = end - start
        merged_header[key] = {"dtype": dtype, "shape": shape, "data_offsets": [offset, offset + size]}
        plan.append((key, shard, start, size))
        offset += size
    header_raw = json.dumps(merged_header).encode("utf-8")
    with open(out_path, "wb") as out:
        out.write(struct.pack("<Q", len(header_raw)))
        out.write(header_raw)
        for _key, shard, start, size in plan:
            with open(os.path.join(tool_dir, shard), "rb") as src:
                src.seek(start)
                remaining = size
                while remaining > 0:
                    chunk = src.read(min(CHUNK, remaining))
                    if not chunk:
                        return fail("shard truncated while copying: " + shard)
                    out.write(chunk)
                    remaining -= len(chunk)
    # Verify the merged file by re-reading its header (keys, dtypes,
    # shapes, offsets) — a bad merge must fail here, not on Ali's PC.
    try:
        check_header, check_start = read_header(out_path)
        check_keys = {k for k in check_header if k != "__metadata__"}
        if check_keys != set(weight_map):
            return fail("merged header key mismatch after write")
        for key in weight_map:
            spec = check_header[key]
            if spec.get("dtype") != locations[key][3] or spec.get("shape") != locations[key][4]:
                return fail("merged header mismatch for tensor: " + key)
        if os.path.getsize(out_path) != check_start + offset:
            return fail("merged file size mismatch after write")
    except (ValueError, KeyError, TypeError) as e:
        return fail("merged file failed verification: %s" % e)
    sidecar = {
        "mergedFile": "diffusion_pytorch_model.safetensors",
        "tensors": len(weight_map),
        "shards": shards,
        "sha256": sha256_file(out_path),
        "bytes": os.path.getsize(out_path),
    }
    with open(sidecar_path, "w", encoding="utf-8") as f:
        json.dump(sidecar, f, indent=2)
    print("merge-shards: merged %d tensors from %d shards -> %s (%d bytes)"
          % (len(weight_map), len(shards), out_path, sidecar["bytes"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
