# Pip installBytes — Measurement Report (2026-10-17)

**Label: Implemented / Tested** (real clean-venv installs, real PyPI)

## Method (documented)
- Per package: fresh `python3 -m venv`, then `pip install --no-deps <pkg>==<ver>`.
- Measured: `du -sb` of the package's own site-packages directories (module dir + dist-info).
- **torch and other dependencies EXCLUDED** — per Claude's note ("Torch jaise dependencies wheel size mein nahi aate").
- `--no-deps` used deliberately: avoids downloading GBs of torch/CUDA wheels on this VM; measures the package's own footprint only.
- PyPI version pin verified via `pip show` for each package (all 5 pins exist on PyPI, none yanked — confirmed by v2 audit's PyPI check).

## Results

| Tool (catalog id) | Package | installBytes | ≈ MiB |
|---|---|---|---|
| voice-studio | chatterbox-tts==0.1.7 | 759840 | 0.72 |
| transcribe | faster-whisper==1.2.1 | 1502238 | 1.43 |
| erase | lama-cleaner==1.2.5 | 10187687 | 9.72 |
| voice-cleanup | deepfilternet==0.5.6 | 948946 | 0.90 |
| stem-split | demucs==4.1.0 | 647575 | 0.62 |

Breakdown (module dir + dist-info):
- chatterbox-tts: `chatterbox/` 737189 + dist-info 22651 = 759840
- faster-whisper: `faster_whisper/` 1482468 + dist-info 19770 = 1502238
- lama-cleaner: `lama_cleaner/` 10152701 + dist-info 34986 = 10187687
- deepfilternet: `df/` 940463 + dist-info 8483 = 948946
- demucs: `demucs/` 619960 + dist-info 27615 = 647575

**Catalog updated:** all 5 `installBytes` values written to `main/catalog.js` (only field added; no other values changed). `validateCatalog()` passes with zero errors.

## Hidden first-run model downloads — CONFIRMED by source inspection

All 5 packages download models on first use. **None were triggered during measurement** (imports failed on missing deps due to `--no-deps`; `~/.cache` diff before/after was empty). Findings are from reading the installed source:

1. **chatterbox-tts** — `chatterbox/tts.py:178`: `hf_hub_download(repo_id="ResembleAI/chatterbox", ...)` inside `from_pretrained()`. Downloads TTS weights from HuggingFace Hub on first inference.
2. **faster-whisper** — `faster_whisper/utils.py:49,116`: `download_model()` calls `huggingface_hub.snapshot_download(repo_id, ...)`. Downloads Whisper model (default large-v3 per catalog's technical field) on first transcription.
3. **lama-cleaner** — `lama_cleaner/helper.py:43`: `download_model()` uses `torch.hub.download_url_to_file(url, cached_file, ...)`. Downloads LaMa/inpainting models to torch hub cache dir on first use.
4. **deepfilternet** — `df/enhance.py:252`: `maybe_download_model()` (default `DeepFilterNet3`); `df/utils.py:206`: `download_file()` via `requests.get(url, stream=True)`. Downloads model weights on first enhance call.
5. **demucs** — `demucs/hf.py:92`: "Load a named model from the HuggingFace hub." Downloads pretrained separator model from HF Hub on first separate call.

**Implication for TakeOne:** `pip install` alone does NOT make these tools work offline. Each needs its model weights on first run (network required at first use, or pre-seed the cache). The disk-space preflight must account for model downloads, not just `installBytes`. Model sizes were NOT measured (would require full dep installs + GPU/torch).

## Open issue for Claude: sizeMB vs installBytes semantic

The v2 audit now flags all 5 pip entries as **MISMATCH**: `sizeMB=<2048|3072|200|50|500>` but `installBytes` says `<0.72|1.43|9.72|0.90|0.62>` MiB (>1 MiB difference).

Root cause: catalog's `sizeMB` was a **total-install estimate** (package + torch/CUDA deps + model downloads), while `installBytes` is **package-only** by design. The v2 check `|installBytes/MiB - sizeMB| > 1 → MISMATCH` assumes they should match.

**Recommendation:** the v2 script should skip the sizeMB-vs-exact-bytes check for `installType: 'pip'` entries (or compare against a separate `totalInstallMB` field). Changing `sizeMB` to package-only values would make the UI lie about real disk needs. I did NOT change any `sizeMB` (per instructions: installBytes only).
