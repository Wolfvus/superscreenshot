import { getCapture, saveCapture } from "./store.js";

const MAX_AREA = 16384 * 16384;
const MAX_SIDE = 32767;

const titleEl = document.getElementById("title");
const metaEl = document.getElementById("meta");
const statusEl = document.getElementById("status");
const stageEl = document.getElementById("stage");
const imageEl = document.getElementById("image");
const copyBtn = document.getElementById("copy");
const downloadBtn = document.getElementById("download");

const id = new URLSearchParams(location.search).get("id");
let objectUrl = "";
let pngBlob = null;
let filename = "screenshot.png";

function fail(message) {
  statusEl.hidden = false;
  statusEl.classList.add("error");
  statusEl.textContent = message;
  stageEl.hidden = true;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function stitch(capture) {
  const tiles = capture.tiles || [];
  if (!tiles.length) throw new Error("No screenshot tiles were saved.");

  if (capture.mode === "visible" || tiles.length === 1) {
    return tiles[0].blob;
  }

  const bitmaps = [];
  for (const tile of tiles) {
    bitmaps.push(await createImageBitmap(tile.blob));
  }

  const windowWidth = capture.windowWidth || bitmaps[0].width;
  const windowHeight = capture.windowHeight || bitmaps[0].height;
  const scale = bitmaps[0].width / Math.max(1, windowWidth);
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
  for (let i = 0; i < bitmaps.length; i++) {
    const bitmap = bitmaps[i];
    const scrollY = tiles[i].scrollY || 0;
    const remaining = documentHeight - destY;
    if (remaining <= 0.5) break;
    const sourceCssY = Math.max(0, destY - scrollY);
    const sliceCssH = Math.min(windowHeight - sourceCssY, remaining);
    if (sliceCssH <= 0.5) continue;
    const sy = sourceCssY * scale;
    const sh = Math.min(bitmap.height - sy, sliceCssH * scale);
    const dy = destY * scale * fit;
    const dh = sliceCssH * scale * fit;
    ctx.drawImage(bitmap, 0, sy, bitmap.width, sh, 0, dy, outW, dh);
    destY += sliceCssH;
    bitmap.close();
  }

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("The page was too large to encode as a PNG. Try capturing the visible area."));
    }, "image/png");
  });
  return blob;
}

function enableActions() {
  copyBtn.disabled = false;
  downloadBtn.disabled = false;
}

copyBtn.addEventListener("click", async () => {
  if (!pngBlob) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
    copyBtn.textContent = "Copied";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 1200);
  } catch {
    copyBtn.textContent = "Copy failed";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
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

async function main() {
  if (!id) {
    fail("Missing screenshot id. Capture a page from the toolbar icon.");
    return;
  }

  const capture = await getCapture(id);
  if (!capture) {
    fail("This screenshot is no longer available. Capture the page again from the toolbar.");
    return;
  }

  document.title = capture.title ? `${capture.title} · screenshot` : "Screenshot preview";
  titleEl.textContent = capture.title || "Screenshot";
  filename = capture.filename || filename;
  statusEl.textContent = capture.mode === "visible" ? "Loading screenshot…" : "Stitching full-page screenshot…";

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
  metaEl.textContent = `${dims.w} × ${dims.h} · ${formatBytes(pngBlob.size)} · ${capture.mode === "visible" ? "visible area" : "full page"}`;
}

main().catch((err) => fail(err?.message || "Could not open this screenshot."));
