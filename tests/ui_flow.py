"""End-to-end flow in a real browser. Needs a running app + mock Immich + fake card.

    python tests/fake_immich.py &
    python tests/synthetic.py /tmp/ss-vol/SS-CARD/DCIM/100MEDIA 8     # or tests/make_card.sh
    # /tmp/ss-home/config.json: {"library": "/tmp/ss-lib", "immich_url": "http://127.0.0.1:2283",
    #                            "immich_key": "testkey", "learning_enabled": false}
    SLIDESTATION_HOME=/tmp/ss-home SLIDESTATION_VOLUMES=/tmp/ss-vol SLIDESTATION_NO_BROWSER=1 \
        uv run --python 3.12 python -m slidestation &
    uv run --with playwright python tests/ui_flow.py

Covers: import from the card, browse, rotate, colour edits, the tone curve's Fit (F), crop and
straighten (K, Enter), undo / redo (Ctrl/Cmd+Z), split view (Y), hold-B before, Develop (Space),
upload, clean the card; asserts no console errors and prints timings.

Env: SS_APP (default http://localhost:8765), SS_SHOTS (screenshot folder, default /tmp/ss-shots),
SS_BROWSER_CHANNEL=chrome to use the installed Chrome instead of `playwright install chromium`,
SS_BROWSER_PATH=/path/to/chrome for any other Chromium build (e.g. one that doesn't match the
Playwright version). Selectors are roles and labels, so they survive markup changes in the React UI.
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


def expect_slide(pg, n):
    """The stage header reads "4 / 12" (with a screen-reader "Slide " in front)."""
    expect(pg.get_by_text(re.compile(rf"^Slide {n} / \d+$"))).to_be_visible()


def group(pg, sid, i):
    return pg.evaluate(f"fetch('/api/sessions/{sid}').then(r=>r.json())")["groups"][i]


def settled(pg, sid, i, check, timeout=5000):
    """Poll the server until slide i satisfies check (edits are debounced and saved async)."""
    g = None
    for _ in range(timeout // 100):
        g = group(pg, sid, i)
        if check(g):
            return g
        pg.wait_for_timeout(100)
    raise AssertionError(g)


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("SS_BROWSER_CHANNEL") or None,
                                    executable_path=os.environ.get("SS_BROWSER_PATH") or None)
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
        expect_slide(pg, 4)

        pg.keyboard.press("r")  # rotate
        sid = pg.evaluate("localStorage.getItem('session')")
        settled(pg, sid, 3, lambda g: g["rot_reason"] == "manual")
        # colour edit: warmth is a 2D pad now, typed into its value field (in hundredths)
        warmth = pg.get_by_label("Warmth value")
        warmth.fill("40")
        warmth.press("Enter")
        settled(pg, sid, 3, lambda g: abs(g["params"]["warmth"] - 0.4) < 1e-6 and g["params_source"] == "manual")

        # Rapid slider moves: the preview must settle on the server's saved render. Previews are
        # cached forever by key, so one rendered before its edit was saved would stay wrong.
        sat = pg.get_by_role("slider", name="Saturation")
        for v in ("-0.5", "-0.6", "-0.7", "-0.8", "-0.85"):
            sat.fill(v)
            pg.wait_for_timeout(40)
        pg.wait_for_timeout(1500)
        wait_preview(pg)
        g = group(pg, sid, 3)
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
        expect_slide(pg, 5)
        pg.keyboard.press("ArrowLeft")
        expect_slide(pg, 4)
        g = group(pg, sid, 3)
        assert abs(g["params"]["saturation"] + 0.85) < 1e-6, g["params"]
        pg.keyboard.press("2")  # drop a scan from the stack, if there is one
        pg.wait_for_timeout(1200)
        pg.keyboard.down("b")  # hold B for before
        expect(pg.get_by_text("BEFORE", exact=True)).to_be_visible()
        pg.keyboard.up("b")
        expect(pg.get_by_text("BEFORE", exact=True)).to_have_count(0)

        # tone curve: F fits each colour channel to the scan and hands over from auto restore
        pg.keyboard.press("f")
        g = settled(pg, sid, 3, lambda g: set(g["params"]["curves"]) == {"r", "g", "b"})
        assert g["params"]["strength"] == 0, g["params"]
        expect(pg.get_by_text("by the tone curve")).to_be_visible()
        wait_preview(pg)

        # crop and straighten: K opens the tool on the uncropped photo, Enter keeps the frame
        t0 = time.time()
        pg.keyboard.press("k")
        bar = pg.get_by_role("toolbar", name="Crop and straighten")
        expect(bar).to_be_visible()
        wait_preview(pg)
        bar.get_by_role("radio", name="1:1").click()
        bar.get_by_role("slider", name="Straighten angle").fill("2")
        pg.screenshot(path=SHOTS / "crop.png")
        pg.keyboard.press("Enter")
        expect(bar).to_have_count(0)
        g = settled(pg, sid, 3, lambda g: g["params"]["crop"] and g["params"]["angle"] == 2)
        l, t, r, b = g["params"]["crop"]
        print(f"crop {g['params']['crop']}, {time.time() - t0:.2f}s")
        wait_preview(pg)

        # undo / redo: Ctrl+Z (Cmd+Z on a Mac) steps the slide's history, a crop is one step
        undo = pg.get_by_role("button", name="Undo", exact=True)
        expect(undo).to_be_enabled()
        pg.keyboard.press("ControlOrMeta+z")
        settled(pg, sid, 3, lambda g: g["params"]["crop"] is None)
        pg.keyboard.press("ControlOrMeta+Shift+z")
        settled(pg, sid, 3, lambda g: g["params"]["crop"] == [l, t, r, b])
        expect(pg.get_by_role("button", name="Redo", exact=True)).to_be_disabled()
        wait_preview(pg)

        # split view: Y shows before | after with a divider
        pg.keyboard.press("y")
        expect(pg.get_by_text("After", exact=True)).to_be_visible()
        pg.screenshot(path=SHOTS / "split.png")
        pg.keyboard.press("y")
        expect(pg.get_by_text("After", exact=True)).to_have_count(0)

        develop = pg.get_by_role("button", name="Develop and go to next")
        expect(develop).to_be_visible()
        pg.keyboard.press(" ")  # develop -> next
        expect_slide(pg, 5)
        settled(pg, sid, 3, lambda g: g["reviewed"])
        pg.keyboard.press("ArrowLeft")
        expect(pg.get_by_role("button", name=re.compile(r"^Developed"))).to_be_visible()
        pg.keyboard.press("ArrowRight")
        pg.keyboard.press("?")
        expect(pg.get_by_role("dialog", name="Keyboard")).to_be_visible()
        pg.keyboard.press("Escape")
        pg.screenshot(path=SHOTS / "edited.png")

        pg.get_by_role("button", name=re.compile(r"^Upload all \d+$")).click()
        confirm(pg, "Upload anyway")  # most slides are undeveloped
        print("upload:", wait_job(pg)["message"])
        pg.wait_for_timeout(2500)
        expect(pg.get_by_role("button", name="Everything is in Immich")).to_be_visible()
        pg.get_by_role("button", name="Clean card").click()
        confirm(pg, "Delete from card")
        print("cleanup:", wait_job(pg)["message"])
        pg.wait_for_timeout(2500)
        expect(pg.get_by_role("button", name="Card cleaned")).to_be_visible()
        pg.screenshot(path=SHOTS / "done.png")
        assert not errors, errors
        print("no console errors")
        browser.close()


if __name__ == "__main__":
    main()
