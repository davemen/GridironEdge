# Running Gridiron Edge in Safari

Safari supports Web Extensions, but they ship as a native macOS app rather than a
folder you load. Converting is one command; the only real work is signing.

## Build it

```bash
xcrun safari-web-extension-converter . \
  --app-name "Gridiron Edge" \
  --bundle-identifier com.gridironedge.app \
  --macos-only
```

That produces an Xcode project. Open it, set your **Team** under Signing &
Capabilities on both targets (the app and the `.appex`), and run.

Then in Safari: **Settings → Extensions**, enable Gridiron Edge, and grant it
access to `fantasy.espn.com`. Developer mode must be on under Settings →
Advanced.

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
