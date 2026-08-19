import { saveCapture } from "./store.js";

const MAX_CAPTURES = 80;
const CAPTURE_GAP_MS = 550;
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
  }
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
    await chrome.action.setBadgeBackgroundColor({ color: "#6d5cff" });
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

async function captureWindow(windowId, lastAt) {
  const wait = CAPTURE_GAP_MS - (Date.now() - lastAt);
  if (wait > 0) await delay(wait);
  try {
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

async function startCapture({ mode, tabId, port }) {
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
      await runCapture(mode, tabId);
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

async function runCapture(mode, tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (isRestricted(tab.url || "")) {
    throw new Error(restrictedMessage(tab.url));
  }

  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  post(session.port, { type: "progress", phase: "preparing", current: 0, total: 1 });
  await setBadge("…");

  if (mode === "visible") {
    await captureVisible(tab);
    return;
  }

  await captureFull(tab);
}

async function captureVisible(tab) {
  assertNotAborted();
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const blob = dataUrlToBlob(shot);
  await persistAndOpen({
    mode: "visible",
    tab,
    tiles: [{ blob, scrollY: 0 }],
    meta: {
      windowWidth: tab.width || 0,
      windowHeight: tab.height || 0,
      documentHeight: tab.height || 0,
      dpr: 1,
    },
  });
}

async function captureFull(tab) {
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

      const shot = await captureWindow(tab.windowId, lastCaptureAt);
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
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(id)}`),
    active: true,
  });
  post(session.port, { type: "done", id });
}
