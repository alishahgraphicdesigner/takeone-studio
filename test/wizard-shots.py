#!/usr/bin/env python3
"""wizard-shots.py — pre-ship user-eye gate for the TakeOne Studio setup wizard.

Renders every wizard step headlessly (system Chromium) with a mocked
window.takeone IPC surface that mirrors the real main-process behavior
(main.js: checkPC/recommendPack/maskPersonalPath shapes), using Ali's real
PC profile (RTX 5070 Ti 16GB, 64GB RAM, 425GB free, speed unavailable).

For each step it saves a screenshot AND scans the rendered text for
personal-data leaks (the mock uses a fake Windows username 'qauser';
any screen showing it means maskPersonalPath was bypassed -> FAIL).

Usage:
    ~/workspace/.wizevenv/bin/python test/wizard-shots.py [--out DIR]

Exit code 0 = all steps rendered, no leaks found.
Exit code 1 = a step failed to render or a leak was found.
"""
import argparse, json, os, sys, time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
WIZARD_HTML = HERE.parent / "renderer" / "wizard.html"
CHROME = "/opt/meta-chromium/chrome"
# Fake username: the ONLY username that may appear is the masked form.
FAKE_USER = "qauser"

# Ali's real PC profile (measured 2026-10-13..15).
PC_PROFILE = {
    "gpuName": "NVIDIA GeForce RTX 5070 Ti",
    "vramMB": 16384,
    "ramGB": 64,
    "diskFreeGB": 425,
    "speedMbps": None,          # today's reality: office network blocks the probe
    "measuredAt": "2026-10-15T19:00:00",
}

MOCK_JS = """
(() => {
  const PC = __PC__;
  const ROOT = __ROOT__;
  // --- real logic ported from main.js (recommendPack / maskPersonalPath) ---
  const r1 = (x) => Math.round(x * 10) / 10;
  function recommendPack(pc) {
    const vramMB = pc.vramMB || 0, vramGB = r1(vramMB / 1024);
    if (!pc.gpuName) return { tier: 'lite',
      reason: 'No NVIDIA GPU was detected on this PC, so the Lite pack is recommended.' };
    if (vramMB >= 12000) return { tier: 'pro',
      reason: `Your ${pc.gpuName} has ${vramGB} GB of VRAM — the full Pro pack is recommended, including the heaviest video tools.` };
    if (vramMB >= 8000) return { tier: 'standard',
      reason: `Your ${pc.gpuName} has ${vramGB} GB of VRAM — the Standard pack is recommended. The 24 GB-tier Video Pro tool is excluded because this card cannot run it.` };
    return { tier: 'lite',
      reason: `Your ${pc.gpuName} has ${vramGB} GB of VRAM — the Lite pack is recommended. Heavier tools would be too slow or would fail on this card.` };
  }
  function maskPersonalPath(p) {
    if (!p) return p;
    return String(p)
      .replace(/^([A-Za-z]:\\\\Users\\\\)[^\\\\]+/i, '$1\\u2022\\u2022\\u2022')
      .replace(/^(\\/home\\/)[^/]+/i, '$1\\u2022\\u2022\\u2022')
      .replace(/^(\\/Users\\/)[^/]+/i, '$1\\u2022\\u2022\\u2022');
  }
  const CATALOG = __CATALOG__;
  window.takeone = {
    checkPC: async () => PC,
    recommendPack: async (pc) => recommendPack(pc || PC),
    validateWizard: async () => ({ ok: true }),
    pickFolder: async () => null,
    defaultRoot: async () => ROOT,
    displayPath: async (p) => maskPersonalPath(p),
    diskFree: async () => PC.diskFreeGB,
    scanModels: async () => [],
    scanFolderModels: async () => ({ ok: true, found: [] }),
    adoptModels: async () => ({ ok: true, results: [] }),
    changeRoot: async () => ({ ok: true }),
    validateRoot: async () => ({ ok: true, conflicts: [] }),
    relaunch: async () => {},
    getConfig: async () => ({}),
    saveWizard: async () => ({ ok: true }),
    finishWizard: async () => ({ ok: true }),
    folderSizes: async () => ({}),
    catalog: async () => ({ ok: true, catalog: CATALOG }),
    installPlan: async () => ({}),
    toolStates: async () => ({}),
    checkOnline: async () => true,
  };
})();
""".replace("__PC__", json.dumps(PC_PROFILE)) \
   .replace("__ROOT__", json.dumps(f"C:\\Users\\{FAKE_USER}\\Documents\\TakeOne"))

