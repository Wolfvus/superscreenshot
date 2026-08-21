import { deleteCapture, saveCapture } from "./store.js";

const MAX_CAPTURES = 80;
const CAPTURE_GAP_MS = 550;
const PREVIEW_TAB_KEY_PREFIX = "preview-tab:";
const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source|brave|opera):/i;
const STORE_HOSTS = /^(https:\/\/chrome\.google\.com\/webstore|https:\/\/chromewebstore\.google\.com)/i;

let session = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({
      id: "capture-full",
      title: "Capture full page",
      contexts: ["page", "frame", "action"],
    });
    chrome.contextMenus.create({
      id: "capture-visible",
      title: "Capture visible area",
      contexts: ["page", "frame", "action"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const mode = info.menuItemId === "capture-visible" ? "visible" : "full";
  if (tab?.id != null) void startCapture({ mode, tabId: tab.id });
});

chrome.commands.onCommand.addListener(async (command) => {
  const mode = command === "capture-visible" ? "visible" : "full";
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) void startCapture({ mode, tabId: tab.id });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "capture") return;
  port.onMessage.addListener((msg) => {
    if (msg?.type === "CAPTURE") {
      void startCapture({
        mode: msg.mode === "visible" ? "visible" : "full",
        tabId: msg.tabId,
        port,
        viewport: msg.viewport || null,
      });
    } else if (msg?.type === "CANCEL") {
      if (session) session.aborted = true;
    }
  });
  port.onDisconnect.addListener(() => {
    if (session?.port === port) session.port = null;
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "STATUS") {
    sendResponse(
      session
        ? { capturing: true, progress: session.progress, mode: session.mode }
        : { capturing: false }
    );
    return;
  }
  if (msg?.type === "CANCEL") {
    if (session) session.aborted = true;
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "DISCARD_CAPTURE") {
    void discardCapture(msg.id, _sender.tab?.id).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: err?.message || "Could not discard screenshot." })
    );
    return true;
  }
});

function previewTabKey(tabId) {
  return `${PREVIEW_TAB_KEY_PREFIX}${tabId}`;
}

