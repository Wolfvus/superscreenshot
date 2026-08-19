# SuperScreenshot

A local Chrome extension that captures the **full page** (or just the visible area) and saves a PNG on your computer. It never uploads the screenshot.

Chrome can only photograph the visible viewport, so a full-page capture scrolls the tab, takes overlapping shots, hides repeating sticky headers after the first frame, and stitches them together in a preview tab.

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder: `superscreenshot`

Pin the puzzle-piece toolbar icon so SuperScreenshot is one click away.

To capture `file://` pages, open the extension’s details on `chrome://extensions` and enable **Allow access to file URLs**.

## Use it

- Toolbar icon → **Capture full page** or **Visible area**
- Keyboard: **⌥⇧S** (Mac) / **Alt+Shift+S** (full page), **⌥⇧V** / **Alt+Shift+V** (visible)
- Right-click the page → **Capture full page**

When it finishes, a preview tab opens. From there you can **Download PNG** or **Copy**.

## What it won’t capture

Protected Chrome surfaces are blocked by the browser: `chrome://` pages, the Web Store, DevTools, and most extension pages. Very long pages are capped at 80 viewport shots; if the result would exceed Chrome’s canvas limit it is scaled down to fit.

Nothing in this extension talks to a server. Screenshots live in IndexedDB until you download them.
