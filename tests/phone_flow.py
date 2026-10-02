"""The browser-only version on phones (frontend `npm run build:web`), in headless Chromium.

    (cd frontend && npm run build:web)
    uv run --python 3.12 --with playwright --with fastapi --with uvicorn --with python-multipart \\
        --with numpy --with pillow python tests/phone_flow.py

Imports a synthetic card at the sizes of an iPhone upright (390 × 844) and on its side (844 × 390),
then checks the phone layouts (frontend/src/lib/layout.ts, components/compact.tsx): nothing runs
off the screen, a swipe across the photo moves between slides, every tool opens its panel, the
crop tool takes over and gives the photo back, Develop moves on; and that a tablet (820 × 1180) and
a laptop (1440 × 900) still get the side-by-side layout. Screenshots go to SS_SHOTS (default
/tmp/ss-phone-shots).
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
import web_flow as wf  # noqa: E402
from synthetic import make_scans  # noqa: E402

SHOTS = Path(os.environ.get("SS_SHOTS", "/tmp/ss-phone-shots"))

# Elements outside the window that no scrolling container clips: what a phone can't reach
OFF_SCREEN = """
() => {
  const [W, H] = [innerWidth, innerHeight];
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("[data-sonner-toaster]")) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
    let p = el.parentElement, clipped = false;
    for (; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(s.overflowX + s.overflowY)) { clipped = true; break; }
    }
    if (!clipped && (r.right > W + 1 || r.bottom > H + 1 || r.left < -1 || r.top < -1))
      out.push(`${el.tagName} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}"`);
  }
  return { scroll: document.documentElement.scrollWidth > W, off: out.slice(0, 10) };
}
"""
SHOWN = "() => document.querySelector('img.ss-photo[alt^=\"Slide\"]')?.alt"
TOOLS = ["Slides", "Frame", "Adjust", "Curve", "Local", "Scans", "Details", "Insights", "Tray"]


def fits(pg, what: str) -> None:
    r = pg.evaluate(OFF_SCREEN)
    assert not r["scroll"] and not r["off"], f"{what}: off screen {r}"


def swipe(cdp, x0: float, y: float, x1: float) -> None:
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y}]})
    for k in range(1, 6):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * k / 5, "y": y}]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def main() -> None:
    assert (wf.SITE / "index.html").exists(), "build it first: cd frontend && npm run build:web"
    SHOTS.mkdir(parents=True, exist_ok=True)
    site = Path(tempfile.mkdtemp(prefix="ss-phone-")) / "site"
    subprocess.run(["cp", "-r", str(wf.SITE), str(site)], check=True)
    made = make_scans(site / "card", 4, (1200, 800))
    names = [n for slide in made for n in slide]
    port = wf.serve(site)
    exe = os.environ.get("SS_BROWSER_PATH") or ("/opt/pw-browsers/chromium" if Path("/opt/pw-browsers/chromium").exists() else None)
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=exe)
        for w, h, tag in [(390, 844, "upright"), (844, 390, "side"), (820, 1180, "tablet"), (1440, 900, "laptop")]:
            phone = tag in ("upright", "side")
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2,
                                      is_mobile=phone, has_touch=tag != "laptop")
            ctx.add_init_script(wf.PICKERS)
            pg = ctx.new_page()
            pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(f"http://127.0.0.1:{port}/index.html")
            pg.evaluate(wf.FILL_CARD, names)
            expect(pg.get_by_role("button", name="Choose a folder of scans")).to_be_visible()
            fits(pg, f"{tag} empty")

            # the new-tray dialog fits and its buttons can be reached (they couldn't on a phone)
            pg.get_by_role("button", name="Choose a folder of scans").click()
            dlg = pg.get_by_role("dialog")
            dlg.get_by_label("Name").fill(f"{tag} tray")
            dlg.get_by_role("button", name="Create").click(timeout=5_000)
            expect(pg.get_by_text(re.compile(r"Imported \d+ scans")).first).to_be_visible(timeout=120_000)
            expect(pg.locator('img.ss-photo[alt^="Slide"]')).to_be_visible(timeout=30_000)
            expect(pg.locator("html")).to_have_attribute("data-layout", {"upright": "portrait", "side": "landscape"}.get(tag, "wide"))
            pg.wait_for_timeout(1500)
            pg.screenshot(path=str(SHOTS / f"{tag}-tray.png"))
            fits(pg, f"{tag} tray")
            if not phone:
                # side by side: the inspector's sections and the filmstrip's filters are all there
                expect(pg.get_by_role("button", name="Develop and go to next")).to_be_visible()
                expect(pg.get_by_role("toolbar", name="Filter slides")).to_be_visible()
                ctx.close()
                continue

            # swipe across the photo: next, then back
            cdp = ctx.new_cdp_session(pg)
            box = pg.locator('img.ss-photo[alt^="Slide"]').bounding_box()
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            swipe(cdp, cx + 100, cy, cx - 100)
            pg.wait_for_function(f"() => ({SHOWN})() === 'Slide 2'", timeout=10_000)
            swipe(cdp, cx - 100, cy, cx + 100)
            pg.wait_for_function(f"() => ({SHOWN})() === 'Slide 1'", timeout=10_000)

            # every tool opens its panel, which fits on the screen
            tools = pg.get_by_role("navigation", name="Tools")
            for t in TOOLS:
                tools.get_by_role("button", name=t, exact=True).click()
                expect(pg.get_by_role("region", name=t)).to_be_visible()
                pg.screenshot(path=str(SHOTS / f"{tag}-tool-{t.lower()}.png"))
                fits(pg, f"{tag} {t}")
            # the Local tool opens the overlay on the photo with its panel, and closes with it
            tools.get_by_role("button", name="Local", exact=True).click()
            expect(pg.locator(".ss-local")).to_be_visible()
            pg.get_by_role("region", name="Local").get_by_role("button", name="Close").click()
            expect(pg.locator(".ss-local")).to_have_count(0)

            # crop takes the screen (no tools, no Develop bar) and gives it back
            tools.get_by_role("button", name="Frame", exact=True).click()
            pg.get_by_role("button", name="Crop", exact=True).click()
            expect(pg.locator(".ss-crop")).to_be_visible()
            expect(pg.get_by_role("navigation", name="Tools")).to_have_count(0)
            pg.screenshot(path=str(SHOTS / f"{tag}-crop.png"))
            fits(pg, f"{tag} crop")
            pg.get_by_role("button", name="Cancel").click()
            expect(pg.locator(".ss-crop")).to_have_count(0)

            # Skip and Develop from the bar
            pg.get_by_role("button", name="Skip slide").click()
            expect(pg.get_by_role("button", name="Unskip slide")).to_be_visible()
            pg.get_by_role("button", name="Unskip slide").click()
            pg.get_by_role("button", name="Develop and go to next").click()
            pg.wait_for_function(f"() => ({SHOWN})() === 'Slide 2'", timeout=10_000)

            # Settings and People & Places fit too
            pg.get_by_role("button", name="Settings").first.click()
            expect(pg.get_by_role("dialog")).to_be_visible()
            fits(pg, f"{tag} settings")
            pg.keyboard.press("Escape")
            pg.get_by_role("button", name="People and places").first.click()
            expect(pg.get_by_role("tab", name="People")).to_be_visible()
            pg.screenshot(path=str(SHOTS / f"{tag}-people.png"))
            fits(pg, f"{tag} people")
            print(f"{tag}: ok")
            ctx.close()
        browser.close()
    assert not errors, errors
    print("phone flow passed")


if __name__ == "__main__":
    main()
