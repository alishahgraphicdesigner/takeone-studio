#!/usr/bin/env python3
"""wo43-img-check.py — WO-43 renderer proof in the REAL Electron (CDP, WO-37 method).

The v2.2.17 renderer loaded Quick Generate images straight from
http://127.0.0.1:<port>/view, which rendered as a broken image on Ali's PC.
v2.2.18 hands the renderer a dataUrl instead. This check proves a dataUrl
image actually renders in the real Electron runtime: it launches the app
headlessly, opens a fresh page over CDP, injects an <img> with a dataUrl,
and FAILS unless img.naturalWidth > 0.

Usage:
    ~/workspace/.wizevenv/bin/python test/wo43-img-check.py
Exit 0 = dataUrl image renders (naturalWidth > 0). Exit 1 = anything else.
"""
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parent
ELECTRON = APP_DIR / "node_modules" / ".bin" / "electron"
PORT = 9223

# 1x1 transparent PNG — the same bytes the unit tests serve from fake ComfyUI.
DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def wait_for_cdp(timeout_s=40):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://localhost:{PORT}/json/version", timeout=2)
            return True
        except Exception:
            time.sleep(1)
    return False


def main():
    from playwright.sync_api import sync_playwright

    if not ELECTRON.exists():
        print(f"FAIL: electron binary not found: {ELECTRON}")
        return 1
    proc = subprocess.Popen(
        ["xvfb-run", "-a", str(ELECTRON), ".", "--no-sandbox",
         f"--remote-debugging-port={PORT}"],
        cwd=str(APP_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    try:
        if not wait_for_cdp():
            print("FAIL: Electron CDP port did not come up")
            return 1
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(f"http://localhost:{PORT}")
            # WO-37 method: Electron refuses a fresh browser context over
            # CDP, so reuse an existing app window (the last page) instead
            # of browser.new_page(). set_content replaces its document;
            # the app is killed right after, so nothing persists.
            pages = []
            for _ in range(20):
                pages = browser.contexts[0].pages if browser.contexts else []
                if pages:
                    break
                time.sleep(1)
            if not pages:
                print("FAIL: no app pages found over CDP")
                return 1
            page = pages[-1]
            page.set_content(f'<img id="t" src="{DATA_URL}">')
            page.wait_for_function(
                "() => { const i = document.getElementById('t'); return i.complete && i.naturalWidth > 0; }",
                timeout=15000)
            w, h = page.evaluate(
                "() => { const i = document.getElementById('t'); return [i.naturalWidth, i.naturalHeight]; }")
            print(f"dataUrl img: naturalWidth={w} naturalHeight={h}")
            if not (w > 0 and h > 0):
                print("FAIL: dataUrl image did not render (naturalWidth 0)")
                return 1
            print("PASS — dataUrl image renders in real Electron")
            return 0
    finally:
        # Process-group kill: terminating xvfb-run alone orphans Electron.
        try:
            import os, signal
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            try:
                import os, signal
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
