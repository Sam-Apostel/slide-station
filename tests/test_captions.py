"""Captions: a one-sentence description per slide from a local vision-language model (Florence-2),
offered as an insights suggestion, editable, accepted into the slide's caption (Immich's description).

The model is replaced by a fake (no model, no network); the decoding loop runs against scripted
ONNX sessions. The one real-model test runs only with SS_REAL_CAPTIONS=1: it downloads the ~275 MB
model into the scratch library and captions two synthetic scenes.
Run: uv run --python 3.12 pytest tests/test_captions.py -q   (SS_REAL_CAPTIONS=1 for the real model)
"""
from __future__ import annotations

import hashlib
import json
import os
import time

import httpx
import numpy as np
import pytest

from conftest import wait_job
from slidestation import captions, insights, store
from slidestation import workflow as wf
from test_insights import FakeClip, _beach_scene, _snow_scene

STEP = insights.step


class FakeFlorence:
    """`caption(rgb)` -> (text, confidence); `text` may be a function of the call number."""

    def __init__(self, text="A beach with the sea behind it."):
        self.text = text
        self.calls = 0
        self.during = None  # run while "the model runs" (to edit the slide meanwhile)

    def caption(self, rgb: np.ndarray):
        self.calls += 1
        if self.during:
            self.during()
        return (self.text(self.calls) if callable(self.text) else self.text), 0.62


@pytest.fixture
def florence(monkeypatch):
    """Captions on (tags off), with the fake model; the background thread kept out of it."""
    fake = FakeFlorence()
    monkeypatch.setattr(captions, "backend", lambda: fake)
    monkeypatch.setattr(captions, "model_ready", lambda: True)
    monkeypatch.setattr(insights, "step", lambda: False)
    with insights.worker_busy:  # a slide the background worker was already analysing: let it finish
        pass
    store.save_config({**store.load_config(), "captions_enabled": True, "insights_enabled": False})
    yield fake
    store.save_config({**store.load_config(), "captions_enabled": False})


def analyse_all():
    while STEP():
        pass


def payload(api, sid):
    return api.get(f"/api/sessions/{sid}").json()


