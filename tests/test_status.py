"""A slide's status through upload: in Immich (green), edited after upload (developed again, gold,
ready to go up), and back to in Immich when the edit is undone. Run: uv run --python 3.12 pytest tests -q
"""
from __future__ import annotations

from slidestation.store import developed, render_key, summary


def _tray(**g) -> dict:
    slide = {"id": "g1", "scans": ["s1"], "excluded": [], "rotation": 0, "params": {}, "reviewed": False,
             "skip": False, **g}
    return {"id": "t", "name": "t", "album": "t", "created": 0, "scans": {"s1": {}}, "groups": [slide]}


def test_edit_after_upload_is_developed_again_until_undone():
    d = _tray()
    g = d["groups"][0]
    assert not developed(g) and summary(d)["ready_upload"] == 0

    # uploaded without being marked developed ("upload all") still counts as developed
    g["immich"] = {"asset_id": "a1", "key": render_key(g)}
    assert developed(g)
    assert summary(d)["uploaded"] == 1 and summary(d)["ready_upload"] == 0

    g["rotation"] = 90  # an edit: Immich's copy is stale, the slide is ready to go up again
    s = summary(d)
    assert s["uploaded"] == 0 and s["ready_upload"] == 1 and s["reviewed"] == 1

    g["rotation"] = 0  # undone back to the version Immich has
    assert summary(d)["uploaded"] == 1 and summary(d)["ready_upload"] == 0
