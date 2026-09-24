"""Watched folders in the real UI (ARCHITECTURE §4e "Watched folders"): add a folder in Settings,
drop a sub-folder of scans into it, see it settle in the activity well and Settings, and become a
tray named and dated after it. Needs a running server (single user, as the desktop app) that polls
quickly, on the same machine (the script writes the share the server reads):

    # /tmp/ss-watch-home/config.json: {"library": "/tmp/ss-watch-lib", "learning_enabled": false}
    SLIDESTATION_HOME=/tmp/ss-watch-home SLIDESTATION_VOLUMES=/tmp/ss-watch-vol SLIDESTATION_NO_BROWSER=1 \\
        SLIDESTATION_WATCH_INTERVAL=1 SLIDESTATION_WATCH_SETTLE=3 SLIDESTATION_PORT=8791 \\
        uv run --python 3.12 python -m slidestation &
    uv run --python 3.12 --with playwright python tests/watch_flow.py

Env: SS_APP (default http://localhost:8765; `SLIDESTATION_PORT=8791 npx vite --port 5191` in
frontend/ serves the UI from source against that server), SS_SHOTS, SS_BROWSER_PATH /
SS_BROWSER_CHANNEL as in ui_flow.py.
"""
import hashlib
import os
import re
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from synthetic import make_scans  # noqa: E402

APP = os.environ.get("SS_APP", "http://localhost:8765")
SHOTS = Path(os.environ.get("SS_SHOTS", "/tmp/ss-shots"))


def tree(p: Path) -> dict:
    return {str(f.relative_to(p)): hashlib.sha1(f.read_bytes()).hexdigest() for f in sorted(p.rglob("*")) if f.is_file()}


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    share = Path(tempfile.mkdtemp(prefix="ss-share-"))
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("SS_BROWSER_CHANNEL") or None,
                                    executable_path=os.environ.get("SS_BROWSER_PATH") or None)
        pg = browser.new_page(viewport={"width": 1512, "height": 900})
        errors = []
        pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(APP)

        pg.get_by_role("button", name="Settings", exact=True).click()
        dialog = pg.get_by_role("dialog")
        dialog.get_by_label("Watched folders").fill(str(share))
        dialog.get_by_role("button", name="Watch", exact=True).click()
        folder = dialog.locator(f'[data-watched="{share.resolve()}"]')
        expect(folder).to_be_visible()
        expect(folder.get_by_text("No folders in it yet.")).to_be_visible()
        folder.get_by_label("Only once a .done file is in it").click()
        expect(folder.get_by_label("Only once a .done file is in it")).to_be_checked()

        # someone copies a tray into the share: it waits for its .done file
        salt = int(time.time()) % 100000  # new bytes and a new tray each run: the library skips scans it has
        name = f"1978-08 Lake Garda {salt}"
        make_scans(share / name, 3, salt=salt, first=salt)
        row = folder.locator("li", has_text=name)
        expect(row).to_contain_text("waiting for .done", timeout=15000)
        dialog.get_by_role("button", name="Cancel").click()
        well = pg.get_by_role("status").filter(has_text="Watched folders")
        expect(well).to_contain_text("1 waiting", timeout=10000)
        pg.screenshot(path=str(SHOTS / "watch-well.png"))
        before = tree(share)
        (share / name / ".done").write_text("")
        before[f"{name}/.done"] = hashlib.sha1(b"").hexdigest()

        # imported: a tray named and dated after the folder, shown in Settings
        expect(pg.get_by_role("combobox", name="Tray")).to_contain_text(name, timeout=60000)
        pg.get_by_role("button", name="Settings", exact=True).click()
        expect(row).to_contain_text("imported 3 slides", timeout=60000)
        pg.screenshot(path=str(SHOTS / "watch-settings.png"))
        dialog.get_by_role("button", name="Cancel").click()
        st = pg.evaluate("fetch('/api/state').then(r => r.json())")
        [tray] = [s for s in st["sessions"] if s["name"] == name]
        assert tray["date"] == "1978-08" and tray["album"] == name and tray["slides"] == 3, tray
        assert tree(share) == before, "the share changed"
        pg.get_by_role("combobox", name="Tray").select_option(tray["id"])
        expect(pg.get_by_text(re.compile(r"^Slide 1 / 3$"))).to_be_visible(timeout=30000)

        # stop watching: the folder goes from Settings, the tray stays
        pg.get_by_role("button", name="Settings", exact=True).click()
        folder.get_by_role("button", name="Stop watching").click()
        expect(folder).to_have_count(0)
        dialog.get_by_role("button", name="Cancel").click()
        assert not [e for e in errors if "favicon" not in e], errors
        browser.close()
    print("watch flow OK")


if __name__ == "__main__":
    main()
