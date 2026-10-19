# Pip measurement — consolidated results (2026-10-17)

## installBytes WITH dependencies (clean venv, before/after du -sb, TMPDIR on big disk)
| package | installBytes | MiB | rc | notes |
|---|---|---|---|---|
| chatterbox-tts==0.1.7 | 6469663154 | 6169.95 | 0 | OK (retry, warm cache) |
| faster-whisper==1.2.1 | 458964825 | 437.70 | 0 | OK |
| demucs==4.1.0 | 5728539677 | 5463.16 | 0 | OK |
| deepfilternet==0.5.6 | 155333985 | 148.14 | 0 | OK (retry3) |
| lama-cleaner==1.2.5 | NOT TESTED | — | 1 | tokenizers==0.13.3 (via transformers==4.27.4) has no cp312 prebuilt wheel; source build impossible on this VM — apt Rust 1.75 can't parse edition2024 dep manifests, rustup Rust 1.99 can't compile the 2024-era tokenizers code. No older Python available. Catalog keeps package-only installBytes; no installScope. |

Old --no-deps values (superseded): chatterbox 759840, faster-whisper 1502238, lama-cleaner 10187687, deepfilternet 948946, demucs 647575.

## firstRunBytes — measured via HTTP HEAD Content-Length (real network, 2026-10-17)
| tool | source | firstRunBytes | MiB |
|---|---|---|---|
| voice-studio (chatterbox-tts) | ResembleAI/chatterbox: ve.safetensors 5695784 + t3_cfg.safetensors 2129653744 + s3gen.safetensors 1056484620 + tokenizer.json 25470 + conds.pt 107374 | 3191966992 | 3044.1 |
| transcribe (faster-whisper, catalog-documented large-v3) | Systran/faster-whisper-large-v3: model.bin 3087284237 + vocabulary.json 1068114 + config.json 2394 + tokenizer.json 2480617 | 3090835362 | 2947.7 |
| erase (lama-cleaner, default big-lama) | github Sanster/models big-lama.pt | 205669692 | 196.1 |
| voice-cleanup (deepfilternet, default DeepFilterNet3) | github Rikorose/DeepFilterNet DeepFilterNet3.zip | 7986207 | 7.6 |
| stem-split (demucs, default htdemucs via HF first) | adefossez/HTDemucs 955717e8.safetensors | 84025440 | 80.1 |

Notes: chatterbox excludes Cangjie5_TC.json (only used by non-En tokenizer path; EnTokenizer used by from_pretrained does not download it). faster-whisper model = catalog's documented large-v3 (no wired invocation in repo; WhisperModel requires explicit model arg). demucs tries HF hub first, falls back to legacy AWS.

## Catalog pip entries updated (2026-10-17, validateCatalog() zero errors)
| tool | installBytes | installScope | firstRunBytes | sizeMB (= (installBytes+firstRunBytes)/MiB) |
|---|---|---|---|---|
| voice-studio | 6469663154 | env-diff-with-deps | 3191966992 | 9214 |
| transcribe | 458964825 | env-diff-with-deps | 3090835362 | 3385 |
| voice-cleanup | 155333985 | env-diff-with-deps | 7986207 | 156 |
| stem-split | 5728539677 | env-diff-with-deps | 84025440 | 5543 |
| erase (lama-cleaner) | 10187687 (unchanged, package-only) | — | — | 200 (unchanged) — pending |

## --hash-all (new audit-catalog.js, 2026-10-17 ~15:14 UTC run)
- image-lite: VERIFIED — full 6.6GB download+hash, computed sha256 e869ac7d6942cb327d68d5ed83a40447aadf20e0c3358d98b2cc9e270db0da26 matches catalog.
- smart-select: VERIFIED — computed sha256 65b50056e05bcb13694174f51bb6da89c894b57b75ccdf0ba6352c597c5d1125 matches catalog.
