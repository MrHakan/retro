/**
 * fx.js — the shared toolkit every game draws from: seeded RNG, math and
 * collision helpers, a pooled particle system, screen shake, the arcade
 * palette, and canvas drawing utilities (neon glow, vector shapes, and
 * nearest-neighbour "pixel" text that needs no font file).
 */

/* ------------------------------------------------------------------ math */

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const dist2 = (ax, ay, bx, by) => (bx - ax) ** 2 + (by - ay) ** 2;
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export const aabb = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Circle {x,y,r} vs axis-aligned rect {x,y,w,h}. Returns null or a hit normal. */
export function circleRect(cx, cy, r, rx, ry, rw, rh) {
  const nx = clamp(cx, rx, rx + rw);
  const ny = clamp(cy, ry, ry + rh);
  const dx = cx - nx;
  const dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 > r * r) return null;
  const d = Math.sqrt(d2);
  if (d === 0) {
    // Centre is inside the rect: push out along the shallowest axis.
    const left = cx - rx;
    const right = rx + rw - cx;
    const top = cy - ry;
    const bottom = ry + rh - cy;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { nx: -1, ny: 0, depth: r + left };
    if (m === right) return { nx: 1, ny: 0, depth: r + right };
    if (m === top) return { nx: 0, ny: -1, depth: r + top };
    return { nx: 0, ny: 1, depth: r + bottom };
  }
  return { nx: dx / d, ny: dy / d, depth: r - d };
}

/** Segment intersection; returns {x,y,t} or null. */
export function segIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t };
}

/** Reflect velocity (vx,vy) about a unit normal (nx,ny) with restitution. */
export function reflect(vx, vy, nx, ny, restitution = 1) {
  const d = vx * nx + vy * ny;
  return { x: (vx - 2 * d * nx) * restitution, y: (vy - 2 * d * ny) * restitution };
}

/* ------------------------------------------------------------------- rng */

/** Deterministic, fast PRNG (mulberry32). */
export class RNG {
  constructor(seed = Date.now() >>> 0) {
    this.seed(seed);
  }
  seed(s) {
    this._s = (typeof s === 'string' ? hashString(s) : s >>> 0) || 1;
    return this;
  }
  /** [0,1) */
  next() {
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + this.next() * (b - a);
  }
  /** Integer in [a, b] inclusive. */
  int(a, b) {
    return Math.floor(this.range(a, b + 1 - 1e-9));
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p) {
    return this.next() < p;
  }
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  angle() {
    return this.next() * TAU;
  }
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* --------------------------------------------------------------- palette */

export const PAL = {
  bg: '#05060a',
  bgAlt: '#0b0f1a',
  grid: '#16233d',
  cyan: '#22e7ff',
  magenta: '#ff3ea5',
  violet: '#a86bff',
  lime: '#8dff4a',
  yellow: '#ffd53d',
  orange: '#ff8b2e',
  red: '#ff3b53',
  blue: '#3d7bff',
  white: '#eaf6ff',
  dim: '#5a6b8c',
  green: '#2bd97a',
  pink: '#ff8fd0',
};

export const NEON = [PAL.cyan, PAL.magenta, PAL.lime, PAL.yellow, PAL.violet, PAL.orange, PAL.blue];

/** `#rrggbb` + alpha -> `rgba(...)`. Accepts rgba passthrough. */
export function alpha(hex, a) {
  if (!hex || hex[0] !== '#') return hex;
  const n = parseInt(hex.slice(1), 16);
  if (hex.length === 7) {
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const r = ((n >> 8) & 15) * 17;
  const g = ((n >> 4) & 15) * 17;
  const b = (n & 15) * 17;
  return `rgba(${r},${g},${b},${a})`;
}

/** Blend two hex colours. */
export function mix(c1, c2, t) {
  const a = parseInt(c1.slice(1), 16);
  const b = parseInt(c2.slice(1), 16);
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, t));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, t));
  const bl = Math.round(lerp(a & 255, b & 255, t));
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

export function hsl(h, s, l, a = 1) {
  return `hsla(${h},${s}%,${l}%,${a})`;
}

/* ------------------------------------------------------------- particles */

/**
 * Pooled particle system. Particles are plain objects reused from a free list
 * so a heavy explosion doesn't churn the GC mid-frame.
 */
export class Particles {
  constructor(max = 900) {
    this.max = max;
    this.list = [];
    this.pool = [];
  }

  /**
   * @param {object} o {x,y,vx,vy,life,size,color,gravity,drag,shape,glow,
   *                    rot,vr,fade,shrink,additive,text}
   */
  emit(o) {
    if (this.list.length >= this.max) return null;
    const p = this.pool.pop() || {};
    p.x = o.x || 0;
    p.y = o.y || 0;
    p.vx = o.vx || 0;
    p.vy = o.vy || 0;
    p.life = p.maxLife = o.life ?? 0.6;
    p.size = o.size ?? 2;
    p.color = o.color || PAL.cyan;
    p.gravity = o.gravity ?? 0;
    p.drag = o.drag ?? 0;
    p.shape = o.shape || 'square';
    p.glow = o.glow ?? 0;
    p.rot = o.rot ?? 0;
    p.vr = o.vr ?? 0;
    p.fade = o.fade !== false;
    p.shrink = o.shrink ?? 0;
    p.additive = o.additive !== false;
    p.text = o.text || null;
    this.list.push(p);
    return p;
  }

