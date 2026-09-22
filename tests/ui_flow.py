"""End-to-end flow in a real browser. Needs a running app + mock Immich + fake card.

    python tests/fake_immich.py &
    tests/make_card.sh <folder-with-scans> 20
    SLIDESTATION_HOME=/tmp/ss-home SLIDESTATION_VOLUMES=/tmp SLIDESTATION_NO_BROWSER=1 \
        uv run --python 3.12 python -m slidestation &
    uv run --with playwright python tests/ui_flow.py

Env: SS_APP (default http://localhost:8765), SS_SHOTS (screenshot folder, default /tmp/ss-shots),
SS_BROWSER_CHANNEL=chrome to use the installed Chrome instead of `playwright install chromium`.
Selectors are roles and labels, so they survive markup changes in the React UI.
"""
import os
import re
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

APP = os.environ.get("SS_APP", "http://localhost:8765")
SHOTS = Path(os.environ.get("SS_SHOTS", "/tmp/ss-shots"))


def wait_job(pg, timeout=900):
    for _ in range(timeout):
        pg.wait_for_timeout(1000)
        job = pg.evaluate("fetch('/api/state').then(r=>r.json())")["job"]
        if job and job["finished"]:
            assert not job["error"], job["error"]
            return job
    raise TimeoutError("job did not finish")


def wait_preview(pg):
    pg.wait_for_timeout(50)
    expect(pg.get_by_test_id("preview-loading")).to_have_count(0, timeout=30000)


def confirm(pg, name):
    pg.get_by_role("alertdialog").get_by_role("button", name=name).click()


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("SS_BROWSER_CHANNEL") or None)
        pg = browser.new_page(viewport={"width": 1512, "height": 900})
        errors = []
        pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
        pg.on("pageerror", lambda e: errors.append(str(e)))

        pg.goto(APP)
        pg.get_by_role("button", name=re.compile(r"^Import \d+ scans? from")).click()
        dlg = pg.get_by_role("dialog")
        dlg.get_by_label("Name", exact=True).fill("Test tray")
        dlg.get_by_label("Name", exact=True).press("Enter")  # Enter submits the form
        print("import:", wait_job(pg)["message"])
        pg.wait_for_timeout(2000)
        wait_preview(pg)
        pg.screenshot(path=SHOTS / "review.png")

        t0 = time.time()
        for _ in range(3):
            pg.keyboard.press("ArrowRight")
            wait_preview(pg)
        print(f"browsing 3 slides: {time.time() - t0:.2f}s")
        expect(pg.get_by_text(re.compile(r"^Slide 4 of \d+$"))).to_be_visible()

        pg.keyboard.press("r")  # rotate
        pg.wait_for_timeout(800)
        sid = pg.evaluate("localStorage.getItem('session')")
        g = pg.evaluate(f"fetch('/api/sessions/{sid}').then(r=>r.json())")["groups"][3]
        assert g["rot_reason"] == "manual", g
        pg.get_by_role("slider", name="Warmth").fill("0.4")  # colour edit
        pg.wait_for_timeout(1000)
        expect(pg.get_by_text("Adjusted by hand")).to_be_visible()

        # Rapid slider moves: the preview must settle on the server's saved render. Previews are
        # cached forever by key, so one rendered before its edit was saved would stay wrong.
        sat = pg.get_by_role("slider", name="Saturation")
        for v in ("-0.5", "-0.6", "-0.7", "-0.8", "-0.85"):
            sat.fill(v)
            pg.wait_for_timeout(40)
        pg.wait_for_timeout(1500)
        wait_preview(pg)
        g = pg.evaluate(f"fetch('/api/sessions/{sid}').then(r=>r.json())")["groups"][3]
        assert abs(g["params"]["saturation"] + 0.85) < 1e-6, g["params"]
        src = pg.get_by_role("img", name="Slide 4").get_attribute("src")
        assert f"v={g['key']}" in src, (src, g["key"])
        cc = pg.evaluate(
            f"fetch('/api/sessions/{sid}/groups/{g['id']}/preview.jpg?size=320&v=stale').then(r=>r.headers.get('cache-control'))"
        )
        assert cc == "no-store", cc
        # arrows move between slides even with a slider focused (they don't nudge it)
        sat.focus()
        pg.keyboard.press("ArrowRight")
        expect(pg.get_by_text(re.compile(r"^Slide 5 of \d+$"))).to_be_visible()
        pg.keyboard.press("ArrowLeft")
        expect(pg.get_by_text(re.compile(r"^Slide 4 of \d+$"))).to_be_visible()
        g = pg.evaluate(f"fetch('/api/sessions/{sid}').then(r=>r.json())")["groups"][3]
        assert abs(g["params"]["saturation"] + 0.85) < 1e-6, g["params"]
        pg.keyboard.press("2")  # drop a scan from the stack, if there is one
        pg.wait_for_timeout(1200)
        pg.keyboard.down("b")  # hold B for before
        expect(pg.get_by_text("BEFORE", exact=True)).to_be_visible()
        pg.keyboard.up("b")
        expect(pg.get_by_text("BEFORE", exact=True)).to_have_count(0)
        pg.keyboard.press(" ")  # approve -> next
        pg.wait_for_timeout(1200)
        expect(pg.get_by_text(re.compile(r"^Slide 5 of \d+$"))).to_be_visible()
        pg.keyboard.press("?")
        expect(pg.get_by_role("dialog", name="Keyboard")).to_be_visible()
        pg.keyboard.press("Escape")
        pg.screenshot(path=SHOTS / "edited.png")

        pg.get_by_role("button", name=re.compile(r"^Upload \d+ slides? to Immich")).click()
        confirm(pg, "Upload anyway")  # most slides are unreviewed
        print("upload:", wait_job(pg)["message"])
        pg.wait_for_timeout(2500)
        expect(pg.get_by_role("button", name="Everything is in Immich")).to_be_visible()
        pg.get_by_role("button", name="Clean scanner card").click()
        confirm(pg, "Delete from card")
        print("cleanup:", wait_job(pg)["message"])
        pg.wait_for_timeout(2500)
        expect(pg.get_by_text("Card cleaned")).to_be_visible()
        pg.screenshot(path=SHOTS / "done.png")
        assert not errors, errors
        print("no console errors")
        browser.close()


if __name__ == "__main__":
    main()
