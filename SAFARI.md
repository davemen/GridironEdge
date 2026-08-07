# Running Gridiron Edge in Safari

Safari supports Web Extensions, but they ship as a native macOS app rather than a
folder you load. Converting is one command; the only real work is signing.

## Build it

**Stage the package first.** Do not point the converter at the repo root. The
repo root is the Chrome extension, but it is also a working directory — your
synced league, the news cache, `BACKTEST.md`, the audit report and every test
file live there, and the converter copies whatever it is given straight into a
distributable app. Doing this the obvious way produced a 16MB app containing a
personal league file.

```bash
./tools/package-extension.sh          # -> ../GridironEdge-package
cd ../GridironEdge-package
xcrun safari-web-extension-converter . \
  --app-name GridironEdge \
  --bundle-identifier com.gridironedge \
  --macos-only \
  --project-location ../GridironEdge-Safari
```

That produces an Xcode project at
`../GridironEdge-Safari/GridironEdge/GridironEdge.xcodeproj`.

`--project-location` matters and used to be missing: without it the converter
writes the project next to the staged files, and every other path in this file
-- the rebuild command below, `tools/install-safari.sh` and
`tools/make-icons.py` -- looks for it under `../GridironEdge-Safari`. Anyone
following the build section as written ended up with a project the rebuild
section could not find, and make-icons silently skipped the asset catalogue. Open it, set your **Team** under Signing &
Capabilities on both targets (the app and the `.appex`), and run.

The two bundle IDs must nest: the app is `com.gridironedge.GridironEdge` and the
extension must be `com.gridironedge.GridironEdge.Extension`. macOS refuses to
load an embedded binary whose identifier is not a child of its host's, and the
converter does not always get this right on its own — check both targets.

Then in Safari: **Settings → Extensions**, enable Gridiron Edge, and grant it
access to `fantasy.espn.com`. Developer mode must be on under Settings →
Advanced.

## Rebuilding after a code change

Re-run the packaging script and rebuild the **existing** Xcode project:

```bash
./tools/package-extension.sh
xcodebuild -project ../GridironEdge-Safari/GridironEdge/GridironEdge.xcodeproj \
  -scheme GridironEdge -configuration Debug DEVELOPMENT_TEAM=<TEAM> build
```

The converter references the package folder rather than copying it, so a
re-package is picked up by the next build. **Do not run the converter again** —
converting under a different app name or bundle ID produces a second app, and
Safari then lists two identical "Gridiron Edge" entries with no way to tell them
apart.

### Safari lists it twice

Every registered app bundle gets its own row, and Xcode registers its build
product in `DerivedData` alongside whatever is in `/Applications`. So one build
plus one install looks like two extensions. Quit Safari, keep a single copy, and
drop the rest from the LaunchServices database:

```bash
LSREG=/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister
find /Applications ~/Library/Developer/Xcode/DerivedData -maxdepth 6 -name "GridironEdge.app"
"$LSREG" -u <path-to-each-copy-you-do-not-want>
"$LSREG" -kill -r -domain local -domain user
```

Stale identities also leave directories behind under
`~/Library/Application Scripts/` and `~/Library/Containers/` named for the old
bundle ID; those are safe to delete.

## Icons

`python3 tools/make-icons.py` regenerates every size the extension and the app
need, including the Xcode asset catalogue. Stdlib only — no Pillow, nothing to
install. Sizes at or below 24px get a deliberately simplified glyph, because the
full drawing's laces collapse into a grey smear at 16px.

## The one real difference

The converter warns about exactly one thing:

> The following keys in your manifest.json are not supported by your current
> version of Safari: **`world`**

`world: "MAIN"` is how the scraper reads ESPN's own React store — the fastest
route to draft state. Safari ignores it, so that script would never run.

The extension handles this without a Safari-specific build. The service worker
watches draft tabs; if one has been open for six seconds and has never reported,
it injects the same scraper into the **isolated** world instead, which every
engine supports. That loses the store shortcut and falls back to reading the
rendered DOM — a path the scraper already has and `test/scraper.test.mjs`
already covers.

So Safari runs the same code, one route slower. In practice the DOM path is what
serves auctions anyway.

## What signing costs

An Apple Developer account (~$99/yr). Without a team set, `xcodebuild` fails at
`ValidateEmbeddedBinary` — the code compiles cleanly, but macOS will not load an
unsigned app extension. There is no way around that for distribution.

## Status

Verified on this machine: the conversion runs, the Xcode project is produced, and
the build reaches signing with **zero compile errors**. It has not been run
inside Safari against a live ESPN draft room — the isolated-world fallback is
implemented and unit-tested, but the round trip through a real draft is untested
on that engine.
