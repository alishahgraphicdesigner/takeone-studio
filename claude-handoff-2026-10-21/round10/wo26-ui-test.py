#!/usr/bin/env python3
"""WO-26 UI test — the Image Studio card's one-click engine+model chain.
Drives all 7 states through window.__engineUI with fake engine events (no IPC):
idle, downloading, verifying, installing, ready, failed, cancelled.
Asserts each state's user-facing text and runs the audit's dev-jargon regex
over every UI string. Saves a screenshot per state. Exit 0 = all hold."""
import json, re, subprocess, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

REPO = Path.home() / "workspace" / "takeone-v22"
OUT = Path("/tmp/wo-runs"); OUT.mkdir(parents=True, exist_ok=True)
CHROME = "/opt/meta-chromium/chrome"

cat = subprocess.run(["node", "-e",
    "const {CATALOG}=require(process.argv[1]); console.log(JSON.stringify(CATALOG))",
    str(REPO / "main" / "catalog.js")], capture_output=True, text=True, check=True)
CATALOG = json.loads(cat.stdout)
STUDIO = next(t for t in CATALOG if t["id"] == "image-studio")
assert not STUDIO.get("unavailable"), "image-studio must be offered for WO-26"

STATES = {}
for t in CATALOG:
    STATES[t["id"]] = {"state": "not-installed", "progress": 0, "error": None,
                       "detail": None, "gateOk": True, "gateReason": None,
                       "gateWhy": None, "deps": [], "verifiedAt": None, "speedBps": 0,
                       "unavailable": t.get("unavailable") or None,
                       "unavailableUser": t.get("unavailableUser") or None}

MOCK_JS = """
(() => {
  const CATALOG = __CATALOG__;
  const STATES = __STATES__;
  window.__dlStarts = [];
  window.takeone = {
    getConfig: async () => ({ storageRoot: 'C:\\\\TakeOne', pcCheck: { speedMbps: 100 } }),
    catalog: async () => ({ ok: true, catalog: CATALOG }),
    toolStates: async () => ({ ok: true, states: STATES }),
    checkOnline: async () => ({ online: true }),
    diskFree: async () => 500,
    displayPath: async (p) => p,
    engineStatus: async () => ({ ok: true, ready: false }),
    engineInstall: async () => ({ ok: true }),
    engineCancel: async () => ({ ok: true }),
    dlStart: async (id) => { window.__dlStarts.push(id); return { ok: true }; },
    listProjects: async () => ({ ok: true, projects: [] }),
    listTrash: async () => ({ ok: true, trash: [] }),
    getTaste: async () => ({ ok: true, rules: [] }),
    resumeState: async () => ({ ok: false }),
    getProject: async () => ({ ok: false }),
    onEngineEvent: () => {},
    onDlEvent: () => {}, onDepEvent: () => {},
  };
})();
"""

# audit-catalog.js v4 dev-jargon regex (must never appear in UI text)
JARGON = re.compile(r"\b(run\s*#?\d+|CI|WO-?\d+|pip|PyPI|torch|cu\d{3}|venv|sha-?256|import|ModuleNotFound|stack ?trace|exit code|rc=\d+)\b|==|\.py\b", re.I)

