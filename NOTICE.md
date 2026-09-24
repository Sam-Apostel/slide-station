# Third-party components

The MIT licence in `LICENSE` covers this project's own code. It does **not** cover the
third-party files listed here.

## ProUI — `frontend/src/components/ui/*`

Commercial component library (<https://pro-ui.dev>), installed from its shadcn-style registry
with the project owner's licence. ProUI is paid software; its terms state that you may not
"redistribute ProUI itself as a competing component library or template kit".

ProUI's owner agreed to this repository including the components the app genuinely uses, as long
as the kit itself isn't bundled. Only those components are here, and the ProUI theme in
`frontend/src/index.css` is trimmed to them. They are **not** licensed for reuse: anyone forking or
copying this repository needs their own ProUI licence, or should replace them with the free
shadcn/ui equivalents (MIT).

Many ProUI components are adapted from shadcn/ui (<https://github.com/shadcn-ui/ui>),
MIT licence, Copyright (c) 2023 shadcn.

## ProUI for SwiftUI — `apple/Vendor/ProUI/*`

The same licence and the same agreement, for the native app. The SwiftUI kit ships as source; only
the files the app uses are here (theme, button, inspector with disclosure groups, button group, toolbar, scope bar and status
bar, and their shared support), with unused parts of those files removed and the colours changed to
the Slide Station skin. The rest of the kit, its icon sets and the six template apps are not
included. Not licensed for reuse — get your own ProUI licence.

## YuNet face detector — `slidestation/models/face_detection_yunet_2023mar.onnx`

From OpenCV Zoo (<https://github.com/opencv/opencv_zoo>), MIT licence. Used to work out which way
up a slide is, and to find the faces for recognising people. The browser version serves the same
file and runs it with onnxruntime-web (MIT, `frontend/package.json`).

## SFace face recognition model — not in the repository

`face_recognition_sface_2021dec.onnx` from OpenCV Zoo, Apache 2.0 licence, is downloaded on first
use (Settings → recognise people) from OpenCV's Hugging Face mirror into the library's `models/`
folder. It is never bundled.

## CLIP ViT-B/32 (scene tags) — downloaded, not in the repo

When "Suggest tags" is turned on, the app downloads OpenAI's CLIP ViT-B/32 (MIT licence,
<https://github.com/openai/CLIP>) as quantized ONNX files converted by Xenova
(<https://huggingface.co/Xenova/clip-vit-base-patch32>, a pinned revision) into the library's
`models/` folder. Nothing of it is committed or bundled.

## Python and JavaScript dependencies

See `pyproject.toml` and `frontend/package.json`; each keeps its own licence.
