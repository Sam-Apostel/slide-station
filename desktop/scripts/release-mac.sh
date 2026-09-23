#!/bin/bash
# Build a signed + notarised Slide Station.dmg and check it the way Gatekeeper will.
# One-time setup: desktop/README.md → "Signing and notarising".
#
#   cd desktop && npm run release:mac                 # build + verify locally
#   PUBLISH=always GH_TOKEN=… npm run release:mac     # …and publish to GitHub Releases (what CI does)
#
set -euo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

echo "Checking the signing setup…"
xcode-select -p >/dev/null 2>&1 || fail "Xcode command line tools missing: xcode-select --install"
xcrun --find notarytool >/dev/null 2>&1 || fail "notarytool missing: update Xcode / the command line tools"
ok "Xcode tools"

ids=$(security find-identity -v -p codesigning | grep "Developer ID Application" || true)
[ -n "$ids" ] || fail "no \"Developer ID Application\" certificate in your keychain (README step 2)"
[ "$(printf '%s\n' "$ids" | wc -l)" -eq 1 ] || [ -n "${CSC_NAME:-}" ] ||
  fail "several Developer ID certificates: pick one with CSC_NAME=\"Your Name (TEAMID)\""
ok "signing certificate: $(printf '%s\n' "$ids" | head -1 | sed 's/.*"\(.*\)"/\1/')"

if [ -n "${APPLE_API_KEY:-}" ]; then
  [ -f "$APPLE_API_KEY" ] || fail "APPLE_API_KEY points at a missing file: $APPLE_API_KEY"
  [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] || fail "set APPLE_API_KEY_ID and APPLE_API_ISSUER too"
  ok "notary credentials: App Store Connect API key"
elif [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  # APPLE_KEYCHAIN stays unset unless you chose a keychain: store-credentials saves profiles in the
  # data-protection keychain, which notarytool only searches when no keychain path is given
  xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE" ${APPLE_KEYCHAIN:+--keychain "$APPLE_KEYCHAIN"} \
    >/dev/null 2>&1 ||
    fail "notarytool can't use keychain profile \"$APPLE_KEYCHAIN_PROFILE\" (README step 3)"
  ok "notary credentials: keychain profile $APPLE_KEYCHAIN_PROFILE"
elif [ -n "${APPLE_ID:-}" ]; then
  [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] ||
    fail "set APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID too"
  ok "notary credentials: Apple ID"
else
  fail "no notary credentials: set APPLE_KEYCHAIN_PROFILE (or an API key / Apple ID, README step 3)"
fi

if [ "${PUBLISH:-never}" != never ]; then
  [ -n "${GH_TOKEN:-}" ] || fail "PUBLISH=${PUBLISH} needs GH_TOKEN (a token that can create releases)"
  ok "publishing to GitHub Releases as $(node -p 'require("./package.json").version')"
fi

echo "Building…"
npm run build:ui
npx electron-builder --mac --publish "${PUBLISH:-never}"

app=$(ls -d dist/mac*/"Slide Station.app" | head -1)
dmg=$(ls -t dist/*.dmg | head -1)
echo "Verifying $app"
codesign --verify --deep --strict --verbose=2 "$app" 2>&1 | tail -2
spctl --assess --type execute --verbose "$app" 2>&1 | grep -q "source=Notarized Developer ID" ||
  fail "Gatekeeper does not see the app as notarised: spctl --assess -vv \"$app\""
ok "Gatekeeper: notarised Developer ID"
xcrun stapler validate "$app" >/dev/null && ok "notarisation ticket stapled to the app"
echo
echo "Done: $dmg"
