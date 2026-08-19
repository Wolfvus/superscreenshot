import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "icons");

const PURPLE = [109, 92, 255, 255];
const PURPLE_DARK = [72, 56, 214, 255];
const WHITE = [255, 255, 255, 255];
const INK = [22, 16, 52, 255];

function crc32(buf) {
  let c = 0xffffffff;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let k = n;
    for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
    table[n] = k >>> 0;
  }
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeCanvas(size) {
  return { size, px: Buffer.alloc(size * size * 4) };
}

function blend(px, i, color) {
  const sa = color[3] / 255;
  const da = px[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  const mix = (c, d) => Math.round((c * sa + d * da * (1 - sa)) / outA);
  px[i] = mix(color[0], px[i]);
  px[i + 1] = mix(color[1], px[i + 1]);
  px[i + 2] = mix(color[2], px[i + 2]);
  px[i + 3] = Math.round(outA * 255);
}

function setCover(canvas, x, y, coverage, color) {
  const size = canvas.size;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= size || iy >= size || coverage <= 0) return;
  const a = Math.max(0, Math.min(1, coverage));
  blend(canvas.px, (iy * size + ix) * 4, [color[0], color[1], color[2], Math.round(color[3] * a)]);
}

function distRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const inside = px >= x + r && px <= x + w - r && py >= y && py <= y + h;
  const insideV = py >= y + r && py <= y + h - r && px >= x && px <= x + w;
  if (inside || insideV) return -1;
  const dx = px - cx;
  const dy = py - cy;
  return Math.hypot(dx, dy) - r;
}

function fillRoundRect(canvas, x, y, w, h, r, color) {
  const x0 = Math.floor(x - 1);
  const y0 = Math.floor(y - 1);
  const x1 = Math.ceil(x + w + 1);
  const y1 = Math.ceil(y + h + 1);
  for (let iy = y0; iy < y1; iy++) {
    for (let ix = x0; ix < x1; ix++) {
      const d = distRoundRect(ix + 0.5, iy + 0.5, x, y, w, h, r);
      setCover(canvas, ix, iy, Math.min(1, Math.max(0, 0.5 - d)), color);
    }
  }
}

function strokeRoundRect(canvas, x, y, w, h, r, width, color) {
  const x0 = Math.floor(x - width - 1);
  const y0 = Math.floor(y - width - 1);
  const x1 = Math.ceil(x + w + width + 1);
  const y1 = Math.ceil(y + h + width + 1);
  const half = width / 2;
  for (let iy = y0; iy < y1; iy++) {
    for (let ix = x0; ix < x1; ix++) {
      const d = Math.abs(distRoundRect(ix + 0.5, iy + 0.5, x, y, w, h, r));
      setCover(canvas, ix, iy, Math.min(1, Math.max(0, half + 0.5 - d)), color);
    }
  }
}

function fillCircle(canvas, cx, cy, radius, color) {
  const x0 = Math.floor(cx - radius - 1);
  const y0 = Math.floor(cy - radius - 1);
  const x1 = Math.ceil(cx + radius + 1);
  const y1 = Math.ceil(cy + radius + 1);
  for (let iy = y0; iy < y1; iy++) {
    for (let ix = x0; ix < x1; ix++) {
      const d = Math.hypot(ix + 0.5 - cx, iy + 0.5 - cy) - radius;
      setCover(canvas, ix, iy, Math.min(1, Math.max(0, 0.5 - d)), color);
    }
  }
}

function strokeLine(canvas, x0, y0, x1, y1, width, color) {
  const minX = Math.floor(Math.min(x0, x1) - width - 1);
  const minY = Math.floor(Math.min(y0, y1) - width - 1);
  const maxX = Math.ceil(Math.max(x0, x1) + width + 1);
  const maxY = Math.ceil(Math.max(y0, y1) + width + 1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const half = width / 2;
  for (let iy = minY; iy < maxY; iy++) {
    for (let ix = minX; ix < maxX; ix++) {
      const px = ix + 0.5 - x0;
      const py = iy + 0.5 - y0;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (len * len)));
      const d = Math.hypot(px - dx * t, py - dy * t);
      setCover(canvas, ix, iy, Math.min(1, Math.max(0, half + 0.5 - d)), color);
    }
  }
}

function drawIcon(size) {
  const canvas = makeCanvas(size);
  const s = size / 128;
  fillRoundRect(canvas, 8 * s, 8 * s, 112 * s, 112 * s, 28 * s, PURPLE);
  fillRoundRect(canvas, 8 * s, 8 * s, 112 * s, 36 * s, 28 * s, [132, 118, 255, 46]);
  fillRoundRect(canvas, 10 * s, 86 * s, 108 * s, 32 * s, 24 * s, [...PURPLE_DARK.slice(0, 3), 40]);

  const frame = { x: 30 * s, y: 34 * s, w: 68 * s, h: 56 * s, r: 12 * s };
  strokeRoundRect(canvas, frame.x, frame.y, frame.w, frame.h, frame.r, 5.5 * s, WHITE);

  const tick = 12 * s;
  const inset = 9 * s;
  const x0 = frame.x + inset;
  const y0 = frame.y + inset;
  const x1 = frame.x + frame.w - inset;
  const y1 = frame.y + frame.h - inset;
  const tw = Math.max(2.4 * s, 2);
  strokeLine(canvas, x0, y0, x0 + tick, y0, tw, WHITE);
  strokeLine(canvas, x0, y0, x0, y0 + tick, tw, WHITE);
  strokeLine(canvas, x1, y0, x1 - tick, y0, tw, WHITE);
  strokeLine(canvas, x1, y0, x1, y0 + tick, tw, WHITE);
  strokeLine(canvas, x0, y1, x0 + tick, y1, tw, WHITE);
  strokeLine(canvas, x0, y1, x0, y1 - tick, tw, WHITE);
  strokeLine(canvas, x1, y1, x1 - tick, y1, tw, WHITE);
  strokeLine(canvas, x1, y1, x1, y1 - tick, tw, WHITE);

  fillCircle(canvas, 64 * s, 62 * s, 11.5 * s, WHITE);
  fillCircle(canvas, 64 * s, 62 * s, 6.2 * s, INK);
  fillCircle(canvas, 61.5 * s, 59.5 * s, 1.8 * s, WHITE);

  return encodePNG(size, size, canvas.px);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), drawIcon(size));
}
console.log("wrote icons to", OUT);
