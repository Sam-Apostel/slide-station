"""Write tests/fake_clip/: a stand-in for the scene-tag model (CLIP) small enough to keep in the repo, for
tests/web_flow.py (the browser version downloads it from the test server instead of Hugging Face).

    uv run --python 3.12 --with onnx python tests/make_fake_clip.py

Same inputs and outputs as Xenova/clip-vit-base-patch32's quantized ONNX files: `vision.onnx` maps
pixel_values [n, 3, h, w] to image_embeds [n, 512] (each channel's mean and mean square through a fixed
random matrix, so different pictures point different ways), `text.onnx` maps input_ids [n, l] (int64) to
text_embeds [n, 512] (sines of the ids' sum), plus a small byte-level BPE vocabulary learned from the
label prompts (vocab.json, merges.txt), enough for the tokenizer to encode them. Nothing it says is
meaningful; it only lets the whole path run: download, checksum, tokenizer, text and image model, tags.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fake_clip"
DIM = 512


def vision():
    from onnx import TensorProto, helper, numpy_helper

    w = np.random.default_rng(1).normal(size=(6, DIM)).astype(np.float32)
    nodes = [
        helper.make_node("ReduceMean", ["pixel_values"], ["mean"], axes=[2, 3], keepdims=0),
        helper.make_node("Mul", ["pixel_values", "pixel_values"], ["sq"]),
        helper.make_node("ReduceMean", ["sq"], ["meansq"], axes=[2, 3], keepdims=0),
        helper.make_node("Concat", ["mean", "meansq"], ["feat"], axis=1),
        helper.make_node("MatMul", ["feat", "w"], ["image_embeds"]),
    ]
    g = helper.make_graph(
        nodes, "fake-clip-vision",
        [helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, ["batch_size", 3, "height", "width"])],
        [helper.make_tensor_value_info("image_embeds", TensorProto.FLOAT, ["batch_size", DIM])],
        [numpy_helper.from_array(w, "w")])
    return helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)


def text():
    from onnx import TensorProto, helper, numpy_helper

    rng = np.random.default_rng(2)
    f = rng.uniform(0.001, 0.05, size=(1, DIM)).astype(np.float32)
    ph = rng.uniform(0, 6.28, size=(1, DIM)).astype(np.float32)
    nodes = [
        helper.make_node("Cast", ["input_ids"], ["ids"], to=TensorProto.FLOAT),
        helper.make_node("ReduceSum", ["ids", "axis"], ["sum"], keepdims=1),
        helper.make_node("Mul", ["sum", "f"], ["x"]),
        helper.make_node("Add", ["x", "ph"], ["y"]),
        helper.make_node("Sin", ["y"], ["text_embeds"]),
    ]
    g = helper.make_graph(
        nodes, "fake-clip-text",
        [helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch_size", "sequence_length"])],
        [helper.make_tensor_value_info("text_embeds", TensorProto.FLOAT, ["batch_size", DIM])],
        [numpy_helper.from_array(f, "f"), numpy_helper.from_array(ph, "ph"),
         numpy_helper.from_array(np.array([1], np.int64), "axis")])
    return helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)


def bytes_to_unicode() -> dict[int, str]:  # insights._bytes_to_unicode, without importing the app
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs, n = bs[:], 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, map(chr, cs)))


def vocabulary(prompts: list[str]) -> tuple[dict, str]:
    """A byte-level BPE vocabulary learned from the prompts: every byte (and byte + "</w>"), 80 merges."""
    enc = bytes_to_unicode()
    base = list(enc.values())
    vocab = base + [c + "</w>" for c in base]
    words = Counter()
    for p in prompts:
        for w in p.split():
            chars = list("".join(enc[b] for b in w.encode()))
            words[tuple(chars[:-1] + [chars[-1] + "</w>"])] += 1
    merges = []
    for _ in range(80):
        pairs = Counter()
        for w, n in words.items():
            for a, b in zip(w, w[1:]):
                pairs[(a, b)] += n
        if not pairs:
            break
        (a, b), _ = max(pairs.items(), key=lambda kv: (kv[1], kv[0]))
        merges.append(f"{a} {b}")
        vocab.append(a + b)
        new = Counter()
        for w, n in words.items():
            out, i = [], 0
            while i < len(w):
                if i < len(w) - 1 and (w[i], w[i + 1]) == (a, b):
                    out.append(a + b)
                    i += 2
                else:
                    out.append(w[i])
                    i += 1
            new[tuple(out)] += n
        words = new
    vocab += ["<|startoftext|>", "<|endoftext|>"]
    return {t: i for i, t in enumerate(dict.fromkeys(vocab))}, "#version: 0.2\n" + "\n".join(merges) + "\n"


def main() -> None:
    sys.path.insert(0, str(ROOT))
    src = (ROOT / "slidestation" / "insights.py").read_text()  # the prompts, without importing the app
    prompts = [p for p in __import__("re").findall(r'\("[^"]+", "([^"]+)"\)', src)]
    assert len(prompts) >= 30, prompts
    import onnx

    OUT.mkdir(exist_ok=True)
    onnx.save(vision(), OUT / "vision.onnx")
    onnx.save(text(), OUT / "text.onnx")
    vocab, merges = vocabulary(prompts)
    (OUT / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False))
    (OUT / "merges.txt").write_text(merges)
    for f in sorted(OUT.iterdir()):
        print(f.name, f.stat().st_size)


if __name__ == "__main__":
    main()