  /** Radial burst of `n` particles. */
  burst(x, y, n, o = {}) {
    const spread = o.spread ?? TAU;
    const dir = o.dir ?? 0;
    for (let i = 0; i < n; i++) {
      const a = dir - spread / 2 + Math.random() * spread;
      const sp = (o.speed ?? 60) * (0.35 + Math.random() * 0.9);
      this.emit({
        ...o,
        x: x + (o.jitter ? (Math.random() - 0.5) * o.jitter : 0),
        y: y + (o.jitter ? (Math.random() - 0.5) * o.jitter : 0),
        vx: Math.cos(a) * sp + (o.vx || 0),
        vy: Math.sin(a) * sp + (o.vy || 0),
        life: (o.life ?? 0.6) * (0.6 + Math.random() * 0.8),
        size: (o.size ?? 2) * (0.6 + Math.random() * 0.8),
        color: Array.isArray(o.color) ? o.color[(Math.random() * o.color.length) | 0] : o.color,
        rot: Math.random() * TAU,
        vr: o.vr ?? (Math.random() - 0.5) * 8,
      });
    }
  }

  /** Floating score/combo text. */
  popText(x, y, text, color = PAL.yellow, life = 0.9) {
    this.emit({ x, y, vy: -30, life, color, text, size: 10, shape: 'text', drag: 1.5, additive: false });
  }

