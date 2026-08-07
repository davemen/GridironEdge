#!/usr/bin/env bash
#
# Build the Safari app from the current source and install it.
#
#   ./tools/install-safari.sh [TEAM_ID]
#
# Every step here exists because leaving it out broke something:
#
#   - packaging first, because pointing the converter at the repo root ships
#     the working directory -- a personal league file, the news cache and every
#     test -- in a 16MB app
#   - unregistering and deleting the Xcode build product, because it is a
#     second app bundle as far as LaunchServices is concerned and Safari lists
#     one extension row per bundle, so a build plus an install looks like two
#     identical "Gridiron Edge" entries with no way to tell them apart
#   - LAUNCHING the app, because Safari only learns an extension exists after
#     its container app has run once. Replacing the bundle without launching it
#     makes the extension vanish from Safari's list entirely, which reads as a
#     broken build rather than an unopened app.
#
# The extension itself is only reloaded in a page when that page loads, so a
# draft room open from before an install keeps running the old content scripts.
# It carries on scraping perfectly, which is what makes this confusing: the
# reminder at the end is not a formality.
set -euo pipefail

TEAM="${1:-DWQ9ZN5SGU}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="$ROOT/../GridironEdge-Safari/GridironEdge/GridironEdge.xcodeproj"
APP=/Applications/GridironEdge.app
LSREG=/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister

if [ ! -d "$PROJ" ]; then
  echo "No Xcode project at $PROJ — see SAFARI.md for the one-time conversion." >&2
  exit 1
fi

echo "==> staging the package"
"$ROOT/tools/package-extension.sh" >/dev/null

echo "==> building"
xcodebuild -project "$PROJ" -scheme GridironEdge -configuration Debug \
  -destination 'platform=macOS' DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  build 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)" || true

PROD=$(xcodebuild -project "$PROJ" -scheme GridironEdge -configuration Debug \
  -showBuildSettings 2>/dev/null | awk -F' = ' '/ BUILT_PRODUCTS_DIR /{print $2; exit}')
if [ ! -d "$PROD/GridironEdge.app" ]; then
  echo "Build produced no app at $PROD" >&2
  exit 1
fi

echo "==> installing"
rm -rf "$APP"
cp -R "$PROD/GridironEdge.app" "$APP"

# The build product is a second registered bundle; drop it so Safari lists one.
"$LSREG" -u "$PROD/GridironEdge.app" 2>/dev/null || true
rm -rf "$(dirname "$(dirname "$(dirname "$PROD")")")"

"$LSREG" -f "$APP" 2>/dev/null || true
open -a "$APP"

BUILD=$(grep -o "__GRIDIRON_EDGE_VERSION__ = '[^']*'" \
  "$APP/Contents/PlugIns/GridironEdge Extension.appex/Contents/Resources/chrome-extension/content-main.js" \
  | sed "s/.*'\(.*\)'/\1/")

cat <<EOF

Installed $(du -sh "$APP" | cut -f1) — build ${BUILD:-unknown}

Then, in this order:
  1. Quit and reopen Safari
  2. Settings -> Extensions -> tick Gridiron Edge, allow fantasy.espn.com
  3. RELOAD the ESPN draft room tab. Content scripts are injected at page load,
     so a tab open from before this install keeps the old ones -- and keeps
     scraping, so nothing looks wrong while a new route is simply absent.
  4. Confirm in that tab's console:
       [Gridiron Edge Sync] Isolated script initialized (${BUILD:-...}).
       [Gridiron Edge Sync] Main world script initialized (${BUILD:-...}).
EOF
