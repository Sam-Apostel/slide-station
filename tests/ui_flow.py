"""End-to-end flow in a real browser. Needs a running app + mock Immich + fake card.

    python tests/fake_immich.py &
    tests/make_card.sh <folder-with-scans> 20
    SLIDESTATION_HOME=/tmp/ss-home SLIDESTATION_VOLUMES=/tmp SLIDESTATION_NO_BROWSER=1 \
        uv run --python 3.12 python -m slidestation &
    uv run --with playwright python tests/ui_flow.py
"""
import time

from playwright.sync_api import sync_playwright

APP = "http://localhost:8765"
SHOTS = "/tmp/ss-shots/"


def wait_job(pg, timeout=900):
    for _ in range(timeout):
        pg.wait_for_timeout(1000)
        job = pg.evaluate("fetch('/api/state').then(r=>r.json())")["job"]
        if job and job["finished"]:
            assert not job["error"], job["error"]
            return job
    raise TimeoutError("job did not finish")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 1512, "height": 900})
        errors = []
        pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("dialog", lambda d: d.accept())

        pg.goto(APP)
        pg.wait_for_timeout(2500)
        pg.click("#emptyHint button, #importBtn")
        pg.wait_for_timeout(300)
        pg.fill("#nName", "Test tray")
        pg.click("#nOk")
        print("import:", wait_job(pg)["message"])
        pg.wait_for_timeout(2000)
        pg.screenshot(path=SHOTS + "review.png")

        t0 = time.time()
        for _ in range(3):
            pg.keyboard.press("ArrowRight")
            pg.wait_for_function("document.getElementById('spinner').hidden", timeout=30000)
        print(f"browsing 3 slides: {time.time() - t0:.2f}s")

        pg.keyboard.press("r")                       # rotate
        pg.wait_for_timeout(1200)
        pg.fill("#p_warmth", "0.4")                  # colour edit
        pg.dispatch_event("#p_warmth", "input")
        pg.wait_for_timeout(2000)
        pg.keyboard.press("2")                       # drop a scan from the stack
        pg.wait_for_timeout(1200)
        pg.keyboard.press(" ")                       # approve
        pg.wait_for_timeout(1200)

        pg.click("#uploadBtn")
        print("upload:", wait_job(pg)["message"])
        pg.click("#cleanBtn")
        print("cleanup:", wait_job(pg)["message"])
        pg.screenshot(path=SHOTS + "done.png")
        assert not errors, errors
        print("no console errors")
        browser.close()


if __name__ == "__main__":
    main()
