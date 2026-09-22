#!/bin/bash
# Build a fake scanner card from a folder of scans: tests/make_card.sh ~/some/scans [count]
set -euo pipefail
SRC="${1:?usage: make_card.sh <folder-with-jpegs> [count]}"
N="${2:-20}"
CARD="${CARD:-/tmp/ss-card}"
rm -rf "$CARD"; mkdir -p "$CARD/DCIM/100MEDIA"
i=0
for f in "$SRC"/*.[jJ][pP][gG]; do
  [ "$i" -ge "$N" ] && break
  cp "$f" "$CARD/DCIM/100MEDIA/"; i=$((i+1))
done
echo "$i scans in $CARD"
echo "Run the app against it with:"
echo "  SLIDESTATION_HOME=/tmp/ss-home SLIDESTATION_VOLUMES=/tmp SLIDESTATION_NO_BROWSER=1 uv run --python 3.12 python -m slidestation"
