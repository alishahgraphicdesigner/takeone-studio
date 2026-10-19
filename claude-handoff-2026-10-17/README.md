# Claude Handoff — TakeOne Audit v2 + Pip installBytes (2026-10-17)

## Kya kiya gaya

1. **v2 script install:** `tools/audit-catalog-v2.js` (aapki bheji hui `audit-catalog-2.js` ki copy). Purani `tools/audit-catalog.js` untouched hai. Syntax check: Passed.
2. **v2 fast audit:** chalaya gaya (~30 sec). Report: `v2-fast-audit-before-installbytes.json` (installBytes se pehle) aur `v2-fast-audit-after-installbytes.json` (installBytes ke baad).
3. **Targeted hash audit:** `node tools/audit-catalog-v2.js --only=image-lite,smart-select --hash-all` — **INCOMPLETE (network stall)**. Tafseel neeche.
4. **Video Studio sizeMB:** verify ho gaya — catalog me `sizeMB: 16753, sizeBytes: 17567317037` (17567317037/1048576 = 16753.5 MiB). v2 audit me koi sizeMB MISMATCH nahi. Aapka "3072 MiB" wala khadsha purani report ka tha; current catalog sahi hai.
5. **Pip installBytes:** 5 packages clean venv me measure kiye (real installs, real PyPI). Tafseel: `pip-installbytes-findings.md`.
6. **Catalog update:** 5 `installBytes` fields `main/catalog.js` me add kiye. Koi aur field change NAHI ki. `validateCatalog()` zero errors.
7. **Hidden first-run downloads:** 5/5 packages me code inspection se CONFIRM hue (tafseel findings me).

## v2 fast audit ka verdict (installBytes ke baad)

- **VERIFIED: 5** — brain, image-studio, image-lite, depth-fx, pose-lock
- **MISMATCH: 5** — 5 pip entries (neeche wajah)
- **UNPINNED: 9** — HF entries (chhoti files ke sha256 missing: tokenizer configs, LICENSE.txt, etc.)
- **NOT_AUDITABLE: 2** — voice-lite, slow-motion (external/adopt, manual check chahiye)
- **Gate: FAIL**

### Pip MISMATCH ki wajah (aapke liye action item)

v2 script ka sizeMB check (`|installBytes/MiB - sizeMB| > 1 → MISMATCH`) 5/5 pip entries par fire hota hai:

| Tool | sizeMB (catalog) | installBytes | Farq |
|---|---|---|---|
| voice-studio | 2048 | 0.72 MiB | sizeMB total-install estimate tha |
| transcribe | 3072 | 1.43 MiB | (deps + models shamil) |
| erase | 200 | 9.72 MiB | installBytes package-only hai |
| voice-cleanup | 50 | 0.90 MiB | (aapki design ke mutabiq) |
| stem-split | 500 | 0.62 MiB | |

**Masla:** `sizeMB` catalog me total-install estimate tha (torch/CUDA deps + model downloads), jabke `installBytes` package-only hai (aapki hidayat ke mutabiq). Script dono ko match karne ki koshish karta hai jo semantically ghalat hai.

**Tajweez:** v2 script `installType: 'pip'` entries par sizeMB-vs-exact-bytes check skip kare, ya `sizeMB` ki definition badle. Maine `sizeMB` change NAHI kiya (sirf installBytes add karne ki ijazat thi) — package-only values UI ko jhoot bolwayengi (asal disk need GBs me hai).

### Baqi UNPINNED (9 HF entries)

Chhoti non-weight files ke sha256 catalog me nahi hain (tokenizer_config.json, special_tokens_map.json, config.json, LICENSE.txt, vocab.json, .gitignore, handler.py, birefnet.py, modeling_florence2.py, etc.). Ye files `files[]` manifest me hain lekin `sha256: null` ke saath. Inhe fix karne ke liye: ya to in files ke sha256 HF se nikal kar catalog me dalen, ya manifest se non-essential files hatayen (video-quality wali safetensors-only safai isi ka hissa hai).

