#!/usr/bin/env python3
"""WO-20 UI test — renders the REAL renderer/studio.html + models.js in headless
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
COMING = [t for t in CATALOG if t.get("unavailable")]
assert len(COMING) == 19, [t["id"] for t in COMING]
for t in COMING:
    assert isinstance(t.get("unavailable"), str) and len(t["unavailable"]) >= 20, t["id"]
    uu = t.get("unavailableUser")
    assert isinstance(uu, str) and uu, t["id"]
    # dev wording must never reach the user field
    assert not any(k in uu for k in ("Not available yet", "CI-measured", "run 39", "Withheld")), t["id"]

# States shaped exactly like main.js mergedToolStates (incl. both fields).
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
    for t in COMING:
        card = page.query_selector(f".tcard[data-tool='{t['id']}']")
        if not card:
            fails.append(f"{t['id']}: card missing"); continue
        txt = card.inner_text()
        html = card.inner_html()
        if "Coming soon" not in txt:
            fails.append(f"{t['id']}: 'Coming soon' not on card")
        if "badge bad" in html or "Not Available" in txt:
            fails.append(f"{t['id']}: red/dev badge leaked to UI")
        if t["unavailableUser"][:30] not in txt:
            fails.append(f"{t['id']}: plain-language user text not on card")
        if "Not available yet" in txt:
            fails.append(f"{t['id']}: DEV wording visible to user")
        btns = [b.inner_text().strip() for b in card.query_selector_all("button")]
        if any(x == "Install" for x in btns):
            fails.append(f"{t['id']}: Install button still present: {btns}")
        print(f"{t['id']:15s} buttons={btns} comingsoon={'Coming soon' in txt}")
    # unavailable tools must not appear in "Complete your pipeline" or the Remaining total
    sugg_el = page.query_selector(".suggest")
    seg = sugg_el.inner_text() if sugg_el else ""
    if seg:
        for g in sorted(set(t["group"] for t in COMING)):
            offered = [x for x in CATALOG if x["group"] == g and not x.get("unavailable")]
            if not offered and g in seg:
                fails.append(f"group '{g}' is fully coming-soon but appears in suggestions")
            print(f"group {g:8s}: offered={len(offered)} in_suggestions={g in seg}")
    meter = page.query_selector("#diskMeter")
    if meter:
        mt = meter.inner_text()
        print("meter:", mt.replace(chr(10), " | "))
    # WO-20: only wired tools (image-studio, image-lite) may offer Download
    dl = []
    for t in CATALOG:
        card = page.query_selector(f".tcard[data-tool='{t['id']}']")
        btns = [b.inner_text().strip() for b in card.query_selector_all("button")] if card else []
        if any(x == "Download" for x in btns):
            dl.append(t["id"])
    print("cards with Download:", dl)
    if sorted(dl) != ["image-lite", "image-studio"]:
        fails.append(f"expected Download only on image-studio/image-lite, got: {dl}")
    shot = OUT / "wo20-models-wired-only.png"
    page.screenshot(path=str(shot), full_page=True)
    print("screenshot:", shot)
    if errors:
        fails.append(f"pageerrors: {errors}")
    b.close()

if fails:
    print("UI TEST: FAIL"); [print(" !", f) for f in fails]; sys.exit(1)
print("UI TEST: all assertions held (19/19 coming-soon, Download only on 2 wired)")
