"""Write frontend/src/standalone/filmstock.fixture.json: film-stock inputs with what filmstock.py and
store.slide_dates make of them, for filmstock.test.ts (the browser's port must agree).

    uv run --python 3.12 python tests/make_filmstock_fixture.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from test_filmstock import faded  # noqa: E402  (the synthetic fades, no conftest needed)

from slidestation import filmstock, store  # noqa: E402

OUT = ROOT / "frontend/src/standalone/filmstock.fixture.json"


def main() -> None:
    feats = {f"{s}{i}": [round(x, 6) for x in faded(s, i)] for s in ("kodachrome", "ektachrome", "agfachrome") for i in range(3)}
    heur = {k: filmstock.heuristic(f) for k, f in feats.items()}

    # a tray: an Ektachrome-looking run, a slide set to Agfachrome, a dated Kodachrome roll
    groups = [{"id": f"g{i}", "feat": feats[f"ektachrome{i % 3}"], "date": ""} for i in range(4)]
    groups += [{"id": "a", "feat": feats["agfachrome0"], "stock": "agfachrome", "date": ""},
               {"id": "k0", "feat": feats["kodachrome0"], "stock": "kodachrome", "date": "1975-06"},
               {"id": "k1", "feat": feats["kodachrome1"], "stock": "kodachrome", "date": ""},
               {"id": "k2", "feat": feats["kodachrome2"], "date": "", "skip": True},
               {"id": "late", "feat": feats["agfachrome1"], "stock": "agfachrome", "date": "2008"},
               {"id": "q", "feat": feats["agfachrome2"], "date": ""}]
    tray = {"id": "t", "date": "1976", "stock": "", "groups": groups}
    with tempfile.TemporaryDirectory() as tmp:
        empty = filmstock.Labels(Path(tmp) / "none.json")
        lab = filmstock.Labels(Path(tmp) / "stocks.json")
        examples = []
        for s in ("kodachrome", "agfachrome"):
            for i in range(6):
                examples.append({"key": f"x:{s}{i}", "f": [round(x, 5) for x in faded(s, 20 + i)], "s": s, "t": 0})
        lab.examples = examples
        lab._fit()
        dates = store.slide_dates(tray)
        out = {
            "features": feats,
            "heuristic": heur,
            "tray": tray,
            "slide_dates": dates,
            "stock_heuristic": filmstock.stock_suggestions(tray, empty),
            "stock_knn": filmstock.stock_suggestions(tray, lab),
            "date_suggestions": filmstock.date_suggestions(tray, dates),
            "labels": examples,
            "predict": {k: lab.predict(f) for k, f in feats.items()},
        }
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
