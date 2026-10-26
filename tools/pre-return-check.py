#!/usr/bin/env python3
"""pre-return-check.py — Muse's OWN self-check for a TakeOne return package.

Usage: python tools/pre-return-check.py <round-return.zip>

FIX-1 (2026-10-26): this script was wrongly named tools/verify-return.py,
as if it were Claude's file. It never was: no Claude-authored
verify-return.py ever arrived in the TakeOne chat or workspace (searched
2026-10-26), so nothing is restored here and nothing is fabricated.
Claude runs HIS copy on his side; this file is only Muse's self-check
before a package goes to Ali. The full output of this script belongs in
the round's NOTE.md, so a future reader can re-run it and get the same
verdict.

Checks (FIX-2 / FIX-3, 2026-10-26):
  1. zip opens and is non-empty, single round dir
  2. NOTE.md present at <round>/NOTE.md and <= 60 lines
  3. files/ non-empty (package.json + main.js + docs/VERSIONS.md) and
     files/ bytes match FINGERPRINT.txt section B (recomputed sha256
     per member) — files/ must be the BUILD commit's bytes, unchanged
     after CI. The post-CI ledger VERSIONS.md lives separately under
     files-ledger/docs/VERSIONS.md (record only, never code).
  4. logs/ non-empty with a verify, an e2e-video, and a build log, each
     recording success (a failed first attempt may honestly sit next
     to the green re-run)
  5. NOTE version == package.json version in files/
  6. NOTE artifact name TakeOne-Studio-<version>-run<N> matches the
     files-ledger/docs/VERSIONS.md line for that version + build run id
     + the same 64-hex SHA256 as NOTE
  7. NOTE carries verify / e2e-video / build run ids (7+ digits each)
  8. contact_sheet.png (UI audit, FIX-2) present at <round>/ root; if
     NOTE names a pack sheet, that file must be in the zip too
  9. no .exe anywhere in the zip; no single member over 10 MB

Each check prints PASS or FAIL with its evidence; the last line is
ALL PASS or FAILURES: <n>. Exit 0 iff every check passes.
"""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        print("usage: python tools/pre-return-check.py <round-return.zip>")
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

    # FIX-3: FINGERPRINT.txt section B lists sha256 per files/ member;
    # recompute every member and compare. Any post-CI edit breaks this.
    try:
        fp_text = zf.read(f"{root}/FINGERPRINT.txt").decode("utf-8")
    except KeyError:
        fp_text = ""
    check("FINGERPRINT.txt present", bool(fp_text))
    fp_hashes = {}
    if fp_text and "\n--- files/ sha256 (recomputed by the checker) ---\n" in fp_text:
        section_b = fp_text.split("\n--- files/ sha256 (recomputed by the checker) ---\n", 1)[1]
        for line in section_b.splitlines():
            m = re.match(r"^([0-9a-f]{64})  (.+)$", line.strip())
            if m:
                fp_hashes[m.group(2)] = m.group(1)
    mismatches = []
    for n in files:
        rel = n[len(f"{root}/files/"):]
        actual = hashlib.sha256(zf.read(n)).hexdigest()
        if rel in fp_hashes and fp_hashes[rel] != actual:
            mismatches.append(rel)
    missing_fp = [n[len(f"{root}/files/"):] for n in files if n[len(f"{root}/files/"):] not in fp_hashes]
    check("files/ match FINGERPRINT.txt", not mismatches and not missing_fp,
          f"{len(files)} checked" + (f"; mismatched: {mismatches[:3]}" if mismatches else "")
          + (f"; not fingerprinted: {missing_fp[:3]}" if missing_fp else ""))

    logs = [n for n in names if n.startswith(f"{root}/logs/") and not n.endswith("/")]
    check("logs/ non-empty", len(logs) > 0, f"{len(logs)} logs")
    for kind in ["verify", "e2e-video", "build"]:
        found = [n for n in logs if kind in Path(n).name.lower()]
        check(f"logs/ has {kind} log", bool(found), found[0] if found else "missing")
        if found:
            good = False
            for fn in found:
                text = zf.read(fn).decode("utf-8", errors="replace")
                if ("success" in text.lower() and
                        ("conclusion" in text.lower() or "PASS" in text or "OK:" in text)):
                    good = True
                    break
            check(f"{kind} log records success", good,
                  "green log present" if good else "no green log")

    ver_m = re.search(r"version (\d+\.\d+\.\d+)", note) or re.search(r"\b(2\.\d+\.\d+)\b", note)
    version = ver_m.group(1) if ver_m else ""
    check("NOTE carries a version", bool(version), version)
    pkg_version = ""
    try:
        pkg = zf.read(f"{root}/files/package.json").decode("utf-8")
        pkg_version = json.loads(pkg).get("version", "")
    except Exception:
        pass
    check("NOTE version == package.json version", bool(version) and version == pkg_version,
          f"NOTE {version} vs package.json {pkg_version}")

    art_m = re.search(r"TakeOne-Studio-(\d+\.\d+\.\d+)-run(\d+)", note)
    check("NOTE carries an artifact name", bool(art_m),
          art_m.group(0) if art_m else "none")
    ledger_text = ""
    try:
        ledger_text = zf.read(f"{root}/files-ledger/docs/VERSIONS.md").decode("utf-8")
    except KeyError:
        pass
    check("files-ledger/docs/VERSIONS.md present", bool(ledger_text))
    sha_m = re.search(r"\b[0-9a-f]{64}\b", note)
    check("NOTE carries a SHA256", bool(sha_m), (sha_m.group(0)[:12] + "…") if sha_m else "")
    if art_m:
        build_logs = [n for n in logs if "build" in Path(n).name.lower()]
        build_id_m = re.search(r"(\d{7,})", Path(build_logs[0]).name) if build_logs else None
        build_id = build_id_m.group(1) if build_id_m else ""
        line = [ln for ln in ledger_text.splitlines()
                if art_m.group(1) in ln and build_id and build_id in ln]
        check("ledger VERSIONS.md line matches version + build run id", bool(line),
              line[0][:120] if line else f"no line for {art_m.group(1)} / {build_id}")
        if sha_m:
            check("ledger VERSIONS.md carries the same SHA256", sha_m.group(0) in ledger_text)
    run_ids = re.findall(r"\b\d{7,}\b", note)
    check("NOTE carries run ids", len(run_ids) >= 3, f"{len(run_ids)} numeric ids")

    # FIX-2: the UI audit contact sheet is mandatory; a pack sheet is
    # optional, but if NOTE names one it must be in the zip.
    check("contact_sheet.png present", f"{root}/contact_sheet.png" in names)
    sheet_ms = re.findall(r"([A-Za-z0-9_.-]+\.png)", note)
    pack_sheets = [s for s in sheet_ms if s != "contact_sheet.png" and "sheet" in s]
    for s in pack_sheets:
        check(f"pack sheet {s} present", f"{root}/{s}" in names)

    exes = [n for n in names if n.lower().endswith(".exe")]
    check("no .exe in zip", not exes, exes[:3])
    big = [(i.filename, i.file_size) for i in zf.infolist() if i.file_size > 10 * 1024 * 1024]
    check("no member over 10 MB", not big, str(big[:3]))

    fails = sum(1 for _n, ok, _d in results if not ok)
    print("ALL PASS" if fails == 0 else f"FAILURES: {fails}")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
