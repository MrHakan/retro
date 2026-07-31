/**
 * make-icons.mjs — generates the PWA PNG icons from code.
 *
 * The arcade ships no binary art assets, so the icons are rasterised here with
 * a tiny hand-rolled PNG encoder (zlib is the only thing used, and it's built
 * into Node). Run with:  node tools/make-icons.mjs
 *
 * This is a build-time tool only — nothing in the deployed site depends on it.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');

/* ------------------------------------------------------------ PNG encoder */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba length = w*h*4 */
function encodePNG(rgba, w, h) {
  const stride = w * 4;
  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------- mini rasteriser */

class Bitmap {
  constructor(size) {
    this.size = size;
    this.data = new Uint8Array(size * size * 4);
  }
  px(x, y, [r, g, b], a = 1) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || a <= 0) return;
    const i = (y * this.size + x) * 4;
    const d = this.data;
    const src = Math.min(1, a);
    const dstA = d[i + 3] / 255;
    const outA = src + dstA * (1 - src);
    if (outA === 0) return;
    d[i] = (r * src + d[i] * dstA * (1 - src)) / outA;
    d[i + 1] = (g * src + d[i + 1] * dstA * (1 - src)) / outA;
    d[i + 2] = (b * src + d[i + 2] * dstA * (1 - src)) / outA;
    d[i + 3] = outA * 255;
  }
  rect(x, y, w, h, color, a = 1) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, color, a);
  }
  /** Anti-aliased disc. */
  disc(cx, cy, r, color, a = 1) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
      for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
        if (d2 <= r2) this.px(x, y, color, a);
        else if (d2 <= (r + 1) ** 2) this.px(x, y, color, a * (1 - (Math.sqrt(d2) - r)));
      }
    }
  }
  /** Additive-ish radial glow. */
  glow(cx, cy, r, color, strength = 0.5) {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > r) continue;
        this.px(x, y, color, strength * (1 - d / r) ** 2);
      }
    }
  }
  roundRectMask(radius) {
    // Knock the corners out so the icon reads as a rounded tile.
    const s = this.size;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx = Math.max(radius - x, 0, x - (s - radius - 1));
        const dy = Math.max(radius - y, 0, y - (s - radius - 1));
        if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > radius) {
          this.data[(y * s + x) * 4 + 3] = 0;
        }
      }
    }
  }
}

const BG = [5, 6, 10];
const PANEL = [12, 20, 36];
const CYAN = [34, 231, 255];
const MAGENTA = [255, 62, 165];
const LIME = [141, 255, 74];
const YELLOW = [255, 213, 61];

/**
 * The mark: a CRT cabinet screen showing a neon grid, with a joystick ball
 * and two buttons below it.
 * @param {number} size
 * @param {boolean} maskable adds the 20% safe-zone padding Android expects
 */
function drawIcon(size, maskable = false) {
  const bm = new Bitmap(size);
  const u = size / 32; // design grid unit
  const pad = maskable ? size * 0.14 : 0;
  const S = (n) => Math.round(n * u + pad * (n / 32) * 0 + pad);
  const scale = (size - pad * 2) / size;
  const P = (n) => Math.round(pad + n * u * scale);
  const L = (n) => Math.max(1, Math.round(n * u * scale));

  bm.rect(0, 0, size, size, BG);

  // Backdrop wash.
  bm.glow(size / 2, size * 0.36, size * 0.55, CYAN, 0.14);
  bm.glow(size / 2, size * 0.8, size * 0.5, MAGENTA, 0.1);

  // Screen bezel.
  const sx = P(4), sy = P(4), sw = L(24), sh = L(16);
  bm.rect(sx - L(1), sy - L(1), sw + L(2), sh + L(2), CYAN, 0.9);
  bm.rect(sx, sy, sw, sh, PANEL);

  // Neon grid inside the screen.
  const step = Math.max(2, Math.round(sw / 8));
  for (let x = sx; x <= sx + sw; x += step) bm.rect(x, sy, Math.max(1, L(0.12)), sh, CYAN, 0.35);
  for (let y = sy; y <= sy + sh; y += step) bm.rect(sx, y, sw, Math.max(1, L(0.12)), CYAN, 0.35);

  // A tiny "player" and "target" on the screen, echoing the hub's games.
  bm.glow(sx + sw * 0.3, sy + sh * 0.62, L(3), LIME, 0.8);
  bm.rect(Math.round(sx + sw * 0.3 - L(1.2)), Math.round(sy + sh * 0.62 - L(1.2)), L(2.4), L(2.4), LIME);
  bm.glow(sx + sw * 0.72, sy + sh * 0.34, L(3), MAGENTA, 0.8);
  bm.disc(sx + sw * 0.72, sy + sh * 0.34, L(1.3), MAGENTA);

  // Scanlines across the screen.
  for (let y = sy; y < sy + sh; y += Math.max(2, Math.round(u * 0.9))) {
    bm.rect(sx, y, sw, 1, [0, 0, 0], 0.28);
  }

  // Joystick: shaft + ball.
  const jx = P(9), jy = P(26);
  bm.rect(jx - L(0.5), jy - L(4), L(1.2), L(4), [160, 180, 210], 0.9);
  bm.rect(jx - L(3), jy, L(6.5), L(1.6), [90, 110, 145]);
  bm.glow(jx, jy - L(4.5), L(4), MAGENTA, 0.7);
  bm.disc(jx, jy - L(4.5), L(2.1), MAGENTA);
  bm.disc(jx - L(0.6), jy - L(5.1), L(0.7), [255, 200, 230], 0.8);

  // Two action buttons.
  for (const [bx, col] of [[P(20), CYAN], [P(26), YELLOW]]) {
    bm.glow(bx, jy - L(2), L(3.4), col, 0.7);
    bm.disc(bx, jy - L(2), L(2), col);
    bm.disc(bx - L(0.5), jy - L(2.6), L(0.6), [255, 255, 255], 0.6);
  }

  if (!maskable) bm.roundRectMask(Math.round(size * 0.18));
  return encodePNG(bm.data, size, size);
}

mkdirSync(OUT, { recursive: true });

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['icon-180.png', 180, false],
];

for (const [name, size, maskable] of targets) {
  const png = drawIcon(size, maskable);
  writeFileSync(join(OUT, name), png);
  console.log(`wrote icons/${name}  (${size}x${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}
