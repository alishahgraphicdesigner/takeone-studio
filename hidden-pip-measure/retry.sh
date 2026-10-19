#!/bin/bash
set -u
export TMPDIR=/home/hatch/workspace/.pip-tmp
export TEMP=$TMPDIR
export TMP=$TMPDIR
BASE=/home/hatch/workspace/.pip-venvs
mkdir -p "$BASE" "$TMPDIR"
OUT=/home/hatch/workspace/takeone-v22/hidden-pip-measure/retry-results.txt
echo "RETRY2 START $(date -u +%FT%TZ)" > "$OUT"
for spec in "chatterbox-tts==0.1.7" "lama-cleaner==1.2.5" "deepfilternet==0.5.6"; do
  echo "=== $spec ===" >> "$OUT"
  VENV="$BASE/v"
  rm -rf "$VENV"
  python3 -m venv "$VENV" 2>>"$OUT"
  BEFORE=$(du -sb "$VENV" | cut -f1)
  echo "before=$BEFORE" >> "$OUT"
  timeout 2400 "$VENV/bin/pip" install -q --disable-pip-version-check "$spec" >>"$OUT" 2>&1
  RC=$?
  AFTER=$(du -sb "$VENV" | cut -f1)
  DIFF=$((AFTER - BEFORE))
  MIB=$(python3 -c "print(f'{$DIFF/1048576:.2f}')")
  echo "after=$AFTER diff=$DIFF MiB=$MIB pip_rc=$RC" >> "$OUT"
  rm -rf "$VENV"
  echo "done $spec diff=$DIFF rc=$RC" >> "$OUT"
done
echo "RETRY2 END $(date -u +%FT%TZ)" >> "$OUT"
