import { DEVICES } from "./devices.js";
import { deleteCapture, listCaptureIds, saveCapture } from "./store.js";

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
        deviceId: msg.device || null,
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

function captureIdFromPreviewUrl(value) {
  if (!value) return "";
  try {
    const previewUrl = new URL(chrome.runtime.getURL("preview.html"));
    const url = new URL(value);
    if (url.origin !== previewUrl.origin || url.pathname !== previewUrl.pathname) return "";
    return url.searchParams.get("id") || "";
  } catch {
    return "";
  }
}

async function reconcileCaptureStorage() {
  const sessionValues = await chrome.storage.session.get(null);
  const mappedIds = new Set();
  for (const [key, id] of Object.entries(sessionValues)) {
    if (!key.startsWith(PREVIEW_TAB_KEY_PREFIX) || !id) continue;
    const tabId = Number(key.slice(PREVIEW_TAB_KEY_PREFIX.length));
    if (!Number.isInteger(tabId)) continue;
    try {
      await chrome.tabs.get(tabId);
      mappedIds.add(id);
    } catch {
      await chrome.storage.session.remove(key);
    }
  }
  const tabs = await chrome.tabs.query({});
  const openIds = new Set([
    ...mappedIds,
    ...tabs.map((tab) => captureIdFromPreviewUrl(tab.url)).filter(Boolean),
  ]);
  const storedIds = await listCaptureIds();
  await Promise.all(storedIds.filter((id) => !openIds.has(id)).map((id) => deleteCapture(id)));
}

void reconcileCaptureStorage().catch(() => {
  /* cleanup will run again when the service worker starts next time */
});

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

function pngSize(dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!match) return { width: 0, height: 0 };
  const binary = atob(match[1].slice(0, 64));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return {
    width: ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0,
    height: ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0,
  };
}

function resolveDevice(deviceId) {
  return (deviceId && DEVICES[deviceId]) || null;
}

function sendDebugger(debuggee, method, params) {
  return chrome.debugger.sendCommand(debuggee, method, params);
}

async function attachDevice(tabId, device) {
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, "1.3");
  } catch (err) {
    const message = String(err?.message || err);
    if (/Another debugger|already attached|DevTools/i.test(message)) {
      throw new Error("Close Chrome DevTools on this tab and try again.");
    }
    throw new Error("Couldn't emulate this device. Reload the page and try again.");
  }

  try {
    await sendDebugger(debuggee, "Page.enable");
    await sendDebugger(debuggee, "Emulation.setUserAgentOverride", {
      userAgent: device.userAgent,
      acceptLanguage: "en-US,en",
      platform: device.platform,
      userAgentMetadata: device.userAgentMetadata,
    });
    await sendDebugger(debuggee, "Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    await sendDebugger(debuggee, "Emulation.setDeviceMetricsOverride", {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.dpr,
      mobile: true,
      screenWidth: device.width,
      screenHeight: device.height,
    });
    return debuggee;
  } catch (err) {
    await detachDevice(debuggee);
    throw new Error(`Couldn't set the ${device.label} viewport. ${err?.message || "Try again."}`);
  }
}

async function detachDevice(debuggee) {
  if (!debuggee) return;
  try {
    await sendDebugger(debuggee, "Emulation.setTouchEmulationEnabled", { enabled: false });
  } catch {
    /* tab may have closed */
  }
  try {
    await sendDebugger(debuggee, "Emulation.clearDeviceMetricsOverride");
  } catch {
    /* tab may have closed */
  }
  try {
    await chrome.debugger.detach(debuggee);
  } catch {
    /* debugger may already be detached */
  }
}

async function captureEmulated(debuggee, { beyond = false, clip = null, fromSurface = false } = {}) {
  const params = {
    format: "png",
    fromSurface,
    captureBeyondViewport: Boolean(beyond),
  };
  if (clip) params.clip = clip;
  const result = await sendDebugger(debuggee, "Page.captureScreenshot", params);
  if (!result?.data) throw new Error("Couldn't photograph the emulated viewport.");
  return `data:image/png;base64,${result.data}`;
}

