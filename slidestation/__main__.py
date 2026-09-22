import os

os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")

from .server import main  # noqa: E402

main()
