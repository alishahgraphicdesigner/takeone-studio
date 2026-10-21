#!/usr/bin/env python3
"""WO-19 helper: rebuild the wheelhouse from engine-lock.json, sha256-verified.

Usage: python tools/build-wheelhouse.py [wheelhouse-dir]
Exits 1 if any wheel is missing from the lock or fails its sha256/bytes check.
"""
import hashlib
import json
import os
import sys
import urllib.request


def main() -> int:
    dest_dir = sys.argv[1] if len(sys.argv) > 1 else "wheelhouse"
    lock = json.load(open("engine-lock.json"))
    os.makedirs(dest_dir, exist_ok=True)
    bad = 0
    for w in lock["wheels"]:
        dest = os.path.join(dest_dir, w["file"])
        have = (
            os.path.exists(dest)
            and os.path.getsize(dest) == w["bytes"]
            and hashlib.sha256(open(dest, "rb").read()).hexdigest() == w["sha256"]
        )
        if have:
            print("have", w["file"])
            continue
        print("fetch", w["file"], flush=True)
        urllib.request.urlretrieve(w["url"], dest)
        h = hashlib.sha256(open(dest, "rb").read()).hexdigest()
        if h != w["sha256"] or os.path.getsize(dest) != w["bytes"]:
            print("LOCK MISMATCH:", w["file"])
            bad += 1
    print("wheels:", len(lock["wheels"]), "mismatches:", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
