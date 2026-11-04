'use strict';

/** Generates app.ico without any external dependency. */

const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '..', 'app.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function mix(a, b, t) { return a + (b - a) * t; }

function roundedRectSDF(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function segmentDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

function render(size) {
  const ss = 4;
  const S = size * ss;
  const out = new Uint8ClampedArray(size * size * 4);
  const acc = new Float32Array(size * size * 4);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = (x + 0.5) / S;
      const fy = (y + 0.5) / S;
      let r = 0, g = 0, b = 0, a = 0;

      // background rounded square
      const d = roundedRectSDF(fx, fy, 0.5, 0.5, 0.465, 0.465, 0.115);
      if (d <= 0) {
        const t = clamp01((fx * 0.6 + fy * 0.8));
        r = mix(88, 158, t);
        g = mix(120, 92, t);
        b = mix(248, 236, t);
        a = 1;
        // subtle top highlight
        const hl = clamp01(1 - (fy - 0.06) / 0.34) * 0.16;
        r = mix(r, 255, hl); g = mix(g, 255, hl); b = mix(b, 255, hl);
        // inner shadow at bottom
        const sh = clamp01((fy - 0.62) / 0.38) * 0.15;
        r *= 1 - sh; g *= 1 - sh; b *= 1 - sh;
      }

      // book cover
      const book = roundedRectSDF(fx, fy, 0.505, 0.5, 0.245, 0.275, 0.035);
      if (book <= 0) {
        r = 252; g = 253; b = 255; a = 1;
        // spine
        if (fx < 0.315) { r = 222; g = 228; b = 246; }
      }
      // spine line
      if (book <= 0 && Math.abs(fx - 0.315) < 0.008) { r = 170; g = 182; b = 214; }

      // text lines (accent)
      const line1 = segmentDist(fx, fy, 0.37, 0.395, 0.665, 0.395) < 0.019;
      const line2 = segmentDist(fx, fy, 0.37, 0.487, 0.665, 0.487) < 0.017;
      const line3 = segmentDist(fx, fy, 0.37, 0.575, 0.565, 0.575) < 0.017;
      if (book <= 0 && (line1 || line2 || line3)) {
        r = 109; g = 123; b = 246; a = 1;
      }

      // green check badge
      const bd = Math.hypot(fx - 0.735, fy - 0.745) - 0.15;
      if (bd <= 0) {
        r = 46; g = 205; b = 152; a = 1;
        const white = 0.022;
        const c1 = segmentDist(fx, fy, 0.675, 0.748, 0.716, 0.788) < white;
        const c2 = segmentDist(fx, fy, 0.716, 0.788, 0.795, 0.700) < white;
        if (c1 || c2) { r = 255; g = 255; b = 255; }
      }

      // Composite over transparent (premultiplied-ish source).
      if (a > 0) {
        const oy = y >> 2, ox = x >> 2;
        const idx = (oy * size + ox) * 4;
        acc[idx] += r * a;
        acc[idx + 1] += g * a;
        acc[idx + 2] += b * a;
        acc[idx + 3] += a * 255;
      }
    }
  }

  const n = ss * ss;
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = Math.round(acc[i * 4] / n);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n);
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / n);
  }
  return Buffer.from(out.buffer);
}

function bmpEntry(size, rgba) {
  const xorSize = size * size * 4;
  const andRow = Math.ceil(size / 32) * 4;
  const andSize = andRow * size;
  const buf = Buffer.alloc(40 + xorSize + andSize);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16);
  buf.writeUInt32LE(xorSize + andSize, 20);
  buf.writeInt32LE(2835, 24);
  buf.writeInt32LE(2835, 28);
  buf.writeUInt32LE(0, 32);
  buf.writeUInt32LE(0, 36);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4;
      const d = 40 + (y * size + x) * 4;
      buf[d] = rgba[s + 2];
      buf[d + 1] = rgba[s + 1];
      buf[d + 2] = rgba[s];
      buf[d + 3] = rgba[s + 3];
    }
  }
  return buf;
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const p = 6 + i * 16;
    header.writeUInt8(img.size >= 256 ? 0 : img.size, p);
    header.writeUInt8(img.size >= 256 ? 0 : img.size, p + 1);
    header.writeUInt8(0, p + 2);
    header.writeUInt8(0, p + 3);
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(img.data.length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += img.data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

const images = SIZES.map((size) => ({ size, data: bmpEntry(size, render(size)) }));
const buf = ico(images);
fs.writeFileSync(OUT, buf);
console.log('wrote', OUT, (buf.length / 1024).toFixed(1) + ' KB', 'sizes:', SIZES.join(','));
