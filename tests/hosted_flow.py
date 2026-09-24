"""The hosted container's browser flow: sign in with an Immich API key, upload a folder of scans
from the browser, import it, and a second user who sees none of it. Needs a running server in
accounts mode and the mock Immich with two more users:

    MOCK_IMMICH_PORT=2283 MOCK_IMMICH_USERS=ann-key,bob-key python tests/fake_immich.py &
    SLIDESTATION_HOME=/tmp/ss-hosted SLIDESTATION_AUTH=immich SLIDESTATION_IMMICH_URL=http://127.0.0.1:2283 \
        SLIDESTATION_HOST=0.0.0.0 SLIDESTATION_NO_BROWSER=1 uv run --python 3.12 python -m slidestation &
    uv run --python 3.12 --with playwright python tests/hosted_flow.py

(or the container: docker run -e SLIDESTATION_AUTH=immich -e SLIDESTATION_IMMICH_URL=... -p 8765:8765).
Env: SS_APP (default http://localhost:8765), SS_SHOTS, SS_BROWSER_PATH / SS_BROWSER_CHANNEL as in
ui_flow.py. The folder picker is answered with a synthetic folder (a directory for the
webkitdirectory input); dropping a folder goes through the same upload code.
"""
import os
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from synthetic import make_scans  # noqa: E402

APP = os.environ.get("SS_APP", "http://localhost:8765")
SHOTS = Path(os.environ.get("SS_SHOTS", "/tmp/ss-shots"))


def state(pg):
    return pg.evaluate("fetch('/api/state').then(r => r.json())")


def wait_job(pg, timeout=300):
    for _ in range(timeout * 2):
        pg.wait_for_timeout(500)
        job = state(pg)["job"]
        if job and job["finished"]:
            assert not job["error"], job["error"]
            return job
    raise TimeoutError("job did not finish")


def sign_in(pg, key):
    pg.goto(APP)
    expect(pg.get_by_text("Sign in to Slide Station")).to_be_visible()
    pg.get_by_label("Immich API key").fill(key)
    pg.get_by_role("button", name="Sign in").click()
    expect(pg.get_by_text("Sign in to Slide Station")).to_have_count(0)


def upload_tray(pg, folder, name, open_picker):
    """Choose `folder` in the picker, wait for the upload, create the tray, wait for the import."""
    with pg.expect_file_chooser() as fc:
        open_picker()
    fc.value.set_files(str(folder))  # a directory: the webkitdirectory input takes all its files
    dialog = pg.get_by_role("dialog")
    expect(dialog.get_by_text("New tray")).to_be_visible(timeout=60000)  # uploaded: the import asks where
    dialog.get_by_label("Name").fill(name)
    dialog.get_by_role("button", name="Create").click()
    return wait_job(pg)


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="ss-hosted-flow-"))
    salt = int(time.time()) % 100000
    make_scans(tmp / "Box 7" / "100MEDIA", 3, size=(1200, 800), salt=salt, first=salt)
    make_scans(tmp / "Bob box", 1, size=(1200, 800), salt=salt + 1, first=salt + 50)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("SS_BROWSER_CHANNEL") or None,
                                    executable_path=os.environ.get("SS_BROWSER_PATH") or None)
        errors = []

        def page():
            ctx = browser.new_context(viewport={"width": 1400, "height": 860})  # own cookies: own user
            pg = ctx.new_page()
            # 401s before signing in are the sign-in screen's cue, not errors
            pg.on("console", lambda m: m.type == "error" and "401" not in m.text and errors.append(m.text))
            pg.on("pageerror", lambda e: errors.append(str(e)))
            return pg

        # --- Ann: sign in, upload a folder from the empty state, import it
        ann = page()
        sign_in(ann, "ann-key")
        expect(ann.get_by_text("uploaded to")).to_be_visible()  # the hosted steps, no scanner to wait for
        t0 = time.time()
        job = upload_tray(ann, tmp / "Box 7", "Ann's tray",
                          lambda: ann.get_by_role("button", name="Choose a folder of scans").click())
        print(f"ann: {job['message']} ({time.time() - t0:.1f} s upload + import)")
        assert "into 3 slides" in job["message"], job
        st = state(ann)
        assert [t["name"] for t in st["sessions"]] == ["Ann's tray"] and st["server"]["accounts"]
        assert not any(s.get("upload") for s in st["sources"])  # the staging folder went after the import
        assert st["camera"] is None
        ann_sid = st["sessions"][0]["id"]
        expect(ann.get_by_text("Develop").first).to_be_visible()
        ann.screenshot(path=str(SHOTS / "hosted-ann.png"))

        # Settings: the library and Immich are the server's; then sign out
        ann.get_by_role("button", name="Settings", exact=True).click()
        expect(ann.get_by_text("Signed in as")).to_be_visible()
        expect(ann.get_by_label("Immich server URL")).to_have_attribute("readonly", "")
        expect(ann.get_by_label("Library folder")).to_have_count(0)
        ann.screenshot(path=str(SHOTS / "hosted-settings.png"))
        ann.get_by_role("button", name="Sign out").click()
        expect(ann.get_by_text("Sign in to Slide Station")).to_be_visible()

        # --- Bob: a wrong key first, then his own; he sees nothing of Ann's
        bob = page()
        bob.goto(APP)
        bob.get_by_label("Immich API key").fill("not-a-key")
        bob.get_by_role("button", name="Sign in").click()
        expect(bob.get_by_role("alert")).to_contain_text("rejected")
        bob.screenshot(path=str(SHOTS / "hosted-signin.png"))
        sign_in(bob, "bob-key")
        st = state(bob)
        assert st["sessions"] == [] and st["sources"] == [], st
        r = bob.request.get(f"{APP}/api/sessions/{ann_sid}").status  # with his cookie, outside the page
        assert r == 404, r
        job = upload_tray(bob, tmp / "Bob box", "Bob's tray",
                          lambda: bob.get_by_role("button", name="Choose a folder of scans").click())
        print("bob:", job["message"])
        assert [t["name"] for t in state(bob)["sessions"]] == ["Bob's tray"]

        # Ann again: still only hers
        sign_in(ann, "ann-key")
        assert [t["name"] for t in state(ann)["sessions"]] == ["Ann's tray"]
        assert not errors, errors
        browser.close()
    print("hosted flow OK")


if __name__ == "__main__":
    main()
