"""Fetches the video's slides and develops them with Slide Station itself.

The pictures are real 35 mm slides from DOCUMERICA (1971-1977), the US Environmental Protection
Agency's photo project, now in the National Archives and in the public domain. sources.json lists
each one's National Archives id, its Wikimedia Commons page and the photographer; the scans are
the Archives' master TIFFs. For each slide this writes

    <name>-scan.jpg   the scan as it is: faded, trimmed of its mount edge (imaging.before_view)
    <name>.jpg        the same scan through Slide Station's develop with the default settings
                      (auto restore at 0.6, the trim), as a slide looks after import
    faces.json        the faces imaging.detect_faces finds on each developed slide, in 0..1

and CREDITS.md. Run it from the repository root with the app's dependencies:

    uv run --python 3.12 python promo/slides/prepare.py
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from slidestation import imaging  # noqa: E402

HERE = Path(__file__).parent
UA = "SlideStationPromo/1.0 (https://github.com/Sam-Apostel/slide-station)"
EDGE = 1200  # long edge of what's written: the video never shows a slide much bigger


def fetch(nara_id: str, dest: Path) -> None:
    """The National Archives' master scan of the slide (a TIFF), from its catalog record."""
    if dest.exists():
        return
    for attempt in range(5):
        try:
            rec = json.load(urllib.request.urlopen(urllib.request.Request(
                f"https://catalog.archives.gov/proxy/records/search?naId={nara_id}", headers={"User-Agent": UA}), timeout=60))
            objs = rec["body"]["hits"]["hits"][0]["_source"]["record"]["digitalObjects"]
            url = next((o["objectUrl"] for o in objs if o["objectUrl"].lower().endswith((".tif", ".tiff"))), None) \
                or next(o["objectUrl"] for o in objs if o["objectUrl"].lower().endswith(".jpg"))
            dest.write_bytes(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=300).read())
            return
        except Exception as e:
            print(f"  {dest.name}: {e}, retrying", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    raise SystemExit(f"could not fetch NARA {nara_id}")


def save(a: np.ndarray, path: Path) -> None:
    im = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))
    im.thumbnail((EDGE, EDGE), Image.LANCZOS)
    im.save(path, quality=84, optimize=True, progressive=True)


def main() -> None:
    sources = json.loads((HERE / "sources.json").read_text())
    cache = HERE / ".originals"
    cache.mkdir(exist_ok=True)
    faces = {}
    p = imaging.Params()
    for s in sources:
        orig = cache / f"{s['name']}.tif"
        fetch(s["nara_id"], orig)
        a = imaging.load_rgb(str(orig))
        save(imaging.before_view(a, p), HERE / f"{s['name']}-scan.jpg")
        dev = imaging.develop(a, p)
        save(dev, HERE / f"{s['name']}.jpg")
        h, w = dev.shape[:2]
        found = imaging.detect_faces(dev)
        faces[s["name"]] = [[round(float(f[0]) / w, 4), round(float(f[1]) / h, 4), round(float(f[2]) / w, 4), round(float(f[3]) / h, 4), round(float(f[14]), 3)]
                            for f in found if f[14] >= 0.7]
        print(f"{s['name']}: {len(faces[s['name']])} faces")
    (HERE / "faces.json").write_text(json.dumps(faces, indent=1) + "\n")

    lines = ["# Slides in the video", "",
             "Real 35 mm slides from [DOCUMERICA](https://en.wikipedia.org/wiki/Documerica) (1971–1977), the US",
             "Environmental Protection Agency's photography project, held by the National Archives. As works of",
             "the US federal government they are in the public domain. The `-scan` files are the scans as",
             "published (trimmed); the others are those scans developed by Slide Station (`prepare.py`).", "",
             "| File | Photographer | Source |", "| --- | --- | --- |"]
    for s in sources:
        lines.append(f"| `{s['name']}.jpg` | {s['photographer']} | [NARA {s['nara_id']}](https://catalog.archives.gov/id/{s['nara_id']}), [Commons]({s['page']}) |")
    (HERE / "CREDITS.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
