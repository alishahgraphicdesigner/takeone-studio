# Phase A — Verification Checklist (TakeOne Studio 2.2.0)

**Build machine:** Linux VM (cross-compile to Windows x64 NSIS) · **Target PC:** Windows 11 Pro, RTX 5070 Ti 16GB
**Label legend:** [TESTED] = verified · [UNTESTED] = must be proven on the target PC

## Build-verified on this VM [TESTED 2026-10-15]
- [x] `npm install` clean (electron 38, electron-builder 26, tar 7)
- [x] Unit tests green: 16/16 (`test/unit.test.js` — nvidia-smi parser, pack tiers, Gate-2 matrix, root safety)
- [x] Integration tests green: 6/6 (`test/integration.test.js` — real checkPC/disk, model scan, folder sizes, uninstallData refusal)
- [x] Python tarball genuine: cpython-3.11.17 Windows x86_64 install_only_stripped, 25.2 MB, contains python/DLLs/*.pyd
- [x] English-only sweep: no Roman Urdu in UI copy; no TODO/FIXME/lorem/"coming soon"
- [x] Electron smoke (xvfb, Linux): splash → Python unpack (strip:1 fix verified, python.exe lands correctly) → wizard opens → step-2 auto-advance → checkPC IPC returns honest values (gpu=none, speed=null on this VM) → config.json draft persisted (wizardStep 2)
- [x] afterPack strips 54 unused Chromium locales (keeps en-US.pak)
- [x] `npm run dist` → `dist/TakeOne-Studio-2.2.0-setup.exe` BUILT [TESTED 2026-10-15 08:54 UTC]
- [x] Installer verified: valid PE32 NSIS self-extracting archive; "TakeOne Studio" in version info; asar contains exactly app files + `tar` (no devDeps)
- [x] Uninstaller: NSIS `WriteUninstaller` at install time (wine-free build; 9 documented patches in `scripts/patch-nsis-wine.js`, all inert when TAKEONE_SKIP_WINE is unset)

## Installer facts (measured, not claimed)
- **Installer size: 105.1 MB** (110,248,153 bytes) — under the 150 MB kill line; spec's ~80 MB was unachievable with Electron 38 (~325 MB unpacked before strip)
- Unpacked app: ~310 MB after locale strip (54 locales removed)
- Bundled Python: 25.2 MB compressed (cpython-3.11.17 install_only_stripped; full variant was 45 MB — stripped chosen for size; stdlib complete)
- Unsigned: YES — SmartScreen warning WILL appear. Stated honestly in the installer (notice/license page) AND in the wizard welcome step.
- Differential-update blockmap generated (`TakeOne-Studio-2.2.0-setup.exe.blockmap`) — Phase E auto-update ready.

## 5 consecutive clean cycles — ON THE TARGET PC [UNTESTED, do not claim until green]
Repeat 5x. A cycle = install → wizard (all 5 steps) → Studio opens → uninstall. Log each:

| Cycle | Install ok | Wizard 5 steps ok | Check-My-PC real values (GPU/VRAM/RAM/disk/speed) | Studio opens | Uninstall asks adopt-vs-wipe | Notes |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |

**Cycle details to verify each time:**
1. Run `TakeOne-Studio-2.2.0-setup.exe` → SmartScreen warning appears (expected, unsigned) → install to default per-user location → desktop icon "TakeOne Studio" created.
2. First launch → splash "Preparing TakeOne for first run…" → Python unpacks to `Documents\TakeOne\.python\` (check `python.exe` exists) → wizard opens.
3. Wizard step 2 shows REAL values: "NVIDIA GeForce RTX 5070 Ti — 16.0 GB VRAM", "64 GB", "~449 GB free", measured Mbps (not a guessed number).
4. Step 3: change folder works (native folder picker, no terminal).
5. Step 4: recommendation = Pro with the honest reason; Gate-2 check — select "Skip for now" with no tools and no models → Continue MUST stay disabled until "I will add tools later" is ticked.
6. Step 5 → "Open Studio" → Studio shell opens, status cards show the saved choices.
7. Kill the app, reboot the PC, launch again → Studio opens directly (wizard NOT shown; config.json persisted).
8. Settings → "Remove TakeOne…" → questionnaire shows real folder sizes → tick "Downloaded models" etc. → uninstall runs → app removed, unticked data still in Documents\TakeOne.
9. Reinstall over the kept folder → wizard skipped (adopt), Studio opens with old choices.

## Honest limitations of this phase
- The installer was BUILT on Linux but never EXECUTED on Windows here — the 5 cycles above are the gate, and they are [UNTESTED] until run on the target PC.
- `python.exe` inside the bundle is the genuine astral-sh Windows build but has not been launched (can't run Windows binaries on this VM) — first smoke is cycle 1's splash step.
- Download-speed probe uses `https://cachefly.cachefly.net/10mb.test`; if that host is unreachable from the target PC, the wizard shows "Speed test unavailable" honestly instead of a number.
