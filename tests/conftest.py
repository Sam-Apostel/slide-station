"""Shared fixtures: a scratch home + library, the API under TestClient, and the mock Immich.

The environment is set before anything from slidestation is imported: store reads
SLIDESTATION_HOME at import, and without a config.json there the library would default to
~/Pictures/Slide Station. Never let the tests near the real library.
"""
from __future__ import annotations

import atexit
import itertools
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import pytest

_ROOT = Path(tempfile.mkdtemp(prefix="ss-test-"))
atexit.register(shutil.rmtree, _ROOT, True)
os.environ["SLIDESTATION_HOME"] = str(_ROOT / "home")
os.environ["SLIDESTATION_VOLUMES"] = str(_ROOT / "volumes")
os.environ["MOCK_IMMICH_MAJOR"] = "3"
(_ROOT / "home").mkdir()
(_ROOT / "volumes").mkdir()
CONFIG = {
    "library": str(_ROOT / "library"),
    "immich_url": "http://immich.test",
    "immich_key": "testkey",
    "keep_originals": True,
    "keep_exports": False,
    "learning_enabled": False,  # learned suggestions would move the defaults the tests expect
}
(_ROOT / "home" / "config.json").write_text(json.dumps(CONFIG))

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient  # noqa: E402

import fake_immich  # noqa: E402
from slidestation import immich, store  # noqa: E402
from slidestation.server import app  # noqa: E402
from synthetic import make_scans  # noqa: E402

assert store.CONFIG_DIR == _ROOT / "home", "slidestation was imported before the test environment was set"
_salts = itertools.count(1)


@pytest.fixture(autouse=True)
def _config():
    """Every test starts from the scratch config (a test may turn keep_originals off)."""
    store.save_config(dict(CONFIG))
    yield


@pytest.fixture(scope="session")
def api() -> TestClient:
    return TestClient(app)


@pytest.fixture
def immich_db(monkeypatch):
    """Route the real Immich client to tests/fake_immich.py in-process; yields its DB."""
    fake_immich.DB.update(albums={}, assets={}, stacks={}, data={}, log=[])
    monkeypatch.setattr(fake_immich, "MAJOR", 3)
    monkeypatch.setattr(fake_immich, "STACKS", True)
    monkeypatch.setattr(fake_immich, "PAGE", 1000)
    monkeypatch.setattr(fake_immich, "DENY", [])

    def client(headers=None, **_):
        return TestClient(fake_immich.app, base_url="http://immich.test", headers=headers)

    monkeypatch.setattr(immich.httpx, "Client", client)
    return fake_immich.DB


def wait_job(api: TestClient, timeout: float = 60) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        job = api.get("/api/state").json()["job"]
        if job and job["finished"]:
            assert not job["error"], job["error"]
            return job
        time.sleep(0.05)
    raise TimeoutError("job did not finish")


def new_tray(api: TestClient, folder: Path, slides: int = 4, name: str = "Test tray") -> tuple[str, dict]:
    """Create a tray and import `slides` fresh synthetic slides (bracketed every other one)."""
    # new bytes and names each time: the dedupe index skips repeats by content
    salt = next(_salts)
    make_scans(folder, slides, salt=salt, first=salt * 10)
    sid = api.post("/api/sessions", json={"name": name}).json()["id"]
    assert api.post(f"/api/sessions/{sid}/import", json={"source": str(folder)}).json() == {"ok": True}
    wait_job(api)
    return sid, api.get(f"/api/sessions/{sid}").json()


@pytest.fixture
def tray(api, tmp_path):
    """(session id, payload) of a freshly imported 4-slide tray: 2 + 1 + 2 + 1 scans."""
    return new_tray(api, tmp_path / "scans")

