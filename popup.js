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

function capture(mode) {
  if (busy || tabId == null) return;
  setWarning("");
  setBusy(true);
  progressLabel.textContent = "Starting…";
  progressCount.textContent = "";
  barFill.style.width = "8%";
  connect().postMessage({
    type: "CAPTURE",
    mode,
    tabId,
    device: device.value === "desktop" ? null : device.value,
  });
}

fullBtn.addEventListener("click", () => capture("full"));
visibleBtn.addEventListener("click", () => capture("visible"));
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
