/**
 * 11 — ASTEROID MINER & DRIFT
 * Newtonian zero-g prospecting. Momentum never stops, the belt wraps around a
 * torus world larger than the screen, and every rock you crack spills ore you
 * have to physically fly into. The hold only takes so much and the oxygen tank
 * only lasts so long — the whole game is deciding when to stop being greedy and
 * run for the beacon.
 */

import { PAL, TAU, alpha, clamp, mix, text, roundRect, RNG } from '../core/fx.js';

/* ----------------------------------------------------------------- world */

const VIEW = { w: 480, h: 360 };
const WW = 1280;               // toroidal world, bigger than the viewport
const WH = 960;

const SHIP_R = 9;
const TURN = 3.2;              // rad/s
const THRUST = 205;            // px/s^2
const DRAG = 0.055;            // a whisper of drag so a stray tap is recoverable
const MAXV = 340;
const BULLET_V = 300;
const BULLET_LIFE = 1.15;
const FIRE_CD = 0.19;

const CARGO_MAX = 8;
const O2_MAX = 100;
const HULL_MAX = 3;
const DOCK_R = 40;
const DOCK_SPEED = 70;

const SIZES = {
  3: { r: 30, score: 20, ore: 3, hp: 3 },
  2: { r: 19, score: 35, ore: 2, hp: 2 },
  1: { r: 11, score: 55, ore: 2, hp: 1 },
};

/* --------------------------------------------------------------- helpers */

/** Shortest delta across the wrapping world. */
function wrapD(d, span) {
  const h = span / 2;
  if (d > h) return d - span;
  if (d < -h) return d + span;
  return d;
}
const wrapX = (d) => wrapD(d, WW);
const wrapY = (d) => wrapD(d, WH);

function wrapPos(o) {
  if (o.x < 0) o.x += WW; else if (o.x >= WW) o.x -= WW;
  if (o.y < 0) o.y += WH; else if (o.y >= WH) o.y -= WH;
}

/** Irregular rock outline: n vertices with jittered radii. */
function rockVerts(rng, n, rough) {
  const v = [];
  for (let i = 0; i < n; i++) v.push(rng.range(1 - rough, 1 + rough));
  return v;
}

