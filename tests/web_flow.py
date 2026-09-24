"""End-to-end flow of the browser-only version (frontend `npm run build:web`) in headless Chromium.

    (cd frontend && npm run build:web)
    uv run --python 3.12 --with playwright --with fastapi --with uvicorn --with python-multipart \\
        --with numpy --with pillow python tests/web_flow.py

Starts its own static server for frontend/dist-web and the mock Immich (CORS on, as a reverse proxy
in front of a real Immich would have to be). The folder pickers are stood in for by folders in the
page's private storage (OPFS): a synthetic scanner card to import from, one to save into. So import,
save to disk and card cleanup run through the same File System Access code as with real folders.

SS_NO_FS_ACCESS=1 runs it the way Firefox and Safari do: no folder picker API, so the scans come in
through a folder <input>, "save to disk" downloads a zip, and the card can't be cleaned.

SS_CANVAS_LIMIT=250000 pretends canvases stop at that many pixels, as Safari's do on iPad / iPhone
(about 16.7 MP): full-resolution scans are then decoded in strips and the JPEGs encoded in
JavaScript (standalone/strips.ts), which the saved files are checked for.

Env: SS_BROWSER_PATH (default /opt/pw-browsers/chromium if present), SS_SHOTS (screenshots,
default /tmp/ss-web-shots), SS_SLIDES (default 6).
"""
from __future__ import annotations

import base64
import functools
import http.server
import io
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "frontend" / "dist-web"
SHOTS = Path(os.environ.get("SS_SHOTS", "/tmp/ss-web-shots"))
SLIDES = int(os.environ.get("SS_SLIDES", "6"))
NO_FS = bool(os.environ.get("SS_NO_FS_ACCESS"))
CANVAS_LIMIT = int(os.environ.get("SS_CANVAS_LIMIT") or 0)
sys.path.insert(0, str(ROOT / "tests"))
from synthetic import make_scans  # noqa: E402

# The pickers hand out folders in the page's private storage; permissions are always granted.
PICKERS = """
(() => {
  const folder = { scans: "card", export: "saved", library: "disk-library" };
  window.showDirectoryPicker = async (opts) =>
    (await navigator.storage.getDirectory()).getDirectoryHandle(folder[opts?.id] ?? "card", { create: true });
  FileSystemHandle.prototype.queryPermission ??= async () => "granted";
  FileSystemHandle.prototype.requestPermission ??= async () => "granted";
})();
"""

# Copy the synthetic card from the static server into OPFS: card/DCIM/100MEDIA/*.JPG
FILL_CARD = """
async (names) => {
  const root = await navigator.storage.getDirectory();
  let d = await root.getDirectoryHandle("card", { create: true });
  for (const p of ["DCIM", "100MEDIA"]) d = await d.getDirectoryHandle(p, { create: true });
  for (const n of names) {
    const blob = await (await fetch(`card/${n}`)).blob();
    const w = await (await d.getFileHandle(n, { create: true })).createWritable();
    await w.write(blob);
    await w.close();
  }
}
"""

LIST = """
async (path) => {
  let d = await navigator.storage.getDirectory();
  for (const p of path.split("/")) d = await d.getDirectoryHandle(p);
  const out = [];
  for await (const [name, h] of d) if (h.kind === "file") out.push(name);
  return out.sort();
}
"""

READ = """
async ([path, name]) => {
  let d = await navigator.storage.getDirectory();
  for (const p of path.split("/")) d = await d.getDirectoryHandle(p);
  const b = new Uint8Array(await (await (await d.getFileHandle(name)).getFile()).arrayBuffer());
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
"""

# Full-resolution JPEGs in the library's export folders (OPFS): what the background renderer made
EXPORTS = """
async () => {
  let n = 0;
  try {
    const sessions = await (await navigator.storage.getDirectory()).getDirectoryHandle("sessions");
    for await (const [, s] of sessions) {
      if (s.kind !== "directory") continue;
      try {
        for await (const [name] of await s.getDirectoryHandle("export")) n += name.endsWith(".jpg");
      } catch {}
    }
  } catch {}
  return n;
}
"""