async function captureDeviceFrame(debuggee, device, { scrollY = 0 } = {}) {
  const viewport = { x: 0, y: 0, width: device.width, height: device.height, scale: 1 };
  const documentSlice = { ...viewport, y: Math.max(0, scrollY) };
  const attempts = [
    { fromSurface: false },
    { fromSurface: true },
    { fromSurface: false, clip: viewport },
    { fromSurface: true, clip: viewport },
    { fromSurface: false, clip: documentSlice },
  ];
  const expected = Math.round(device.width * device.dpr);
  let best = null;
  let bestScore = Infinity;
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const dataUrl = await captureEmulated(debuggee, attempt);
      const size = pngSize(dataUrl);
      if (!size.width) continue;
      const score = Math.abs(size.width - expected);
      if (score < bestScore) {
        best = dataUrl;
        bestScore = score;
      }
      if (score <= 2) return dataUrl;
    } catch (err) {
      lastError = err;
    }
  }
  if (best) return best;
  throw lastError || new Error("Couldn't photograph the emulated viewport.");
}

async function scrollPage(tabId, y, debuggee) {
  if (debuggee) {
    try {
      await sendDebugger(debuggee, "Runtime.evaluate", {
        expression: `(() => {
          const y = ${Number(y)};
          const html = document.documentElement;
          const body = document.body;
          html.scrollTop = y;
          html.scrollLeft = 0;
          if (body) { body.scrollTop = y; body.scrollLeft = 0; }
          window.scrollTo(0, y);
          return true;
        })()`,
      });
    } catch {
      /* content-script scrolling remains the fallback */
    }
  }
  return sendToTab(tabId, { op: "scroll", x: 0, y });
}

async function layoutScrollY(debuggee) {
  if (!debuggee) return null;
  try {
    const metrics = await sendDebugger(debuggee, "Page.getLayoutMetrics");
    const visual = metrics.cssVisualViewport || metrics.visualViewport;
    if (visual && Number.isFinite(visual.pageY)) return Math.round(visual.pageY);
  } catch {
    /* content-script metrics remain the fallback */
  }
  return null;
}

async function waitForDeviceWidth(tabId, width, timeout = 2500) {
  const started = Date.now();
  let metrics = null;
  while (Date.now() - started < timeout) {
    metrics = await sendToTab(tabId, { op: "metrics" });
    if (Math.abs(Math.round(metrics.windowWidth) - width) <= 1) return metrics;
    await delay(50);
  }
  if (metrics && Math.abs(Math.round(metrics.windowWidth) - width) <= 1) return metrics;
  throw new Error(`The page did not switch to the ${width}px device viewport.`);
}

async function captureWindow(windowId, lastAt, debuggee = null, device = null, scrollY = 0) {
  const wait = CAPTURE_GAP_MS - (Date.now() - lastAt);
  if (wait > 0) await delay(wait);
  try {
    if (debuggee && device) {
      return {
        dataUrl: await captureDeviceFrame(debuggee, device, { scrollY }),
        at: Date.now(),
      };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    return { dataUrl, at: Date.now() };
  } catch (err) {
    const message = String(err?.message || err);
    if (/file/i.test(message)) throw new Error(restrictedMessage("file://"));
    throw new Error("Couldn't photograph the tab. Keep this window in front until capture finishes.");
  }
}

function assertNotAborted() {
  if (session?.aborted) {
    const err = new Error("Capture cancelled.");
    err.cancelled = true;
    throw err;
  }
}

async function startCapture({ mode, tabId, port, deviceId = null }) {
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
      await runCapture(mode, tabId, deviceId, Boolean(port));
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

async function runCapture(mode, tabId, deviceId, fromPopup) {
  const tab = await chrome.tabs.get(tabId);
  if (isRestricted(tab.url || "")) {
    throw new Error(restrictedMessage(tab.url));
  }

  if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  if (!fromPopup) await chrome.windows.update(tab.windowId, { focused: true });

  post(session.port, { type: "progress", phase: "preparing", current: 0, total: 1 });
  await setBadge("…");

  const device = resolveDevice(deviceId);
  if (deviceId && !device) throw new Error("Unsupported device preset.");
  const debuggee = device ? await attachDevice(tabId, device) : null;
  try {
    if (mode === "visible") {
      await captureVisible(tab, debuggee, device);
      return;
    }

    await captureFull(tab, debuggee, device);
  } finally {
    await detachDevice(debuggee);
  }
}

async function captureVisible(tab, debuggee, device) {
  assertNotAborted();
  if (debuggee && device) {
    try {
      await inject(tab.id);
      await waitForDeviceWidth(tab.id, device.width);
      await delay(200);
    } catch {
      await delay(200);
    }
  }
  const shot = debuggee && device
    ? await captureWindow(tab.windowId, 0, debuggee, device)
    : { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }) };
  const blob = dataUrlToBlob(shot.dataUrl);
  await persistAndOpen({
    mode: "visible",
    tab,
    device,
    tiles: [{ blob, scrollY: 0 }],
    meta: {
      windowWidth: device?.width || tab.width || 0,
      windowHeight: device?.height || tab.height || 0,
      documentHeight: device?.height || tab.height || 0,
      dpr: device?.dpr || 1,
    },
  });
}