function drawRock(ctx, verts, r, rot, stroke, fill) {
  ctx.beginPath();
  for (let i = 0; i < verts.length; i++) {
    const a = rot + (i / verts.length) * TAU;
    const rad = r * verts[i];
    const px = Math.cos(a) * rad;
    const py = Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function shipPath(ctx, r) {
  ctx.beginPath();
  ctx.moveTo(r * 1.5, 0);
  ctx.lineTo(-r * 0.75, r * 0.95);
  ctx.lineTo(-r * 0.35, 0);
  ctx.lineTo(-r * 0.75, -r * 0.95);
  ctx.closePath();
}

/* ------------------------------------------------------------------- meta */

export const meta = {
  id: 'asteroids',
  title: 'ASTEROID MINER & DRIFT',
  short: 'AST. MINER',
  category: 'SHOOTER',
  desc: 'Zero-g prospecting with real momentum: crack rocks, scoop the ore they '
      + 'spill, and get back to the beacon before the oxygen runs out. The hold '
      + 'is small and the belt does not care.',
  accent: PAL.orange,
  view: VIEW,
  controls: [
    'LEFT / RIGHT — rotate',
    'UP / A — main thruster',
    'SPACE / B — fire',
  ],
  touch: {
    buttons: [
      { id: 'left', label: '◀' }, { id: 'right', label: '▶' },
      { id: 'a', label: 'THRUST' }, { id: 'b', label: 'FIRE' },
    ],
  },
  art(ctx, w, h, accent) {
    const rng = new RNG(4242);
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = alpha(PAL.white, rng.range(0.15, 0.7));
      ctx.fillRect(rng.range(0, w) | 0, rng.range(0, h) | 0, 1, 1);
    }
    ctx.save();
    ctx.lineWidth = 2;
    // two rocks
    ctx.translate(58, 54);
    ctx.rotate(0.4);
    drawRock(ctx, rockVerts(rng, 10, 0.28), 30, 0, PAL.dim, '#141c2e');
    ctx.restore();
    ctx.save();
    ctx.translate(w - 56, h - 52);
    ctx.rotate(-0.7);
    ctx.lineWidth = 2;
    drawRock(ctx, rockVerts(rng, 9, 0.3), 22, 0, PAL.dim, '#141c2e');
    ctx.restore();

    // ore sparks
    for (let i = 0; i < 5; i++) {
      const x = 96 + i * 14;
      const y = 96 - i * 6;
      ctx.fillStyle = PAL.yellow;
      ctx.shadowColor = PAL.yellow;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, TAU);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // ship with flame
    ctx.save();
    ctx.translate(w / 2 + 18, h / 2 + 6);
    ctx.rotate(-0.55);
    ctx.fillStyle = alpha(PAL.orange, 0.9);
    ctx.shadowColor = PAL.orange;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(-14, 6);
    ctx.lineTo(-40, 0);
    ctx.lineTo(-14, -6);
    ctx.closePath();
    ctx.fill();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.fillStyle = '#0b1226';
    shipPath(ctx, 16);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  },
};

/* ------------------------------------------------------------------ game */

export function create(api) {
  const W = api.w;
  const H = api.h;

  let ship, bullets, rocks, ore, shards, drones, dbullets, stars;
  let station;
  let cargo, oxygen, hull, wave, sold, wrecked;
  let fireCd, invuln, dead, dockGlow, docked, warnT;
  let droneTimer;
  let msg, msgT;
  let flash;

  /* ------------------------------------------------------------- spawning */

  function spawnRock(size, x, y, vx, vy) {
    const s = SIZES[size];
    rocks.push({
      x, y, vx, vy, size, r: s.r,
      rot: api.rng.angle(),
      spin: api.rng.range(-1.4, 1.4),
      verts: rockVerts(api.rng, api.rng.int(8, 12), 0.32),
      hp: s.hp,
      hit: 0,
      tint: api.rng.chance(0.28) ? PAL.violet : null,   // ore-rich rock
    });
  }

  function spawnField(n) {
    for (let i = 0; i < n; i++) {
      // Keep the belt away from the ship's immediate space.
      let x = 0;
      let y = 0;
      for (let t = 0; t < 20; t++) {
        x = api.rng.range(0, WW);
        y = api.rng.range(0, WH);
        const d = Math.hypot(wrapX(x - ship.x), wrapY(y - ship.y));
        const ds = Math.hypot(wrapX(x - station.x), wrapY(y - station.y));
        if (d > 150 && ds > 110) break;
      }
      const a = api.rng.angle();
      const sp = api.rng.range(10, 34);
      spawnRock(3, x, y, Math.cos(a) * sp, Math.sin(a) * sp);
    }
  }

  function spawnOre(x, y, n, rich) {
    for (let i = 0; i < n; i++) {
      const a = api.rng.angle();
      const sp = api.rng.range(18, 62);
      ore.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 26, r: 4.5, ph: api.rng.angle(),
        value: rich ? 2 : 1,
      });
    }
    if (ore.length > 60) ore.splice(0, ore.length - 60);
  }

  function spawnShards(x, y, r, n, color) {
    for (let i = 0; i < n; i++) {
      const a = api.rng.angle();
      const sp = api.rng.range(40, 130);
      shards.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        rot: api.rng.angle(), spin: api.rng.range(-6, 6),
        len: api.rng.range(r * 0.25, r * 0.7), life: api.rng.range(0.5, 1.1),
        max: 1.1, color,
      });
    }
    if (shards.length > 90) shards.splice(0, shards.length - 90);
  }

  function spawnDrone() {
    let x = 0;
    let y = 0;
    for (let t = 0; t < 12; t++) {
      x = api.rng.range(0, WW);
      y = api.rng.range(0, WH);
      if (Math.hypot(wrapX(x - ship.x), wrapY(y - ship.y)) > 240) break;
    }
    drones.push({ x, y, vx: 0, vy: 0, a: 0, hp: 3, cd: 1.6, hit: 0 });
    api.sfx('alert');
    say('HOSTILE DRONE INBOUND', PAL.red);
  }

  function say(t, color) {
    msg = t;
    msgT = 2.4;
    flash = color || PAL.cyan;
  }

  /* ------------------------------------------------------------ mechanics */

  function damage(n, sx, sy) {
    if (invuln > 0 || dead) return;
    hull -= n;
    invuln = 1.6;
    api.sfx('hurt');
    api.shakeScreen(9, 5);
    api.vibrate(90);
    api.particles.burst(sx, sy, 14, {
      speed: 150, life: 0.5, size: 3, color: [PAL.red, PAL.orange, PAL.white],
      glow: 10, drag: 2,
    });
    if (hull <= 0) endRun('HULL BREACH');
    else {
      say('HULL ' + hull + '/' + HULL_MAX, PAL.red);
      updateStatus();
    }
  }

  function endRun(reason) {
    if (dead) return;
    dead = true;
    api.shakeScreen(16, 4);
    api.sfx('explosion');
    api.vibrate(200);
    const sx = W / 2;
    const sy = H / 2;
    api.particles.burst(sx, sy, 34, {
      speed: 220, life: 1.1, size: 4, color: [PAL.orange, PAL.yellow, PAL.white, PAL.red],
      glow: 14, drag: 1.4,
    });
    api.gameOver({
      message: reason,
      stats: {
        WAVE: wave, ORE_SOLD: sold, WRECKS: wrecked,
        CARGO_LOST: cargo, TIME: api.time.toFixed(0) + 'S',
      },
    });
  }

  function breakRock(rk, bx, by) {
    wrecked++;
    const s = SIZES[rk.size];
    api.addScore(s.score);
    api.sfx(rk.size === 3 ? 'explosion' : 'boom', { vol: 0.8 });
    api.shakeScreen(rk.size * 2.5);
    const color = rk.tint ? PAL.violet : PAL.dim;
    spawnShards(rk.x, rk.y, rk.r, 5 + rk.size * 2, rk.tint || '#9fb4d8');
    api.particles.burst(bx, by, 10 + rk.size * 3, {
      speed: 120, life: 0.55, size: 2.6, color: [color, PAL.white], glow: 9, drag: 2.2,
    });
    spawnOre(rk.x, rk.y, s.ore + (rk.tint ? 2 : 0), !!rk.tint);

    if (rk.size > 1) {
      // Two children, pushed apart perpendicular to the killing blow.
      const base = Math.atan2(rk.vy, rk.vx) + api.rng.range(-0.4, 0.4);
      for (let i = 0; i < 2; i++) {
        const a = base + (i ? 1 : -1) * api.rng.range(0.5, 1.1);
        const sp = api.rng.range(30, 70);
        spawnRock(rk.size - 1, rk.x, rk.y,
          rk.vx + Math.cos(a) * sp, rk.vy + Math.sin(a) * sp);
        rocks[rocks.length - 1].tint = rk.tint;
      }
    }
    rocks.splice(rocks.indexOf(rk), 1);
  }

  function dock() {
    const gained = cargo;
    if (gained > 0) {
      const bonus = gained >= CARGO_MAX ? 1.6 : 1;
      const pts = Math.round(gained * 45 * bonus + wave * 10);
      api.addScore(pts);
      api.particles.popText(W / 2, H / 2 - 40, '+' + pts, PAL.yellow, 1.3);
      sold += gained;
      api.sfx('coin');
      if (bonus > 1) {
        api.sfx('combo');
        api.particles.popText(W / 2, H / 2 - 58, 'FULL HOLD x1.6', PAL.lime, 1.4);
      }
      say('OFFLOADED ' + gained + ' ORE', PAL.lime);
    } else {
      say('TANKS TOPPED UP', PAL.cyan);
    }
    cargo = 0;
    oxygen = O2_MAX;
    if (hull < HULL_MAX && gained >= 4) {
      hull++;
      say('HULL PATCHED', PAL.lime);
    }
    api.sfx('powerup');
    api.particles.burst(W / 2, H / 2, 20, {
      speed: 130, life: 0.8, size: 3, color: [PAL.cyan, PAL.white], glow: 12, drag: 2,
    });
    updateStatus();
  }

  function fire() {
    if (fireCd > 0 || dead) return;
    fireCd = FIRE_CD;
    const c = Math.cos(ship.a);
    const s = Math.sin(ship.a);
    bullets.push({
      x: ship.x + c * SHIP_R * 1.4, y: ship.y + s * SHIP_R * 1.4,
      vx: ship.vx + c * BULLET_V, vy: ship.vy + s * BULLET_V,
      life: BULLET_LIFE,
    });
    // Recoil is small but real — everything here obeys momentum.
    ship.vx -= c * 12;
    ship.vy -= s * 12;
    api.sfx('laser', { vol: 0.5 });
    api.particles.emit({
      x: ship.x + c * SHIP_R, y: ship.y + s * SHIP_R,
      vx: c * 40, vy: s * 40, life: 0.16, size: 2.5, color: PAL.cyan, glow: 8,
    });
  }

  function updateStatus() {
    api.setStatus({ WAVE: wave, HULL: hull, ORE: cargo + '/' + CARGO_MAX });
  }

  /* ------------------------------------------------------------ rendering */

  const sx = (x) => wrapX(x - ship.x) + W / 2;
  const sy = (y) => wrapY(y - ship.y) + H / 2;
  const onScreen = (px, py, m) => px > -m && px < W + m && py > -m && py < H + m;

  function drawStation(ctx) {
    const px = sx(station.x);
    const py = sy(station.y);
    if (!onScreen(px, py, 60)) return;
    const t = api.time;
    ctx.save();
    ctx.translate(px, py);

    // Docking halo, brighter as you line up.
    const near = Math.hypot(wrapX(station.x - ship.x), wrapY(station.y - ship.y));
    const glow = clamp(1 - (near - DOCK_R) / 180, 0.15, 1);
    ctx.strokeStyle = alpha(cargo >= CARGO_MAX ? PAL.lime : PAL.cyan, 0.18 + glow * 0.5);
    ctx.lineWidth = 2;
    ctx.shadowColor = cargo >= CARGO_MAX ? PAL.lime : PAL.cyan;
    ctx.shadowBlur = 12 * glow;
    ctx.beginPath();
    ctx.arc(0, 0, DOCK_R + Math.sin(t * 2.4) * 3, 0, TAU);
    ctx.stroke();

    ctx.rotate(t * 0.5);
    ctx.strokeStyle = PAL.cyan;
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 10;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 9, Math.sin(a) * 9);
      ctx.lineTo(Math.cos(a) * 24, Math.sin(a) * 24);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, TAU);
    ctx.stroke();
    ctx.rotate(-t * 1.4);
    ctx.fillStyle = '#0d1830';
    ctx.strokeStyle = PAL.white;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const px2 = Math.cos(a) * 11;
      const py2 = Math.sin(a) * 11;
      if (i === 0) ctx.moveTo(px2, py2);
      else ctx.lineTo(px2, py2);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    text(ctx, 'DOCK', px, py + DOCK_R + 8, {
      size: 7, color: alpha(PAL.cyan, 0.7), align: 'center',
    });
  }

  function drawShip(ctx) {
    if (dead) return;
    const px = W / 2;
    const py = H / 2;
    if (invuln > 0 && Math.floor(invuln * 14) % 2 === 0) return;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ship.a);
    ctx.lineJoin = 'round';

    if (ship.thrusting) {
      // Flame tongue, length flickers per frame.
      const f = 1 + Math.random() * 0.5;
      ctx.beginPath();
      ctx.moveTo(-SHIP_R * 0.6, SHIP_R * 0.45);
      ctx.lineTo(-SHIP_R * (1.3 + f), 0);
      ctx.lineTo(-SHIP_R * 0.6, -SHIP_R * 0.45);
      ctx.closePath();
      ctx.fillStyle = alpha(PAL.orange, 0.85);
      ctx.shadowColor = PAL.orange;
      ctx.shadowBlur = 14;
      ctx.fill();
    }

    ctx.shadowColor = PAL.cyan;
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#0a1428';
    ctx.strokeStyle = invuln > 0 ? PAL.white : PAL.cyan;
    ctx.lineWidth = 2;
    shipPath(ctx, SHIP_R);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = PAL.magenta;
    ctx.shadowColor = PAL.magenta;
    ctx.beginPath();
    ctx.arc(SHIP_R * 0.25, 0, 2.4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawGauges(ctx) {
    const pad = 8;
    // Oxygen.
    const ow = 108;
    const of = oxygen / O2_MAX;
    const ocol = of > 0.45 ? PAL.cyan : of > 0.2 ? PAL.yellow : PAL.red;
    text(ctx, 'O2', pad, pad + 1, { size: 8, color: PAL.dim });
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(pad + 18, pad, ow, 7);
    ctx.save();
    ctx.shadowColor = ocol;
    ctx.shadowBlur = of < 0.25 ? 10 + Math.sin(api.time * 12) * 6 : 6;
    ctx.fillStyle = ocol;
    ctx.fillRect(pad + 18, pad, ow * of, 7);
    ctx.restore();
    ctx.strokeStyle = alpha(PAL.white, 0.2);
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + 18.5, pad + 0.5, ow, 7);

    // Cargo.
    text(ctx, 'ORE', pad, pad + 13, { size: 8, color: PAL.dim });
    const cw = ow / CARGO_MAX;
    for (let i = 0; i < CARGO_MAX; i++) {
      const x = pad + 18 + i * cw;
      if (i < cargo) {
        ctx.fillStyle = cargo >= CARGO_MAX ? PAL.lime : PAL.yellow;
        ctx.fillRect(x + 1, pad + 12, cw - 2, 7);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(x + 1, pad + 12, cw - 2, 7);
      }
    }

    // Hull pips.
    for (let i = 0; i < HULL_MAX; i++) {
      const x = pad + 18 + i * 14;
      ctx.save();
      ctx.strokeStyle = i < hull ? PAL.lime : alpha(PAL.red, 0.5);
      ctx.fillStyle = alpha(PAL.lime, 0.5);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + 5, pad + 24);
      ctx.lineTo(x + 10, pad + 27);
      ctx.lineTo(x + 5, pad + 33);
      ctx.lineTo(x, pad + 27);
      ctx.closePath();
      if (i < hull) ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    text(ctx, 'HULL', pad, pad + 25, { size: 8, color: PAL.dim });
  }

  function drawMinimap(ctx) {
    const mw = 88;
    const mh = mw * (WH / WW);
    const mx = W - mw - 8;
    const my = 8;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = 'rgba(6,12,24,0.72)';
    roundRect(ctx, mx, my, mw, mh, 4);
    ctx.fill();
    ctx.strokeStyle = alpha(PAL.cyan, 0.35);
    ctx.lineWidth = 1;
    ctx.stroke();
    const px = (x) => mx + (x / WW) * mw;
    const py = (y) => my + (y / WH) * mh;
    for (const r of rocks) {
      ctx.fillStyle = r.tint ? alpha(PAL.violet, 0.9) : 'rgba(150,170,200,0.75)';
      const s = r.size === 3 ? 2.2 : r.size === 2 ? 1.6 : 1.1;
      ctx.fillRect(px(r.x) - s / 2, py(r.y) - s / 2, s, s);
    }
    for (const d of drones) {
      ctx.fillStyle = PAL.red;
      ctx.fillRect(px(d.x) - 1.5, py(d.y) - 1.5, 3, 3);
    }
    ctx.fillStyle = PAL.cyan;
    ctx.shadowColor = PAL.cyan;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(px(station.x), py(station.y), 2.6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = PAL.lime;
    ctx.shadowColor = PAL.lime;
    ctx.fillRect(px(ship.x) - 1.5, py(ship.y) - 1.5, 3, 3);
    ctx.restore();
  }

  function drawStationArrow(ctx) {
    const px = sx(station.x);
    const py = sy(station.y);
    if (onScreen(px, py, 40)) return;
    const dx = px - W / 2;
    const dy = py - H / 2;
    const a = Math.atan2(dy, dx);
    const m = 42;
    // Project the direction onto the inset screen border.
    const t = Math.min(
      Math.abs((W / 2 - m) / (Math.cos(a) || 1e-6)),
      Math.abs((H / 2 - m) / (Math.sin(a) || 1e-6)),
    );
    const ax = W / 2 + Math.cos(a) * t;
    const ay = H / 2 + Math.sin(a) * t;
    const d = Math.hypot(dx, dy);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(a);
    const pulse = 0.6 + 0.4 * Math.sin(api.time * 5);
    ctx.fillStyle = alpha(cargo >= CARGO_MAX ? PAL.lime : PAL.cyan, pulse);
    ctx.shadowColor = cargo >= CARGO_MAX ? PAL.lime : PAL.cyan;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-7, 7);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-7, -7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    text(ctx, (d | 0) + 'm', ax, ay + 12, {
      size: 7, color: alpha(PAL.white, 0.6), align: 'center',
    });
  }

  /* --------------------------------------------------------- lifecycle */

  return {
    init() {
      ship = { x: WW / 2, y: WH / 2, vx: 0, vy: 0, a: -Math.PI / 2, thrusting: false };
      station = { x: WW / 2, y: WH / 2 - 120 };
      bullets = [];
      rocks = [];
      ore = [];
      shards = [];
      drones = [];
      dbullets = [];
      cargo = 0;
      oxygen = O2_MAX;
      hull = HULL_MAX;
      wave = 1;
      sold = 0;
      wrecked = 0;
      fireCd = 0;
      invuln = 1.2;
      dead = false;
      dockGlow = 0;
      docked = true;          // you start parked on the beacon
      warnT = 0;
      droneTimer = 26;
      msg = 'MINE THE BELT — DOCK TO SELL';
      msgT = 3;
      flash = PAL.cyan;

      // A fixed starfield in world space, wrapped by the same camera maths.
      const rng = new RNG(1337);
      stars = [];
      for (let i = 0; i < 260; i++) {
        stars.push({
          x: rng.range(0, WW), y: rng.range(0, WH),
          z: rng.range(0.3, 1), tw: rng.angle(),
        });
      }

      spawnField(9);
      updateStatus();
    },

    update(dt) {
      if (dead) return;

      /* ---- ship ---- */
      const turn = api.input.axis('left', 'right');
      ship.a += turn * TURN * dt;
      ship.thrusting = api.input.isDown('a') || api.input.isDown('up');
      if (ship.thrusting) {
        ship.vx += Math.cos(ship.a) * THRUST * dt;
        ship.vy += Math.sin(ship.a) * THRUST * dt;
        // Exhaust plume: emitted in world space then drawn camera-relative.
        const bx = ship.x - Math.cos(ship.a) * SHIP_R;
        const by = ship.y - Math.sin(ship.a) * SHIP_R;
        api.particles.emit({
          x: sx(bx), y: sy(by),
          vx: -Math.cos(ship.a) * api.rng.range(40, 110) + (Math.random() - 0.5) * 30,
          vy: -Math.sin(ship.a) * api.rng.range(40, 110) + (Math.random() - 0.5) * 30,
          life: api.rng.range(0.18, 0.42), size: api.rng.range(1.6, 3.4),
          color: api.rng.chance(0.4) ? PAL.yellow : PAL.orange,
          glow: 8, drag: 2.2, shrink: 4,
        });
        if (api.rng.chance(dt * 8)) api.sfx('thrust', { vol: 0.22 });
      }
      const sp = Math.hypot(ship.vx, ship.vy);
      if (sp > MAXV) {
        ship.vx *= MAXV / sp;
        ship.vy *= MAXV / sp;
      }
      const df = Math.exp(-DRAG * dt);
      ship.vx *= df;
      ship.vy *= df;
      ship.x += ship.vx * dt;
      ship.y += ship.vy * dt;
      wrapPos(ship);

      if (fireCd > 0) fireCd -= dt;
      if (invuln > 0) invuln -= dt;
      if (msgT > 0) msgT -= dt;
      if (api.input.isDown('b')) fire();

      /* ---- life support ---- */
      oxygen -= (1.7 + (ship.thrusting ? 1.1 : 0)) * dt;
      if (oxygen < 25) {
        warnT -= dt;
        if (warnT <= 0) {
          warnT = oxygen < 12 ? 0.45 : 0.9;
          api.sfx('alert', { vol: 0.45 });
        }
      }
      if (oxygen <= 0) {
        oxygen = 0;
        endRun('OXYGEN DEPLETED');
        return;
      }

      /* ---- docking ---- */
      const dSt = Math.hypot(wrapX(station.x - ship.x), wrapY(station.y - ship.y));
      dockGlow = clamp(1 - dSt / 220, 0, 1);
      if (dSt < DOCK_R && sp < DOCK_SPEED) {
        if (!docked) {
          docked = true;
          dock();
        }
        oxygen = O2_MAX;             // the beacon keeps topping you up while parked
      } else if (dSt > DOCK_R * 1.35) {
        docked = false;
      }

      /* ---- bullets ---- */
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.life -= dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        wrapPos(b);
        if (b.life <= 0) {
          bullets.splice(i, 1);
          continue;
        }
        let hitSomething = false;
        for (let j = rocks.length - 1; j >= 0; j--) {
          const r = rocks[j];
          const dx = wrapX(r.x - b.x);
          const dy = wrapY(r.y - b.y);
          if (dx * dx + dy * dy > r.r * r.r) continue;
          r.hp--;
          r.hit = 0.14;
          hitSomething = true;
          api.particles.burst(sx(b.x), sy(b.y), 4, {
            speed: 70, life: 0.25, size: 2, color: PAL.white, glow: 8, drag: 3,
          });
          if (r.hp <= 0) breakRock(r, b.x, b.y);
          else api.sfx('hit', { vol: 0.4 });
          break;
        }
        if (!hitSomething) {
          for (let j = drones.length - 1; j >= 0; j--) {
            const d = drones[j];
            const dx = wrapX(d.x - b.x);
            const dy = wrapY(d.y - b.y);
            if (dx * dx + dy * dy > 144) continue;
            d.hp--;
            d.hit = 0.15;
            hitSomething = true;
            api.sfx('hit');
            if (d.hp <= 0) {
              api.addScore(150);
              api.particles.popText(sx(d.x), sy(d.y), '+150', PAL.lime);
              api.particles.burst(sx(d.x), sy(d.y), 22, {
                speed: 170, life: 0.7, size: 3, color: [PAL.red, PAL.orange, PAL.white],
                glow: 12, drag: 1.8,
              });
              spawnShards(d.x, d.y, 14, 8, PAL.red);
              spawnOre(d.x, d.y, 3, true);
              api.sfx('explosion');
              api.shakeScreen(8);
              drones.splice(j, 1);
            }
            break;
          }
        }
        if (hitSomething) bullets.splice(i, 1);
      }

      /* ---- rocks ---- */
      for (const r of rocks) {
        r.x += r.vx * dt;
        r.y += r.vy * dt;
        r.rot += r.spin * dt;
        if (r.hit > 0) r.hit -= dt;
        wrapPos(r);
        const dx = wrapX(r.x - ship.x);
        const dy = wrapY(r.y - ship.y);
        const rr = r.r + SHIP_R * 0.8;
        if (dx * dx + dy * dy < rr * rr && invuln <= 0) {
          // Elastic-ish shove so you get knocked off course, not stuck inside.
          const d = Math.hypot(dx, dy) || 1;
          const nx = dx / d;
          const ny = dy / d;
          ship.vx -= nx * 110;
          ship.vy -= ny * 110;
          r.vx += nx * 30;
          r.vy += ny * 30;
          damage(1, W / 2, H / 2);
          if (dead) return;
        }
      }

      if (!rocks.length) {
        wave++;
        oxygen = Math.min(O2_MAX, oxygen + 25);
        api.addScore(120 + wave * 30);
        api.sfx('levelup');
        say('BELT CLEARED — WAVE ' + wave, PAL.lime);
        spawnField(Math.min(16, 8 + wave));
        updateStatus();
      }

      /* ---- ore ---- */
      for (let i = ore.length - 1; i >= 0; i--) {
        const o = ore[i];
        o.life -= dt;
        o.ph += dt * 4;
        const dx = wrapX(o.x - ship.x);
        const dy = wrapY(o.y - ship.y);
        const d = Math.hypot(dx, dy) || 1;
        if (d < 90 && cargo < CARGO_MAX) {
          // Gentle tractor pull once you are close enough.
          const pull = (1 - d / 90) * 220 * dt;
          o.vx -= (dx / d) * pull;
          o.vy -= (dy / d) * pull;
        }
        o.vx *= Math.exp(-0.35 * dt);
        o.vy *= Math.exp(-0.35 * dt);
        o.x += o.vx * dt;
        o.y += o.vy * dt;
        wrapPos(o);
        if (d < SHIP_R + o.r + 2) {
          if (cargo >= CARGO_MAX) continue;    // hold is full: it stays out there
          cargo = Math.min(CARGO_MAX, cargo + o.value);
          ore.splice(i, 1);
          api.sfx('pickup', { detune: cargo });
          api.particles.burst(W / 2, H / 2, 6, {
            speed: 60, life: 0.35, size: 2, color: PAL.yellow, glow: 10, drag: 3,
          });
          if (cargo >= CARGO_MAX) {
            say('HOLD FULL — RETURN TO DOCK', PAL.lime);
            api.sfx('powerup');
          }
          updateStatus();
          continue;
        }
        if (o.life <= 0) ore.splice(i, 1);
      }

      /* ---- shards ---- */
      for (let i = shards.length - 1; i >= 0; i--) {
        const s = shards[i];
        s.life -= dt;
        if (s.life <= 0) {
          shards.splice(i, 1);
          continue;
        }
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vx *= Math.exp(-0.8 * dt);
        s.vy *= Math.exp(-0.8 * dt);
        s.rot += s.spin * dt;
        wrapPos(s);
      }

      /* ---- drones ---- */
      droneTimer -= dt;
      if (droneTimer <= 0 && drones.length < 2) {
        droneTimer = 34 - Math.min(16, wave * 2);
        spawnDrone();
      }
      for (const d of drones) {
        const dx = wrapX(ship.x - d.x);
        const dy = wrapY(ship.y - d.y);
        const dd = Math.hypot(dx, dy) || 1;
        d.a = Math.atan2(dy, dx);
        const acc = 78;
        d.vx += (dx / dd) * acc * dt;
        d.vy += (dy / dd) * acc * dt;
        const dsp = Math.hypot(d.vx, d.vy);
        if (dsp > 130) {
          d.vx *= 130 / dsp;
          d.vy *= 130 / dsp;
        }
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        wrapPos(d);
        if (d.hit > 0) d.hit -= dt;
        d.cd -= dt;
        if (d.cd <= 0 && dd < 300) {
          d.cd = 1.5;
          dbullets.push({
            x: d.x, y: d.y,
            vx: (dx / dd) * 165, vy: (dy / dd) * 165, life: 2.2,
          });
          api.sfx('shoot', { vol: 0.35 });
        }
        if (dd < SHIP_R + 11 && invuln <= 0) {
          damage(1, W / 2, H / 2);
          d.vx = -d.vx;
          d.vy = -d.vy;
          if (dead) return;
        }
      }

      for (let i = dbullets.length - 1; i >= 0; i--) {
        const b = dbullets[i];
        b.life -= dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        wrapPos(b);
        const dx = wrapX(b.x - ship.x);
        const dy = wrapY(b.y - ship.y);
        if (dx * dx + dy * dy < (SHIP_R + 3) * (SHIP_R + 3)) {
          dbullets.splice(i, 1);
          damage(1, W / 2, H / 2);
          if (dead) return;
          continue;
        }
        if (b.life <= 0) dbullets.splice(i, 1);
      }
    },

    handleInput(e) {
      if (e.type === 'press' && e.action === 'b') fire();
    },

    render(ctx) {
      /* ---- deep space ---- */
      ctx.fillStyle = '#04060e';
      ctx.fillRect(0, 0, W, H);

      // Parallax-free but wrapped starfield: same camera maths as everything else.
      ctx.save();
      for (const s of stars) {
        const px = sx(s.x);
        const py = sy(s.y);
        if (!onScreen(px, py, 4)) continue;
        ctx.globalAlpha = 0.2 + 0.6 * s.z * (0.65 + 0.35 * Math.sin(api.time * 2 + s.tw));
        ctx.fillStyle = s.z > 0.8 ? PAL.white : '#8fa8cf';
        ctx.fillRect(px | 0, py | 0, s.z > 0.75 ? 2 : 1, s.z > 0.75 ? 2 : 1);
      }
      ctx.restore();

      // Faint world-grid so the drift reads.
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = PAL.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const gs = 80;
      const ox = -((ship.x % gs) + gs) % gs + W / 2 % gs;
      const oy = -((ship.y % gs) + gs) % gs + H / 2 % gs;
      for (let x = ox - gs; x < W + gs; x += gs) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, H);
      }
      for (let y = oy - gs; y < H + gs; y += gs) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(W, y + 0.5);
      }
      ctx.stroke();
      ctx.restore();

      drawStation(ctx);

      /* ---- ore ---- */
      for (const o of ore) {
        const px = sx(o.x);
        const py = sy(o.y);
        if (!onScreen(px, py, 12)) continue;
        const pulse = 0.65 + 0.35 * Math.sin(o.ph);
        const col = o.value > 1 ? PAL.violet : PAL.yellow;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(o.ph * 0.4);
        ctx.shadowColor = col;
        ctx.shadowBlur = 12 * pulse;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(0, -o.r);
        ctx.lineTo(o.r * 0.8, 0);
        ctx.lineTo(0, o.r);
        ctx.lineTo(-o.r * 0.8, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      /* ---- rocks ---- */
      ctx.lineWidth = 2;
      for (const r of rocks) {
        const px = sx(r.x);
        const py = sy(r.y);
        if (!onScreen(px, py, r.r + 8)) continue;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(r.rot);
        const stroke = r.hit > 0 ? PAL.white : r.tint ? PAL.violet : '#9fb4d8';
        ctx.shadowColor = stroke;
        ctx.shadowBlur = r.hit > 0 ? 14 : 5;
        drawRock(ctx, r.verts, r.r, 0, stroke, r.tint ? '#1a1330' : '#131b2c');
        // Inner facet line to sell the volume.
        ctx.globalAlpha = 0.35;
        drawRock(ctx, r.verts, r.r * 0.55, 0.6, stroke, null);
        ctx.restore();
      }

      /* ---- shards ---- */
      ctx.save();
      for (const s of shards) {
        const px = sx(s.x);
        const py = sy(s.y);
        if (!onScreen(px, py, 20)) continue;
        ctx.globalAlpha = clamp(s.life / s.max, 0, 1) * 0.9;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(px - Math.cos(s.rot) * s.len, py - Math.sin(s.rot) * s.len);
        ctx.lineTo(px + Math.cos(s.rot) * s.len, py + Math.sin(s.rot) * s.len);
        ctx.stroke();
      }
      ctx.restore();

      /* ---- bullets ---- */
      ctx.save();
      ctx.strokeStyle = PAL.cyan;
      ctx.shadowColor = PAL.cyan;
      ctx.shadowBlur = 10;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (const b of bullets) {
        const px = sx(b.x);
        const py = sy(b.y);
        if (!onScreen(px, py, 10)) continue;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - b.vx * 0.02, py - b.vy * 0.02);
        ctx.stroke();
      }
      ctx.strokeStyle = PAL.red;
      ctx.shadowColor = PAL.red;
      for (const b of dbullets) {
        const px = sx(b.x);
        const py = sy(b.y);
        if (!onScreen(px, py, 10)) continue;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - b.vx * 0.03, py - b.vy * 0.03);
        ctx.stroke();
      }
      ctx.restore();

      /* ---- drones ---- */
      for (const d of drones) {
        const px = sx(d.x);
        const py = sy(d.y);
        if (!onScreen(px, py, 24)) continue;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(d.a);
        ctx.strokeStyle = d.hit > 0 ? PAL.white : PAL.red;
        ctx.shadowColor = PAL.red;
        ctx.shadowBlur = 12;
        ctx.lineWidth = 2;
        ctx.fillStyle = '#210a12';
        ctx.beginPath();
        ctx.moveTo(12, 0);
        ctx.lineTo(-2, 9);
        ctx.lineTo(-9, 4);
        ctx.lineTo(-9, -4);
        ctx.lineTo(-2, -9);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = PAL.yellow;
        ctx.beginPath();
        ctx.arc(4, 0, 2 + Math.sin(api.time * 9) * 0.6, 0, TAU);
        ctx.fill();
        ctx.restore();
      }

      drawShip(ctx);
      api.particles.render(ctx);

      /* ---- hud ---- */
      drawGauges(ctx);
      drawMinimap(ctx);
      drawStationArrow(ctx);

      if (cargo >= CARGO_MAX && !dead) {
        const a = 0.5 + 0.5 * Math.sin(api.time * 6);
        text(ctx, 'HOLD FULL — DOCK TO SELL', W / 2, H - 26, {
          size: 10, color: alpha(PAL.lime, 0.55 + a * 0.45), align: 'center', glow: 8,
        });
      }
      if (oxygen < 25 && !dead) {
        const a = 0.5 + 0.5 * Math.sin(api.time * 10);
        text(ctx, 'OXYGEN LOW', W / 2, H - 40, {
          size: 11, color: alpha(PAL.red, 0.5 + a * 0.5), align: 'center', glow: 10,
        });
      }
      if (msgT > 0) {
        ctx.save();
        ctx.globalAlpha = clamp(msgT, 0, 1);
        text(ctx, msg, W / 2, H - 12, { size: 9, color: flash, align: 'center', glow: 6 });
        ctx.restore();
      }
      if (dockGlow > 0.02 && !dead) {
        // Subtle vignette pull toward the beacon.
        ctx.save();
        ctx.globalAlpha = dockGlow * 0.12;
        ctx.fillStyle = mix('#000000', PAL.cyan, 0.9);
        ctx.fillRect(0, 0, W, 2);
        ctx.fillRect(0, H - 2, W, 2);
        ctx.restore();
      }
    },
  };
}
