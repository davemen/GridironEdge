# Console-paste diagnostics

Not loaded by the extension. Open the ESPN draft room, paste one of these into
the DevTools console, and read the output. They only read the page — nothing is
clicked, submitted or sent anywhere.

| File | Answers |
|---|---|
| `diagnose.js` | What can and cannot the scraper see on this page? Dumps the nomination card, bid controls, budget rows and the results table where one exists — an auction room often has none. |
| `syncheck.js` | Is the sync loop running, and did the worker store the last payload? |
| `bidcheck.js` | What does the live bid element actually contain right now? |

Before reaching for these, check `window.__GRIDIRON_EDGE_VERSION__` in the page
console. If it is not the version you just edited, Chrome is running a cached
content script and the answer is to reload the extension AND reopen the draft-room tab: content scripts are injected at page load, so reloading the extension alone leaves the open tab on the old ones.

`__GRIDIRON_EDGE_DEBUG__()` is usually faster than any of these — it prints what
the scraper parsed, who it attributed each pick to, and every row it dropped with
the reason.
