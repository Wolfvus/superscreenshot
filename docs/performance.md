# Capture performance check

Local fixture comparison against `origin/main` at `9418bb2`, on 2026-10-23.

Playwright 1.62.1 Chromium, macOS, isolated profile; three alternating baseline/new runs. Timed from capture request until the decoded preview image was visible. Fixture: [`examples/long-page.html`](../examples/long-page.html), 2700 CSS pixels tall. Native desktop window: 1200 × 813; iPhone: 393 × 852 at 3×; iPad: 768 × 1024 at 2×.

| Capture | Baseline median | Updated median | Change |
| --- | ---: | ---: | ---: |
| Visible desktop | 101 ms | 82 ms | run-to-run variation |
| Full desktop | 2605 ms | 2560 ms | run-to-run variation |
| Full iPhone | 3218 ms | 1199 ms | 62.7% faster |
| Full iPad | 2353 ms | 1015 ms | 56.9% faster |

These are fixture-specific results, not a general speed guarantee. Desktop capture keeps Chrome’s 550 ms spacing; its timing differences are run-to-run noise. Mobile debugger captures no longer wait for a quota that only applies to `tabs.captureVisibleTab`. Page paint/image settling, emulation retries and PNG dimension checks remain unchanged.

Stitching now holds one decoded tile at a time rather than decoding all tiles before drawing. Deterministic unit tests verify a peak of one live bitmap and the same overlap geometry. This is a bound on decoded tile count, not a measurement of total process memory; the output canvas and compressed blobs still consume memory.

All runs asserted final PNG dimensions and bottom-section pixels. Updated runs also asserted source-page scroll/header/viewport restoration, cancellation restoration and temporary-image deletion. The baseline’s existing fixed-header restoration bug was excluded from baseline assertions; it is fixed in this change.

## Reproduce

```sh
PLAYWRIGHT_PATH=/path/to/playwright/index.mjs node tests/extension.mjs
# To compare an extracted baseline tree:
PLAYWRIGHT_PATH=/path/to/playwright/index.mjs EXTENSION_PATH=/path/to/baseline BASELINE=1 node tests/extension.mjs
```

`BASELINE=1` skips assertions for newly added behavior. Use a fresh extraction of the named commit. No network content or user screenshots are involved.
