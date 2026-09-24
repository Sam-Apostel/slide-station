# Slide Station as a container next to Immich (README "Next to Immich", ARCHITECTURE "Hosted container").
#
#   docker build -t slide-station .
#   docker run -p 8765:8765 -v slide-station:/data slide-station
#
# Everything it keeps is in /data: config.json and library/ for a single user, or users/<id>/ per
# Immich user with SLIDESTATION_AUTH=immich (see docker-compose.example.yml). The UI is the committed
# build in slidestation/web, so no Node here.
FROM python:3.12-slim

RUN pip install --no-cache-dir uv==0.8.17 \
 && useradd --uid 1000 --create-home slides \
 && mkdir /data /import && chown slides:slides /data /import

WORKDIR /app
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
# with rawpy (camera RAW files); tethered capture (gphoto2) is for a desktop next to the camera
RUN uv sync --frozen --no-dev --extra raw --no-cache
COPY slidestation ./slidestation

ENV PATH=/opt/venv/bin:$PATH \
    SLIDESTATION_HOME=/data \
    SLIDESTATION_LIBRARY=/data/library \
    SLIDESTATION_VOLUMES=/import \
    SLIDESTATION_HOST=0.0.0.0 \
    SLIDESTATION_PORT=8765 \
    SLIDESTATION_NO_BROWSER=1 \
    OPENCV_LOG_LEVEL=ERROR
USER slides
VOLUME /data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ['SLIDESTATION_PORT'], timeout=4)"]
CMD ["python", "-m", "slidestation"]
