const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source|brave|opera):/i;
const STORE_HOSTS = /^(https:\/\/chrome\.google\.com\/webstore|https:\/\/chromewebstore\.google\.com)/i;

const fullBtn = document.getElementById("full");
const visibleBtn = document.getElementById("visible");
const warning = document.getElementById("warning");
const progress = document.getElementById("progress");
const progressLabel = document.getElementById("progress-label");
const progressCount = document.getElementById("progress-count");
const barFill = document.getElementById("bar-fill");
const cancelBtn = document.getElementById("cancel");
const shortcuts = document.getElementById("shortcuts");
const device = document.getElementById("device");
const dimensions = document.getElementById("dimensions");
const viewportWidth = document.getElementById("viewport-width");
const viewportHeight = document.getElementById("viewport-height");

const DEVICE_VIEWPORTS = {
  iphone: { width: 390, height: 844, dpr: 3 },
  pixel: { width: 412, height: 915, dpr: 2.625 },
  ipad: { width: 768, height: 1024, dpr: 2 },
};

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
shortcuts.textContent = isMac
  ? "Shortcuts: ⌥⇧S full page · ⌥⇧V visible area"
  : "Shortcuts: Alt+Shift+S full page · Alt+Shift+V visible area";

let port = null;
let tabId = null;
let busy = false;

function setWarning(text) {
  if (!text) {
    warning.hidden = true;
    warning.textContent = "";
    return;
  }
  warning.hidden = false;
  warning.textContent = text;
}

function setBusy(next) {
  busy = next;
  fullBtn.disabled = next || fullBtn.dataset.blocked === "1";
  visibleBtn.disabled = next || fullBtn.dataset.blocked === "1";
  progress.hidden = !next;
}

function connect() {
  if (port) return port;
  port = chrome.runtime.connect({ name: "capture" });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
  });
  return port;
}

function onMessage(msg) {
  if (msg.type === "progress") {
    setBusy(true);
    const total = Math.max(1, msg.total || 1);
    const current = msg.current || 0;
    const pct = msg.phase === "saving" ? 100 : Math.round((current / total) * 100);
    barFill.style.width = `${pct}%`;
    progressCount.textContent = msg.phase === "capturing" ? `${current}/${total}` : "";
    progressLabel.textContent =
      msg.phase === "preparing"
        ? "Preparing page…"
        : msg.phase === "saving"
          ? "Opening preview…"
          : "Scrolling and capturing…";
    return;
  }
  if (msg.type === "done") {
    setBusy(false);
    window.close();
    return;
  }
  if (msg.type === "cancelled") {
    setBusy(false);
    progressLabel.textContent = "Cancelled";
    return;
  }
  if (msg.type === "error") {
    setBusy(false);
    setWarning(msg.error || "Capture failed.");
  }
}

function selectedViewport() {
  if (device.value === "desktop") return null;
  if (DEVICE_VIEWPORTS[device.value]) return DEVICE_VIEWPORTS[device.value];
  const width = Number(viewportWidth.value);
  const height = Number(viewportHeight.value);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || width > 2000 || height < 200 || height > 3000) {
    setWarning("Custom viewport must be 200–2000 px wide and 200–3000 px tall.");
    return undefined;
  }
  return { width, height, dpr: 2 };
}

function capture(mode) {
  if (busy || tabId == null) return;
  const viewport = selectedViewport();
  if (viewport === undefined) return;
  setWarning("");
  setBusy(true);
  progressLabel.textContent = "Starting…";
  progressCount.textContent = "";
  barFill.style.width = "8%";
  connect().postMessage({ type: "CAPTURE", mode, tabId, viewport });
}

fullBtn.addEventListener("click", () => capture("full"));
visibleBtn.addEventListener("click", () => capture("visible"));
device.addEventListener("change", () => {
  const preset = DEVICE_VIEWPORTS[device.value];
  dimensions.hidden = device.value !== "custom";
  if (preset) {
    viewportWidth.value = preset.width;
    viewportHeight.value = preset.height;
  }
});
cancelBtn.addEventListener("click", () => {
  connect().postMessage({ type: "CANCEL" });
  chrome.runtime.sendMessage({ type: "CANCEL" });
});

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = tab?.id ?? null;
const url = tab?.url || "";
if (tabId == null || RESTRICTED.test(url) || STORE_HOSTS.test(url)) {
  fullBtn.dataset.blocked = "1";
  fullBtn.disabled = true;
  visibleBtn.disabled = true;
  setWarning("This tab can’t be captured. Open a regular webpage and try again.");
} else if (url.startsWith("file:")) {
  setWarning("For local files, enable “Allow access to file URLs” on chrome://extensions.");
}

const status = await chrome.runtime.sendMessage({ type: "STATUS" }).catch(() => null);
if (status?.capturing) {
  setBusy(true);
  onMessage({ type: "progress", ...status.progress });
  connect();
}