def decide(api, sid, **body):
    r = api.post(f"/api/sessions/{sid}/insights/decide", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def cap(g):
    return (g["insights"] or {}).get("caption")


# --------------------------------------------------------------------------- suggestions


def test_off_by_default(api, tray, monkeypatch):
    sid, _ = tray
    monkeypatch.setattr(captions, "model_ready", lambda: True)
    assert not captions.enabled()
    assert api.get("/api/insights").json()["captions"] == {"enabled": False, "ready": True,
                                                           "model_mb": captions.MODEL_MB}
    assert not STEP()


def test_captions_are_suggested_never_applied(api, tray, florence):
    sid, _ = tray
    d = payload(api, sid)
    assert d["insights"] == {"enabled": True, "ready": True, "pending": 4, "missing": []}
    analyse_all()
    d = payload(api, sid)
    assert d["insights"]["pending"] == 0 and florence.calls == 4
    for g in d["groups"]:
        assert g["caption"] == ""
        assert cap(g) == {"value": "A beach with the sea behind it.", "confidence": 0.62,
                          "source": captions.MODEL_ID, "state": "suggested"}
        assert g["insights"]["tags"] == []  # the tag model is off


def test_accept_edited_caption_goes_to_immich(api, tray, florence, immich_db):
    sid, d = tray
    payload(api, sid)
    analyse_all()
    g0, g1 = d["groups"][0]["id"], d["groups"][1]["id"]
    d = decide(api, sid, kind="caption", action="accept", groups=[g0], text="  Aunt Mia on the beach at Knokke ")
    assert d["decided"] == 1 and d["groups"][0]["caption"] == "Aunt Mia on the beach at Knokke"
    assert cap(d["groups"][0])["state"] == "accepted"
    d = decide(api, sid, kind="caption", action="accept", groups=[g1])  # as suggested
    assert d["groups"][1]["caption"] == "A beach with the sea behind it."
    d = decide(api, sid, kind="caption", action="dismiss", groups=[d["groups"][2]["id"]])
    assert d["groups"][2]["caption"] == "" and cap(d["groups"][2])["state"] == "dismissed"

    assert api.post(f"/api/sessions/{sid}/finish", json={}).json() == {"ok": True}
    wait_job(api)
    s = store.Session(sid)
    desc = [immich_db["assets"][g["immich"]["asset_id"]]["description"] for g in s.data["groups"]]
    assert desc == ["Aunt Mia on the beach at Knokke", "A beach with the sea behind it.", "", ""]


def test_never_over_a_caption_the_user_typed(api, tray, florence):
    sid, d = tray
    ids = [g["id"] for g in d["groups"]]
    api.patch(f"/api/sessions/{sid}/groups/{ids[0]}", json={"caption": "Grandpa's Opel"})
    payload(api, sid)
    analyse_all()
    d = payload(api, sid)
    assert florence.calls == 3  # the captioned slide isn't described
    assert cap(d["groups"][0]) is None and d["groups"][0]["caption"] == "Grandpa's Opel"

    # typed after the suggestion arrived: the suggestion goes, "accept all" leaves the slide alone
    d = api.patch(f"/api/sessions/{sid}/groups/{ids[1]}", json={"caption": "Picnic"}).json()
    assert cap(d["groups"][1]) is None
    d = decide(api, sid, kind="caption", action="accept", value="A beach with the sea behind it.")
    assert d["decided"] == 2  # slides 3 and 4
    assert [g["caption"] for g in d["groups"]] == ["Grandpa's Opel", "Picnic"] + ["A beach with the sea behind it."] * 2
    assert d["insights"]["pending"] == 0  # a caption of its own doesn't send a slide back to the models

    # a suggestion still open when a caption was typed can't be accepted over it
    def plant(s):
        s.group(ids[0])["insights"]["caption"] = {"value": "A car.", "confidence": 0.5, "source": "t", "state": "suggested"}

    wf.update_session(sid, plant)
    d = decide(api, sid, kind="caption", action="accept", groups=[ids[0]])
    assert d["decided"] == 0 and d["groups"][0]["caption"] == "Grandpa's Opel"

    # clearing the caption asks for a suggestion again
    api.patch(f"/api/sessions/{sid}/groups/{ids[1]}", json={"caption": ""})
    analyse_all()
    assert cap(payload(api, sid)["groups"][1])["state"] == "suggested" and florence.calls == 4


def test_dismissed_stays_dismissed_new_text_is_new(api, tray, florence):
    sid, d = tray
    g0 = d["groups"][0]["id"]
    payload(api, sid)
    analyse_all()
    decide(api, sid, kind="caption", action="dismiss", groups=[g0])
    api.post(f"/api/sessions/{sid}/insights/run", json={"force": True})
    analyse_all()  # the same words again: still dismissed
    assert cap(payload(api, sid)["groups"][0])["state"] == "dismissed"
    florence.text = "A church in a village square."
    api.patch(f"/api/sessions/{sid}/groups/{g0}", json={"rotation": 90})
    analyse_all()  # turned upright, it says something else: that is a new suggestion
    e = cap(payload(api, sid)["groups"][0])
    assert e["value"] == "A church in a village square." and e["state"] == "suggested"


def test_a_slide_changed_while_captioning_is_not_saved(api, tray, florence):
    sid, d = tray
    g0 = d["groups"][0]["id"]
    payload(api, sid)

    def turn():
        florence.during = None
        api.patch(f"/api/sessions/{sid}/groups/{g0}", json={"rotation": 180})

    florence.during = turn
    assert insights.analyse_slide(sid, g0)
    assert store.Session(sid).group(g0).get("insights") is None  # stale: dropped, not saved
    analyse_all()
    d = payload(api, sid)
    assert d["groups"][0]["rotation"] == 180 and cap(d["groups"][0])["state"] == "suggested"


def test_tags_and_captions_together(api, tray, florence, monkeypatch):
    sid, d = tray
    clip = FakeClip()
    monkeypatch.setattr(insights, "backend", lambda: clip)
    monkeypatch.setattr(insights, "model_ready", lambda: True)
    store.save_config({**store.load_config(), "captions_enabled": False, "insights_enabled": True})
    payload(api, sid)
    analyse_all()
    g0 = d["groups"][0]["id"]
    decide(api, sid, kind="tags", action="dismiss", value="sea", groups=[g0])
    assert cap(payload(api, sid)["groups"][0]) is None and florence.calls == 0

    # captions turned on: every slide is looked at again, the tag decisions stay
    store.save_config({**store.load_config(), "captions_enabled": True})
    assert payload(api, sid)["insights"]["pending"] == 4
    analyse_all()
    g = payload(api, sid)["groups"][0]
    assert {e["value"]: e["state"] for e in g["insights"]["tags"]} == {"beach": "suggested", "sea": "dismissed"}
    assert cap(g)["state"] == "suggested" and florence.calls == 4

    # captions off again: the open caption suggestion stays, the tags are analysed as before
    store.save_config({**store.load_config(), "captions_enabled": False})
    analyse_all()
    assert cap(payload(api, sid)["groups"][0])["state"] == "suggested" and florence.calls == 4


def test_missing_model_is_reported(api, tray, monkeypatch):
    sid, _ = tray
    store.save_config({**store.load_config(), "captions_enabled": True})
    try:
        assert payload(api, sid)["insights"] == {"enabled": True, "ready": False, "pending": 4, "missing": ["captions"]}
        assert not STEP()
    finally:
        store.save_config({**store.load_config(), "captions_enabled": False})


def test_settings_turn_captions_on(api):
    assert api.post("/api/config", json={"captions_enabled": True}).json() == {"ok": True}
    assert captions.enabled() and api.get("/api/insights").json()["captions"]["enabled"]
    api.post("/api/config", json={"captions_enabled": False})
    assert not captions.enabled()


# --------------------------------------------------------------------------- the decoding


def test_tidy():
    assert captions.tidy("  a cat  with green eyes ") == "A cat with green eyes."
    assert captions.tidy("A rocket on a launch pad at night.") == "A rocket on a launch pad at night."
    assert captions.tidy("two dogs,") == "Two dogs."
    assert captions.tidy("") == ""


def test_no_repeat_ngrams():
    assert captions._banned([2, 0, 5, 6, 7, 5, 6]) == {7}  # "5 6 7" was said: 7 can't follow "5 6" again
    assert captions._banned([2, 0, 5]) == set()


def _vocab(tmp_path):
    enc = {"<s>": 0, "<pad>": 1, "</s>": 2, "<unk>": 3, "A": 4, "Ġcat": 5, "Ġcaf": 6, "Ã©": 7, ".": 8, "ĠA": 9}
    f = tmp_path / "vocab.json"
    f.write_text(json.dumps(enc), encoding="utf-8")
    return f


def test_vocab_decodes_byte_level_bpe(tmp_path):
    v = captions.Vocab(_vocab(tmp_path))
    assert v.decode([0, 4, 5, 6, 7, 8, 2, 1]) == "A cat café."  # specials skipped, bytes put back together
    assert v.decode([4, 50300]) == "A"  # task / location tokens past the vocabulary are left out


class _Out:
    def __init__(self, name):
        self.name = name


class _Session:
    def __init__(self, fn, outputs=()):
        self.fn = fn
        self.outputs = [_Out(o) for o in outputs]
        self.calls = []

    def run(self, _, feeds):
        self.calls.append(feeds)
        return self.fn(feeds)

    def get_outputs(self):
        return self.outputs


def test_greedy_decoding_loop(tmp_path):
    """The generation loop against scripted ONNX sessions: the prompt after the image tokens, <s>
    forced first, the cache fed back, a repeated trigram avoided, stopping at </s>."""
    m = captions.Florence.__new__(captions.Florence)
    m.vocab = captions.Vocab(_vocab(tmp_path))
    m.vision = _Session(lambda f: [np.zeros((1, 577, 768), np.float32)])
    m.embed = _Session(lambda f: [np.repeat(f["input_ids"][..., None].astype(np.float32), 768, -1)])
    m.encoder = _Session(lambda f: [f["inputs_embeds"] + 1])
    # wants "A cat A cat A cat": the no-repeat rule turns the third "cat" into "."
    script = [4, 5, 9, 5, 9, 5, 2]
    names = ["logits"] + [f"present.{i}.{p}.{kv}" for i in range(captions.LAYERS)
                          for p in ("decoder", "encoder") for kv in ("key", "value")]

    def decoder(f):
        step = len(m.decoder.calls) - 1
        past = f["past_key_values.0.decoder.key"].shape[2]
        assert past == step and bool(f["use_cache_branch"][0]) == (step > 0)
        assert f["encoder_hidden_states"].shape == (1, 577 + len(captions.PROMPT), 768)
        logits = np.full((1, 1, 10), -5.0, np.float32)
        want = script[min(step - 1, len(script) - 1)] if step else 3
        logits[0, 0, want] = 5.0
        logits[0, 0, 8] = 4.0  # "." is the runner-up
        grown = np.zeros((1, 12, past + 1, 64), np.float32)
        enc = np.zeros((1, 12, 585, 64), np.float32)
        return [logits] + [grown if ".decoder." in n else enc for n in names[1:]]

    m.decoder = _Session(decoder, names)
    ids, conf = m.generate(np.zeros((10, 10, 3), np.float32))
    assert m.embed.calls[0]["input_ids"].tolist() == [captions.PROMPT]
    assert m.encoder.calls[0]["inputs_embeds"].shape == (1, 585, 768)
    assert m.decoder.calls[0]["inputs_embeds"][0, 0, 0] == captions.EOS  # starts from </s>
    assert ids[0] == captions.BOS  # forced, though the model wanted <unk>
    assert m.vocab.decode(ids) == "A cat A cat A."
    assert 0 < conf < 1
    m.decoder.calls = []
    assert m.caption(np.zeros((10, 10, 3), np.float32))[0] == "A cat A cat A."


def test_preprocess_squashes_to_768():
    x = captions.preprocess(np.full((300, 500, 3), 0.5, np.float32))
    assert x.shape == (3, 768, 768) and x.dtype == np.float32
    assert np.allclose(x[:, 0, 0], (128 / 255 - captions.MEAN) / captions.STD, atol=1e-5)


# --------------------------------------------------------------------------- model download


def test_download_endpoint_fetches_the_caption_model(api, monkeypatch):
    blob = os.urandom(200_000)
    files = [("onnx/x.onnx", "vision_encoder.onnx", len(blob), "sha256:" + hashlib.sha256(blob).hexdigest())]
    seen = []

    def handler(req: httpx.Request):
        seen.append(req.url.path)
        return httpx.Response(200, content=blob)

    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(captions, "MODEL_FILES", files)
    d = captions.model_dir()
    if d.exists():
        for f in d.iterdir():
            f.unlink()
    assert api.post("/api/insights/model", json={"models": ["nope"]}).status_code == 400
    assert api.post("/api/insights/model", json={"models": ["captions"]}).json() == {"ok": True, "ready": False}
    job = wait_job(api)
    assert job["kind"] == "model" and "Caption model ready" in job["message"]
    assert seen == ["/onnx-community/Florence-2-base-ft/resolve/" + captions._REPO.rsplit("/", 2)[-2] + "/onnx/x.onnx"]
    assert captions.model_ready() and (d / "vision_encoder.onnx").read_bytes() == blob
    assert api.post("/api/insights/model", json={"models": ["captions"]}).json() == {"ok": True, "ready": True}


# --------------------------------------------------------------------------- the real model


def _rss_mb() -> int:
    try:
        with open("/proc/self/status") as f:
            return next(int(line.split()[1]) // 1024 for line in f if line.startswith("VmRSS"))
    except OSError:
        return 0


@pytest.mark.skipif(not os.environ.get("SS_REAL_CAPTIONS"), reason="set SS_REAL_CAPTIONS=1 to download and run the real model")
def test_real_florence_on_synthetic_scenes():
    if not captions.model_ready():
        captions.download_model(wf.Job("model", None))
    b = captions.backend()
    assert b is not None
    out = {}
    for name, scene in (("beach", _beach_scene(480, 720)), ("snow", _snow_scene(480, 720))):
        t = time.time()
        out[name] = b.caption(scene)
        print(f"{name}: {out[name][0]!r} ({out[name][1]:.2f}) {time.time() - t:.1f}s, RSS {_rss_mb()} MB")
    for text, conf in out.values():
        assert text[0].isupper() and text.endswith(".") and 3 <= len(text.split()) <= 25 and text.isascii()
        assert 0 < conf <= 1
    assert "mountain" in out["snow"][0].lower() or "snow" in out["snow"][0].lower()
