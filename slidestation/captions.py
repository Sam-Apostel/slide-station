"""Captions: a one-sentence description of each slide from a small local vision-language model.

Microsoft's Florence-2 base (fine-tuned, MIT licence), exported to ONNX by onnx-community and
quantized to 8 bits: four small models run with onnxruntime on the CPU.

    pixels (768 x 768) -> vision encoder -> 577 image tokens --+
    the <CAPTION> prompt ("What does the image describe?") ----+-> encoder -> decoder, one token at a time

The decoder is run greedily (the same tokens transformers' `generate(num_beams=1)` picks, with
the model's no_repeat_ngram_size of 3) with its key / value cache, up to MAX_TOKENS. The output
tokens are turned back into text with BART's byte-level vocabulary; nothing needs encoding (the
prompt's ids are fixed), so there is no tokenizer beyond that table.

The caption is a suggestion like the scene tags (`insights.py` runs it in the same background
worker, one slide at a time): the user edits or accepts it into the slide's caption, which goes to
Immich as the description and into the export's EXIF ImageDescription. A slide that already has a
caption (typed, or pulled from Immich) is never captioned.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import numpy as np
from PIL import Image

from .store import library, load_config, models_dir

MODEL_ID = "florence-2-base"
_REPO = "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f/"
# (path in the repo, local name, bytes, checksum): LFS files by sha256, small ones by git blob sha1
MODEL_FILES = [
    ("onnx/vision_encoder_quantized.onnx", "vision_encoder.onnx", 93746540,
     "sha256:3b79d54f23f666f731549db23cb070c35a979ce19cbd9720e90e67a78dc9768c"),
    ("onnx/embed_tokens_quantized.onnx", "embed_tokens.onnx", 39390433,
     "sha256:6b2258db1c8ee9b160576ccde3cd3814d83a2edaed0dd1c6ca9ff3c38fa62214"),
    ("onnx/encoder_model_quantized.onnx", "encoder_model.onnx", 43651493,
     "sha256:f4ad7a68f1fb875d3bcf735ea14a7021b7ba7e83baf7cf10289881b4ed6d9b85"),
    ("onnx/decoder_model_merged_quantized.onnx", "decoder_model_merged.onnx", 98177697,
     "sha256:f22f52f980c33df0efa15932c2f3db6d9d3595ce6387eca938b8cfe23dc4c641"),
    ("vocab.json", "vocab.json", 1099884, "git:94a2f4fd50e976bda926c700291522ea1a79323f"),
]
MODEL_MB = round(sum(f[2] for f in MODEL_FILES) / 1e6)

SIZE = 768  # the vision encoder's input, width and height (the image is squashed, not cropped)
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
BOS, PAD, EOS = 0, 1, 2  # BART's <s>, <pad>, </s>; the decoder starts from </s> and must say <s> first
PROMPT = [BOS, 2264, 473, 5, 2274, 6190, 116, EOS]  # "<s>What does the image describe?</s>" (<CAPTION>)
LAYERS = 6  # decoder layers
DEPTHS = (1, 1, 9, 1)  # the vision encoder (DaViT) blocks per stage
NO_REPEAT = 3  # the model's no_repeat_ngram_size: no three tokens twice
MAX_TOKENS = 40
MAX_CHARS = 200


def model_dir() -> Path:
    return models_dir() / MODEL_ID


def model_ready() -> bool:
    d = model_dir()
    return all((d / name).is_file() and (d / name).stat().st_size == size for _, name, size, _ in MODEL_FILES)


def enabled() -> bool:
    return bool(load_config().get("captions_enabled", False))


def download_model(job) -> None:
    """Fetch the caption model (resumable, verified, atomic: `insights.fetch_files`)."""
    from . import insights

    insights.fetch_files(job, _REPO, MODEL_FILES, model_dir(), "caption model")
    job.message = "Caption model ready: slides are described in the background"


# ------------------------------------------------------------------------------------ text


def _byte_decoder() -> dict[str, int]:
    from .insights import _bytes_to_unicode

    return {c: b for b, c in _bytes_to_unicode().items()}


class Vocab:
    """BART's byte-level BPE, backwards only: token ids to text. Ids past the base vocabulary are
    Florence's task and location tokens (<loc_12>, <cap> ...) and, like <s> </s> <pad>, are skipped."""

    def __init__(self, vocab: Path):
        enc = json.loads(vocab.read_text(encoding="utf-8"))
        self.tokens = [""] * (max(enc.values()) + 1)
        for t, i in enc.items():
            self.tokens[i] = t
        self.special = {BOS, PAD, EOS, enc.get("<unk>", 3)}
        self.bytes = _byte_decoder()

    def decode(self, ids: list[int]) -> str:
        s = "".join(self.tokens[i] for i in ids if i < len(self.tokens) and i not in self.special)
        return bytes(self.bytes[c] for c in s if c in self.bytes).decode("utf-8", errors="replace")


def tidy(text: str) -> str:
    """One short sentence: whitespace collapsed, a capital first letter, a full stop at the end."""
    text = " ".join(text.split())[:MAX_CHARS].strip()
    if not text:
        return ""
    text = text[0].upper() + text[1:]
    return text if text[-1] in ".!?" else text.rstrip(",;:") + "."


# ------------------------------------------------------------------------------------ the model