  update(dt) {
    const list = this.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) {
        list[i] = list[list.length - 1];
        list.pop();
        this.pool.push(p);
        continue;
      }
      if (p.drag) {
        const f = Math.exp(-p.drag * dt);
        p.vx *= f;
        p.vy *= f;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.shrink) p.size = Math.max(0, p.size - p.shrink * dt);
    }
  }

  render(ctx) {
    if (!this.list.length) return;
    ctx.save();
    let additive = false;
    ctx.globalCompositeOperation = 'source-over';
    for (const p of this.list) {
      const t = p.life / p.maxLife;
      const a = p.fade ? clamp(t, 0, 1) : 1;
      if (p.additive !== additive) {
        additive = p.additive;
        ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (p.glow) {
        ctx.shadowBlur = p.glow;
        ctx.shadowColor = p.color;
      } else {
        ctx.shadowBlur = 0;
      }
      const s = p.size;
      switch (p.shape) {
        case 'circle':
          ctx.beginPath();
          ctx.arc(p.x, p.y, s, 0, TAU);
          ctx.fill();
          break;
        case 'line': {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, s * 0.5);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
          ctx.stroke();
          break;
        }
        case 'spark': {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, s * 0.4);
          const c = Math.cos(p.rot) * s * 2;
          const sn = Math.sin(p.rot) * s * 2;
          ctx.beginPath();
          ctx.moveTo(p.x - c, p.y - sn);
          ctx.lineTo(p.x + c, p.y + sn);
          ctx.stroke();
          break;
        }
        case 'text':
          ctx.font = `${s}px "Courier New", monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.text, p.x, p.y);
          break;
        case 'ring':
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, s * 0.25);
          ctx.beginPath();
          ctx.arc(p.x, p.y, s * (1 + (1 - t) * 3), 0, TAU);
          ctx.stroke();
          break;
        default:
          if (p.rot) {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillRect(-s / 2, -s / 2, s, s);
            ctx.restore();
          } else {
            ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
          }
      }
    }
    ctx.restore();
  }

  clear() {
    while (this.list.length) this.pool.push(this.list.pop());
  }

  get count() {
    return this.list.length;
  }
}

/* ------------------------------------------------------------------ shake */

export class Shake {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.mag = 0;
    this.decay = 6;
  }
  add(mag, decay = 6) {
    this.mag = Math.max(this.mag, mag);
    this.decay = decay;
  }
  update(dt) {
    if (this.mag > 0.01) {
      this.mag = Math.max(0, this.mag - this.mag * this.decay * dt - dt * 2);
      this.x = (Math.random() - 0.5) * 2 * this.mag;
      this.y = (Math.random() - 0.5) * 2 * this.mag;
    } else {
      this.mag = 0;
      this.x = 0;
      this.y = 0;
    }
  }
  apply(ctx) {
    if (this.mag) ctx.translate(this.x, this.y);
  }
  reset() {
    this.mag = 0;
    this.x = 0;
    this.y = 0;
  }
}

/* ------------------------------------------------------------- draw utils */

/** Draw with a neon glow, restoring shadow state afterwards. */
export function glow(ctx, color, blur, fn) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  fn(ctx);
  ctx.restore();
}

export function glowRect(ctx, x, y, w, h, color, blur = 10) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

export function glowCircle(ctx, x, y, r, color, blur = 12) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

export function glowLine(ctx, x1, y1, x2, y2, color, width = 2, blur = 10) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Regular / star polygon path. */
export function polygon(ctx, x, y, r, sides, rot = 0, inner = 0) {
  ctx.beginPath();
  const steps = inner ? sides * 2 : sides;
  for (let i = 0; i < steps; i++) {
    const a = rot + (i / steps) * TAU;
    const rad = inner && i % 2 ? inner : r;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Vector text using the canvas font stack. Fast path for HUD and dense info.
 * @param {object} o {size, color, align, baseline, glow, font, weight}
 */
export function text(ctx, str, x, y, o = {}) {
  ctx.save();
  const size = o.size ?? 12;
  ctx.font = `${o.weight || 'bold'} ${size}px ${o.font || '"Courier New", ui-monospace, monospace'}`;
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = o.baseline || 'top';
  ctx.fillStyle = o.color || PAL.white;
  if (o.glow) {
    ctx.shadowColor = o.color || PAL.white;
    ctx.shadowBlur = o.glow;
  }
  if (o.letterSpacing && 'letterSpacing' in ctx) ctx.letterSpacing = o.letterSpacing;
  ctx.fillText(str, x, y);
  ctx.restore();
}

/**
 * Chunky pixel text with no font file: the string is rasterised small into a
 * cached offscreen canvas, then blown up with smoothing off. Any font stack
 * becomes a bitmap font this way.
 */
const _pixCache = new Map();
export function pixelText(ctx, str, x, y, o = {}) {
  const size = o.size ?? 16;
  const scale = Math.max(1, Math.round(o.scale ?? Math.max(1, size / 8)));
  const base = Math.max(5, Math.round(size / scale));
  const color = o.color || PAL.cyan;
  const key = `${str}|${base}|${color}|${o.weight || 'bold'}`;

  let tile = _pixCache.get(key);
  if (!tile) {
    const m = document.createElement('canvas');
    const mc = m.getContext('2d');
    mc.font = `${o.weight || 'bold'} ${base}px "Courier New", ui-monospace, monospace`;
    const w = Math.max(1, Math.ceil(mc.measureText(str).width) + 2);
    const h = Math.ceil(base * 1.35) + 2;
    m.width = w;
    m.height = h;
    const c2 = m.getContext('2d');
    c2.font = `${o.weight || 'bold'} ${base}px "Courier New", ui-monospace, monospace`;
    c2.textBaseline = 'top';
    c2.fillStyle = color;
    c2.fillText(str, 1, 1);
    tile = m;
    if (_pixCache.size > 240) _pixCache.clear();
    _pixCache.set(key, tile);
  }

  const dw = tile.width * scale;
  const dh = tile.height * scale;
  let dx = x;
  if (o.align === 'center') dx -= dw / 2;
  else if (o.align === 'right') dx -= dw;
  let dy = y;
  if (o.baseline === 'middle') dy -= dh / 2;
  else if (o.baseline === 'bottom') dy -= dh;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (o.glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = o.glow;
  }
  ctx.drawImage(tile, Math.round(dx), Math.round(dy), dw, dh);
  ctx.restore();
  return dw;
}

/** Width of `text()` output without drawing. */
export function measure(ctx, str, size = 12, weight = 'bold') {
  ctx.save();
  ctx.font = `${weight} ${size}px "Courier New", ui-monospace, monospace`;
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

/** A scrolling dotted starfield, handy for space games and menus. */
export class Starfield {
  constructor(w, h, count = 90, rng = new RNG(7)) {
    this.w = w;
    this.h = h;
    this.stars = [];
    for (let i = 0; i < count; i++) {
      this.stars.push({
        x: rng.range(0, w),
        y: rng.range(0, h),
        z: rng.range(0.25, 1),
        tw: rng.range(0, TAU),
      });
    }
  }
  update(dt, speed = 20, dirX = 0, dirY = 1) {
    for (const s of this.stars) {
      s.x += dirX * speed * s.z * dt;
      s.y += dirY * speed * s.z * dt;
      s.tw += dt * (2 + s.z * 4);
      if (s.y > this.h) { s.y -= this.h; s.x = Math.random() * this.w; }
      if (s.y < 0) { s.y += this.h; s.x = Math.random() * this.w; }
      if (s.x > this.w) { s.x -= this.w; s.y = Math.random() * this.h; }
      if (s.x < 0) { s.x += this.w; s.y = Math.random() * this.h; }
    }
  }
  render(ctx, tint = '#ffffff') {
    ctx.save();
    for (const s of this.stars) {
      const a = 0.25 + 0.55 * s.z * (0.6 + 0.4 * Math.sin(s.tw));
      ctx.globalAlpha = a;
      ctx.fillStyle = tint;
      const sz = s.z > 0.75 ? 2 : 1;
      ctx.fillRect(s.x | 0, s.y | 0, sz, sz);
    }
    ctx.restore();
  }
}

/** Draw a faint grid — the default backdrop for most cabinets in the hub. */
export function grid(ctx, w, h, cell = 24, color = PAL.grid, alphaVal = 0.5) {
  ctx.save();
  ctx.globalAlpha = alphaVal;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += cell) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += cell) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** Cheap vertical gradient fill. */
export function vgrad(ctx, x, y, w, h, top, bottom) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}
