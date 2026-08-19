// One-off icon generator for the PWA (no external image deps).
// Draws a simple chess-clock glyph (rounded square + two clock faces + hands)
// directly into an RGBA pixel buffer and encodes it as PNG using only Node's
// built-in zlib. Run with: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = [0x14, 0x1a, 0x21, 255]; // dark slate
const ACCENT = [0x35, 0xd0, 0x7f, 255]; // green (active clock)
const FACE = [0xe8, 0xed, 0xf2, 255]; // light face

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function dist(x, y, cx, cy) {
  return Math.hypot(x - cx, y - cy);
}

function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 === 0 ? 0 : (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t, cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

function drawIcon(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };

  // Background: rounded square (or full-bleed for maskable icons).
  const radius = maskable ? 0 : size * 0.18;
  const pad = maskable ? size * 0.08 : 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inPad = x < pad || y < pad || x >= size - pad || y >= size - pad;
      let inside = !inPad;
      if (inside && radius > 0) {
        const rx = Math.min(x, size - 1 - x);
        const ry = Math.min(y, size - 1 - y);
        if (rx < radius && ry < radius) {
          inside = dist(rx, ry, radius, radius) <= radius;
        }
      }
      set(x, y, inside ? BG : [0, 0, 0, 0]);
    }
  }

  // Two overlapping clock faces (chess clock look), left = accent (active), right = neutral.
  const cy = size * 0.52;
  const r = size * 0.27;
  const leftCx = size * 0.38;
  const rightCx = size * 0.62;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dLeft = dist(x, y, leftCx, cy);
      const dRight = dist(x, y, rightCx, cy);
      if (dRight <= r) set(x, y, FACE);
      if (dLeft <= r) set(x, y, FACE);
    }
  }
  // Clock hands on the left (active/green) face.
  const handLen = r * 0.62;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d1 = segDist(x, y, leftCx, cy, leftCx, cy - handLen); // minute hand up
      const d2 = segDist(x, y, leftCx, cy, leftCx + handLen * 0.6, cy); // hour hand right
      if (d1 <= size * 0.018 || d2 <= size * 0.018) set(x, y, ACCENT);
    }
  }
  // Center pins
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dist(x, y, leftCx, cy) <= size * 0.02) set(x, y, ACCENT);
      if (dist(x, y, rightCx, cy) <= size * 0.02) set(x, y, BG);
    }
  }
  // Top button (the physical clock's press button).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dist(x, y, size * 0.5, size * 0.16) <= size * 0.07) set(x, y, ACCENT);
    }
  }

  return buf;
}

const outputs = [
  ['public/icons/icon-192.png', 192, {}],
  ['public/icons/icon-512.png', 512, {}],
  ['public/icons/icon-maskable-512.png', 512, { maskable: true }],
  ['public/icons/apple-touch-icon.png', 180, {}],
  ['public/icons/favicon-32.png', 32, {}],
];

for (const [path, size, opts] of outputs) {
  const rgba = drawIcon(size, opts);
  writeFileSync(path, encodePNG(size, size, rgba));
  console.log('wrote', path);
}
