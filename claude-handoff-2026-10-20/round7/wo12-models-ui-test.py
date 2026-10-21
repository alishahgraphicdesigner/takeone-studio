#!/usr/bin/env python3
"""WO-12 UI test — renders the REAL renderer/studio.html + models.js in headless
Chromium with a mocked window.takeone IPC surface fed by the REAL catalog
(main/catalog.js dumped to JSON by node) and states shaped exactly like
main.js mergedToolStates output (incl. the WO-12 `unavailable` field).
Asserts: every pip tool card shows "Not Available", has NO Install button,
and the reason text is on the card. Saves a screenshot.
Exit 0 = all assertions hold."""
import json, subprocess, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

REPO = Path.home() / "workspace" / "takeone-v22"
OUT = Path("/tmp/wo-runs")
CHROME = "/opt/meta-chromium/chrome"

cat = subprocess.run(["node", "-e",
    "const {CATALOG}=require(process.argv[1]); console.log(JSON.stringify(CATALOG))",
    str(REPO / "main" / "catalog.js")], capture_output=True, text=True, check=True)
CATALOG = json.loads(cat.stdout)
PIP = [t for t in CATALOG if t.get("installType") == "pip"]
assert len(PIP) == 5, PIP
for t in PIP:
    assert isinstance(t.get("unavailable"), str) and len(t["unavailable"]) >= 20, t["id"]

# States shaped like mergedToolStates. Deliberately OMIT `unavailable` for
# voice-studio so the renderer's catalog fallback (tool.unavailable) is also
# exercised; the other four carry it in state, as main.js now sends it.
STATES = {}
for t in CATALOG:
    STATES[t["id"]] = {"state": "not-installed", "progress": 0, "error": None,
                       "detail": None, "gateOk": True, "gateReason": None,
                       "gateWhy": None, "deps": [], "verifiedAt": None, "speedBps": 0,
                       "unavailable": None if t["id"] == "voice-studio" else (t.get("unavailable") or None)}

MOCK_JS = """
(() => {
  const CATALOG = __CATALOG__;
  const STATES = __STATES__;
  window.takeone = {
    getConfig: async () => ({ storageRoot: 'C:\\\\TakeOne', pcCheck: { speedMbps: 100 } }),
    catalog: async () => ({ ok: true, catalog: CATALOG }),
    toolStates: async () => ({ ok: true, states: STATES }),
    checkOnline: async () => ({ online: true }),
    diskFree: async () => 500,
    displayPath: async (p) => p,
    listProjects: async () => ({ ok: true, projects: [] }),
    listTrash: async () => ({ ok: true, trash: [] }),
    getTaste: async () => ({ ok: true, rules: [] }),
    resumeState: async () => ({ ok: false }),
    getProject: async () => ({ ok: false }),
    onDlEvent: () => {}, onDepEvent: () => {},
  };
})();
"""

fails = []
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
    for t in PIP:
        card = page.query_selector(f".tcard[data-tool='{t['id']}']")
        if not card:
            fails.append(f"{t['id']}: card missing"); continue
        txt = card.inner_text()
        if "Not Available" not in txt:
            fails.append(f"{t['id']}: 'Not Available' not on card")
        if t["unavailable"][:40] not in txt:
            fails.append(f"{t['id']}: reason text not on card")
        btns = [b.inner_text().strip() for b in card.query_selector_all("button")]
        if any(x == "Install" for x in btns):
            fails.append(f"{t['id']}: Install button still present: {btns}")
        print(f"{t['id']:15s} buttons={btns} notavailable={'Not Available' in txt}")
    # a non-pip card must still offer its normal action (no blanket breakage)
    brain = page.query_selector(".tcard[data-tool='brain']")
    if brain:
        bt = [b.inner_text().strip() for b in brain.query_selector_all("button")]
        print("brain buttons:", bt)
    shot = OUT / "wo12-models-not-available.png"
    page.screenshot(path=str(shot), full_page=True)
    print("screenshot:", shot)
    if errors:
        fails.append(f"pageerrors: {errors}")
    b.close()

if fails:
    print("UI TEST: FAIL"); [print(" !", f) for f in fails]; sys.exit(1)
print("UI TEST: all assertions held (5/5 pip cards)")
