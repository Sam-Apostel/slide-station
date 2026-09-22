#!/usr/bin/env bash
# Add ProUI components with the shadcn CLI:  scripts/proui-add.sh [shadcn flags] <name>...
#   e.g. scripts/proui-add.sh pro-knob tabs     scripts/proui-add.sh --overwrite pro-slider
# Needs PROUI_LICENSE_KEY in frontend/.env.local (gitignored).
#
# Why not plain `npx shadcn add @proui/<name>`: every ProUI item lists its theme dependency as
# https://pro-ui.dev/r/r/pro-theme.json (note the doubled /r/), which 404s and aborts the CLI.
# This fetches the items and their dependencies, points the dependencies at the local copies, and
# hands those files to the CLI, which then installs files, npm packages and CSS as usual.
# Once ProUI fixes the URL, `npx shadcn add @proui/<name>` works directly (see components.json).
#
# The ProUI theme (pro-theme) is left out by default: src/index.css holds a copy trimmed to the
# components this repo ships (ProUI's owner asked us not to publish the whole kit), and letting the
# CLI re-merge it would bring every component's styles back. Pass --with-theme only if a new
# component needs theme rules that were trimmed — then trim src/index.css again before committing.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.local ] || { echo "frontend/.env.local with PROUI_LICENSE_KEY is missing" >&2; exit 1; }
set -a; . ./.env.local; set +a

flags=(); names=(); with_theme=0
for a in "$@"; do
  if [[ $a == --with-theme ]]; then with_theme=1
  elif [[ $a == -* ]]; then flags+=("$a")
  else names+=("$a"); fi
done
[ ${#names[@]} -gt 0 ] || { sed -n '2,3p' "$0"; exit 1; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
python3 - "$tmp" "$with_theme" "${names[@]}" <<'EOF'
import json, os, re, sys, urllib.request

out, with_theme, names = sys.argv[1], sys.argv[2] == "1", sys.argv[3:]
headers = {"Authorization": f"Bearer {os.environ['PROUI_LICENSE_KEY']}", "User-Agent": "shadcn"}
local = lambda n: os.path.join(out, f"{n}.json")

def fetch(name):
    if os.path.exists(local(name)):
        return
    req = urllib.request.Request(f"https://pro-ui.dev/r/{name}.json", headers=headers)
    try:
        item = json.load(urllib.request.urlopen(req))
    except Exception as e:
        sys.exit(f"could not fetch {name}: {e}")
    deps = []
    for d in item.get("registryDependencies", []):
        m = re.match(r"^(?:https://pro-ui\.dev/r/(?:r/)?|@proui/)([\w-]+?)(?:\.json)?$", d)
        if not m:
            deps.append(d)  # not a ProUI item: leave it for the CLI
            continue
        if m.group(1) == "pro-theme" and not with_theme:
            continue
        fetch(m.group(1))
        deps.append(local(m.group(1)))
    item["registryDependencies"] = deps
    json.dump(item, open(local(name), "w"))

for n in names:
    fetch(n)
EOF

files=()
for n in "${names[@]}"; do files+=("$tmp/$n.json"); done
npx -y shadcn@latest add ${flags[@]+"${flags[@]}"} "${files[@]}"
