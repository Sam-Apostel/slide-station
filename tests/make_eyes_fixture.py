"""Write frontend/src/standalone/eyes.fixture.json: inputs for eyes.py (the eye aspect ratio, the crop
around a face, which faces count) and for look-alikes weighing open eyes into "keep the best", with
what Python makes of them, for eyes.test.ts (the browser's port must agree).

    uv run --python 3.12 python tests/make_eyes_fixture.py
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_insights_fixture import ROOT, f32, near, pattern, unit  # noqa: E402  (sets up a scratch home)

import cv2  # noqa: E402

from slidestation import eyes, similar  # noqa: E402

OUT = ROOT / "frontend/src/standalone/eyes.fixture.json"


def main() -> None:
    rng = np.random.default_rng(11)
    out: dict = {"model": eyes.MODEL_ID}
    pts = [np.asarray(rng.uniform(0, 60, (6, 2)), np.float32) for _ in range(6)]
    out["ear"] = [{"p": [f32(p) for p in x], "ear": eyes.ear(x)} for x in pts]
    mesh = np.asarray(rng.uniform(0, 256, (478, 3)), np.float32)
    out["mesh"] = {"pts": f32(mesh), "ear": eyes.face_ear(mesh)}
    xs = [0.0, 0.05, 0.1, 0.12, 0.14, 0.17, 0.18, 0.3]
    out["openness"] = [[x, eyes.openness(x)] for x in xs]
    entries = [{"model": eyes.MODEL_ID, "ear": [0.3, 0.12]}, {"model": eyes.MODEL_ID, "ear": []},
               {"model": "other", "ear": [0.3]}, None, {"model": eyes.MODEL_ID, "ear": [0.25, 0.4]}]
    out["slide_open"] = [[e, eyes.slide_open(e)] for e in entries]

    # the crop: the affine from a YuNet row, and the 256 px warp of 8-bit RGB (cv2.warpAffine)
    img = pattern(300, 200)
    out["crop"] = []
    for row in ([60, 40, 70, 80, 78.3, 70.1, 112.6, 69.4, 95.2, 88.8, 82.0, 104.5, 109.7, 103.9, 0.93],
                [150.5, 20.25, 40, 52, 160.5, 45.2, 179.8, 52.9, 0, 0, 0, 0, 0, 0, 0.8],
                [200, 120, 90, 100, 230.2, 170.0, 250.3, 140.4, 0, 0, 0, 0, 0, 0, 0.75]):
        row = np.asarray(row, np.float32)
        m = eyes.crop_matrix(row)
        crop = cv2.warpAffine(img, m, (eyes.SIZE, eyes.SIZE), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        out["crop"].append({"face": f32(row), "m": m.reshape(-1).tolist(),
                            "sha1": hashlib.sha1(crop.tobytes()).hexdigest(), "sum": int(crop.astype(np.int64).sum())})

    # which faces count: (x, y, w, h, eyes..., score) rows on a 1000 px wide picture
    rows = np.zeros((7, 15), np.float32)
    for k, (w, score) in enumerate([(120, 0.9), (200, 0.95), (90, 0.9), (150, 0.5), (39, 0.99), (100, 0.72),
                                    (100.5, 0.8)]):
        rows[k, 2], rows[k, 14] = w, score
    out["prominent"] = {"faces": [[float(r[2]), float(r[14])] for r in rows], "width": 1000,
                        "kept": [float(f[2]) for f in eyes.prominent(rows, 1000)]}

    out["best_of"] = []
    for scores, opened in (({"a": 0.9, "b": 0.6, "c": 0.5}, {}), ({"a": 0.9, "b": 0.6, "c": 0.5}, {"a": 0.0}),
                           ({"a": 0.9, "b": 0.35}, {"a": 0.0, "b": 1.0}), ({"a": 0.9, "b": 0.37}, {"a": 0.0, "b": 1.0}),
                           ({"a": 0.0, "b": 0.0}, {"a": 0.0}), ({"a": 0.5, "b": 0.5}, {"a": 0.4, "b": 0.4}),
                           ({"12": 0.5, "3": 0.5}, {})):
        out["best_of"].append({"ids": list(scores), "scores": scores, "opened": opened,
                               "best": similar.best_of(scores, opened)})

    # look-alikes: a tray of duplicates with eyes measured on some slides
    base, other = unit(rng.normal(size=16)), unit(rng.normal(size=16))
    groups, slides = [], {}
    for gid, vec, sharp, ear in (("a", base, 1.0, [0.3, 0.05]), ("b", near(base, 0.97, rng), 0.8, [0.26, 0.3]),
                                 ("c", near(base, 0.96, rng), 0.9, None), ("d", other, 1.0, [0.02]),
                                 ("e", near(other, 0.98, rng), 0.5, [0.13]), ("f", near(other, 0.5, rng), 1.0, [])):
        g = {"id": gid, "scans": [gid + "s0"], "excluded": [], "rotation": 0, "skip": False}
        groups.append(g)
        slides[gid] = {"key": similar.slide_key(g), "emb": similar._pack(vec), "q": {"sharp": sharp, "clipped": 0.1}}
        if ear is not None:
            slides[gid]["eyes"] = {"model": eyes.MODEL_ID, "ear": ear}
    tray = {"id": "t", "groups": groups, "similar": {"apart": [], "dismissed": []}}
    e = {"slides": slides, "scans": {}}

    class S:
        id = "t"
        data = tray

    out["similar"] = {"tray": tray, "embeddings": e, "duplicates": similar.suggest(S(), e, 0.93)["duplicates"]}
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print("wrote", OUT, f"{OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
