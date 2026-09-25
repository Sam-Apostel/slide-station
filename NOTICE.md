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

## Age estimation model (dates from people) — downloaded, not in the repo

When "Date slides by the ages of the people on them" is turned on (desktop / server app), the app
downloads a ViT-B/16 age and gender model, Apache 2.0 licence
(<https://huggingface.co/abhilash88/age-gender-prediction>), as the ONNX export by onnx-community
(<https://huggingface.co/onnx-community/age-gender-prediction-ONNX>, a pinned revision) into the
library's `models/` folder; only its age output is used. It was trained on the UTKFace dataset, whose
images are for non-commercial research. Nothing of it is committed or bundled.

## Map — Leaflet and OpenStreetMap

People & Places draws its map with Leaflet (BSD 2-clause, `frontend/package.json`) on
OpenStreetMap's tiles (© OpenStreetMap contributors, ODbL; credited on the map), fetched from
tile.openstreetmap.org by the viewer's browser under OSM's tile usage policy.

## CLIP ViT-B/32 (scene tags) — downloaded, not in the repo

When "Suggest tags" is turned on, the app downloads OpenAI's CLIP ViT-B/32 (MIT licence,
<https://github.com/openai/CLIP>) as quantized ONNX files converted by Xenova
(<https://huggingface.co/Xenova/clip-vit-base-patch32>, a pinned revision) into the library's
`models/` folder. Nothing of it is committed or bundled.

## Florence-2 base (captions) — downloaded, not in the repo

When "Suggest captions" is turned on, the app downloads Microsoft's Florence-2 base, fine-tuned
(MIT licence, Copyright (c) Microsoft Corporation, <https://huggingface.co/microsoft/Florence-2-base-ft>)
as 8-bit ONNX files converted by onnx-community
(<https://huggingface.co/onnx-community/Florence-2-base-ft>, a pinned revision), plus its BART
vocabulary, into the library's `models/` folder. Nothing of it is committed or bundled.
## GeoNames place names (places) — downloaded, not in the repo

The place field searches GeoNames' `cities15000.zip`, `countryInfo.txt` and `admin1CodesASCII.txt`
from <https://download.geonames.org/export/dump/>, downloaded on first use into the library's
`data/geonames/` folder. The browser version, which download.geonames.org doesn't serve (no CORS),
takes the same three files of one day's dump (2026-09-15) from a CC BY 4.0 copy on Hugging Face
(<https://huggingface.co/datasets/DataDock/geonames>, a pinned revision). GeoNames data is licensed under Creative Commons Attribution 4.0
(<https://creativecommons.org/licenses/by/4.0/>): **place names and coordinates © GeoNames
(<https://www.geonames.org>)**. The data is used unmodified; nothing of it is committed or bundled.

## PaddleOCR text detection and recognition (place suggestions) — downloaded, not in the repo

When "Suggest places from signs" is downloaded, the app fetches PaddleOCR's PP-OCRv3 mobile text
detector and PP-OCRv5 Latin-script recogniser (Apache 2.0, <https://github.com/PaddlePaddle/PaddleOCR>)
as ONNX files converted by monkt (<https://huggingface.co/monkt/paddleocr-onnx>, a pinned revision,
Apache 2.0) into the library's `models/ppocr/` folder. Nothing of it is committed or bundled.

## MediaPipe face landmarks (eyes open) — downloaded, not in the repo

When "Prefer the shot with open eyes" is turned on, the app downloads the face landmarks model of
Google's MediaPipe Face Landmarker (the 478-point face mesh; Apache 2.0, © Google LLC,
<https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker>) as an ONNX file converted
from the TFLite original with the weights unchanged by senty-au
(<https://huggingface.co/senty-au/face_landmarks_detector-ONNX>, Apache 2.0, a pinned revision; its
model card names the source bundle and its checksums) into the library's `models/face-landmarks-478/`
folder. Nothing of it is committed or bundled. (Ready-made open / closed eye classifiers were not
used: the usual ones on Hugging Face are licensed for non-commercial use only, CC BY-NC.)

## Python and JavaScript dependencies

See `pyproject.toml` and `frontend/package.json`; each keeps its own licence.