# 21-tool catalog, same content as the wizard's honest fallback list.
FALLBACK_TOOLS = [
    ('brain', 'Brain', 'Qwen3 8B', 5120, 6144),
    ('image-studio', 'Image Studio', 'SDXL-Lightning 9-step', 7168, 8192),
    ('image-lite', 'Image Lite', 'SD 1.5 + Turbo', 7168, 6144),
    ('video-studio', 'Video Studio', 'Wan 2.1 1.3B', 3072, 8397),
    ('video-quality', 'Video Quality', 'Allegro 2.8B', 6144, 9523),
    ('video-pro', 'Video Pro', 'Wan 2.2 TI2V-5B', 11264, 24576),
    ('voice-studio', 'Voice Studio', 'Chatterbox TTS', 2048, 4096),
    ('voice-lite', 'Voice Lite', 'Piper (optional)', 150, 0),
    ('transcribe', 'Transcribe', 'faster-whisper large-v3', 3072, 4096),
    ('music-studio', 'Music Studio', 'ACE-Step v1.5', 4096, 8192),
    ('upscaler', 'Upscaler', 'SwinIR x4', 65, 2048),
    ('face-restore', 'Face Restore', 'GFPGAN v1.4', 333, 2048),
    ('vision', 'Vision', 'Florence-2 large', 1536, 3072),
    ('smart-select', 'Smart Select', 'SAM 2 tiny', 150, 2048),
    ('erase', 'Erase', 'LaMa', 200, 2048),
    ('depth-fx', 'Depth FX', 'Depth-Anything V2', 100, 1024),
    ('pose-lock', 'Pose Lock', 'DWPose', 500, 2048),
    ('bg-remove', 'BG Remove', 'BiRefNet', 800, 3072),
    ('voice-cleanup', 'Voice Cleanup', 'DeepFilterNet + Silero', 50, 0),
    ('slow-motion', 'Slow Motion', 'RIFE', 50, 2048),
    ('stem-split', 'Stem Split', 'Demucs', 500, 4096),
]
CATALOG = [{"id": i, "friendlyName": n, "technical": t, "sizeMB": s, "vramMB": v}
           for i, n, t, s, v in FALLBACK_TOOLS]
MOCK_JS = MOCK_JS.replace("__CATALOG__", json.dumps(CATALOG))

STEP_NAMES = {1: "welcome", 2: "check-pc", 3: "storage", 4: "tools", 5: "ready"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/wizard-shots")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME,
                                    args=["--no-sandbox", "--disable-gpu"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.add_init_script(MOCK_JS)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(WIZARD_HTML.as_uri())
        page.wait_for_timeout(600)

        for step in range(1, 6):
            # ensure we are on the right step
            visible = page.evaluate(
                "() => document.querySelector('section.step.on').dataset.step")
            if int(visible) != step:
                failures.append(f"step {step}: not visible (on {visible})")
                break
            # let async renders settle (step 2 runs the mocked PC check)
            page.wait_for_timeout(900)
            shot = out / f"step-{step}-{STEP_NAMES[step]}.png"
            page.screenshot(path=str(shot))
            text = page.evaluate(
                "() => document.querySelector('section.step.on').innerText")
            leak = FAKE_USER.lower() in text.lower()
            masked_ok = "\u2022\u2022\u2022" in text if step in (3, 5) else True
            status = "LEAK!" if leak else ("OK" if masked_ok else "MASK-MISSING")
            print(f"step {step} ({STEP_NAMES[step]:9s}) -> {shot.name}  [{status}]")
            if leak:
                failures.append(f"step {step}: username '{FAKE_USER}' leaked on screen")
            if step in (3, 5) and not masked_ok:
                failures.append(f"step {step}: masked path marker not found")
            if step < 5:
                btn = page.locator("section.step.on [data-next]")
                btn.click()
                page.wait_for_timeout(300)

        if errors:
            print("page errors:", *errors[:5], sep="\n  ")
            failures.append(f"{len(errors)} JS page error(s)")
        browser.close()

    print("---")
    if failures:
        print("FAIL:")
        for f in failures:
            print(" -", f)
        return 1
    print(f"PASS: 5 steps rendered to {out}, no personal-data leaks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
