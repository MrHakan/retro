/**
 * 12 — PIXEL MINI-GOLF
 * Nine procedurally generated top-down holes. Drag back from the ball to load a
 * slingshot putt, watch the predicted bounce, and let rolling friction do the
 * rest. Every generated layout is flood-filled before it is handed to the
 * player, so the cup is always reachable.
 */

import {
  PAL, TAU, alpha, clamp, circleRect, reflect, mix, text, roundRect, RNG,
} from '../core/fx.js';

/* ----------------------------------------------------------------- layout */

const VIEW = { w: 480, h: 360 };
const HUD_H = 30;
const WALL = 9;                       // outer wall thickness
const FX = 12;                        // playfield rect
const FY = HUD_H + 6;
const FW = VIEW.w - FX * 2;
const FH = VIEW.h - FY - 12;

const BALL_R = 4.6;
const CUP_R = 8.5;
const HOLES = 9;
const MAX_POWER = 430;
const MIN_POWER = 80;
const DRAG_MAX = 128;                 // pixels of pull for full power
const GRAB_R = 92;                    // how close the press must start
const REST_V = 13;                    // below this the ball is considered parked
const RESTITUTION = 0.72;

/** Surfaces: linear deceleration in px/s^2. */
const SURF = {
  grass: { decel: 112, color: '#1d5c33', label: 'GRASS' },
  sand: { decel: 470, color: '#c9a martin', label: 'SAND' },
  ice: { decel: 9, color: '#7fd8ff', label: 'ICE' },
};
SURF.sand.color = '#c9a45c';

/* --------------------------------------------------------------- geometry */

const rectAt = (x, y, w, h) => ({ x, y, w, h });

