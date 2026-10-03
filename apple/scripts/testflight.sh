#!/bin/bash
# Archive the native apps and upload them to TestFlight.
#
#   apple/scripts/testflight.sh                 iPhone/iPad, Mac and Apple TV
#   PLATFORMS="ios tv" apple/scripts/testflight.sh
#
# Signing and upload go through the Apple account signed in to Xcode on this Mac (Xcode ▸
# Settings ▸ Accounts), so a self-hosted runner on that Mac needs no secrets. With an App Store
# Connect API key in ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH (an AuthKey_….p8) it uses the key
# instead. The build number is the UTC time (yyyymmddHHMM) unless BUILD_NUMBER says otherwise;
# the version is MARKETING_VERSION in project.yml.
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

BUILD="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
PLATFORMS="${PLATFORMS:-ios mac tv}"
OUT="build/testflight/$BUILD"
mkdir -p "$OUT"

xcodegen generate --quiet

AUTH=(-allowProvisioningUpdates)
if [ -n "${ASC_KEY_ID:-}" ]; then
  AUTH+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>Y3734CNKQ8</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><false/>
</dict>
</plist>
EOF

failed=()
for p in $PLATFORMS; do
  case "$p" in
    ios) scheme=SlideStation; dest="generic/platform=iOS"; sign=() ;;
    mac) scheme=SlideStationMac; dest="generic/platform=macOS"; sign=() ;;
    # a development profile needs a registered Apple TV: archive unsigned, the export signs for the App Store
    tv) scheme=SlideStationTV; dest="generic/platform=tvOS"; sign=(CODE_SIGNING_ALLOWED=NO) ;;
    *) echo "Unknown platform $p (ios, mac, tv)"; exit 2 ;;
  esac
  echo "::group::$p: archive (build $BUILD)"
  if xcodebuild archive -project SlideStation.xcodeproj -scheme "$scheme" -configuration Release \
      -destination "$dest" -archivePath "$OUT/$p.xcarchive" -derivedDataPath "build/DerivedData-$p" \
      CURRENT_PROJECT_VERSION="$BUILD" ${sign[@]+"${sign[@]}"} "${AUTH[@]}" -quiet; then
    echo "::endgroup::"
    echo "::group::$p: upload to App Store Connect"
    if xcodebuild -exportArchive -archivePath "$OUT/$p.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" \
        -exportPath "$OUT/$p" "${AUTH[@]}"; then
      echo "$p: build $BUILD uploaded"
    else
      failed+=("$p (upload)")
    fi
  else
    failed+=("$p (archive)")
  fi
  echo "::endgroup::"
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "Failed: ${failed[*]}"
  exit 1
fi
echo "Build $BUILD is on its way to TestFlight (processing takes a few minutes)."
