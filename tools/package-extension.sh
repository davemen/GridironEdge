#!/bin/bash
# Stage only what the extension actually needs.
#
# The repo root IS the extension package, which makes "Load unpacked" a
# one-click affair during development — but it also means everything else in the
# repo gets bundled. A Safari build came out at 16MB carrying BACKTEST.md, the
# audit report, every test, and the user's own scraped league file. Shipping
# somebody's private draft data inside a distributable app is not acceptable.
#
# This is a packaging step, not a build step: no compiler, no dependencies, no
# transform. It copies.
#
#   ./tools/package-extension.sh [dest]      # default: ../GridironEdge-package
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/../GridironEdge-package}"

rm -rf "$DEST"
mkdir -p "$DEST"

# Everything the manifest references, and nothing else.
cp "$ROOT/manifest.json" "$DEST/"
cp "$ROOT/index.html"    "$DEST/"
cp -R "$ROOT/css"        "$DEST/"
cp -R "$ROOT/js"         "$DEST/"
cp -R "$ROOT/data"       "$DEST/"
cp -R "$ROOT/icons"      "$DEST/"

mkdir -p "$DEST/chrome-extension"
for f in background.js content-isolated.js content-main.js popup.js popup.html; do
  cp "$ROOT/chrome-extension/$f" "$DEST/chrome-extension/"
done
# chrome-extension/debug/ is console-paste tooling; it has no place in a build.

echo "Packaged to: $DEST"
echo "Size:        $(du -sh "$DEST" | cut -f1)"
echo
echo "Load unpacked (Chrome):  select $DEST"
echo "Safari (first time only -- see SAFARI.md):"
echo "  xcrun safari-web-extension-converter \"$DEST\" \\"
echo "    --app-name GridironEdge --bundle-identifier com.gridironedge --macos-only"
echo
echo "  Use exactly that app name. Converting again under a different name"
echo "  builds a second app with a second bundle ID, and Safari then lists"
echo "  'Gridiron Edge' twice with no way to tell which is which."
echo "  To rebuild after a code change, do NOT re-convert -- just re-run this"
echo "  script and rebuild the existing Xcode project."
