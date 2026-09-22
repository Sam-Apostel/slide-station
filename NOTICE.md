# Third-party components

The MIT licence in `LICENSE` covers this project's own code. It does **not** cover the
third-party files listed here.

## ProUI — `frontend/src/components/ui/*`

Commercial component library (<https://pro-ui.dev>), installed from its shadcn-style
registry. ProUI is paid software; using it requires a licence from ProUI, and its terms state that
you may not "redistribute ProUI itself as a competing component library or template kit".

These files are present in this repository at the project owner's decision. Anyone forking or
copying this repository should assume the ProUI files are **not** theirs to reuse and should obtain
their own ProUI licence, or replace them with the free shadcn/ui equivalents (MIT).

If ProUI would rather these files were not published, open an issue and they will be removed and
replaced with a setup step that fetches them from the registry instead.

## YuNet face detector — `slidestation/models/face_detection_yunet_2023mar.onnx`

From OpenCV Zoo (<https://github.com/opencv/opencv_zoo>), MIT licence. Used to work out which way
up a slide is.

## Python and JavaScript dependencies

See `pyproject.toml` and `frontend/package.json`; each keeps its own licence.