async function discardCapture(id, tabId) {
  if (!id) return;
  await deleteCapture(id);
  if (tabId != null) await chrome.storage.session.remove(previewTabKey(tabId));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.get(previewTabKey(tabId)).then(async (values) => {
    const id = values[previewTabKey(tabId)];
    await chrome.storage.session.remove(previewTabKey(tabId));
    if (!id) return;
    await deleteCapture(id);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" || !tab.url) return;
  const previewUrl = new URL(chrome.runtime.getURL("preview.html"));
  const url = new URL(tab.url);
  if (url.origin !== previewUrl.origin || url.pathname !== previewUrl.pathname) return;
  const id = url.searchParams.get("id");
  if (!id) return;
  void chrome.storage.session.set({ [previewTabKey(tabId)]: id });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRestricted(url) {
  if (!url) return true;
  return RESTRICTED.test(url) || STORE_HOSTS.test(url);
}

function restrictedMessage(url) {
  if (!url) return "This tab can't be captured.";
  if (url.startsWith("file:")) {
    return "Local files need extra permission. Open chrome://extensions, find SuperScreenshot, and enable “Allow access to file URLs”.";
  }
  return "Chrome pages, the Web Store, and other protected tabs can't be captured. Open a regular website and try again.";
}

function slug(value) {
  return (
    String(value || "page")
      .replace(/^https?:\/\//, "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "page"
  );
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Unexpected screenshot data.");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

async function withKeepAlive(fn) {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 15000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

function post(port, payload) {
  if (!port) return;
  try {
    port.postMessage(payload);
  } catch {
    /* popup closed */
  }
}

async function setBadge(text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#0577b9" });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }
    await chrome.action.setBadgeText({ text: text || "" });
  } catch {
    /* ignore */
  }
}

async function sendToTab(tabId, payload) {
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, { ns: "ss", ...payload });
  } catch (err) {
    const message = String(err?.message || err);
    if (/Receiving end does not exist/i.test(message)) {
      throw new Error("Could not talk to the page. Reload it and try again.");
    }
    throw err;
  }
  if (!response?.ok) throw new Error(response?.error || "The page did not respond.");
  return response.result;
}

async function inject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

async function captureWindow(windowId, lastAt, debuggee = null) {
  const wait = CAPTURE_GAP_MS - (Date.now() - lastAt);
  if (wait > 0) await delay(wait);
  try {
    if (debuggee) {
      return { dataUrl: await captureViewport(debuggee), at: Date.now() };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    return { dataUrl, at: Date.now() };
  } catch (err) {
    const message = String(err?.message || err);
    if (/file/i.test(message)) throw new Error(restrictedMessage("file://"));
    throw new Error("Couldn't photograph the tab. Keep this window in front until capture finishes.");
  }
}

async function applyViewport(tabId, viewport) {
  if (!viewport) return null;
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, "1.3");
    await chrome.debugger.sendCommand(debuggee, "Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr,
      mobile: true,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    await delay(250);
    return debuggee;
  } catch (err) {
    try {
      await chrome.debugger.detach(debuggee);
    } catch {
      /* debugger was not attached */
    }
    throw new Error(`Couldn't set the mobile viewport. ${err?.message || "Close DevTools and try again."}`);
  }
}

async function clearViewport(debuggee) {
  if (!debuggee) return;
  try {
    await chrome.debugger.sendCommand(debuggee, "Emulation.clearDeviceMetricsOverride");
  } catch {
    /* tab may have closed */
  }
  try {
    await chrome.debugger.detach(debuggee);
  } catch {
    /* debugger may already be detached */
  }
}

async function captureViewport(debuggee) {
  if (!debuggee) return null;
  const result = await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", { format: "png" });
  if (!result?.data) throw new Error("Couldn't photograph the emulated viewport.");
  return `data:image/png;base64,${result.data}`;
}

function assertNotAborted() {
  if (session?.aborted) {
    const err = new Error("Capture cancelled.");
    err.cancelled = true;
    throw err;
  }
}

async function startCapture({ mode, tabId, port, viewport = null }) {
  if (session) {
    post(port || session.port, {
      type: "error",
      error: session.aborted ? "Cancel is still finishing." : "A capture is already running.",
    });
    return;
  }

  session = {
    aborted: false,
    mode,
    port: port || null,
    progress: { current: 0, total: 1, phase: "starting" },
  };

  await withKeepAlive(async () => {
    try {
      await runCapture(mode, tabId, viewport);
    } catch (err) {
      await restoreQuiet(tabId);
      await setBadge("");
      if (!err?.cancelled) {
        post(session?.port, {
          type: "error",
          error: err?.message || "Capture failed.",
        });
      } else {
        post(session?.port, { type: "cancelled" });
      }
    } finally {
      session = null;
      await setBadge("");
    }
  });
}

async function restoreQuiet(tabId) {
  try {
    await sendToTab(tabId, { op: "restore" });
  } catch {
    /* page may already be gone */
  }
}

async function runCapture(mode, tabId, viewport) {
  const tab = await chrome.tabs.get(tabId);
  if (isRestricted(tab.url || "")) {
    throw new Error(restrictedMessage(tab.url));
  }

  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  post(session.port, { type: "progress", phase: "preparing", current: 0, total: 1 });
  await setBadge("…");

  const debuggee = await applyViewport(tabId, viewport);
  try {
    if (mode === "visible") {
      await captureVisible(tab, viewport, debuggee);
      return;
    }

    await captureFull(tab, debuggee);
  } finally {
    await clearViewport(debuggee);
  }
}

async function captureVisible(tab, viewport, debuggee) {
  assertNotAborted();
  const shot = (await captureViewport(debuggee)) || (await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }));
  const blob = dataUrlToBlob(shot);
  await persistAndOpen({
    mode: "visible",
    tab,
    tiles: [{ blob, scrollY: 0 }],
    meta: {
      windowWidth: viewport?.width || tab.width || 0,
      windowHeight: viewport?.height || tab.height || 0,
      documentHeight: viewport?.height || tab.height || 0,
      dpr: viewport?.dpr || 1,
    },
  });
}

async function captureFull(tab, debuggee) {
  try {
    await inject(tab.id);
  } catch {
    throw new Error("This page doesn't allow capture scripts. Try a normal webpage.");
  }
  await sendToTab(tab.id, { op: "prepare" });
  await sendToTab(tab.id, { op: "wait" });
  const prepared = await sendToTab(tab.id, { op: "metrics" });
  let lastCaptureAt = 0;

  try {
    const windowHeight = Math.max(1, Math.round(prepared.windowHeight));
    let documentHeight = Math.max(windowHeight, Math.round(prepared.documentHeight));
    const positions = [];
    let y = 0;
    while (positions.length < MAX_CAPTURES) {
      const maxScroll = Math.max(0, documentHeight - windowHeight);
      const target = Math.min(y, maxScroll);
      if (positions.length && target === positions[positions.length - 1]) break;
      positions.push(target);
      if (target >= maxScroll) break;
      y += windowHeight;
    }

    const tiles = [];
    post(session.port, {
      type: "progress",
      phase: "capturing",
      current: 0,
      total: positions.length,
    });

    for (let i = 0; i < positions.length; i++) {
      assertNotAborted();
      await sendToTab(tab.id, { op: "scroll", x: 0, y: positions[i] });
      await sendToTab(tab.id, { op: "wait" });
      if (i === 1) {
        await sendToTab(tab.id, { op: "hideFixed" });
        await sendToTab(tab.id, { op: "wait" });
      }

      const shot = await captureWindow(tab.windowId, lastCaptureAt, debuggee);
      lastCaptureAt = shot.at;
      const actual = await sendToTab(tab.id, { op: "metrics" });
      tiles.push({
        blob: dataUrlToBlob(shot.dataUrl),
        scrollY: Math.round(actual.scrollY),
      });

      documentHeight = Math.max(documentHeight, Math.round(actual.documentHeight));
      await setBadge(`${i + 1}`);
      post(session.port, {
        type: "progress",
        phase: "capturing",
        current: i + 1,
        total: positions.length,
      });

      if (i === positions.length - 1) {
        const grown = Math.round(actual.documentHeight);
        const bottom = tiles[tiles.length - 1].scrollY + windowHeight;
        if (grown > bottom + 8 && positions.length < MAX_CAPTURES) {
          const next = Math.min(positions[positions.length - 1] + windowHeight, Math.max(0, grown - windowHeight));
          if (next > positions[positions.length - 1] + 1) positions.push(next);
        }
      }
    }

    await sendToTab(tab.id, { op: "restore" });

    await persistAndOpen({
      mode: "full",
      tab,
      tiles,
      meta: {
        windowWidth: prepared.windowWidth,
        windowHeight: prepared.windowHeight,
        documentHeight,
        dpr: prepared.dpr,
      },
    });
  } catch (err) {
    await restoreQuiet(tab.id);
    throw err;
  }
}

async function persistAndOpen({ mode, tab, tiles, meta }) {
  assertNotAborted();
  post(session.port, { type: "progress", phase: "saving", current: tiles.length, total: tiles.length });
  const id = `ss_${Date.now()}`;
  const host = (() => {
    try {
      return new URL(tab.url || "").hostname;
    } catch {
      return "page";
    }
  })();
  const filename = `screenshot-${slug(host)}-${timestamp()}.png`;
  await saveCapture(id, {
    id,
    createdAt: Date.now(),
    title: tab.title || host,
    url: tab.url || "",
    filename,
    mode,
    windowWidth: meta.windowWidth,
    windowHeight: meta.windowHeight,
    documentHeight: meta.documentHeight,
    dpr: meta.dpr,
    tiles,
  });
  const previewTab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(id)}`),
    active: true,
  });
  if (previewTab.id != null) {
    await chrome.storage.session.set({ [previewTabKey(previewTab.id)]: id });
  }
  post(session.port, { type: "done", id });
}