fails = []
def check(name, cond, detail=""):
    if not cond:
        fails.append(f"{name}: {detail or 'assertion failed'}")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    page = b.new_page(viewport={"width": 1280, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(MOCK_JS.replace("__CATALOG__", json.dumps(CATALOG)).replace("__STATES__", json.dumps(STATES)))
    page.goto((REPO / "renderer" / "studio.html").as_uri())
    page.wait_for_timeout(800)
    page.click("button[data-view='models']")
    page.wait_for_timeout(1500)

    card_sel = ".tcard[data-tool='image-studio']"
    page.wait_for_selector(card_sel)
    card = page.query_selector(card_sel)
    check("hook", page.evaluate("typeof window.__engineUI !== 'undefined'"), "window.__engineUI missing")

    def shot(state):
        el = page.query_selector(card_sel)
        el.scroll_into_view_if_needed()
        el.screenshot(path=str(OUT / f"wo26-{state}.png"))

    def text():
        return page.query_selector(card_sel).inner_text()

    # 1. idle
    page.evaluate("window.__engineUI.reset('image-studio')")
    page.wait_for_timeout(300)
    t = text()
    check("idle-install", "Install" in t, t[:200])
    check("idle-sizes", "10.1 GB" in t and "3.5 GB" in t and "6.6 GB" in t, t[:300])
    check("idle-disk", "19 GB free" in t, t[:300])
    check("idle-no-download-btn", t.count("Download") == 0, "normal Download button leaked")
    shot("idle")

    # 2. downloading (Step 1 of 2, GB)
    page.evaluate("window.__engineUI.event('image-studio', {type:'phase', phase:'downloading'})")
    page.evaluate("window.__engineUI.event('image-studio', {type:'download', progress:0.35, doneBytes:1200000000, totalBytes:3500000000})")
    page.wait_for_timeout(300)
    t = text()
    check("downloading-step", "Step 1 of 2" in t, t[:200])
    check("downloading-gb", "GB of" in t and "Downloading the engine" in t, t[:200])
    check("downloading-cancel", "Cancel" in t, t[:200])
    shot("downloading")

    # 3. verifying
    page.evaluate("window.__engineUI.event('image-studio', {type:'phase', phase:'verifying'})")
    page.wait_for_timeout(300)
    t = text()
    check("verifying", "Checking the engine files" in t, t[:200])
    shot("verifying")

    # 4. installing (bytes-weighted bar, i/86)
    page.evaluate("window.__engineUI.event('image-studio', {type:'wheel', index:3, count:86, doneBytes:100000000, totalBytes:3500000000})")
    page.wait_for_timeout(300)
    t = text()
    check("installing-part", "part 3 of 86" in t, t[:200])
    check("installing-step", "Step 1 of 2" in t, t[:200])
    bar = page.query_selector(f"{card_sel} .prog i")
    check("installing-bar", bar is not None, "no progress bar")
    shot("installing")

    # 5. ready (auto-starts model = Step 2 of 2)
    page.evaluate("window.__engineUI.event('image-studio', {type:'phase', phase:'ready'})")
    page.wait_for_timeout(300)
    t = text()
    check("ready", "Engine ready" in t and "Step 2 of 2" in t, t[:200])
    check("ready-autostart", page.evaluate("window.__dlStarts.includes('image-studio')"), "model dlStart not called")
    shot("ready")

    # 6. failed (WHY + WHAT NEXT, plain words)
    page.evaluate("""window.__engineUI.set('image-studio', {phase:'failed',
      why:'Not enough free disk space. The engine needs about 12.2 GB free.',
      whatNext:'Free up some disk space and try again. Nothing was installed.'})""")
    page.wait_for_timeout(300)
    t = text()
    check("failed-why", "Didn\u2019t work." in t and "12.2 GB free" in t, t[:300])
    check("failed-whatnext", "What to do:" in t and "Free up some disk space" in t, t[:300])
    check("failed-retry", "Try again" in t, t[:200])
    shot("failed")

    # 7. cancelled
    page.evaluate("window.__engineUI.set('image-studio', {phase:'cancelled'})")
    page.wait_for_timeout(300)
    t = text()
    check("cancelled", "Cancelled." in t and "resumes where it stopped" in t, t[:300])
    shot("cancelled")

    # jargon regex over ALL states' UI text
    for state in ["idle", "downloading", "verifying", "installing", "ready", "failed", "cancelled"]:
        page.evaluate(f"window.__engineUI.reset('image-studio')")
        page.wait_for_timeout(150)
        if state == "downloading":
            page.evaluate("window.__engineUI.event('image-studio', {type:'download', progress:0.5, doneBytes:1500000000, totalBytes:3500000000})")
        elif state == "verifying":
            page.evaluate("window.__engineUI.event('image-studio', {type:'phase', phase:'verifying'})")
        elif state == "installing":
            page.evaluate("window.__engineUI.event('image-studio', {type:'wheel', index:40, count:86, doneBytes:1500000000, totalBytes:3500000000})")
        elif state == "ready":
            page.evaluate("window.__engineUI.event('image-studio', {type:'phase', phase:'ready'})")
        elif state == "failed":
            page.evaluate("window.__engineUI.set('image-studio', {phase:'failed', why:'Not enough free disk space.', whatNext:'Free up some disk space and try again.'})")
        elif state == "cancelled":
            page.evaluate("window.__engineUI.set('image-studio', {phase:'cancelled'})")
        page.wait_for_timeout(150)
        txt = page.query_selector(card_sel).inner_text()
        m = JARGON.search(txt)
        check(f"jargon-{state}", not m, f"dev wording in UI: {m.group(0) if m else ''} :: {txt[:200]}")

    # chain hidden when engine already ready / tool installed
    page.evaluate("window.__engineUI.setReady(true)")
    page.wait_for_timeout(300)
    t = text()
    check("chain-hidden-when-ready", "Step 1 of 2" not in t and "One click installs" not in t, t[:200])

    check("page-errors", not errors, "; ".join(errors[:3]))
    b.close()

print("FAILURES:" if fails else "WO-26 UI TEST: ALL PASS")
for f in fails:
    print(" -", f)
sys.exit(1 if fails else 0)