# How light the shown photo is: mean of the top fifth, and of a box around the middle (0..1)
PHOTO_LIGHT = """
() => {
  const img = document.querySelector('img.ss-photo[alt^="Slide"]');
  const c = document.createElement("canvas");
  [c.width, c.height] = [img.naturalWidth, img.naturalHeight];
  const x = c.getContext("2d");
  x.drawImage(img, 0, 0);
  const mean = (l, t, w, h) => {
    const d = x.getImageData(Math.round(l * c.width), Math.round(t * c.height),
                             Math.round(w * c.width), Math.round(h * c.height)).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length / 4) / 3 / 255;
  };
  return [mean(0, 0, 1, 0.2), mean(0.4, 0.4, 0.2, 0.2)];
}
"""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def serve(folder: Path) -> int:
    port = free_port()
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    handler = functools.partial(Quiet, directory=str(folder))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return port


def main() -> None:
    assert (SITE / "index.html").exists(), "build it first: cd frontend && npm run build:web"
    SHOTS.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="ss-web-"))
    site = tmp / "site"
    subprocess.run(["cp", "-r", str(SITE), str(site)], check=True)
    # slide 4 sits turned 1.5° in its mount: the import straightens it by itself
    made = make_scans(site / "card", SLIDES, (1200, 800), mounts=[None, None, None, 1.5])
    names = [n for slide in made for n in slide]
    (site / "start.html").write_text("<!doctype html><title>start</title><link rel=icon href=favicon.svg>")
    port = serve(site)

    immich_port = free_port()
    immich = subprocess.Popen(
        [sys.executable, str(ROOT / "tests" / "fake_immich.py")],
        env={**os.environ, "MOCK_IMMICH_PORT": str(immich_port), "MOCK_IMMICH_CORS": "1", "MOCK_IMMICH_MAJOR": "3"},
    )
    immich_url = f"http://127.0.0.1:{immich_port}"
    for _ in range(50):
        try:
            urllib.request.urlopen(immich_url + "/api/server/version")
            break
        except OSError:
            time.sleep(0.2)

    exe = os.environ.get("SS_BROWSER_PATH") or ("/opt/pw-browsers/chromium" if Path("/opt/pw-browsers/chromium").exists() else None)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=exe)
            ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
            ctx.add_init_script("delete window.showDirectoryPicker;" if NO_FS else PICKERS)
            if CANVAS_LIMIT:
                ctx.add_init_script(f"localStorage.setItem('slide-station-canvas-limit', '{CANVAS_LIMIT}')")
            pg = ctx.new_page()
            pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(f"http://127.0.0.1:{port}/start.html")  # history to go back to (see the crop keys)
            pg.goto(f"http://127.0.0.1:{port}/index.html")
            if not NO_FS:
                pg.evaluate(FILL_CARD, names)

            # ---- import: choose the card, a new tray, wait for the slides
            t0 = time.time()
            if NO_FS:
                with pg.expect_file_chooser() as fc:
                    pg.get_by_role("button", name="Choose a folder of scans").click()
                fc.value.set_files(site / "card")
            else:
                pg.get_by_role("button", name="Choose a folder of scans").click()
            dlg = pg.get_by_role("dialog")
            dlg.get_by_label("Name").fill("Web tray")
            dlg.get_by_label("Photo date").fill("1978-08")
            dlg.get_by_role("button", name="Create").click()
            expect(pg.get_by_text(re.compile(r"Imported \d+ scans into \d+ slides")).first).to_be_visible(timeout=120_000)
            print(f"import: {len(names)} scans, {time.time() - t0:.1f}s")
            expect(pg.get_by_text(f"{SLIDES} slides", exact=True)).to_be_visible()

            # ---- the photo and the filmstrip render in the worker
            photo = pg.locator("main img[src^='blob:']").first
            expect(photo).to_be_visible(timeout=30_000)
            pg.wait_for_function(
                "() => [...document.querySelectorAll(\"main img[src^='blob:']\")].filter(i => i.naturalWidth > 0).length >= 3",
                timeout=30_000,
            )
            pg.screenshot(path=str(SHOTS / "01-imported.png"))

            # ---- develop a few with the keyboard: rotate, fit, crop, undo
            t0 = time.time()
            pg.keyboard.press("r")
            pg.keyboard.press("f")
            pg.wait_for_timeout(500)
            pg.keyboard.press("k")
            expect(pg.locator(".ss-crop")).to_be_visible()
            pg.keyboard.press("ArrowRight")  # nudge the crop frame
            # and shrink it - not the browser's Back. Playwright's keys never reach the browser's
            # own shortcuts, so this only guards the page side; with real keys (XTEST under Xvfb,
            # headed Chromium) Alt+Left goes back outside the crop tool and stays inside it.
            pg.keyboard.press("Alt+ArrowLeft")
            pg.wait_for_timeout(300)
            assert pg.url.endswith("/index.html"), pg.url
            expect(pg.locator(".ss-crop")).to_be_visible()
            pg.keyboard.press("Enter")
            expect(pg.locator(".ss-crop")).to_have_count(0)
            pg.keyboard.press("Control+z")
            pg.keyboard.press("Control+Shift+z")
            for _ in range(3):
                pg.keyboard.press(" ")
                pg.wait_for_timeout(200)
            print(f"develop: {time.time() - t0:.1f}s")

            # ---- the developed slides are rendered at full resolution in the background
            t0 = time.time()
            assert pg.evaluate(EXPORTS) < 3
            while pg.evaluate(EXPORTS) < 3:
                assert time.time() - t0 < 120, f"{pg.evaluate(EXPORTS)} slides rendered in the background"
                pg.wait_for_timeout(500)
            print(f"background render: {pg.evaluate(EXPORTS)} slides, {time.time() - t0:.1f}s")
            pg.screenshot(path=str(SHOTS / "02-developed.png"))

            # ---- 1:1 zoom (the worker renders the originals at full resolution), a preset, the grid
            t0 = time.time()
            pg.keyboard.press("z")
            pg.wait_for_function(
                "() => [...document.querySelectorAll('.ss-zoom img')].some(i => i.naturalWidth > 0)", timeout=60_000
            )
            expect(pg.locator(".ss-zoom-tag")).to_contain_text(re.compile(r"100 % · \d+ × \d+"))  # trimmed to its mount
            print(f"zoom: {time.time() - t0:.1f}s")
            pg.keyboard.press("Escape")
            pg.get_by_role("button", name="Presets", exact=True).click()
            dlg = pg.get_by_role("dialog", name="Presets")
            dlg.get_by_label(re.compile(r"^Save slide")).fill("Web look")
            dlg.get_by_role("button", name="Save", exact=True).click()
            dlg.get_by_role("listitem", name="Web look").get_by_role("button", name="+ rest").click()
            expect(pg.get_by_text(re.compile(r"Applied “Web look” to \d+ slides?")).first).to_be_visible()
            expect(dlg).to_have_count(0)
            pg.keyboard.press("g")
            grid = pg.get_by_role("grid", name="Slides")
            expect(grid).to_be_visible()
            pg.wait_for_function(
                "() => [...document.querySelectorAll('[role=gridcell] img')].filter(i => i.naturalWidth > 0).length >= 3",
                timeout=30_000,
            )
            pg.keyboard.press(" ")
            pg.screenshot(path=str(SHOTS / "02b-grid.png"))
            pg.keyboard.press("g")
            expect(grid).to_have_count(0)
            pg.keyboard.press("ArrowLeft")  # the grid developed slide 4 and stepped on: back to it
            # ---- slide 4: straightened to its mount at import; trim to it, then dust repair
            expect(pg.get_by_text("Level with the mount")).to_be_visible(timeout=10_000)
            pg.get_by_role("button", name="Straighten and trim to the mount").click()
            pg.wait_for_timeout(500)
            expect(pg.get_by_text("Level with the mount")).to_be_visible()
            expect(pg.get_by_role("button", name="Uncrop")).to_be_visible()
            dust = pg.get_by_label("Dust value")
            dust.fill("40")
            dust.press("Enter")
            expect(dust).to_have_value("40")
            pg.wait_for_function(
                "() => [...document.querySelectorAll(\"main img[src^='blob:']\")].some(i => i.naturalWidth > 0)",
                timeout=30_000,
            )
            print("mount and dust: straightened, trimmed, dust 40")
            pg.screenshot(path=str(SHOTS / "02b-mount-dust.png"))

            # ---- local adjustments: a radial dodges the middle, a graduated filter burns the top
            t0 = time.time()
            look = lambda: pg.evaluate(PHOTO_LIGHT)  # noqa: E731
            wait_photo = lambda old: pg.wait_for_function(  # noqa: E731
                "(old) => { const i = document.querySelector('img.ss-photo[alt^=\"Slide\"]');"
                " return i && i.src !== old && i.naturalWidth > 0 }", arg=old, timeout=30_000)
            photo_src = lambda: pg.locator("img.ss-photo[alt^='Slide']").get_attribute("src")  # noqa: E731
            top0, mid0 = look()
            pg.keyboard.press("a")
            expect(pg.locator(".ss-local")).to_be_visible()
            src = photo_src()
            pg.get_by_role("button", name="Add radial").click()
            expect(pg.get_by_role("button", name="Radial 1", exact=True)).to_be_visible()
            wait_photo(src)
            src = photo_src()
            val = pg.get_by_label("Local exposure value")
            val.fill("80")
            val.press("Enter")
            wait_photo(src)
            top1, mid1 = look()
            assert mid1 > mid0 + 0.03, (mid0, mid1)  # dodged
            # drag the radial's centre up: the render follows the handle
            h = pg.locator(".ss-local-handle[data-h='center']").bounding_box()
            src = photo_src()
            pg.mouse.move(h["x"] + h["width"] / 2, h["y"] + h["height"] / 2)
            pg.mouse.down()
            pg.mouse.move(h["x"] + h["width"] / 2, h["y"] - 40, steps=5)
            pg.mouse.up()
            wait_photo(src)
            src = photo_src()
            pg.get_by_role("button", name="Add graduated").click()
            expect(pg.get_by_role("button", name="Graduated 2", exact=True)).to_be_visible()
            wait_photo(src)
            src = photo_src()
            val.fill("-90")
            val.press("Enter")
            wait_photo(src)
            top2, mid2 = look()
            assert top2 < top1 - 0.03, (top1, top2)  # burned in from the top
            pg.keyboard.press("o")
            expect(pg.get_by_test_id("local-mask")).to_be_visible()
            pg.screenshot(path=str(SHOTS / "02c-local.png"))
            pg.keyboard.press("Escape")
            expect(pg.locator(".ss-local")).to_have_count(0)
            pg.keyboard.press("Control+z")  # the graduated filter's exposure
            pg.keyboard.press("Control+z")  # adding it
            expect(pg.get_by_role("button", name="Graduated 2", exact=True)).to_have_count(0)
            expect(pg.get_by_role("button", name="Radial 1", exact=True)).to_be_visible()
            # a brush stroke across the photo, then deleted with ⌫
            pg.get_by_role("button", name="Add brush").click()
            expect(pg.locator(".ss-local")).to_be_visible()
            box = pg.locator(".ss-local").bounding_box()
            pg.mouse.move(box["x"] + box["width"] * 0.2, box["y"] + box["height"] * 0.8)
            pg.mouse.down()
            pg.mouse.move(box["x"] + box["width"] * 0.8, box["y"] + box["height"] * 0.7, steps=12)
            pg.mouse.up()
            expect(pg.get_by_text("1 stroke so far")).to_be_visible()
            expect(pg.get_by_test_id("local-mask")).to_be_visible()  # a brush always shows its mask
            pg.keyboard.press("Backspace")
            expect(pg.get_by_role("button", name="Brush 2", exact=True)).to_have_count(0)
            pg.keyboard.press("Escape")
            print(f"local: radial {mid0:.3f} -> {mid1:.3f} middle, graduated {top1:.3f} -> {top2:.3f} top, "
                  f"{time.time() - t0:.1f}s")

            # ---- date a range of slides
            pg.keyboard.press("Control+k")
            pg.get_by_placeholder("Type an action or a tray name…").fill("Date a range")
            pg.keyboard.press("Enter")
            rng = pg.get_by_role("dialog", name="Date a range of slides")
            rng.get_by_label("Date", exact=True).fill("1979-07")
            rng.get_by_role("button", name="Date slides").click()
            expect(pg.get_by_role("dialog")).to_have_count(0)

            # ---- film stock: the fade guess (the synthetic scans are magenta), accepted, given to the tray
            expect(pg.get_by_text("Looks like")).to_be_visible(timeout=10_000)
            pg.get_by_text("Looks like").scroll_into_view_if_needed()
            pg.screenshot(path=str(SHOTS / "02c-film-stock.png"))
            pg.get_by_role("button", name="Accept ektachrome").click()
            pg.get_by_role("button", name=re.compile(r"^Apply to \d+–\d+…")).click()
            prop = pg.get_by_role("dialog", name="Apply Ektachrome to more slides")
            prop.get_by_label("From slide").fill("1")
            prop.get_by_role("button", name=re.compile(r"^Apply to \d+ slides")).click()
            expect(pg.get_by_text(re.compile(r"Film stock Ektachrome: \d+ slides")).first).to_be_visible()
            expect(pg.get_by_label("Film stock", exact=True).first).to_have_value("ektachrome")
            print("film stock: Ektachrome suggested, accepted and applied to the tray")

            # ---- connect the mock Immich and upload everything
            pg.get_by_role("button", name="Settings", exact=True).click()
            s = pg.get_by_role("dialog")
            s.get_by_label("Immich server URL").fill(immich_url)
            s.get_by_label("Immich API key").fill("testkey")
            s.get_by_role("button", name="Test connection").click()
            expect(s.get_by_role("status")).to_contain_text("Connected to Immich", timeout=10_000)
            s.get_by_role("button", name="Save").click()
            expect(pg.get_by_role("dialog")).to_have_count(0)

            t0 = time.time()
            pg.get_by_role("button", name=re.compile(r"^Upload all \d+")).click()
            pg.get_by_role("alertdialog").get_by_role("button", name="Upload anyway").click()
            expect(pg.get_by_text(re.compile(r"Done - \d+ slides uploaded")).first).to_be_visible(timeout=300_000)
            db = __import__("json").loads(urllib.request.urlopen(immich_url + "/debug").read())
            assets = list(db["assets"].values())
            assert len(assets) == SLIDES, f"{len(assets)} assets in Immich, expected {SLIDES}"
            assert all(a["bytes"] > 50_000 for a in assets), assets
            assert all("deviceAssetId" not in a["fields"] and a["fields"].get("filename") for a in assets), assets
            print(f"upload: {len(assets)} slides, {time.time() - t0:.1f}s")
            pg.screenshot(path=str(SHOTS / "03-uploaded.png"))

            # ---- save the finished JPEGs to a folder (or, without the picker API, as a zip)
            if NO_FS:
                with pg.expect_download(timeout=300_000) as dl:
                    pg.get_by_role("button", name="Save to disk").click()
                z = zipfile.ZipFile(dl.value.path())
                saved = sorted(z.namelist())
                files = [z.read(n) for n in saved]
            else:
                pg.get_by_role("button", name="Save to disk").click()
                expect(pg.get_by_text(re.compile(r"Saved \d+ slides")).first).to_be_visible(timeout=300_000)
                saved = pg.evaluate(LIST, "saved")
                files = [base64.b64decode(pg.evaluate(READ, ["saved", n])) for n in saved]
            assert len(saved) >= 3, saved
            jpegs = [Image.open(io.BytesIO(f)) for f in files]
            for j in jpegs:
                j.load()  # the whole file decodes
            sizes = {j.size for j in jpegs}
            assert sizes & {(1200, 800), (800, 1200)}, sizes  # the slides left uncropped: the scan's size
            if CANVAS_LIMIT:  # encoded by jpeg-js (4:4:4), not the browser's encoder (4:2:0)
                assert all(all(c[1:3] == (1, 1) for c in j.layer) for j in jpegs), [j.layer for j in jpegs]
            jpeg = jpegs[0]
            exif = jpeg.getexif()
            when = exif.get_ifd(0x8769).get(36867, "")
            assert exif.get(271) == "GCMC" and exif.get(305) == "Slide Station", dict(exif)
            assert when.startswith(("1978:", "1979:")), when
            print(f"saved: {len(saved)} JPEGs, {jpeg.size[0]}x{jpeg.size[1]}, DateTimeOriginal {when}")

            # ---- clean the card: only files matching the verified copies go
            if NO_FS:
                # a folder read through <input> can't be written to: cleaning stays locked
                expect(pg.get_by_role("button", name="Clean card")).to_be_disabled()
            else:
                pg.get_by_role("button", name="Clean card").click()
                pg.get_by_role("alertdialog").get_by_role("button", name="Delete from card").click()
                expect(pg.get_by_text(re.compile(r"Deleted \d+ scans from the card")).first).to_be_visible(timeout=60_000)
                left = pg.evaluate(LIST, "card/DCIM/100MEDIA")
                assert not left, left
                print("cleanup: card is empty")

            # ---- a reload finds the tray again in the browser's storage
            pg.reload()
            expect(pg.get_by_text(f"{SLIDES} in Immich")).to_be_visible(timeout=30_000)
            pg.wait_for_function(
                "() => [...document.querySelectorAll(\"main img[src^='blob:']\")].filter(i => i.naturalWidth > 0).length >= 4",
                timeout=60_000,
            )
            pg.screenshot(path=str(SHOTS / "04-reloaded.png"))

            # ---- round trip: a caption edited in Immich comes back
            def immich_call(method: str, path: str, body: dict | None = None):
                req = urllib.request.Request(
                    immich_url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                    headers={"x-api-key": "testkey", "Content-Type": "application/json"})
                return json.loads(urllib.request.urlopen(req).read() or "null")

            db = immich_call("GET", "/debug")
            first_id = next(iter(db["assets"]))
            immich_call("PUT", f"/api/assets/{first_id}", {"description": "Edited in Immich"})
            pg.keyboard.press("Control+k")
            pg.get_by_placeholder("Type an action or a tray name…").fill("Pull captions")
            pg.keyboard.press("Enter")
            expect(pg.get_by_text("Pulled 1 caption from Immich")).to_be_visible(timeout=30_000)

            # ---- pull the uploaded photos back in as a new tray, develop again, replace them
            pg.keyboard.press("Control+k")
            pg.get_by_placeholder("Type an action or a tray name…").fill("Pull photos back in")
            pg.keyboard.press("Enter")
            dlg = pg.get_by_role("dialog")
            dlg.get_by_role("button", name=re.compile("^Web tray")).click()
            expect(dlg.get_by_role("button", name=f"Import {SLIDES} photos")).to_be_enabled(timeout=30_000)
            dlg.get_by_label("New tray").fill("Pulled back")
            pg.wait_for_function("() => document.querySelectorAll(\"[role=dialog] img[src^='blob:']\").length >= 3")
            pg.screenshot(path=str(SHOTS / "05-immich-album.png"))
            dlg.get_by_role("button", name=f"Import {SLIDES} photos").click()
            expect(pg.get_by_text(f"Pulled in {SLIDES} photos from Immich").first).to_be_visible(timeout=120_000)
            expect(pg.get_by_text(f"{SLIDES} slides", exact=True)).to_be_visible()
            pg.get_by_role("button", name=re.compile(r"^Upload all \d+")).click()
            pg.get_by_role("alertdialog").get_by_role("button", name="Upload anyway").click()
            expect(pg.get_by_text(re.compile(rf"Done - {SLIDES} slides uploaded to 'Web tray'")).first).to_be_visible(
                timeout=300_000)
            db = immich_call("GET", "/debug")
            live = [k for k, a in db["assets"].items() if not a["trashed"]]
            (album,) = [a for a in db["albums"].values() if a["name"] == "Web tray"]
            assert len(live) == SLIDES and all(k in album["assets"] for k in live), (live, album)
            assert db["assets"][first_id]["trashed"], "the pulled-in photo was replaced"
            print(f"round trip: pulled {SLIDES} photos back in, uploaded, originals replaced")
            pg.screenshot(path=str(SHOTS / "06-pulled-back.png"))
            browser.close()
    finally:
        immich.terminate()
    errors = [e for e in errors if "favicon" not in e]
    assert not errors, errors
    print("no console errors")


if __name__ == "__main__":
    main()
