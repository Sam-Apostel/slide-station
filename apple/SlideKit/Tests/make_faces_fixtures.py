"""Fixtures for SlideFaces' parity tests: slidestation/people.py's answers on made-up inputs.

    uv run --python 3.12 python apple/SlideKit/Tests/make_faces_fixtures.py

Faces need no real photos here: face keys, the float16 packing, the clustering, the clothes
histogram and turned boxes are all plain maths. (YuNet and SFace themselves are checked against
cv2 on real photos by hand, never committed.)
"""
import base64
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from slidestation import people  # noqa: E402

out = {}

out["keys"] = [
    {"scans": s, "excluded": e, "rotation": r, "mirror": m,
     "key": people.face_key({"scans": s, "excluded": e, "rotation": r, "mirror": m})}
    for s, e, r, m in [(["IMG_0001.JPG"], [], 0, False), (["IMG_0002.JPG", "IMG_0003.JPG"], [], 90, False),
                       (["a.jpg", "b.jpg", "c.jpg"], ["b.jpg"], 270, True), (["été.jpg"], [], 180, False)]
]

rng = np.random.default_rng(7)
v = rng.normal(size=128).astype(np.float32)
v /= np.linalg.norm(v)
out["pack"] = {"vector": [float(x) for x in v], "packed": people._pack(v),
               "unpacked": [float(x) for x in people.unpack(people._pack(v))],
               "special": [0.0, -0.0, 1e-8, 6.1e-5, 65504.0, 1e6, -2.5, 0.33325]}
out["pack"]["special_packed"] = base64.b64encode(np.asarray(out["pack"]["special"], np.float16).tobytes()).decode()


def identities(n_people, per, noise, seed):
    r = np.random.default_rng(seed)
    centres = r.normal(size=(n_people, 128))
    emb = []
    for c in centres:
        for _ in range(per):
            e = c + r.normal(scale=noise, size=128)
            emb.append(e / np.linalg.norm(e))
    return np.asarray(emb, np.float32)


cases = []
emb = identities(4, 5, 0.6, 1)
cases.append({"emb": emb, "clusters": [], "rejected": {}, "slides": None})
cases.append({"emb": emb, "clusters": [[0, 1], [5]], "rejected": {}, "slides": None})
cases.append({"emb": emb, "clusters": [[0, 1, 2]], "rejected": {3: {0}}, "slides": None})
slides = [f"t/{i % 7}" for i in range(len(emb))]
cases.append({"emb": emb, "clusters": [[10]], "rejected": {}, "slides": slides})
emb2 = identities(6, 3, 0.9, 2)
cases.append({"emb": emb2, "clusters": [], "rejected": {}, "slides": [f"t/{i // 2}" for i in range(len(emb2))]})
out["agglomerate"] = [
    {"emb": [[float(x) for x in e] for e in c["emb"]], "clusters": c["clusters"],
     "rejected": {str(k): sorted(v) for k, v in c["rejected"].items()}, "slides": c["slides"],
     "groups": people.agglomerate(c["emb"], c["clusters"], c["rejected"], slides=c["slides"])}
    for c in cases
]

# clothes: a made-up picture, a face near the top, a shirt below it
h, w = 90, 120
yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
img = np.stack([0.2 + 0.6 * xx / w, 0.3 + 0.5 * yy / h, 0.5 + 0.3 * np.sin(xx / 9)], -1).astype(np.float32)
img[40:85, 40:85] = [0.8, 0.15, 0.2]  # a red shirt
img[50:70, 55:65] = [0.1, 0.1, 0.6]
box = [0.38, 0.12, 0.2, 0.26]
out["clothes"] = {"width": w, "height": h, "rgb": base64.b64encode(img.tobytes()).decode(), "box": box,
                  "hist": [float(x) for x in people.describe_clothes(img, box)],
                  "edge_box": [0.4, 0.8, 0.1, 0.18],
                  "edge": people.describe_clothes(img, [0.4, 0.8, 0.1, 0.18]) is None}
a = people.describe_clothes(img, box)
b = people.describe_clothes(img[:, ::-1].copy(), box)
out["clothes"]["like_self"] = people.clothes_like(a, a)
out["clothes"]["like_mirrored"] = people.clothes_like(a, b)
out["clothes"]["mirrored_hist"] = [float(x) for x in b]

out["turn"] = [{"box": bx, "from": list(f), "to": list(t), "out": people._turn_box(bx, f, t)}
               for bx in ([0.1, 0.2, 0.3, 0.25], [0.6, 0.05, 0.1, 0.2])
               for f in ((0, False), (90, False), (270, True))
               for t in ((0, False), (180, False), (90, True))]

dest = Path(__file__).parent / "SlideFacesTests" / "Fixtures" / "people.json"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out))
print("wrote", dest, dest.stat().st_size // 1024, "KB")
