#!/usr/bin/env python3
"""studio-shots.py — user-eye gate for the Studio empty state.

Renders studio.html headlessly with a mocked window.takeone IPC surface,
in both variants (zero tools installed / some tools installed), screenshots
each, and FAILS on any JS pageerror or missing CTA.

Usage:
    ~/workspace/.wizevenv/bin/python test/studio-shots.py [--out DIR]
Exit 0 = both variants rendered clean. Exit 1 = render error / missing CTA.
"""
import argparse, json, sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
STUDIO_HTML = HERE.parent / "renderer" / "studio.html"
CHROME = "/opt/meta-chromium/chrome"

MOCK_JS = """
(() => {
  const INSTALLED = __INSTALLED__;
  const STATES = {};
  for (const id of INSTALLED) STATES[id] = { state: 'installed' };
  window.takeone = {
    getConfig: async () => ({ storageRoot: 'C:\\\\TakeOne', pcCheck: {}, niche: 'none' }),
    listProjects: async () => ({ ok: true, projects: [] }),
    getTaste: async () => ({ ok: true, rules: [] }),
    catalog: async () => ({ ok: true, catalog: [] }),
    listTrash: async () => ({ ok: true, trash: [] }),
    checkOnline: async () => ({ online: true }),
    resumeState: async () => ({ ok: false }),
    toolStates: async () => ({ ok: true, states: STATES }),
    getProject: async () => ({ ok: false }),
    createProject: async () => ({ ok: false, reason: 'mock' }),
    displayPath: async (p) => p,
    showInFolder: async () => ({ ok: true }),
  };
})();
"""


def render_variant(page, installed, out, name):
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(MOCK_JS.replace("__INSTALLED__", json.dumps(installed)))
    page.goto(STUDIO_HTML.as_uri())
    page.wait_for_timeout(1200)
    shot = out / f"studio-empty-{name}.png"
    page.screenshot(path=str(shot))
    body_text = page.evaluate("() => document.querySelector('#studioBody').innerText")
    fails = list(errors)
    # CTAs that must exist and be clickable — no dead ends, no black screens
    for sel, label in [("#npScript", "Start from a script"), ("#npCreate", "New project")]:
        el = page.query_selector(sel)
        if not el or not el.is_visible():
            fails.append(f"{name}: CTA missing: {label}")
    if installed == [] and not page.query_selector("#npTools"):
        fails.append(f"{name}: no-tools variant must show 'Browse AI tools'")
    if "No project yet" not in body_text and "Your studio is ready" not in body_text:
        fails.append(f"{name}: empty hero headline missing")
    # no fake screens: must not show demo project names
    for fake in ["Pompeii", "Echoes"]:
        if fake in body_text:
            fails.append(f"{name}: fake demo content leaked: {fake}")
    print(f"variant {name:10s} -> {shot.name}  [{'FAIL' if fails else 'OK'}]")
    for f in fails:
        print("   !", f)
    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/studio-shots")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME,
                                    args=["--no-sandbox", "--disable-gpu"])
        failures += render_variant(browser.new_page(viewport={"width": 1440, "height": 900}),
                                   [], out, "no-tools")
        failures += render_variant(browser.new_page(viewport={"width": 1440, "height": 900}),
                                   ["image-studio", "voice-studio"], out, "with-tools")
        browser.close()
    print("---")
    if failures:
        print(f"FAIL: {len(failures)} problem(s)")
        return 1
    print(f"PASS: empty state renders clean in both variants -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