function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Rotate (x,y) about (cx,cy) by -a — used to enter the windmill's frame. */
function unrotate(px, py, cx, cy, a) {
  const c = Math.cos(-a);
  const s = Math.sin(-a);
  const dx = px - cx;
  const dy = py - cy;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/* ------------------------------------------------------------- generation */

/**
 * Build one hole and prove it is playable. Interior blocks are thrown down at
 * random, then a flood fill over the free space (inflated by the ball radius)
 * has to connect tee to cup — if it doesn't, the layout is discarded and
 * regenerated. After too many failures we fall back to an open field, which is
 * trivially completable.
 */
function generateHole(rng, index) {
  const par = 0;
  void par;
  for (let attempt = 0; attempt < 24; attempt++) {
    const hole = buildCandidate(rng, index, attempt);
    if (validate(hole)) return hole;
  }
  const fallback = buildCandidate(rng, index, 99, true);
  return fallback;
}

function buildCandidate(rng, index, attempt, open = false) {
  const diff = index / (HOLES - 1);
  const tee = { x: 0, y: 0 };
  const cup = { x: 0, y: 0 };
  const m = 34;

  // Tee and cup always start far apart, on opposite halves.
  const side = rng.chance(0.5);
  if (side) {
    tee.x = rng.range(FX + m, FX + FW * 0.32);
    tee.y = rng.range(FY + m, FY + FH - m);
    cup.x = rng.range(FX + FW * 0.68, FX + FW - m);
    cup.y = rng.range(FY + m, FY + FH - m);
  } else {
    tee.x = rng.range(FX + m, FX + FW - m);
    tee.y = rng.range(FY + FH * 0.68, FY + FH - m);
    cup.x = rng.range(FX + m, FX + FW - m);
    cup.y = rng.range(FY + m, FY + FH * 0.32);
  }

  const blocks = [];
  const patches = [];
  const slopes = [];
  let mill = null;

  const clearOf = (r, p, pad) =>
    !(p.x > r.x - pad && p.x < r.x + r.w + pad && p.y > r.y - pad && p.y < r.y + r.h + pad);

  if (!open) {
    const count = 2 + Math.round(diff * 4) + (attempt % 2);
    for (let i = 0; i < count * 3 && blocks.length < count; i++) {
      const vert = rng.chance(0.5);
      const w = vert ? rng.range(14, 22) : rng.range(46, 140);
      const h = vert ? rng.range(46, 128) : rng.range(14, 22);
      const r = rectAt(
        rng.range(FX + 24, FX + FW - w - 24),
        rng.range(FY + 24, FY + FH - h - 24),
        w, h,
      );
      if (!clearOf(r, tee, 30) || !clearOf(r, cup, 34)) continue;
      blocks.push(r);
    }

    // Surface patches: sand traps and ice sheets.
    const pc = 1 + Math.round(diff * 2.4);
    for (let i = 0; i < pc; i++) {
      const w = rng.range(50, 130);
      const h = rng.range(40, 90);
      const r = rectAt(
        rng.range(FX + 10, FX + FW - w - 10),
        rng.range(FY + 10, FY + FH - h - 10),
        w, h,
      );
      if (!clearOf(r, tee, 16)) continue;
      r.type = rng.chance(index >= 3 ? 0.45 : 0.25) ? 'ice' : 'sand';
      patches.push(r);
    }

    // Slope zones push the ball with a constant acceleration.
    if (index >= 2) {
      const sc = rng.int(1, 2);
      for (let i = 0; i < sc; i++) {
        const w = rng.range(70, 150);
        const h = rng.range(60, 120);
        const r = rectAt(
          rng.range(FX + 8, FX + FW - w - 8),
          rng.range(FY + 8, FY + FH - h - 8),
          w, h,
        );
        if (!clearOf(r, cup, 46)) continue;
        const a = rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
        const mag = rng.range(70, 135);
        r.ax = Math.cos(a) * mag;
        r.ay = Math.sin(a) * mag;
        slopes.push(r);
      }
    }

    // A windmill blade sweeping the middle of the run.
    if (index >= 1) {
      const len = rng.range(34, 52);
      for (let t = 0; t < 24; t++) {
        const mx = rng.range(FX + len + 16, FX + FW - len - 16);
        const my = rng.range(FY + len + 16, FY + FH - len - 16);
        const dt2 = Math.hypot(mx - tee.x, my - tee.y);
        const dc = Math.hypot(mx - cup.x, my - cup.y);
        if (dt2 < len + 60 || dc < len + 60) continue;
        let clash = false;
        for (const b of blocks) {
          if (!clearOf(b, { x: mx, y: my }, len + 6)) clash = true;
        }
        if (clash) continue;
        mill = {
          x: mx, y: my, len, thick: 8,
          ang: rng.angle(), spd: rng.pick([-1, 1]) * rng.range(1.1, 2.1),
        };
        break;
      }
    }
  }

  const d = Math.hypot(cup.x - tee.x, cup.y - tee.y);
  let par = d < 210 ? 2 : d < 330 ? 3 : 4;
  if (blocks.length >= 5) par++;
  if (mill) par++;
  par = clamp(par, 2, 5);

  return { tee, cup, blocks, patches, slopes, mill, par, index };
}

/** Solid rects: the four outer walls plus every interior block. */
function solidsOf(hole) {
  return [
    rectAt(FX - WALL, FY - WALL, FW + WALL * 2, WALL),
    rectAt(FX - WALL, FY + FH, FW + WALL * 2, WALL),
    rectAt(FX - WALL, FY, WALL, FH),
    rectAt(FX + FW, FY, WALL, FH),
    ...hole.blocks,
  ];
}

/** Flood fill the free space; the hole is only kept if the cup is reachable. */
function validate(hole) {
  const cell = 8;
  const cols = Math.ceil(FW / cell);
  const rows = Math.ceil(FH / cell);
  const solids = hole.blocks;               // outer walls are the grid border
  const blocked = new Uint8Array(cols * rows);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cx = FX + gx * cell + cell / 2;
      const cy = FY + gy * cell + cell / 2;
      let bad = 0;
      for (const s of solids) {
        if (circleRect(cx, cy, BALL_R + 1.5, s.x, s.y, s.w, s.h)) {
          bad = 1;
          break;
        }
      }
      blocked[gy * cols + gx] = bad;
    }
  }

  const gi = (p) => {
    const gx = clamp(Math.floor((p.x - FX) / cell), 0, cols - 1);
    const gy = clamp(Math.floor((p.y - FY) / cell), 0, rows - 1);
    return gy * cols + gx;
  };
  const start = gi(hole.tee);
  const goal = gi(hole.cup);
  if (blocked[start] || blocked[goal]) return false;

  const seen = new Uint8Array(cols * rows);
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const cur = queue.pop();
    if (cur === goal) return true;
    const cx = cur % cols;
    const cy = (cur / cols) | 0;
    if (cx > 0 && !seen[cur - 1] && !blocked[cur - 1]) { seen[cur - 1] = 1; queue.push(cur - 1); }
    if (cx < cols - 1 && !seen[cur + 1] && !blocked[cur + 1]) { seen[cur + 1] = 1; queue.push(cur + 1); }
    if (cy > 0 && !seen[cur - cols] && !blocked[cur - cols]) { seen[cur - cols] = 1; queue.push(cur - cols); }
    if (cy < rows - 1 && !seen[cur + cols] && !blocked[cur + cols]) {
      seen[cur + cols] = 1;
      queue.push(cur + cols);
    }
  }
  return false;
}

/* ------------------------------------------------------------------- meta */

