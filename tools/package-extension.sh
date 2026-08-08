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

# `rm -rf "$DEST"` on an argument nobody checked.
#
# The quoting was always right; the precondition was missing. A mistyped
# argument was deleted in full, and `./tools/package-extension.sh ~` erased the
# home directory. An audit proved it against a decoy tree.
#
# So a destination is only ever removed if this script made it. The marker is
# written on the way out, which also means an existing directory full of
# somebody else's files is refused rather than emptied.
MARKER=".gridiron-package"

# RESOLVE the path before judging it, and judge it before creating anything.
#
# The previous version compared string LITERALS, so a destination that resolved
# to $HOME without being spelled "$HOME" walked straight past the blocklist --
# and the marker was not a backstop, because this script PLANTS it. Proven
# against a decoy home directory with the real rm, in two steps:
#
#   ./package-extension.sh "$HOME/x/.."   (with $HOME/x absent)
#       nothing to delete, so it created $HOME/.gridiron-package and copied
#       the extension into the home directory
#   ./package-extension.sh "$HOME//"
#       not spelled "$HOME", marker now present -> rm -rf "$HOME//"
#
# So: canonicalise first, judge the RESOLVED path, and only then delete.
# Create it first, THEN resolve, then judge. Resolving a path that does not
# exist yet cannot collapse a "..", and "$HOME/x/.." with $HOME/x absent is
# exactly the input that walked past the first version of this guard: it stayed
# literal, missed the blocklist, and put the marker in $HOME.
#
# Creating a directory in a forbidden place is recoverable; deleting one is not,
# which is why this order and not the other.
# Did it exist before we touched it? The marker check below turns on this, and
# creating the directory first would otherwise make every first run look like a
# pre-existing directory with no marker.
DEST_EXISTED=0
[ -e "$DEST" ] && DEST_EXISTED=1
mkdir -p "$DEST" || { echo "Cannot create '$DEST'." >&2; exit 1; }
DEST_REAL="$(cd "$DEST" && pwd -P)" || { echo "Cannot resolve '$DEST'." >&2; exit 1; }
refuse() {
  echo "Refusing to package into '$DEST_REAL': $1" >&2
  # Leave nothing behind if we made it. rmdir only removes an EMPTY directory,
  # so this can never take anything with it. An intermediate directory created
  # on the way to a refused path (the "x" in "$HOME/x/..") can survive as an
  # empty directory; that is deliberate, because walking back up to delete more
  # is the kind of cleverness this guard exists to prevent.
  rmdir "$DEST" 2>/dev/null || true
  exit 1
}
HOME_REAL="$(cd "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")"
ROOT_REAL="$(cd "$ROOT" && pwd -P)"

case "$DEST_REAL" in
  ""|"/") refuse "that is the filesystem root." ;;
esac
[ "$DEST_REAL" = "$HOME_REAL" ] && refuse "that is your home directory."
[ "$DEST_REAL" = "$ROOT_REAL" ] && refuse "that is this repo."
# Never into an ancestor of the repo either -- that would take the repo with it.
case "$ROOT_REAL/" in
  "$DEST_REAL"/*) refuse "it contains this repo." ;;
esac
DEST="$DEST_REAL"

if [ "$DEST_EXISTED" = 1 ]; then
  if [ ! -f "$DEST/$MARKER" ]; then
    echo "Refusing to delete '$DEST': it is not a package directory this script created." >&2
    echo "Remove it yourself, or pass a path that does not exist." >&2
    exit 1
  fi
  rm -rf "$DEST"
fi
mkdir -p "$DEST"
printf 'Created by tools/package-extension.sh. Safe to delete.\n' > "$DEST/$MARKER"

# Everything the extension needs at runtime: what the manifest names, plus the
# app page it opens through chrome.runtime.getURL.
cp "$ROOT/manifest.json" "$DEST/"
cp "$ROOT/index.html"    "$DEST/"
cp -R "$ROOT/css"        "$DEST/"
cp -R "$ROOT/js"         "$DEST/"
cp -R "$ROOT/data"       "$DEST/"
cp -R "$ROOT/icons"      "$DEST/"

mkdir -p "$DEST/chrome-extension"
# popup.js and popup.html are gone: the manifest registers no default_popup,
# so they were 676 unreachable lines shipped in every build -- carrying a
# third copy of the scraper and three more club tables.
for f in background.js content-isolated.js content-main.js; do
  cp "$ROOT/chrome-extension/$f" "$DEST/chrome-extension/"
done
# chrome-extension/debug/ is console-paste tooling; it has no place in a build.

echo "Packaged to: $DEST"
echo "Size:        $(du -sh "$DEST" | cut -f1)"
echo
echo "Load unpacked (Chrome):  select $DEST"
echo "Safari (first time only -- see SAFARI.md):"
echo "  xcrun safari-web-extension-converter \"$DEST\" \\"
echo "    --app-name GridironEdge --bundle-identifier com.gridironedge --macos-only \\"
# --project-location, or the project lands beside the staged files and every
# other path in this repo -- SAFARI.md's rebuild step, install-safari.sh and
# make-icons.py -- looks for it under ../GridironEdge-Safari. SAFARI.md records
# that omission as the bug; this copy of the command still had it.
echo "    --project-location ../GridironEdge-Safari"
echo
echo "  Use exactly that app name. Converting again under a different name"
echo "  builds a second app with a second bundle ID, and Safari then lists"
echo "  'Gridiron Edge' twice with no way to tell which is which."
echo "  To rebuild after a code change, do NOT re-convert -- just re-run this"
echo "  script and rebuild the existing Xcode project."
