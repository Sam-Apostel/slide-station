#!/bin/bash
# Double-click to start Slide Station. Close this window (or press Ctrl+C) to stop it.
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v uv >/dev/null 2>&1; then
  echo "First run: installing uv (a small Python manager, one-time)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh || { echo "Could not install uv - see README.md"; read -r -n1; exit 1; }
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "Starting Slide Station - it opens in your browser at http://localhost:8765"
echo "(the first start downloads Python and the image libraries, about a minute)"
exec uv run --quiet --python 3.12 python -m slidestation
