#!/usr/bin/env python3
"""verify-return.py — return-package gate for TakeOne/Claude rounds.

Usage: python tools/verify-return.py <round-return.zip>

Checks the return package the way Claude would have to: the NOTE is
short, the files and raw logs are really inside, the version / artifact /
SHA / run ids in the NOTE agree with the files, and no installer binary
is smuggled into the zip (GitHub's 100 MB limit; installers live only
as Actions artifacts).

Each check prints PASS or FAIL with its evidence; the last line is
ALL PASS or FAILURES: <n>. Exit 0 iff every check passes. The full
output of this script belongs in the round's NOTE.md (the order requires
it), so a future reader can re-run it and get the same verdict.

Checks:
  1. zip opens and is non-empty
  2. NOTE.md present at <round>/NOTE.md and <= 60 lines
  3. files/ non-empty (contains package.json + main.js + docs/VERSIONS.md)
  4. logs/ non-empty with a verify, an e2e, and a build log
  5. verify log names SUCCESS, e2e log names SUCCESS, build log names SUCCESS
  6. NOTE version (e.g. 2.2.19) == package.json version in files/
  7. NOTE artifact name TakeOne-Studio-<version>-run<N> matches the
     VERSIONS.md line for that version in files/
  8. NOTE carries a 64-hex SHA256 and the VERSIONS.md line carries the same one
  9. NOTE carries verify / e2e / build run ids (7+ digits each)
 10. no .exe anywhere in the zip; no single member over 10 MB
"""
import re
import sys
import zipfile
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        print("usage: python tools/verify-return.py <round-return.zip>")
        return 2
    zpath = Path(sys.argv[1])
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))

    if not zpath.exists():
        print(f"FAIL zip exists — {zpath} not found")
        print("FAILURES: 1")
        return 1
    try:
        zf = zipfile.ZipFile(zpath)
        names = zf.namelist()
    except zipfile.BadZipFile:
        print("FAIL zip opens — not a valid zip file")
        print("FAILURES: 1")
        return 1
    check("zip opens", True, f"{len(names)} members")

    rounds = sorted({n.split("/")[0] for n in names if "/" in n})
    check("single round dir", len(rounds) == 1, f"dirs: {rounds}")
    root = rounds[0] if rounds else ""
    note_name = f"{root}/NOTE.md" if root else "NOTE.md"

    try:
        note = zf.read(note_name).decode("utf-8")
    except KeyError:
        note = ""
    check("NOTE.md present", bool(note), note_name)
    note_lines = note.count("\n") + (1 if note and not note.endswith("\n") else 0) if note else 0
    check("NOTE.md <= 60 lines", 0 < note_lines <= 60, f"{note_lines} lines")

    files = [n for n in names if n.startswith(f"{root}/files/") and not n.endswith("/")]
    check("files/ non-empty", len(files) > 0, f"{len(files)} files")
    for want in ["package.json", "main.js", "docs/VERSIONS.md"]:
        check(f"files/ has {want}", any(n.endswith("/files/" + want) for n in files))

    logs = [n for n in names if n.startswith(f"{root}/logs/") and not n.endswith("/")]
    check("logs/ non-empty", len(logs) > 0, f"{len(logs)} logs")
    log_text = {}
    for kind in ["verify", "e2e", "build"]:
        found = [n for n in logs if kind in Path(n).name.lower()]
        ok = bool(found)
        text = ""
        if found:
            text = zf.read(found[0]).decode("utf-8", errors="replace")
            log_text[kind] = text
        check(f"logs/ has {kind} log", ok, found[0] if found else "missing")
        if found:
            # The log must record a success conclusion, not just a filename.
            good = ("success" in text.lower() and
                    ("conclusion" in text.lower() or "PASS" in text or "OK:" in text))
            check(f"{kind} log records success", good)

    ver_m = re.search(r"version (\d+\.\d+\.\d+)", note) or re.search(r"\b(2\.\d+\.\d+)\b", note)
    version = ver_m.group(1) if ver_m else ""
    check("NOTE carries a version", bool(version), version)
    pkg_version = ""
    try:
        import json
        pkg = zf.read(f"{root}/files/package.json").decode("utf-8")
        pkg_version = json.loads(pkg).get("version", "")
    except Exception as e:  # noqa: BLE001 — a missing/unreadable package.json is itself a failure
        pass
    check("NOTE version == package.json version", bool(version) and version == pkg_version,
          f"NOTE {version} vs package.json {pkg_version}")

    art_m = re.search(r"TakeOne-Studio-(\d+\.\d+\.\d+)-run(\d+)", note)
    check("NOTE carries an artifact name", bool(art_m),
          art_m.group(0) if art_m else "none")
    versions_text = ""
    try:
        versions_text = zf.read(f"{root}/files/docs/VERSIONS.md").decode("utf-8")
    except KeyError:
        pass
    if art_m:
        # VERSIONS.md records the build run ID (from the build log's
        # filename), not the artifact's run NUMBER — match on those.
        build_logs = [n for n in logs if "build" in Path(n).name.lower()]
        build_id_m = re.search(r"(\d{7,})", Path(build_logs[0]).name) if build_logs else None
        build_id = build_id_m.group(1) if build_id_m else ""
        line = [ln for ln in versions_text.splitlines()
                if art_m.group(1) in ln and build_id and build_id in ln]
        check("VERSIONS.md line matches version + build run id", bool(line),
              line[0][:120] if line else f"no line for {art_m.group(1)} / {build_id}")
    sha_m = re.search(r"\b[0-9a-f]{64}\b", note)
    check("NOTE carries a SHA256", bool(sha_m), (sha_m.group(0)[:12] + "…") if sha_m else "")
    if sha_m:
        check("VERSIONS.md carries the same SHA256", sha_m.group(0) in versions_text)
    run_ids = re.findall(r"\b\d{7,}\b", note)
    check("NOTE carries run ids", len(run_ids) >= 3, f"{len(run_ids)} numeric ids")

    exes = [n for n in names if n.lower().endswith(".exe")]
    check("no .exe in zip", not exes, exes[:3])
    big = [(i.filename, i.file_size) for i in zf.infolist() if i.file_size > 10 * 1024 * 1024]
    check("no member over 10 MB", not big, str(big[:3]))

    fails = sum(1 for _n, ok, _d in results if not ok)
    print("ALL PASS" if fails == 0 else f"FAILURES: {fails}")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
