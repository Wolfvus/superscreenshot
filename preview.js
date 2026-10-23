import { t, localize } from "./i18n.js";
localize();
import { getCapture, saveCapture } from "./store.js";

const MAX_AREA = 16384 * 16384;
const MAX_SIDE = 32767;

const titleEl = document.getElementById("title");
const metaEl = document.getElementById("meta");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const stageEl = document.getElementById("stage");
const imageEl = document.getElementById("image");
const copyBtn = document.getElementById("copy");
const downloadBtn = document.getElementById("download");
const discardBtn = document.getElementById("discard");
const zoomOutBtn = document.getElementById("zoom-out");
const zoomFitBtn = document.getElementById("zoom-fit");
const zoomInBtn = document.getElementById("zoom-in");
const imageShell = document.querySelector(".image-shell");

const id = new URLSearchParams(location.search).get("id");
let objectUrl = "";
let pngBlob = null;
let filename = "screenshot.png";
let zoom = 0;

function fail(message) {
  statusEl.hidden = false;
  statusEl.classList.add("error");
  statusEl.textContent = message;
  stageEl.hidden = true;
}

function setZoom(next) {
  zoom = Math.max(25, Math.min(200, next));
  imageShell.style.width = `${zoom}%`;
  imageShell.style.maxWidth = "none";
  zoomFitBtn.textContent = `${zoom}%`;
}

zoomOutBtn.addEventListener("click", () => setZoom((zoom || 100) - 25));
zoomInBtn.addEventListener("click", () => setZoom((zoom || 100) + 25));
zoomFitBtn.addEventListener("click", () => {
  zoom = 0;
  imageShell.style.width = "min(1100px, 100%)";
  imageShell.style.maxWidth = "1100px";
  zoomFitBtn.textContent = t("fit");
});

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function stitch(capture) {
  const tiles = capture.tiles || [];
  if (!tiles.length) throw new Error(t("noTiles"));

  if (capture.mode === "visible" || tiles.length === 1) {
    return tiles[0].blob;
  }

  const first = await createImageBitmap(tiles[0].blob);

  const windowWidth = capture.windowWidth || first.width;
  const windowHeight = capture.windowHeight || first.height;
  const scale = first.width / Math.max(1, windowWidth);
  const documentHeight = Math.max(
    capture.documentHeight || 0,
    tiles[tiles.length - 1].scrollY + windowHeight
  );
  let outW = Math.max(1, Math.round(windowWidth * scale));
  let outH = Math.max(1, Math.round(documentHeight * scale));
  const fit = Math.min(1, MAX_SIDE / outW, MAX_SIDE / outH, Math.sqrt(MAX_AREA / (outW * outH)));
  if (fit < 1) {
    outW = Math.max(1, Math.floor(outW * fit));
    outH = Math.max(1, Math.floor(outH * fit));
  }

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = fit < 1;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW, outH);

  let destY = 0;
  for (let i = 0; i < tiles.length; i++) {
    const bitmap = i === 0 ? first : await createImageBitmap(tiles[i].blob);
    try {
      const tileCssH = bitmap.height / scale;
      const scrollY = tiles[i].scrollY || 0;
      const remaining = documentHeight - destY;
      if (remaining <= 0.5) break;
      let sourceCssY = Math.max(0, destY - scrollY);
      if (sourceCssY >= tileCssH - 0.5) sourceCssY = 0;
      const sliceCssH = Math.min(tileCssH - sourceCssY, remaining);
      if (sliceCssH <= 0.5) continue;
      const sy = sourceCssY * scale;
      const sh = Math.min(bitmap.height - sy, sliceCssH * scale);
      const dy = destY * scale * fit;
      const dh = sliceCssH * scale * fit;
      ctx.drawImage(bitmap, 0, sy, bitmap.width, sh, 0, dy, outW, dh);
      destY += sliceCssH;
    } finally {
      bitmap.close();
    }
  }

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error(t("tooLarge")));
    }, "image/png");
  });
  return blob;
}

function enableActions() {
  copyBtn.disabled = false;
  downloadBtn.disabled = false;
  zoomOutBtn.disabled = false;
  zoomFitBtn.disabled = false;
  zoomInBtn.disabled = false;
}

copyBtn.addEventListener("click", async () => {
  if (!pngBlob) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
    copyBtn.textContent = t("copied");
    setTimeout(() => {
      copyBtn.textContent = t("copy");
    }, 1200);
  } catch {
    copyBtn.textContent = t("copyFailed");
    setTimeout(() => {
      copyBtn.textContent = t("copy");
    }, 1400);
  }
});

downloadBtn.addEventListener("click", () => {
  if (!objectUrl) return;
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.click();
});

discardBtn.addEventListener("click", async () => {
  if (!id || !confirm(t("confirmDelete"))) return;
  discardBtn.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: "DISCARD_CAPTURE", id });
  if (!response?.ok) {
    discardBtn.disabled = false;
    fail(response?.error || t("discardFailed"));
    return;
  }
  window.close();
});

async function main() {
  if (!id) {
    fail(t("missingId"));
    return;
  }

  const capture = await getCapture(id);
  if (!capture) {
    fail(t("unavailable"));
    return;
  }

  document.title = capture.title ? `${capture.title} · ${t("screenshot")}` : t("previewTitle");
  titleEl.textContent = capture.title || t("screenshot");
  filename = capture.filename || filename;
  statusTextEl.textContent = capture.mode === "visible" ? t("loading") : t("stitchFull");

  pngBlob = capture.image || (await stitch(capture));
  if (!capture.image) {
    await saveCapture(id, {
      ...capture,
      image: pngBlob,
      tiles: [],
    });
  }

  objectUrl = URL.createObjectURL(pngBlob);
  imageEl.src = objectUrl;
  stageEl.hidden = false;
  statusEl.hidden = true;
  enableActions();

  const dims = await new Promise((resolve) => {
    if (imageEl.complete && imageEl.naturalWidth) {
      resolve({ w: imageEl.naturalWidth, h: imageEl.naturalHeight });
      return;
    }
    imageEl.onload = () => resolve({ w: imageEl.naturalWidth, h: imageEl.naturalHeight });
  });
  const kind = capture.mode === "visible" ? t("visibleArea") : t("fullPage");
  const device = capture.deviceLabel ? ` · ${capture.deviceLabel}` : "";
  metaEl.textContent = `${dims.w} × ${dims.h} · ${formatBytes(pngBlob.size)} · ${kind}${device}`;
}

main().catch((err) => fail(err?.message || t("openFailed")));
