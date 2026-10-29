#!/usr/bin/env python3
"""ui-audit.py — M1 UI AUDIT: every screen, three viewports, automatic checks.

Launches the REAL Electron app (no stubs, no mocks) under a throwaway HOME
with a pre-seeded library: config.json with wizardCompleted=true, so boot
goes straight to the Studio window with real IPC, plus one real
"Quick Generate" project holding one real PNG (so the Library card
thumbnail is a real render, not a fixture).

For each screen (Studio, Library, Models, Extras, Settings) and each
viewport (1280x800, 1920x1080, 1280x800 at 125% scale via
deviceScaleFactor 1.25), it screenshots the window and runs checks:
  - clipped text: visible element with scrollWidth > clientWidth while
    its horizontal overflow is hidden/clip (text cut off, no scroll).
  - overlapping interactive elements: two visible buttons/inputs/
    textareas/selects/links whose boxes intersect (ancestor pairs and
    full containment excluded — a button inside a card is not an overlap).
  - truncated buttons: any visible button with scrollWidth > clientWidth.
  - Studio only: #qgPrompt must be a TEXTAREA that auto-grows (a long
    pasted value grows the box and stays fully visible, no hidden overflow).
  - Library only: a .projthumb <img> with naturalWidth > 0.
  - Settings only: ONE "TakeOne folder" card (the old "Data folder" card
    is merged into it — FIX-4 FINAL item 4) + the diagnostics button.
  - Models only (M2.6-ENABLE, switch OFF by default): the video-studio
    card shows "Coming soon", no Install button path.
  - Studio only (M2.6-ENABLE OFF): the Video panel shows "Coming soon".
  - FIX-4 late-project check (after the viewport loop): the Library page
    was opened FIRST; a project is then created through real IPC while
    the app runs; navigate away and back — the new card must appear.
    This is the test that catches the stale-list bug (a seeded project
    would pass without any fix, so the created project is never seeded).

All screenshots are composed into contact_sheet.png (grid: screens as
rows, viewports as columns) with a report.json. Any failed check, or a
missing screenshot, exits 1 — the CI job fails, and the WO-40 gate then
fails the installer build.

Usage:
    xvfb-run -a python3 tools/ui-audit.py --out ui-audit-out
    (CI wraps it in xvfb-run; the script itself does not start X.)
Exit 0 = all screens, all viewports, all checks green. Exit 1 = anything else.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parent
ELECTRON = APP_DIR / "node_modules" / ".bin" / "electron"
PORT = 9224

# 1x1 transparent PNG — the seeded Library thumbnail (real bytes).
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

VIEWS = ["studio", "library", "models", "extras", "settings"]
VIEWPORTS = [
    ("1280x800", 1280, 800, 1.0),
    ("1920x1080", 1920, 1080, 1.0),
    ("1280x800@125pct", 1280, 800, 1.25),
]

CHECKS_JS = r"""
() => {
  const vis = (el) => {
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    // Off-screen views are display:none in this app; offsetParent null
    // catches them too (except position:fixed, which we still want).
    if (el.offsetParent === null && st.position !== 'fixed') return false;
    return true;
  };
  const clipped = [];
  const buttons = [];
  for (const el of document.querySelectorAll('*')) {
    if (!vis(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      const ov = getComputedStyle(el).overflowX;
      if (ov === 'hidden' || ov === 'clip') {
        const txt = (el.innerText || '').trim().slice(0, 60);
        clipped.push(`${el.tagName.toLowerCase()}.${(el.className.baseVal !== undefined ? '' : el.className || '')} :: ${txt}`);
      }
      if (el.tagName === 'BUTTON') buttons.push(el.innerText.trim().slice(0, 60));
    }
  }
  const overlaps = [];
  const inter = [...document.querySelectorAll('button, input, textarea, select, a')]
    .filter(vis);
  for (let i = 0; i < inter.length; i++) {
    for (let j = i + 1; j < inter.length; j++) {
      const a = inter[i], b = inter[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ix = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      const iy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      // Full containment is layout, not overlap (e.g. a control inside a
      // larger labelled area); only real intersections count.
      const contained = (ix * iy >= Math.min(ra.width * ra.height, rb.width * rb.height) - 1);
      if (ix * iy > 25 && !contained) {
        overlaps.push(`${a.tagName}#${a.id || a.className} x ${b.tagName}#${b.id || b.className}`);
      }
    }
  }
  return { clipped, buttons, overlaps };
}
"""

PROMPT_JS = r"""
async () => {
  const ta = document.querySelector('#qgPrompt');
  if (!ta) return { ok: false, reason: '#qgPrompt missing' };
  if (ta.tagName !== 'TEXTAREA') return { ok: false, reason: '#qgPrompt is ' + ta.tagName + ', not TEXTAREA' };
  // Reset first: an earlier viewport's check leaves a long value behind,
  // which would pollute the baseline (at a wider viewport the same text
  // wraps into fewer lines, so the box correctly SHRINKS — not a failure).
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const before = ta.offsetHeight;
  ta.focus();
  ta.value = 'A very long pasted prompt '.repeat(20).trim();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const grown = ta.offsetHeight > before;
  const fullyVisible = (ta.scrollHeight - ta.clientHeight) <= 2;
  return { ok: grown && fullyVisible, before, after: ta.offsetHeight, scrollHeight: ta.scrollHeight, clientHeight: ta.clientHeight };
}
"""


def wait_for_cdp(port, timeout_s=60):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://localhost:{port}/json/version", timeout=2)
            return True
        except Exception:
            time.sleep(1)
    return False


def seed_library(work):
    """Throwaway HOME + storage root with a completed wizard + one real project."""
    home = work / "home"
    root = work / "root"
    (home / ".config").mkdir(parents=True)
    proj = root / "Projects" / "quick-generate-audit"
    (proj / "images").mkdir(parents=True)
    import base64
    (proj / "images" / "audit-thumb.png").write_bytes(base64.b64decode(TINY_PNG_B64))
    (proj / "project.json").write_text(json.dumps({
        "id": "quick-generate-audit", "name": "Quick Generate",
        "createdAt": "2026-10-26T00:00:00.000Z", "updatedAt": "2026-10-26T00:00:00.000Z",
        "steps": {}, "currentStep": 1, "originalIdea": "",
    }), encoding="utf-8")
    (root / "config.json").write_text(json.dumps({
        "version": 1, "wizardCompleted": True, "storageRoot": str(root),
        "pcCheck": {"measuredAt": "2026-10-26T00:00:00.000Z", "speedMbps": 130},
        "packChoice": None, "customTools": [], "niche": "none",
    }), encoding="utf-8")
    # Receipt: this is how boot() finds the storage root.
    receipt_dir = home / ".config" / "TakeOne"
    receipt_dir.mkdir(parents=True, exist_ok=True)
    (receipt_dir / "receipt.json").write_text(
        json.dumps({"storageRoot": str(root)}), encoding="utf-8")
    return home, root


def check_fix7_trash(page, failures):
    """FIX-7 trash flow through REAL IPC + REAL clicks, on a live-created
    project (never seeded). create -> trash -> Restore click -> card
    back; delete-forever click; empty-trash click; seeded project
    trash -> Restore click -> card back WITH its thumbnail. Confirm
    dialogs are auto-accepted. Any harness error fails the audit."""
    try:
        page.on("dialog", lambda dialog: dialog.accept())

        created = page.evaluate("""async () => {
          const cfg = await window.takeone.getConfig();
          return window.takeone.createProject(cfg.storageRoot, 'Audit Trash Project');
        }""")
        if not (created and created.get('ok')):
            failures.append(f"FIX-7 trash: createProject failed: {created}")
            return
        tid = created['project']['id']

        def show_library():
            page.click('.railbtn[data-view="library"]')
            page.wait_for_timeout(800)

        def trash_rows():
            return page.evaluate("() => [...document.querySelectorAll('.trashrow')].map((r) => r.innerText)")

        def proj_names():
            return page.evaluate("() => [...document.querySelectorAll('.projcard')].map((c) => c.innerText)")

        tr = page.evaluate("""async (tid) => {
          const cfg = await window.takeone.getConfig();
          return window.takeone.trashProject(cfg.storageRoot, tid);
        }""", tid)
        if not (tr and tr.get('ok')):
            failures.append(f"FIX-7 trash: trashProject failed: {tr}")
            return
        show_library()
        if not any('Audit Trash Project' in r for r in trash_rows()):
            failures.append(f"FIX-7 trash: trash row missing after trash: {trash_rows()}")
            return
        page.locator(".trashrow", has_text="Audit Trash Project").locator("[data-restore]").click()
        page.wait_for_timeout(800)
        if not any('Audit Trash Project' in n for n in proj_names()) or any('Audit Trash Project' in r for r in trash_rows()):
            failures.append(f"FIX-7 trash: Restore click did not bring the card back / trash row stayed: names={proj_names()} rows={trash_rows()}")
            return
        print("FIX-7 trash: OK (create -> trash -> Restore click -> card back, trash row gone)")

        # Delete forever (click) + empty trash (click).
        tr2 = page.evaluate("""async (tid) => {
          const cfg = await window.takeone.getConfig();
          return window.takeone.trashProject(cfg.storageRoot, tid);
        }""", tid)
        if not (tr2 and tr2.get('ok')):
            failures.append(f"FIX-7 trash: re-trash for delete-forever failed: {tr2}")
            return
        show_library()
        page.locator(".trashrow", has_text="Audit Trash Project").locator("[data-forget]").click()
        page.wait_for_timeout(800)
        if any('Audit Trash Project' in r for r in trash_rows()):
            failures.append(f"FIX-7 trash: delete-forever click left the row: {trash_rows()}")
            return
        for name in ('Audit Empty One', 'Audit Empty Two'):
            c = page.evaluate("""async (name) => {
              const cfg = await window.takeone.getConfig();
              return window.takeone.createProject(cfg.storageRoot, name);
            }""", name)
            if not (c and c.get('ok')):
                failures.append(f"FIX-7 trash: create for empty-trash failed: {c}")
                return
            page.evaluate("""async (tid) => {
              const cfg = await window.takeone.getConfig();
              return window.takeone.trashProject(cfg.storageRoot, tid);
            }""", c['project']['id'])
        show_library()
        if len(trash_rows()) < 2:
            failures.append(f"FIX-7 trash: expected 2 rows before empty-trash: {trash_rows()}")
            return
        page.click('#trashEmpty')
        page.wait_for_timeout(800)
        body = page.evaluate("() => document.querySelector('#libraryBody').innerText")
        if 'Nothing in Trash.' not in body or trash_rows():
            failures.append(f"FIX-7 trash: empty-trash click did not clear Trash: rows={trash_rows()}")
            return
        print("FIX-7 trash: OK (delete-forever click + empty-trash click)")

        # Seeded project (has a real thumbnail): trash -> Restore click
        # -> card back WITH its thumbnail.
        tr3 = page.evaluate("""async () => {
          const cfg = await window.takeone.getConfig();
          return window.takeone.trashProject(cfg.storageRoot, 'quick-generate-audit');
        }""")
        if not (tr3 and tr3.get('ok')):
            failures.append(f"FIX-7 trash: trash seeded project failed: {tr3}")
            return
        show_library()
        page.locator(".trashrow", has_text="Quick Generate").locator("[data-restore]").click()
        page.wait_for_timeout(800)
        thumbs = page.evaluate("() => [...document.querySelectorAll('.projcard')].filter((c) => c.innerText.includes('Quick Generate')).map((c) => !!c.querySelector('.projthumb'))")
        if not thumbs or not thumbs[0]:
            failures.append(f"FIX-7 trash: restored seeded card has no thumbnail: {thumbs}")
            return
        print("FIX-7 trash: OK (seeded project restored with thumbnail)")
    except Exception as e:  # noqa: BLE001 — any harness error fails the audit
        failures.append(f"FIX-7 trash harness error: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--electron-bin", default=str(ELECTRON))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    from playwright.sync_api import sync_playwright

    electron = Path(args.electron_bin)
    if not electron.exists():
        print(f"FAIL: electron binary not found: {electron} (run npm ci first)")
        return 1

    work = Path(tempfile.mkdtemp(prefix="ui-audit-"))
    home, _root = seed_library(work)
    # Force BOTH HOME and XDG_CONFIG_HOME: Electron resolves appData from
    # XDG_CONFIG_HOME when set, else HOME/.config — a CI runner env that
    # sets XDG_CONFIG_HOME would otherwise make boot miss the seeded
    # receipt and fall into the first-run wizard path (the CI failure mode:
    # a page with no #studioBody, hence the wait timeout).
    env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"))
    # Free port per run (a stale app on a fixed port would silently serve
    # OLD code — the audit must never attach to anything but its own app).
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    # Keep Electron's GPU path off in headless CI; the app renders in xvfb.
    # New session + process-group kill on cleanup: terminating xvfb-run
    # alone orphans Electron (it keeps the CDP port and the old code).
    proc = subprocess.Popen(
        ["xvfb-run", "-a", str(electron), ".", "--no-sandbox", "--disable-gpu",
         f"--remote-debugging-port={port}"],
        cwd=str(APP_DIR), env=env, start_new_session=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    report = {}
    failures = []
    try:
        if not wait_for_cdp(port):
            print("FAIL: Electron CDP port did not come up")
            return 1
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(f"http://localhost:{port}")
            pages = []
            for _ in range(30):
                pages = browser.contexts[0].pages if browser.contexts else []
                if pages:
                    break
                time.sleep(1)
            # Diagnose the boot path in the log: a wizard/splash page here
            # means the seeded receipt was missed (never a silent timeout).
            for pg in pages:
                print(f"page: {pg.url} :: {pg.title()}")
            if not pages:
                print("FAIL: no app pages found over CDP")
                return 1
            studio_pages = [pg for pg in pages if pg.url.endswith("studio.html")]
            if not studio_pages:
                print("FAIL: no studio.html page — boot did not reach the Studio window")
                print("pages were: " + ", ".join(pg.url for pg in pages))
                try:
                    import glob
                    for lf in glob.glob("/tmp/takeone-startup.log"):
                        print("app log tail:")
                        print("\n".join(open(lf, errors="replace").read().splitlines()[-30:]))
                except Exception:
                    pass
                return 1
            page = studio_pages[-1]
            page.wait_for_function(
                "() => document.querySelector('#studioBody') && document.querySelector('#studioBody').innerText.trim().length > 0",
                timeout=120000)
            for view in VIEWS:
                report[view] = {}
                # Real user path: click the rail button.
                page.click(f'.railbtn[data-view="{view}"]')
                page.wait_for_timeout(800)
                for label, w, h, dsf in VIEWPORTS:
                    cdp = page.context.new_cdp_session(page)
                    cdp.send("Emulation.setDeviceMetricsOverride",
                             {"width": w, "height": h, "deviceScaleFactor": dsf, "mobile": False})
                    page.wait_for_timeout(400)
                    shot = out / f"{view}_{label}.png"
                    page.screenshot(path=str(shot))
                    checks = page.evaluate(CHECKS_JS)
                    extra = {}
                    if view == "studio":
                        # M2.6-ENABLE OFF: the Video panel must read Coming
                        # soon (refreshVideoState runs after IPC, so wait).
                        page.wait_for_function(
                            "() => { const d = document.querySelector('#videoDl');"
                            " return !!d && d.innerText.includes('Coming soon'); }",
                            timeout=30000)
                        extra["prompt"] = page.evaluate(PROMPT_JS)
                        # M2: the Video panel lives in Studio too — same
                        # bar as Quick Generate: multi-line prompt
                        # textarea + Generate button present, no stub.
                        extra["video"] = page.evaluate(
                            "() => { const p = document.querySelector('#videoPrompt');"
                            " const g = document.querySelector('#videoGenBtn');"
                            " const k = document.querySelector('#videoPackBtn');"
                            " return { panel: !!document.querySelector('#videoPanel'),"
                            " promptTextarea: !!p && p.tagName === 'TEXTAREA',"
                            " genBtn: !!g, packBtn: !!k }; }")
                        # M3: the Image-models bake-off panel lives in
                        # Studio too — panel + pack button present even
                        # with the switch OFF (disabled, Coming soon).
                        extra["imageModels"] = page.evaluate(
                            "() => { const p = document.querySelector('#imageModelsPanel');"
                            " const k = document.querySelector('#imPackBtn');"
                            " return { panel: !!p, packBtn: !!k }; }")
                    if view == "library":
                        extra["thumb"] = page.evaluate(
                            "() => [...document.querySelectorAll('.projthumb')].some((i) => i.naturalWidth > 0)")
                    if view == "settings":
                        # FIX-4 FINAL item 4: ONE folder card. The label is
                        # uppercased by CSS, so match case-insensitively;
                        # the old "Data folder" card must be GONE.
                        extra["folderCard"] = page.evaluate(
                            "() => { const t = document.body.innerText.toLowerCase();"
                            " return { merged: t.includes('takeone folder') && !t.includes('data folder') }; }")
                        extra["diagnosticsBtn"] = page.evaluate(
                            "() => !!document.querySelector('#copyDiagnostics')")
                    if view == "models":
                        # M2.6-ENABLE OFF: video-studio must read Coming
                        # soon (cards render after IPC states load, so wait).
                        page.wait_for_function(
                            "() => !!document.querySelector('.tcard[data-tool=\"video-studio\"]')",
                            timeout=30000)
                        extra["videoSoon"] = page.evaluate(
                            "() => { const c = document.querySelector('.tcard[data-tool=\"video-studio\"]');"
                            " return !!c && c.innerText.includes('Coming soon'); }")
                        # M3: the two new image-models cards must read
                        # Coming soon too (their own switch is OFF).
                        page.wait_for_function(
                            "() => !!document.querySelector('.tcard[data-tool=\"z-image-turbo\"]')",
                            timeout=30000)
                        page.wait_for_function(
                            "() => !!document.querySelector('.tcard[data-tool=\"flux2-klein-4b\"]')",
                            timeout=30000)
                        extra["imageModelsSoon"] = page.evaluate(
                            "() => { const a = document.querySelector('.tcard[data-tool=\"z-image-turbo\"]');"
                            " const b = document.querySelector('.tcard[data-tool=\"flux2-klein-4b\"]');"
                            " return !!a && a.innerText.includes('Coming soon') && !!b && b.innerText.includes('Coming soon'); }")
                        # Round22: the shipped estimate helper must give
                        # the order's example exactly (pure function, run
                        # in the real app — no state change, OFF state
                        # untouched by this check).
                        extra["dlEstimate"] = page.evaluate(
                            "() => (window.TakeOneDownloadEstimate"
                            " ? window.TakeOneDownloadEstimate.formatDownloadEstimate(32617, 22.8)"
                            " : null)")
                    view_fail = []
                    if checks["clipped"]:
                        view_fail.append(f"clipped text: {checks['clipped'][:5]}")
                    if checks["overlaps"]:
                        view_fail.append(f"overlapping interactive elements: {checks['overlaps'][:5]}")
                    if checks["buttons"]:
                        view_fail.append(f"truncated button text: {checks['buttons'][:5]}")
                    if view == "studio" and not extra["prompt"]["ok"]:
                        view_fail.append(f"prompt textarea check failed: {extra['prompt']}")
                    if view == "studio":
                        v = extra["video"]
                        if not (v["panel"] and v["promptTextarea"] and v["genBtn"] and v["packBtn"]):
                            view_fail.append(f"video panel incomplete: {v}")
                    if view == "studio":
                        im = extra["imageModels"]
                        if not (im["panel"] and im["packBtn"]):
                            view_fail.append(f"image-models panel incomplete: {im}")
                    if view == "library" and not extra["thumb"]:
                        view_fail.append("no Library card thumbnail rendered (naturalWidth 0)")
                    if view == "settings" and not (extra["folderCard"]["merged"] and extra["diagnosticsBtn"]):
                        view_fail.append(f"settings folder cards not merged / diagnostics button missing: {extra}")
                    if view == "models" and not extra["videoSoon"]:
                        view_fail.append(f"models video-studio card is not Coming soon (switch OFF expected): {extra}")
                    if view == "models" and not extra["imageModelsSoon"]:
                        view_fail.append(f"models image-models cards are not Coming soon (switch OFF expected): {extra}")
                    if view == "models" and extra["dlEstimate"] != "about 3-4 hours at your speed":
                        view_fail.append(f"models download estimate helper wrong: {extra['dlEstimate']!r}")
                    report[view][label] = {
                        "screenshot": shot.name, "checks": checks, "extra": extra,
                        "failures": view_fail,
                    }
                    if view_fail:
                        failures.append(f"{view} {label}: " + "; ".join(view_fail))
                    print(f"{view} {label}: {'FAIL ' + '; '.join(view_fail) if view_fail else 'OK'}")
            # FIX-4 (FINAL item 3) — the bug-catching test. The Library
            # page was opened FIRST (in the loop above); now create a
            # project through REAL IPC while the app runs, navigate away
            # and back, and the new card must appear. A seeded project
            # would pass with no fix at all — this one is created live.
            try:
                page.click('.railbtn[data-view="library"]')
                page.wait_for_timeout(800)
                before = page.evaluate("() => document.querySelectorAll('.projcard').length")
                created = page.evaluate("""async () => {
                  const cfg = await window.takeone.getConfig();
                  return window.takeone.createProject(cfg.storageRoot, 'Audit Late Project');
                }""")
                if not (created and created.get('ok')):
                    failures.append(f"FIX-4 late-project: createProject failed: {created}")
                else:
                    page.click('.railbtn[data-view="studio"]')
                    page.wait_for_timeout(800)
                    page.click('.railbtn[data-view="library"]')
                    page.wait_for_timeout(800)
                    after = page.evaluate("() => document.querySelectorAll('.projcard').length")
                    names = page.evaluate("() => [...document.querySelectorAll('.projcard')].map((c) => c.innerText)")
                    if after != before + 1 or not any('Audit Late Project' in n for n in names):
                        failures.append(f"FIX-4 late-project: before={before} after={after} names={names}")
                    else:
                        print(f"FIX-4 late-project: OK (cards {before} -> {after}, new project listed)")
            except Exception as e:  # noqa: BLE001 — any harness error fails the audit
                failures.append(f"FIX-4 late-project harness error: {e}")
            # FIX-7 trash flow (live project + clicks + thumbnail variant).
            _f7_before = len(failures)
            check_fix7_trash(page, failures)
            report["fix7_trash"] = {"ok": len(failures) == _f7_before}
    finally:
        # Kill the whole process group: xvfb-run, Xvfb, AND Electron.
        # (proc.terminate() alone leaves Electron alive on its CDP port.)
        try:
            import signal
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            try:
                import signal
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                pass

    # FIX-8 phase 2 — separate launch: experimental switch ON + a
    # video-studio that is complete on disk as SPARSE files (exact
    # manifest sizes, ~0 bytes real). The stat-only install check
    # passes; the panel must show the installed branch. On unfixed
    # code this fails: vs was read off the response object, so it was
    # always undefined and the panel showed "isn't installed yet".
    _f8_before = len(failures)
    try:
        work2 = Path(tempfile.mkdtemp(prefix="ui-audit-fix8-"))
        home2, root2 = seed_library(work2)
        cfgp = root2 / "config.json"
        cfg2 = json.loads(cfgp.read_text(encoding="utf-8"))
        cfg2["settings"] = {"experimentalVideo": True}
        cfgp.write_text(json.dumps(cfg2), encoding="utf-8")
        manifest = json.loads(subprocess.run(
            ["node", "-e",
             "const {CATALOG}=require('./main/catalog.js');"
             "const t=CATALOG.find((x) => x.id === 'video-studio');"
             "console.log(JSON.stringify(t.files))"],
            cwd=str(APP_DIR), capture_output=True, text=True, check=True).stdout)
        vsdir = root2 / "Models" / "video" / "video-studio"
        for f in manifest:
            p = vsdir / f["path"]
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "wb") as fh:
                fh.truncate(f["bytes"])
        env2 = dict(os.environ, HOME=str(home2), XDG_CONFIG_HOME=str(home2 / ".config"))
        import socket as _socket
        with _socket.socket() as _s:
            _s.bind(("127.0.0.1", 0))
            port2 = _s.getsockname()[1]
        proc2 = subprocess.Popen(
            ["xvfb-run", "-a", str(electron), ".", "--no-sandbox", "--disable-gpu",
             f"--remote-debugging-port={port2}"],
            cwd=str(APP_DIR), env=env2, start_new_session=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            if not wait_for_cdp(port2):
                failures.append("FIX-8 phase 2: Electron CDP port did not come up")
            else:
                with sync_playwright() as pw2:
                    browser2 = pw2.chromium.connect_over_cdp(f"http://localhost:{port2}")
                    pages2 = []
                    for _ in range(30):
                        pages2 = browser2.contexts[0].pages if browser2.contexts else []
                        if pages2:
                            break
                        time.sleep(1)
                    studio2 = [pg for pg in pages2 if pg.url.endswith("studio.html")]
                    if not studio2:
                        failures.append(f"FIX-8 phase 2: no studio page: {[pg.url for pg in pages2]}")
                    else:
                        page2 = studio2[-1]
                        page2.wait_for_function(
                            "() => document.querySelector('#studioBody') && document.querySelector('#studioBody').innerText.trim().length > 0",
                            timeout=120000)
                        page2.click('.railbtn[data-view="studio"]')
                        page2.wait_for_timeout(1500)
                        ts2 = page2.evaluate("async () => { const cfg = await window.takeone.getConfig(); return window.takeone.toolStates(cfg.storageRoot); }")
                        vs2 = (ts2.get("states") or {}).get("video-studio") or {}
                        dl2 = page2.evaluate("() => (document.querySelector('#videoDl') || {}).innerText || ''")
                        gen_dis = page2.evaluate("() => !!document.querySelector('#videoGenBtn')?.disabled")
                        pack_dis = page2.evaluate("() => !!document.querySelector('#videoPackBtn')?.disabled")
                        if vs2.get("state") != "installed":
                            failures.append(f"FIX-8 phase 2: toolStates video-studio not installed: {vs2}")
                        elif "Video Studio is installed" not in dl2 or "isn't installed yet" in dl2:
                            failures.append(f"FIX-8 phase 2: panel did not show installed branch: {dl2!r}")
                        elif gen_dis or pack_dis:
                            failures.append(f"FIX-8 phase 2: video buttons still disabled: gen={gen_dis} pack={pack_dis}")
                        else:
                            print("FIX-8 phase 2: OK (sparse video-studio -> toolStates installed -> panel installed branch)")
        finally:
            try:
                import signal
                os.killpg(proc2.pid, signal.SIGTERM)
                proc2.wait(timeout=10)
            except Exception:
                try:
                    import signal
                    os.killpg(proc2.pid, signal.SIGKILL)
                except Exception:
                    pass
    except Exception as e:  # noqa: BLE001 — any harness error fails the audit
        failures.append(f"FIX-8 phase 2 harness error: {e}")
    report["fix8_panel"] = {"ok": len(failures) == _f8_before}

    # Contact sheet: rows = screens, columns = viewports.
    try:
        from PIL import Image, ImageDraw
        cell_w, label_h = 480, 26
        thumbs = {}
        for view in VIEWS:
            for label, _w, _h, _d in VIEWPORTS:
                p = out / f"{view}_{label}.png"
                if p.exists():
                    im = Image.open(p).convert("RGB")
                    scale = cell_w / im.width
                    thumbs[(view, label)] = im.resize((cell_w, int(im.height * scale)))
        cell_h = max((im.height for im in thumbs.values()), default=0) + label_h
        sheet = Image.new("RGB", (cell_w * len(VIEWPORTS), cell_h * len(VIEWS)), (20, 20, 26))
        draw = ImageDraw.Draw(sheet)
        for ri, view in enumerate(VIEWS):
            for ci, (label, _w, _h, _d) in enumerate(VIEWPORTS):
                im = thumbs.get((view, label))
                if not im:
                    continue
                x, y = ci * cell_w, ri * cell_h
                # Plain hyphen: PIL's default font has no em-dash glyph.
                draw.text((x + 6, y + 6), f"{view} - {label}", fill=(255, 255, 255))
                sheet.paste(im, (x, y + label_h))
        sheet.save(out / "contact_sheet.png")
    except Exception as e:  # noqa: BLE001 — a sheet failure must fail the audit, loudly
        failures.append(f"contact sheet failed: {e}")
    (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if failures:
        print("UI AUDIT FAILED:")
        for f in failures:
            print(" - " + f)
        return 1
    print("UI AUDIT PASS — all screens, all viewports, all checks green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