function buildPositions(documentHeight, windowHeight) {
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
  return positions;
}

async function captureFull(tab, debuggee, device) {
  try {
    await inject(tab.id);
  } catch {
    throw new Error("This page doesn't allow capture scripts. Try a normal webpage.");
  }
  if (device) {
    await waitForDeviceWidth(tab.id, device.width);
    await delay(200);
  }
  await sendToTab(tab.id, { op: "prepare" });
  await sendToTab(tab.id, { op: "wait" });
  const prepared = await sendToTab(tab.id, { op: "metrics" });
  let lastCaptureAt = 0;

  try {
    const windowHeight = Math.max(1, Math.round(prepared.windowHeight));
    let documentHeight = Math.max(windowHeight, Math.round(prepared.documentHeight));
    const positions = buildPositions(documentHeight, windowHeight);

    const tiles = [];
    post(session.port, {
      type: "progress",
      phase: "capturing",
      current: 0,
      total: positions.length,
    });

    for (let i = 0; i < positions.length; i++) {
      assertNotAborted();
      await scrollPage(tab.id, positions[i], debuggee);
      await sendToTab(tab.id, { op: "wait" });

      const shot = await captureWindow(
        tab.windowId,
        lastCaptureAt,
        debuggee,
        device,
        positions[i]
      );
      lastCaptureAt = shot.at;
      const actual = await sendToTab(tab.id, { op: "metrics" });
      const layoutY = await layoutScrollY(debuggee);
      const reported = layoutY ?? Math.round(actual.scrollY);
      const intended = positions[i];
      tiles.push({
        blob: dataUrlToBlob(shot.dataUrl),
        scrollY: Math.abs(reported - intended) <= 4 ? reported : intended,
      });

      await sendToTab(tab.id, { op: "hideFixed" });
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
      device,
      tiles,
      meta: {
        windowWidth: prepared.windowWidth,
        windowHeight: prepared.windowHeight,
        documentHeight,
        dpr: device?.dpr || prepared.dpr,
      },
    });
  } catch (err) {
    await restoreQuiet(tab.id);
    throw err;
  }
}

async function persistAndOpen({ mode, tab, tiles, meta, device = null }) {
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
  const devicePart = device?.filename ? `-${device.filename}` : "";
  const filename = `screenshot-${slug(host)}${devicePart}-${timestamp()}.png`;
  await saveCapture(id, {
    id,
    createdAt: Date.now(),
    title: tab.title || host,
    url: tab.url || "",
    filename,
    mode,
    deviceLabel: device?.label || "",
    windowWidth: meta.windowWidth,
    windowHeight: meta.windowHeight,
    documentHeight: meta.documentHeight,
    dpr: meta.dpr,
    tiles,
  });
  try {
    const previewTab = await chrome.tabs.create({
      url: chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(id)}`),
      active: true,
    });
    if (previewTab.id == null) throw new Error("Chrome did not create the preview tab.");
    const key = previewTabKey(previewTab.id);
    await chrome.storage.session.set({ [key]: id });
    try {
      await chrome.tabs.get(previewTab.id);
    } catch {
      await chrome.storage.session.remove(key);
      await deleteCapture(id);
      throw new Error("The preview tab was closed before the screenshot opened.");
    }
  } catch (err) {
    await deleteCapture(id);
    throw err;
  }
  post(session.port, { type: "done", id });
}
