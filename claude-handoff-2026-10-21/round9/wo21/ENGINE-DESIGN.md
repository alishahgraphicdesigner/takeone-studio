# WO-21 — Engine install design (DESIGN ONLY — koi implementation nahi)

Goal: user Models page par "Install" dabaye to engine (ComfyUI + 86 locked wheels)
honest progress ke saath `<root>/.engine/` me lag jaye. Phases: Downloading (GB) →
Verifying → Installing (wheel counter) → Ready. Har phase me cancel; fail par WHY +
WHAT NEXT (plain words, user ki zubaan).

## Layout

```
<root>/.engine/
  engine-state.json        # { phase, progress, detail, error, updatedAt } — restart-safe
  wheelhouse/              # 86 wheels, engine-lock.json se (har ek sha256-verified)
  comfyui.zip              # ComfyUI pinned b1a247c9 (sha256 14d2ffe3…be4e)
  ComfyUI/                 # extracted (python -m zipfile)
  venv/                    # shipped python se -m venv
  extra_model_paths.yaml   # base_path -> <root>/Models
```

Shipped python tarball (`resources/python-3.11.17-windows-x86_64-install_only_stripped.tar.gz`)
installer ke saath ata hai — download nahi hota. Manifest = 87 files
(86 wheels + 1 ComfyUI zip). Total download ≈ 3.54 GB.

## Manifest job (main/downloads.js patch)

`addHfDownload` ko generalize karo — naya method:

```js
addManifestJob({ id, files, category })
// files: [{ url, dest /* .engine ke andar relative */, bytes, sha256 }]
// Har file: aria2 download → size+sha256 verify → dest par move.
// Pehle se verified file reuse hoti hai (resume after restart/cancel/retry).
// Emits: state { phase:'downloading'|'verifying', fileIndex, fileCount, bytes, totalBytes }
```

`addHfDownload` is ka caller ban jata hai (HF URL building + dest mapping us ke paas rehta hai).
Cancel path WO-10 wala hai (forceRemove → 'removed' wait ≤3s → exists-checked delete).

## main/engine.js (naya) — function signatures

```js
engineRoot(root)                      // → path <root>/.engine
engineStatePath(root)                 // → path <root>/.engine/engine-state.json
readEngineState(root)                 // → { phase, progress, detail, error } | { phase:'idle' }
writeEngineState(root, patch)         // state file update + 'engine-state' event emit
planEngineInstall(root)               // → { files: [{url, dest, bytes, sha256}] } — engine-lock.json + ComfyUI zip se
installEngine(root, { onEvent })      // full pipeline; resolves { ok:true } ya { ok:false, why, whatNext }
cancelEngineInstall(root)             // har phase me cancel; resolves { ok:true, freedBytes }
enginePython(root)                    // → <root>/.engine/venv/Scripts/python.exe (win) | bin/python3 (linux)
venvExists(root)                      // → bool
assertEngineReady(root)               // → { ok:true } | { ok:false, reason } — venv python + torch cuda + ComfyUI dir
writeModelPaths(root)                 // extra_model_paths.yaml likhta hai (base_path: <root>/Models)
runPipWheels(root, { onProgress })    // wheelhouse ke 86 wheels, per-wheel pip install, i/N counter
```

`installEngine` ke andar tartib:

1. `writeEngineState({phase:'downloading'})` → `downloads.addManifestJob({id:'engine', files: planEngineInstall(root).files})` → GB progress events.
2. `writeEngineState({phase:'verifying'})` → manifest job khud har file verify karta hai; engine.js dobara quick-verify (size check) karta hai.
3. Shipped python extract → `-m venv` (WO-19 me prove: ensurepip kaam karta hai).
4. `writeEngineState({phase:'installing'})` → `runPipWheels` — per-wheel `pip install --no-index --find-links wheelhouse <file>`, counter i/86. (Single pip call tez hota lekin counter phir andaza hota; per-wheel me har invocation local file par hai, resolution nahi — exact counter, honest.)
5. ComfyUI zip extract via `python -m zipfile -e` (shipped python se, tar/7z dependency nahi).
6. `writeModelPaths(root)` → pip check → `assertEngineReady` → `writeEngineState({phase:'ready'})`.

Fail: `{ ok:false, why: '<plain words>', whatNext: '<plain words + action id>' }` — dev wording kabhi UI tak nahi.
Cancel: downloading → manifest job cancel (WO-10 path); verifying → loop rok, partial delete; installing → pip child kill, venv rehta hai (dobara install resume karta hai, pehle se installed wheels skip).

## main/comfy.js patch

- `ComfyManager` ka `pythonExe` ab `enginePython(root)` se ata hai (bundled python nahi).
- `start()` se pehle `writeModelPaths(root)` ensure + `--extra-model-paths-config <root>/.engine/extra_model_paths.yaml` args me.
- Agar `assertEngineReady(root).ok === false` → start refuse karega plain-words error ke saath ("Engine not installed yet — install it from the Models page.").

## main.js patch

- IPC: `takeone:engineInstall(root)` → `installEngine`; `takeone:engineCancel(root)` → `cancelEngineInstall`; `takeone:engineStatus(root)` → `readEngineState`.
- `getComfy(root)` → `pythonExe: enginePython(root)`.
- Engine events (`engine-state`) renderer tak forward (jaise `comfy-event`).

## UI (baad me — is round me nahi)

Models page par Engine card: Install button → phases progress bar (GB / file i-N / wheel i-86) → Ready. Cancel har phase me. Fail par WHY + WHAT NEXT box. Ye UI WO-21 ke agle round me, Claude ke design review ke baad.

## Khula sawal (Claude ke liye)

Per-wheel pip install (86 invocations) vs single pip call + indeterminate progress — design me per-wheel chuna hai (exact counter, honest). Agar 86 invocations CI/app me sust pare to batching par wapas aayenge, Claude ki approval se.