def preprocess(rgb: np.ndarray) -> np.ndarray:
    """Florence's input (its CLIPImageProcessor settings): 768 x 768 bicubic, ImageNet mean / std, CHW."""
    img = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8))
    a = np.asarray(img.resize((SIZE, SIZE), Image.BICUBIC), np.float32) / 255
    return ((a - MEAN) / STD).transpose(2, 0, 1).copy()


def _banned(seq: list[int], n: int = NO_REPEAT) -> set[int]:
    """Tokens that would repeat an n-gram already in `seq` (transformers' no_repeat_ngram_size)."""
    if len(seq) < n:
        return set()
    prefix = tuple(seq[len(seq) - n + 1:])
    return {seq[i + n - 1] for i in range(len(seq) - n + 1) if tuple(seq[i:i + n - 1]) == prefix}


class Florence:
    """The four ONNX parts and the vocabulary. `caption(rgb)` -> (text, confidence)."""

    def __init__(self, d: Path):
        import onnxruntime as ort

        self.dir = d
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)  # leave room for the UI's renders
        opts.enable_cpu_mem_arena = False  # the image-sized buffers go back to the system after each slide

        def load(name, o=opts):
            return ort.InferenceSession(str(d / name), o, providers=["CPUExecutionProvider"])

        # The ONNX export traced the vision encoder on a 224 x 224 image, which froze its channel
        # attention's scale (1 / sqrt(tokens), tokens = 56², 28², 14², 7² per stage) as constants.
        # At 768 x 768 they must be 1 / 192, 1 / 96, 1 / 48, 1 / 24, or the features drift far from
        # the PyTorch model's (correlation 0.91; captions change). Overridden at load time.
        vopts = ort.SessionOptions()
        vopts.intra_op_num_threads = opts.intra_op_num_threads
        vopts.enable_cpu_mem_arena = False
        self._scales = []  # the session only borrows these: keep them alive
        for stage, depth in enumerate(DEPTHS):
            v = ort.OrtValue.ortvalue_from_numpy(np.array(2.0 ** stage / (SIZE / 4), np.float32))
            self._scales.append(v)
            for j in range(depth):
                vopts.add_initializer(f"/blocks.{stage}/blocks.{stage}.{j}/channel_block/channel_attn/fn/Constant_6_output_0", v)
        self.vision = load("vision_encoder.onnx", vopts)
        self.embed = load("embed_tokens.onnx")
        self.encoder = load("encoder_model.onnx")
        self.decoder = load("decoder_model_merged.onnx")
        self.vocab = Vocab(d / "vocab.json")

    def _embed(self, ids: list[int]) -> np.ndarray:
        return self.embed.run(None, {"input_ids": np.array([ids], np.int64)})[0]

    def generate(self, rgb: np.ndarray) -> tuple[list[int], float]:
        """Greedy decoding with the key / value cache. Returns the tokens (after the start token)
        and the geometric mean of their probabilities."""
        image = self.vision.run(None, {"pixel_values": preprocess(rgb)[None]})[0]
        x = np.concatenate([image, self._embed(PROMPT)], axis=1)
        mask = np.ones(x.shape[:2], np.int64)
        hidden = self.encoder.run(None, {"inputs_embeds": x, "attention_mask": mask})[0]

        empty = np.zeros((1, 12, 0, 64), np.float32)
        past = {f"past_key_values.{i}.{part}.{kv}": empty
                for i in range(LAYERS) for part in ("decoder", "encoder") for kv in ("key", "value")}
        names = [o.name for o in self.decoder.get_outputs()]
        seq, logp = [EOS], []
        for step in range(MAX_TOKENS):
            out = self.decoder.run(None, {
                "inputs_embeds": self._embed(seq[-1:]), "encoder_hidden_states": hidden,
                "encoder_attention_mask": mask, "use_cache_branch": np.array([step > 0]), **past})
            logits = out[0][0, -1].astype(np.float64)
            for name, v in zip(names[1:], out[1:]):
                if step == 0 or ".decoder." in name:  # the cross-attention cache is computed once
                    past[name.replace("present", "past_key_values")] = v
            lp = logits - logits.max()
            lp -= np.log(np.exp(lp).sum())
            if step == 0:
                nxt = BOS  # forced_bos_token_id
            elif step == MAX_TOKENS - 1:
                nxt = EOS  # forced_eos_token_id at the length limit
            else:
                lp_pick = lp.copy()
                lp_pick[list(_banned(seq))] = -np.inf
                nxt = int(np.argmax(lp_pick))
                logp.append(lp[nxt])
            seq.append(nxt)
            if nxt == EOS:
                break
        conf = float(np.exp(np.mean(logp))) if logp else 0.0
        return seq[1:], conf

    def caption(self, rgb: np.ndarray) -> tuple[str, float]:
        ids, conf = self.generate(rgb)
        return tidy(self.vocab.decode(ids)), conf


_model: Florence | None = None
_model_lock = threading.Lock()


def backend():
    """The loaded model (`caption(rgb) -> (text, confidence)`), or None while it isn't downloaded.
    Tests replace this with a fake."""
    global _model
    if not model_ready():
        return None
    with _model_lock:
        if _model is None or _model.dir != model_dir():
            _model = Florence(model_dir())
        return _model


def release() -> None:
    """Let the loaded model go (captions turned off): its ~0.5 GB goes back to the system."""
    global _model
    with _model_lock:
        _model = None