## Windows 6 Tests — Not Tested (kyun, aur kya chahiye)

Ye 6 tests **is environment se nahi ho sakte**, aur inke baghair koi "tested" claim jhoot hoga:

1. **Clean install** (Windows par)
2. **Brain download / verification / install**
3. **Cancel during download** (real process kill)
4. **Cancel during installation / verification**
5. **Restart aur resume** (app band karke dobara kholna)
6. **Studio ka real output file** (end-to-end generation, asli file disk par)

**Kyun nahi ho sakay:**

Ye kaam Linux VM par ho raha hai. TakeOne ka installer Windows ka `.exe` (NSIS) hai — yahan chal hi nahi sakta. Wine ke neeche chalana **valid behavioral test nahi hota**: installer ka asal behavior — file placement, registry entries, process lifecycle, cancel ka real background work rokna — sirf real Windows par verify ho sakta hai. Is environment me koi Windows machine maujood nahi hai.

**Kya chahiye:**

Ye 6 tests **2.2.10 release gate ke blockers** hain aur sirf real Windows 11 machine par ho sakte hain (Ali ki machine — RTX 5070 Ti, Windows 11 Pro). Do raste hain:
- **Ali khud chalayein** (6 tests, checklist ke saath), ya
- **Ye tests pending rahen** ge aur 2.2.10 release nahi hogi.

Koi bhi "tested", "fixed", ya "verified" claim in 6 tests ke baghair **jhoot** hoga. Audit gate (catalog) aur Windows behavior gate dono pass hone chahiye.

## Files is folder me

- `v2-fast-audit-before-installbytes.json` — v2 fast audit (installBytes se pehle)
- `v2-fast-audit-after-installbytes.json` — v2 fast audit (installBytes ke baad, MISMATCH wala)
- `v2-hash-image-lite-smart-select.json` — **NOT PRODUCED** (network stall — neeche tafseel)
- `pip-installbytes-findings.md` — 5 packages: sizes, method, hidden downloads, sizeMB issue
- `catalog.js` — updated catalog ki copy (installBytes shamil)
- `downloads.js` — downloader code ki copy (review ke liye)
- `README.md` — ye file

## Targeted --hash-all: kya hua (honest)

**Label: Implemented / Tested / Failed (network, not catalog)**

`--only=image-lite,smart-select --hash-all` chalaya gaya. Nateeja:
- **image-lite:** download 138MB/6.6GB par **stall** ho gaya — 90+ seconds tak 0 bytes (I/O counters se verify kiya). ~45 min wait ke baad process kill kiya. Ye **network stall** hai, catalog failure nahi.
- **smart-select:** kabhi start hi nahi hua (script sequentially chalti hai, image-lite par atki rahi).

**Important:** image-lite **fast audit me VERIFIED hai** (HEAD se bytes 6938081905 match, published sha256 via HF LFS etag cross-checked). Sirf full-download hash missing hai. Dobara chalane par shayad complete ho (network par depend karta hai) — v2 me 3 retries dead requests par hain, stalled stream par nahi.

## Honest labels summary

| Cheez | Label |
|---|---|
| v2 script install + syntax | Implemented / Tested / Passed |
| v2 fast audit (real network) | Implemented / Tested |
| image-lite --hash-all | Implemented / Tested / **Failed** (network stall @138MB/6.6GB, not catalog) |
| smart-select --hash-all | **Not Tested** (never started — script stalled on image-lite) |
| pip installBytes (5 pkgs, clean venv) | Implemented / Tested / Passed |
| Hidden model downloads (code inspection) | Implemented / Tested / Passed (confirmed, not triggered) |
| catalog.js installBytes edit | Implemented / Tested / Passed (validateCatalog clean) |
| Video Studio sizeMB | Implemented / Tested / Passed (16753 correct, no mismatch) |
| Windows 6 tests | **Not Tested** (impossible on Linux — upar wajah) |
| v2 script real-network behavior | Tested (fast audit) / hash-all [STATUS] |