export const meta = {
  id: 'minigolf',
  title: 'PIXEL MINI-GOLF',
  short: 'MINI-GOLF',
  category: 'SPORTS',
  desc: 'Nine procedural holes of top-down putting. Drag back to aim, read the '
      + 'bounce line, and mind the sand, the ice and the windmill. Fewer strokes '
      + 'means a bigger score.',
  accent: PAL.lime,
  scoreLabel: 'SCORE',
  view: VIEW,
  controls: [
    'DRAG FROM BALL — aim and set power',
    'RELEASE — putt',
    'A — reset the ball',
  ],
  touch: { buttons: [{ id: 'a', label: 'RESET' }] },
  art(ctx, w, h, accent) {
    ctx.fillStyle = '#123d22';
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 10) {
      ctx.fillStyle = (y / 10) % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)';
      ctx.fillRect(0, y, w, 10);
    }
    // rail
    ctx.strokeStyle = '#2b1a10';
    ctx.lineWidth = 8;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    // sand + ice
    ctx.fillStyle = '#c9a45c';
    ctx.beginPath();
    ctx.ellipse(70, 118, 34, 22, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(127,216,255,0.55)';
    ctx.fillRect(140, 30, 62, 44);
    // block
    ctx.fillStyle = '#3a2416';
    ctx.fillRect(96, 78, 78, 14);
    // cup + flag
    ctx.fillStyle = '#04070c';
    ctx.beginPath();
    ctx.arc(190, 122, 9, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#dfe9f5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(190, 122);
    ctx.lineTo(190, 78);
    ctx.stroke();
    ctx.fillStyle = PAL.red;
    ctx.beginPath();
    ctx.moveTo(190, 78);
    ctx.lineTo(216, 86);
    ctx.lineTo(190, 94);
    ctx.closePath();
    ctx.fill();
    // ball + aim line
    ctx.save();
    ctx.strokeStyle = alpha(accent, 0.9);
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(56, 60);
    ctx.lineTo(190, 122);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(56, 60, 6, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = alpha(accent, 0.9);
    ctx.fillRect(20, h - 26, 90, 8);
  },
};

/* ------------------------------------------------------------------ game */

export function create(api) {
  const W = api.w;
  const H = api.h;

  let rng;
  let hole, holeIdx, solids;
  let ball, trail;
  let strokes, card, total;
  let phase;                 // 'aim' | 'roll' | 'sunk' | 'card' | 'done'
  let aiming, aimFrom, aimTo, power;
  let strokeStart;
  let rollTime, sinkT, cardT, banner, bannerT;
  let felt;                  // pre-rendered background
  let aces;
  let lastSurface;
  let finished;

  /* --------------------------------------------------------- course setup */

  function loadHole(i) {
    holeIdx = i;
    hole = generateHole(rng, i);
    solids = solidsOf(hole);
    ball = { x: hole.tee.x, y: hole.tee.y, vx: 0, vy: 0 };
    strokeStart = { x: ball.x, y: ball.y };
    trail = [];
    strokes = 0;
    rollTime = 0;
    sinkT = 0;
    phase = 'aim';
    aiming = false;
    power = 0;
    lastSurface = 'grass';
    api.setStatus({ HOLE: (i + 1) + '/' + HOLES, PAR: hole.par, STROKES: 0 });
    say('HOLE ' + (i + 1) + ' — PAR ' + hole.par, 2);
  }

  function say(t, secs) {
    banner = t;
    bannerT = secs;
  }

  /* ------------------------------------------------------------- physics */

  function surfaceAt(x, y) {
    let s = 'grass';
    for (const p of hole.patches) if (pointInRect(x, y, p)) s = p.type;
    return s;
  }

  function slopeAt(x, y, out) {
    out.x = 0;
    out.y = 0;
    for (const s of hole.slopes) {
      if (pointInRect(x, y, s)) {
        out.x += s.ax;
        out.y += s.ay;
      }
    }
  }

  /** One collision resolve pass against every solid rect. Returns hit count. */
  function collide(b, r, restitution, spark) {
    let hits = 0;
    for (const s of solids) {
      const h = circleRect(b.x, b.y, r, s.x, s.y, s.w, s.h);
      if (!h) continue;
      b.x += h.nx * h.depth;
      b.y += h.ny * h.depth;
      const vn = b.vx * h.nx + b.vy * h.ny;
      if (vn < 0) {
        const v = reflect(b.vx, b.vy, h.nx, h.ny, restitution);
        b.vx = v.x;
        b.vy = v.y;
        hits++;
        if (spark) bounceFx(b.x, b.y, h.nx, h.ny, Math.hypot(v.x, v.y));
      }
    }
    return hits;
  }

  /** Rotating blade collision, in the blade's own frame. */
  function collideMill(b, r, spark) {
    const m = hole.mill;
    if (!m) return 0;
    const l = unrotate(b.x, b.y, m.x, m.y, m.ang);
    const h = circleRect(l.x, l.y, r, -m.len, -m.thick / 2, m.len * 2, m.thick);
    if (!h) return 0;
    const c = Math.cos(m.ang);
    const s = Math.sin(m.ang);
    const nx = h.nx * c - h.ny * s;
    const ny = h.nx * s + h.ny * c;
    b.x += nx * h.depth;
    b.y += ny * h.depth;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      const v = reflect(b.vx, b.vy, nx, ny, 0.85);
      // The blade is moving, so it also flings the ball along its tangent.
      const rx = b.x - m.x;
      const ry = b.y - m.y;
      b.vx = v.x - ry * m.spd * 0.55;
      b.vy = v.y + rx * m.spd * 0.55;
      if (spark) {
        bounceFx(b.x, b.y, nx, ny, 260);
        api.sfx('brick', { vol: 0.7 });
        api.shakeScreen(4);
      }
      return 1;
    }
    return 0;
  }

  function bounceFx(x, y, nx, ny, speed) {
    const n = clamp(Math.round(speed / 60), 2, 7);
    api.particles.burst(x, y, n, {
      speed: 70, life: 0.3, size: 2, dir: Math.atan2(ny, nx), spread: 2,
      color: [PAL.white, PAL.yellow], glow: 8, drag: 3,
    });
  }

  function stepBall(b, dt, live) {
    const acc = { x: 0, y: 0 };
    slopeAt(b.x, b.y, acc);
    b.vx += acc.x * dt;
    b.vy += acc.y * dt;

    const surf = surfaceAt(b.x, b.y);
    let decel = SURF[surf].decel;
    if (live) {
      if (surf !== lastSurface) {
        if (surf === 'sand') api.sfx('splash', { vol: 0.55 });
        else if (surf === 'ice') api.sfx('freeze', { vol: 0.5 });
        lastSurface = surf;
      }
      // A long roll gets damped so a stroke can never stall the game.
      if (rollTime > 9) decel *= 5;
    }

    let sp = Math.hypot(b.vx, b.vy);
    if (sp > 0) {
      const drop = decel * dt;
      const ns = Math.max(0, sp - drop);
      b.vx = (b.vx / sp) * ns;
      b.vy = (b.vy / sp) * ns;
      sp = ns;
    }

    // Sub-step so a fast putt cannot tunnel through a rail.
    const steps = clamp(Math.ceil((sp * dt) / 2.6), 1, 12);
    const sdt = dt / steps;
    let bounces = 0;
    for (let i = 0; i < steps; i++) {
      b.x += b.vx * sdt;
      b.y += b.vy * sdt;
      bounces += collide(b, BALL_R, RESTITUTION, live);
      if (live) bounces += collideMill(b, BALL_R, true);
      if (live && bounces) api.sfx('bounce', { vol: 0.35 });
      if (bounces) break;
    }
    return { speed: Math.hypot(b.vx, b.vy), bounces };
  }

  /** Ghost simulation for the aim preview: same rails, no side effects. */
  function preview(vx, vy) {
    const b = { x: ball.x, y: ball.y, vx, vy };
    const pts = [{ x: b.x, y: b.y }];
    let bounces = 0;
    for (let i = 0; i < 130 && bounces < 3; i++) {
      const dt = 1 / 60;
      const acc = { x: 0, y: 0 };
      slopeAt(b.x, b.y, acc);
      b.vx += acc.x * dt;
      b.vy += acc.y * dt;
      const decel = SURF[surfaceAt(b.x, b.y)].decel;
      let sp = Math.hypot(b.vx, b.vy);
      if (sp <= REST_V) break;
      const ns = Math.max(0, sp - decel * dt);
      b.vx = (b.vx / sp) * ns;
      b.vy = (b.vy / sp) * ns;
      sp = ns;
      const steps = clamp(Math.ceil((sp * dt) / 2.6), 1, 8);
      const sdt = dt / steps;
      for (let s = 0; s < steps; s++) {
        b.x += b.vx * sdt;
        b.y += b.vy * sdt;
        const hit = collide(b, BALL_R, RESTITUTION, false);
        if (hit) {
          bounces += hit;
          pts.push({ x: b.x, y: b.y });
          break;
        }
      }
      if (i % 2 === 0) pts.push({ x: b.x, y: b.y });
    }
    pts.push({ x: b.x, y: b.y });
    return pts;
  }

  /* --------------------------------------------------------------- flow */

  function putt(vx, vy) {
    strokes++;
    strokeStart = { x: ball.x, y: ball.y };
    ball.vx = vx;
    ball.vy = vy;
    phase = 'roll';
    rollTime = 0;
    trail.length = 0;
    api.sfx('kick');
    api.vibrate(20);
    api.particles.burst(ball.x, ball.y, 8, {
      speed: 90, life: 0.3, size: 2, dir: Math.atan2(vy, vx) + Math.PI, spread: 1.4,
      color: [PAL.white, PAL.lime], glow: 8, drag: 3,
    });
    api.setStatus({ HOLE: (holeIdx + 1) + '/' + HOLES, PAR: hole.par, STROKES: strokes });
  }

  function sink() {
    phase = 'sunk';
    sinkT = 1.5;
    const pts = Math.max(0, hole.par + 4 - strokes) * 100;
    card[holeIdx] = { strokes, par: hole.par, pts };
    total += strokes;
    api.addScore(pts);
    api.sfx('coin');
    api.particles.burst(hole.cup.x, hole.cup.y, 26, {
      speed: 140, life: 0.9, size: 3, color: [PAL.lime, PAL.yellow, PAL.white],
      glow: 12, drag: 2,
    });
    api.particles.popText(hole.cup.x, hole.cup.y - 18, '+' + pts, PAL.yellow, 1.2);

    const rel = strokes - hole.par;
    let name = rel === 0 ? 'PAR' : rel === -1 ? 'BIRDIE' : rel === -2 ? 'EAGLE'
      : rel < -2 ? 'ALBATROSS' : rel === 1 ? 'BOGEY' : rel + ' OVER';
    if (strokes === 1) {
      aces++;
      name = 'HOLE IN ONE!';
      api.sfx('perfect');
      api.shakeScreen(9, 4);
      api.vibrate(160);
      for (let i = 0; i < 4; i++) {
        api.particles.burst(hole.cup.x, hole.cup.y, 14, {
          speed: 200 + i * 40, life: 1.1, size: 3.4,
          color: [PAL.magenta, PAL.cyan, PAL.yellow], glow: 14, drag: 1.6,
        });
      }
    } else if (rel <= -1) {
      api.sfx('levelup');
    }
    say(name, 2);
  }

  function pickUp() {
    // Stroke cap: bank a zero and move on so a run can't stall forever.
    phase = 'sunk';
    sinkT = 1.2;
    card[holeIdx] = { strokes, par: hole.par, pts: 0 };
    total += strokes;
    api.sfx('miss');
    say('PICKED UP', 2);
  }

  function nextHole() {
    if (holeIdx + 1 >= HOLES) {
      finishRound();
      return;
    }
    loadHole(holeIdx + 1);
  }

  function finishRound() {
    if (finished) return;
    finished = true;
    phase = 'done';
    const parTotal = card.reduce((a, c) => a + (c ? c.par : 0), 0);
    const rel = total - parTotal;
    api.sfx('victory');
    api.win({
      message: 'ROUND COMPLETE — ' + (rel === 0 ? 'LEVEL PAR' : (rel > 0 ? '+' : '') + rel),
      stats: {
        STROKES: total,
        PAR: parTotal,
        VS_PAR: (rel > 0 ? '+' : '') + rel,
        ACES: aces,
        CARD: card.map((c) => (c ? c.strokes : '-')).join(' '),
      },
    });
  }

  function resetBall() {
    if (phase === 'card') {
      cardT = 0;
      return;
    }
    if (phase !== 'aim' && phase !== 'roll') return;
    ball.x = strokeStart.x;
    ball.y = strokeStart.y;
    ball.vx = 0;
    ball.vy = 0;
    trail.length = 0;
    phase = 'aim';
    aiming = false;
    api.sfx('back');
    say('BALL REPLACED', 1.2);
  }

  /* ------------------------------------------------------------- drawing */

  function buildFelt() {
    // One-time pre-render: mown stripes plus grain, so the per-frame cost of
    // the playfield is a single drawImage.
    try {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#0a1a12';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#1d5c33';
      g.fillRect(FX, FY, FW, FH);
      const r2 = new RNG(20260731);
      for (let y = 0; y < FH; y += 14) {
        g.fillStyle = ((y / 14) | 0) % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.06)';
        g.fillRect(FX, FY + y, FW, 14);
      }
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = r2.chance(0.5) ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.06)';
        g.fillRect(FX + r2.range(0, FW) | 0, FY + r2.range(0, FH) | 0, 1, 1);
      }
      return c;
    } catch {
      return null;               // headless / no DOM: fall back to flat fill
    }
  }

  function drawWalls(ctx) {
    for (const s of solids) {
      ctx.fillStyle = '#2b1a10';
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(s.x, s.y, s.w, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(s.x, s.y + s.h - 2, s.w, 2);
      ctx.strokeStyle = alpha(PAL.orange, 0.35);
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
    }
  }

  function drawPatches(ctx) {
    for (const p of hole.patches) {
      ctx.save();
      if (p.type === 'sand') {
        ctx.fillStyle = SURF.sand.color;
        ctx.globalAlpha = 0.9;
        roundRect(ctx, p.x, p.y, p.w, p.h, 14);
        ctx.fill();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = '#8a6a34';
        ctx.lineWidth = 2;
        for (let i = 6; i < p.w; i += 12) {
          ctx.beginPath();
          ctx.moveTo(p.x + i, p.y + 4);
          ctx.lineTo(p.x + i - 4, p.y + p.h - 4);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = alpha(SURF.ice.color, 0.42);
        roundRect(ctx, p.x, p.y, p.w, p.h, 6);
        ctx.fill();
        ctx.strokeStyle = alpha('#d8f4ff', 0.6);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = '#eaffff';
        for (let i = 0; i < 3; i++) {
          const yy = p.y + 8 + i * (p.h / 3);
          ctx.beginPath();
          ctx.moveTo(p.x + 6, yy + 10);
          ctx.lineTo(p.x + p.w * 0.45, yy);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  function drawSlopes(ctx) {
    for (const s of hole.slopes) {
      const a = Math.atan2(s.ay, s.ax);
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = PAL.violet;
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = PAL.violet;
      ctx.lineWidth = 2;
      const step = 22;
      const t = (api.time * 26) % step;
      for (let y = s.y + 10; y < s.y + s.h - 4; y += step) {
        for (let x = s.x + 10; x < s.x + s.w - 4; x += step) {
          const ox = Math.cos(a) * t;
          const oy = Math.sin(a) * t;
          let px = x + ox;
          let py = y + oy;
          if (px > s.x + s.w - 4 || py > s.y + s.h - 4 || px < s.x + 2 || py < s.y + 2) {
            px = x;
            py = y;
          }
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(a);
          ctx.beginPath();
          ctx.moveTo(-4, -4);
          ctx.lineTo(2, 0);
          ctx.lineTo(-4, 4);
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.restore();
    }
  }

  function drawCup(ctx) {
    const c = hole.cup;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, CUP_R + 2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#04070c';
    ctx.beginPath();
    ctx.arc(c.x, c.y, CUP_R, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = alpha(PAL.white, 0.35);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Flag — the pole leans and the cloth ripples.
    const sway = Math.sin(api.time * 2.2) * 3;
    const topX = c.x + sway * 0.4;
    const topY = c.y - 34;
    ctx.strokeStyle = '#dfe9f5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(topX, topY);
    ctx.stroke();
    ctx.fillStyle = PAL.red;
    ctx.shadowColor = PAL.red;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.quadraticCurveTo(topX + 12, topY + 3 + sway, topX + 22, topY + 6);
    ctx.lineTo(topX, topY + 12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawMill(ctx) {
    const m = hole.mill;
    if (!m) return;
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(m.ang);
    ctx.fillStyle = '#3a2416';
    ctx.strokeStyle = alpha(PAL.orange, 0.8);
    ctx.lineWidth = 1.5;
    roundRect(ctx, -m.len, -m.thick / 2, m.len * 2, m.thick, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = alpha(PAL.yellow, 0.7);
    ctx.fillRect(-m.len + 3, -1, m.len * 2 - 6, 2);
    ctx.restore();
    ctx.save();
    ctx.fillStyle = '#1a2436';
    ctx.strokeStyle = PAL.orange;
    ctx.lineWidth = 2;
    ctx.shadowColor = PAL.orange;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 7, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawAim(ctx) {
    if (!aiming) return;
    const dx = ball.x - aimTo.x;
    const dy = ball.y - aimTo.y;
    const len = Math.hypot(dx, dy);
    if (len < 4) return;
    const p = clamp(len / DRAG_MAX, 0, 1);
    const ux = dx / len;
    const uy = dy / len;
    const speed = MIN_POWER + p * (MAX_POWER - MIN_POWER);

    // Predicted path with bounces.
    const pts = preview(ux * speed, uy * speed);
    ctx.save();
    ctx.strokeStyle = alpha(PAL.white, 0.5);
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    const end = pts[pts.length - 1];
    ctx.strokeStyle = alpha(PAL.cyan, 0.8);
    ctx.beginPath();
    ctx.arc(end.x, end.y, 5, 0, TAU);
    ctx.stroke();

    // Pull-back rubber band.
    ctx.strokeStyle = alpha(PAL.yellow, 0.85);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ball.x, ball.y);
    ctx.lineTo(ball.x - ux * Math.min(len, DRAG_MAX), ball.y - uy * Math.min(len, DRAG_MAX));
    ctx.stroke();

    // Direction arrow.
    ctx.fillStyle = mix(PAL.lime, PAL.red, p);
    ctx.shadowColor = mix(PAL.lime, PAL.red, p);
    ctx.shadowBlur = 8;
    ctx.save();
    ctx.translate(ball.x + ux * 26, ball.y + uy * 26);
    ctx.rotate(Math.atan2(uy, ux));
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, 5);
    ctx.lineTo(-5, -5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // Power meter, anchored bottom-left of the field.
    const mw = 108;
    const mx = FX + 6;
    const my = FY + FH - 14;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    roundRect(ctx, mx, my, mw, 9, 4);
    ctx.fill();
    ctx.fillStyle = mix(PAL.lime, PAL.red, p);
    roundRect(ctx, mx + 1.5, my + 1.5, (mw - 3) * p, 6, 3);
    ctx.fill();
    ctx.restore();
    text(ctx, 'POWER ' + Math.round(p * 100) + '%', mx + mw + 8, my + 1, {
      size: 8, color: PAL.white,
    });
  }

  function drawBall(ctx) {
    if (phase === 'sunk' && sinkT < 1.2) return;
    ctx.save();
    for (let i = 0; i < trail.length; i++) {
      const t = i / trail.length;
      ctx.globalAlpha = t * 0.35;
      ctx.fillStyle = PAL.white;
      ctx.beginPath();
      ctx.arc(trail[i].x, trail[i].y, BALL_R * (0.3 + t * 0.6), 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(ball.x + 1.5, ball.y + 2, BALL_R, BALL_R * 0.8, 0, 0, TAU);
    ctx.fill();
    ctx.shadowColor = PAL.white;
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = alpha('#8fc7ff', 0.9);
    ctx.beginPath();
    ctx.arc(ball.x - 1.4, ball.y - 1.4, BALL_R * 0.42, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (phase === 'aim' && !aiming) {
      // Grab hint ring.
      const pulse = 0.35 + 0.25 * Math.sin(api.time * 4);
      ctx.save();
      ctx.strokeStyle = alpha(PAL.lime, pulse);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, 14 + Math.sin(api.time * 4) * 1.5, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawHud(ctx) {
    ctx.fillStyle = 'rgba(6,12,10,0.9)';
    ctx.fillRect(0, 0, W, HUD_H);
    ctx.strokeStyle = alpha(PAL.lime, 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HUD_H + 0.5);
    ctx.lineTo(W, HUD_H + 0.5);
    ctx.stroke();

    text(ctx, 'HOLE ' + (holeIdx + 1) + '/' + HOLES, 10, 9, { size: 11, color: PAL.lime, glow: 6 });
    text(ctx, 'PAR ' + hole.par, 104, 10, { size: 10, color: PAL.white });
    text(ctx, 'STROKES ' + strokes, 158, 10, { size: 10, color: strokes > hole.par ? PAL.orange : PAL.white });

    const parSoFar = card.reduce((a, c) => a + (c ? c.par : 0), 0);
    const rel = total - parSoFar;
    const relTxt = card.some(Boolean) ? (rel === 0 ? 'E' : (rel > 0 ? '+' : '') + rel) : '—';
    text(ctx, 'TOTAL ' + total, W - 10, 4, { size: 9, color: PAL.dim, align: 'right' });
    text(ctx, 'VS PAR ' + relTxt, W - 10, 16, {
      size: 10, align: 'right',
      color: rel > 0 ? PAL.orange : rel < 0 ? PAL.lime : PAL.white,
    });

    // Mini strip of the card so far.
    for (let i = 0; i < HOLES; i++) {
      const x = 268 + i * 12;
      const c = card[i];
      ctx.fillStyle = i === holeIdx ? PAL.lime : c ? alpha(PAL.white, 0.5) : 'rgba(255,255,255,0.12)';
      ctx.fillRect(x, 20, 9, 4);
    }
  }

  function drawCard(ctx) {
    const bw = 300;
    const bh = 210;
    const bx = (W - bw) / 2;
    const by = (H - bh) / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(4,10,8,0.92)';
    roundRect(ctx, bx, by, bw, bh, 8);
    ctx.fill();
    ctx.strokeStyle = PAL.lime;
    ctx.lineWidth = 2;
    ctx.shadowColor = PAL.lime;
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.restore();

    text(ctx, 'SCORECARD', W / 2, by + 12, { size: 14, color: PAL.lime, align: 'center', glow: 8 });
    const cols = ['HOLE', 'PAR', 'SHOTS', 'PTS'];
    cols.forEach((c, i) => {
      text(ctx, c, bx + 26 + i * 70, by + 36, { size: 8, color: PAL.dim });
    });
    for (let i = 0; i < HOLES; i++) {
      const y = by + 50 + i * 16;
      const c = card[i];
      const on = !!c;
      text(ctx, String(i + 1), bx + 26, y, { size: 10, color: on ? PAL.white : PAL.dim });
      text(ctx, on ? String(c.par) : '-', bx + 96, y, { size: 10, color: on ? PAL.white : PAL.dim });
      const rel = on ? c.strokes - c.par : 0;
      text(ctx, on ? String(c.strokes) : '-', bx + 166, y, {
        size: 10,
        color: !on ? PAL.dim : rel < 0 ? PAL.lime : rel > 0 ? PAL.orange : PAL.white,
      });
      text(ctx, on ? String(c.pts) : '-', bx + 236, y, { size: 10, color: on ? PAL.yellow : PAL.dim });
    }
    const hint = holeIdx + 1 >= HOLES ? 'TAP TO FINISH' : 'TAP OR PRESS A FOR HOLE ' + (holeIdx + 2);
    text(ctx, hint, W / 2, by + bh - 16, {
      size: 9, color: alpha(PAL.white, 0.6 + 0.4 * Math.sin(api.time * 5)), align: 'center',
    });
  }

  /* --------------------------------------------------------- lifecycle */

  return {
    init() {
      rng = new RNG((api.rng.int(1, 0x7ffffff) ^ 0x5f3a) >>> 0);
      card = new Array(HOLES).fill(null);
      total = 0;
      aces = 0;
      finished = false;
      cardT = 0;
      banner = '';
      bannerT = 0;
      aimFrom = { x: 0, y: 0 };
      aimTo = { x: 0, y: 0 };
      felt = buildFelt();
      loadHole(0);
    },

    update(dt) {
      if (bannerT > 0) bannerT -= dt;
      if (hole.mill) hole.mill.ang += hole.mill.spd * dt;

      if (phase === 'roll') {
        rollTime += dt;
        const r = stepBall(ball, dt, true);

        // Trail sampling.
        trail.push({ x: ball.x, y: ball.y });
        if (trail.length > 16) trail.shift();
        if (r.speed > 120 && api.rng.chance(dt * 20)) {
          api.particles.emit({
            x: ball.x, y: ball.y, vx: -ball.vx * 0.05, vy: -ball.vy * 0.05,
            life: 0.3, size: 1.8, color: PAL.white, glow: 6, drag: 3,
          });
        }

        // Cup check — too fast and it lips out.
        const dc = Math.hypot(ball.x - hole.cup.x, ball.y - hole.cup.y);
        if (dc < CUP_R - 1.5) {
          if (r.speed < 250) {
            ball.x = hole.cup.x;
            ball.y = hole.cup.y;
            ball.vx = 0;
            ball.vy = 0;
            sink();
            return;
          }
          // Lip-out: kick it back across the rim.
          const nx = (ball.x - hole.cup.x) / (dc || 1);
          const ny = (ball.y - hole.cup.y) / (dc || 1);
          ball.vx += nx * 30;
          ball.vy += ny * 30;
          api.sfx('deny', { vol: 0.5 });
        }

        if (r.speed < REST_V) {
          ball.vx = 0;
          ball.vy = 0;
          trail.length = 0;
          const maxStrokes = hole.par + 6;
          if (strokes >= maxStrokes) pickUp();
          else phase = 'aim';
        }
        return;
      }

      if (phase === 'sunk') {
        sinkT -= dt;
        if (sinkT <= 0) {
          phase = 'card';
          cardT = 4.5;
        }
        return;
      }

      if (phase === 'card') {
        cardT -= dt;
        if (cardT <= 0) nextHole();
      }
    },

    handleInput(e) {
      if (e.type === 'press' && e.action === 'a') {
        if (phase === 'card') nextHole();
        else resetBall();
        return;
      }

      if (phase === 'card') {
        if (e.type === 'pointerdown') nextHole();
        return;
      }
      if (phase !== 'aim') return;

      if (e.type === 'pointerdown') {
        const d = Math.hypot(e.x - ball.x, e.y - ball.y);
        if (d > GRAB_R) return;
        aiming = true;
        aimFrom = { x: e.x, y: e.y };
        aimTo = { x: e.x, y: e.y };
        api.sfx('blip', { vol: 0.4 });
        return;
      }

      if (e.type === 'pointermove' && aiming) {
        aimTo = { x: e.x, y: e.y };
        return;
      }

      if (e.type === 'pointerup' && aiming) {
        aiming = false;
        aimTo = { x: e.x, y: e.y };
        const dx = ball.x - aimTo.x;
        const dy = ball.y - aimTo.y;
        const len = Math.hypot(dx, dy);
        if (len < 10) {
          api.sfx('deny', { vol: 0.4 });
          return;
        }
        const p = clamp(len / DRAG_MAX, 0, 1);
        const speed = MIN_POWER + p * (MAX_POWER - MIN_POWER);
        putt((dx / len) * speed, (dy / len) * speed);
      }
    },

    render(ctx) {
      /* ---- course ---- */
      if (felt) {
        ctx.drawImage(felt, 0, 0);
      } else {
        ctx.fillStyle = '#0a1a12';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#1d5c33';
        ctx.fillRect(FX, FY, FW, FH);
      }

      drawPatches(ctx);
      drawSlopes(ctx);
      drawCup(ctx);
      drawWalls(ctx);
      drawMill(ctx);
      drawAim(ctx);
      drawBall(ctx);
      api.particles.render(ctx);
      drawHud(ctx);

      if (bannerT > 0 && banner) {
        ctx.save();
        ctx.globalAlpha = clamp(bannerT, 0, 1);
        const bw = Math.max(140, banner.length * 10 + 24);
        ctx.fillStyle = 'rgba(4,10,8,0.82)';
        roundRect(ctx, W / 2 - bw / 2, FY + 10, bw, 28, 6);
        ctx.fill();
        ctx.strokeStyle = alpha(PAL.lime, 0.7);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        text(ctx, banner, W / 2, FY + 24, {
          size: 13, color: PAL.white, align: 'center', baseline: 'middle', glow: 8,
        });
        ctx.restore();
      }

      if (phase === 'card') drawCard(ctx);
    },
  };
}
