/**
 * 14 — LUNAR RESCUE LANDER
 *
 * A precision gravity simulation, not an arcade flyer. Gravity is a constant
 * downward pull, the main engine pushes along the hull's facing vector, and the
 * RCS jets apply *torque* — the ship carries angular momentum, so a nudge keeps
 * rotating until you counter it. Fuel is finite; when it runs out you are a
 * ballistic object and physics finishes the story on its own.
 */

import { PAL, TAU, clamp, lerp, alpha, polygon, text } from '../core/fx.js';

const VIEW_W = 480;
const VIEW_H = 360;

const STEP = 12;                        // px between terrain vertices
const COLS = Math.floor(VIEW_W / STEP); // terrain spans [0 .. COLS*STEP]

/* --- flight model --------------------------------------------------------
 * Everything is in screen pixels / seconds. The numbers are tuned so a clean
 * approach takes real planning but a save from 40 px up is still possible.  */
const GRAVITY_BASE = 15;      // px/s^2, +GRAVITY_STEP per level
const GRAVITY_STEP = 2.6;
const THRUST = 44;            // px/s^2 along the hull axis
const RCS_TORQUE = 5.2;       // rad/s^2
const RCS_DAMP = 0.5;         // gentle passive bleed, so spin *mostly* persists
const MAX_SPIN = 2.8;

const FUEL_BASE = 105;
const FUEL_STEP = 7;          // less fuel every level
const FUEL_MIN = 55;
const BURN_MAIN = 14;         // fuel/s
const BURN_RCS = 3.5;

const MAX_TOUCH_VY = 26;      // px/s vertical at touchdown
const MAX_TOUCH_VX = 14;      // px/s horizontal
const MAX_TILT = 0.15;        // radians (~8.6 degrees)

const SHIP_R = 9;             // half-width of the landing gear
const MAX_LEVEL = 8;
const LANDERS = 3;

/** Pad geometry: [half-width in terrain columns, score multiplier]. */
const PAD_KINDS = [
  { cols: 2, mult: 5 },
  { cols: 3, mult: 3 },
  { cols: 5, mult: 2 },
];

export const meta = {
  id: 'lander',
  title: 'LUNAR RESCUE LANDER',
  short: 'LANDER',
  category: 'SIMULATION',
  desc: 'Real inertia, real fuel, real consequences. Kill your descent rate, keep '
      + 'the hull upright and set down inside a pad — the narrow ones pay best.',
  accent: PAL.cyan,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'LEFT / RIGHT — RCS rotate',
    'A / UP — main thruster',
    'LAND — under 26 v-speed, upright, on a pad',
  ],
  touch: {
    buttons: [
      { id: 'left', label: '◀' },
      { id: 'right', label: '▶' },
      { id: 'a', label: 'THRUST', wide: true },
    ],
  },
  art(ctx, w, h, accent) {
    ctx.fillStyle = '#04060e';
    ctx.fillRect(0, 0, w, h);
    // Stars.
    ctx.fillStyle = '#8fa8d0';
    for (let i = 0; i < 30; i++) {
      ctx.fillRect((i * 79) % w, (i * 137) % (h * 0.6), 1 + (i % 3 === 0 ? 1 : 0), 1);
    }
    // Terrain.
    const ys = [140, 120, 132, 106, 118, 150, 150, 150, 128, 142, 114, 136, 148];
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < ys.length; i++) ctx.lineTo((i * w) / (ys.length - 1), ys[i]);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = '#101c2e';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Landing pad.
    ctx.fillStyle = PAL.lime;
    ctx.fillRect((5 * w) / 12, 149, (2 * w) / 12, 3);
    // Lander with flame.
    const sx = w * 0.42;
    const sy = 62;
    ctx.strokeStyle = PAL.white;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 11);
    ctx.lineTo(sx + 10, sy + 4);
    ctx.lineTo(sx - 10, sy + 4);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - 8, sy + 4); ctx.lineTo(sx - 12, sy + 14);
    ctx.moveTo(sx + 8, sy + 4); ctx.lineTo(sx + 12, sy + 14);
    ctx.stroke();
    ctx.fillStyle = PAL.orange;
    ctx.beginPath();
    ctx.moveTo(sx - 5, sy + 5);
    ctx.lineTo(sx + 5, sy + 5);
    ctx.lineTo(sx, sy + 30);
    ctx.closePath();
    ctx.fill();
  },
};

export function create(api) {
  /** @type {number[]} terrain heights, one per column vertex */
  let ground;
  /** @type {{x1:number,x2:number,y:number,mult:number}[]} */
  let pads;
  let stars;

  let ship;             // {x,y,vx,vy,a,av,fuel,maxFuel}
  let gravity, level, landers, phase, phaseT, over;
  let thrusting, throttle, dustT, msg, msgColor, bonusLines, statusFuel;

  /* ---------------------------------------------------------- terrain gen */

  /** Interpolated terrain height at any x. */
  function groundAt(x) {
    const t = clamp(x / STEP, 0, COLS);
    const i = Math.min(COLS - 1, Math.floor(t));
    return lerp(ground[i], ground[i + 1], t - i);
  }

  function padAt(x) {
    for (const p of pads) if (x >= p.x1 && x <= p.x2) return p;
    return null;
  }

  function buildTerrain() {
    const rough = 10 + level * 3;
    const base = VIEW_H * 0.74;
    const phase1 = api.rng.range(0, TAU);
    const phase2 = api.rng.range(0, TAU);
    ground = new Array(COLS + 1);
    for (let i = 0; i <= COLS; i++) {
      const y = base
        + Math.sin(i * 0.33 + phase1) * 26
        + Math.sin(i * 0.11 + phase2) * 34
        + api.rng.range(-rough, rough);
      ground[i] = clamp(y, VIEW_H * 0.42, VIEW_H - 12);
    }

    // Carve the pads: fewer (and therefore harder to reach) as levels climb.
    const count = clamp(4 - Math.ceil(level / 2), 1, 3);
    pads = [];
    const used = [];
    for (let n = 0; n < count; n++) {
      const kind = PAD_KINDS[Math.min(PAD_KINDS.length - 1, n)];
      let i0 = -1;
      for (let tries = 0; tries < 40; tries++) {
        const c = api.rng.int(2, COLS - kind.cols - 2);
        if (used.some((u) => c < u.b + 2 && c + kind.cols > u.a - 2)) continue;
        i0 = c;
        break;
      }
      if (i0 < 0) continue;
      used.push({ a: i0, b: i0 + kind.cols });

      // Flatten, and drop the pad slightly so it reads as a shelf.
      let y = 0;
      for (let i = i0; i <= i0 + kind.cols; i++) y += ground[i];
      y = clamp(y / (kind.cols + 1), VIEW_H * 0.5, VIEW_H - 18);
      for (let i = i0; i <= i0 + kind.cols; i++) ground[i] = y;

      pads.push({ x1: i0 * STEP, x2: (i0 + kind.cols) * STEP, y, mult: kind.mult });
    }
    // Guarantee at least one pad even if the placement loop got unlucky.
    if (!pads.length) {
      const i0 = Math.floor(COLS / 2) - 2;
      const y = ground[i0];
      for (let i = i0; i <= i0 + 4; i++) ground[i] = y;
      pads.push({ x1: i0 * STEP, x2: (i0 + 4) * STEP, y, mult: 2 });
    }
  }

  function spawnShip(refuel) {
    const fuel = Math.max(FUEL_MIN, FUEL_BASE - (level - 1) * FUEL_STEP);
    ship = {
      x: api.rng.range(VIEW_W * 0.2, VIEW_W * 0.8),
      y: 34,
      vx: api.rng.range(-16, 16),
      vy: 6,
      a: 0,
      av: api.rng.range(-0.3, 0.3),
      fuel: refuel ? fuel : ship.fuel,
      maxFuel: fuel,
    };
    gravity = GRAVITY_BASE + (level - 1) * GRAVITY_STEP;
    phase = 'fly';
    phaseT = 0;
    throttle = 0;
    thrusting = false;
    msg = '';
    bonusLines = null;
    statusFuel = Math.round(ship.fuel);
    api.setStatus({ LEVEL: level, LANDERS: landers, FUEL: statusFuel });
  }

  function nextLevel() {
    level++;
    if (level > MAX_LEVEL) {
      finish(true, 'ALL SITES SECURED');
      return;
    }
    buildTerrain();
    spawnShip(true);
  }

  function finish(win, message) {
    if (over) return;
    over = true;
    const stats = {
      'SITES LANDED': clamp(level - 1, 0, MAX_LEVEL),
      LANDERS: Math.max(0, landers),
      GRAVITY: gravity.toFixed(1),
    };
    if (win) api.win({ message, stats });
    else api.gameOver({ message, stats });
  }

  /* --------------------------------------------------------------- events */

  function touchdown(pad) {
    phase = 'landed';
    phaseT = 0;
    api.sfx('victory');
    api.vibrate(40);

    const centre = (pad.x1 + pad.x2) / 2;
    const half = (pad.x2 - pad.x1) / 2;
    const precision = Math.round((1 - clamp(Math.abs(ship.x - centre) / half, 0, 1)) * 120);
    const softness = Math.round((1 - clamp(Math.abs(ship.vy) / MAX_TOUCH_VY, 0, 1)) * 100);
    const fuelBonus = Math.round(ship.fuel * 8);
    const base = 200 * level;
    const total = (base + precision + softness + fuelBonus) * pad.mult;

    bonusLines = [
      ['TOUCHDOWN', base],
      ['PRECISION', precision],
      ['SOFT LANDING', softness],
      ['FUEL ' + Math.round(ship.fuel), fuelBonus],
      ['PAD x' + pad.mult, ''],
    ];
    msg = 'THE EAGLE HAS LANDED';
    msgColor = PAL.lime;
    api.addScore(total);

    for (let i = 0; i < 14; i++) {
      api.particles.emit({
        x: ship.x + api.rng.range(-10, 10), y: pad.y,
        vx: api.rng.range(-40, 40), vy: -api.rng.range(10, 50),
        life: 0.8, size: 2, color: PAL.lime, glow: 8, drag: 1.4, gravity: 40,
      });
    }
  }

  function crash(reason) {
    // Several touchdown checks can fail in the same frame; only the first
    // one is the crash.
    if (phase !== 'fly') return;
    api.hitStop(0.1);
    api.flash(PAL.orange, 0.5);
    phase = 'crash';
    phaseT = 0;
    msg = reason;
    msgColor = PAL.red;
    landers--;
    api.sfx('explosion');
    api.shakeScreen(16, 4);
    api.vibrate(180);
    api.particles.burst(ship.x, ship.y, 30, {
      speed: 190, life: 1.1, size: 3.2, glow: 12, drag: 1.1, gravity: 90,
      color: [PAL.orange, PAL.yellow, PAL.red, PAL.white],
    });
    api.particles.burst(ship.x, ship.y, 10, {
      speed: 90, life: 1.4, size: 2, glow: 6, drag: 0.7, gravity: 120,
      color: [PAL.dim, PAL.white], shape: 'spark',
    });
    api.setStatus({ LEVEL: level, LANDERS: Math.max(0, landers), FUEL: 0 });
  }

  /** Resolve the frame in which the hull first touches rock. */
  function contact() {
    const bottom = ship.y + SHIP_R;
    const g = Math.min(groundAt(ship.x - SHIP_R), groundAt(ship.x), groundAt(ship.x + SHIP_R));
    if (bottom < g) return;

    const pad = padAt(ship.x);
    const onPad = pad
      && ship.x - SHIP_R >= pad.x1 - 0.5
      && ship.x + SHIP_R <= pad.x2 + 0.5;

    if (!onPad) {
      crash(pad ? 'HALF ON THE PAD' : 'CRASHED INTO THE ROCKS');
      return;
    }
    if (ship.vy > MAX_TOUCH_VY) { crash('DESCENT TOO FAST'); return; }
    if (Math.abs(ship.vx) > MAX_TOUCH_VX) { crash('DRIFTED IN TOO HARD'); return; }
    if (Math.abs(ship.a) > MAX_TILT) { crash('LANDED ON ITS SIDE'); return; }
    ship.y = pad.y - SHIP_R;
    ship.vx = 0;
    ship.vy = 0;
    ship.av = 0;
    ship.a = 0;
    touchdown(pad);
  }

  /* ------------------------------------------------------------ lifecycle */

  return {
    init() {
      level = 1;
      landers = LANDERS;
      over = false;
      dustT = 0;
      msgColor = PAL.white;
      stars = [];
      for (let i = 0; i < 70; i++) {
        stars.push({
          x: api.rng.range(0, VIEW_W),
          y: api.rng.range(0, VIEW_H * 0.75),
          z: api.rng.range(0.3, 1),
        });
      }
      buildTerrain();
      // spawnShip reads ship.fuel when not refuelling; seed it first.
      ship = { fuel: FUEL_BASE };
      spawnShip(true);
    },

    update(dt) {
      if (over) return;

      if (phase !== 'fly') {
        phaseT += dt;
        if (phaseT > 2.3) {
          if (phase === 'landed') nextLevel();
          else if (landers <= 0) finish(false, msg || 'LANDER LOST');
          else spawnShip(true);
        }
        return;
      }

      /* --- RCS: torque, not teleportation ----------------------------- */
      const rot = api.input.axis('left', 'right');
      if (rot && ship.fuel > 0) {
        ship.av += rot * RCS_TORQUE * dt;
        ship.fuel = Math.max(0, ship.fuel - BURN_RCS * dt);
        if (api.rng.chance(dt * 26)) {
          const side = -rot;
          api.particles.emit({
            x: ship.x + Math.cos(ship.a) * side * SHIP_R,
            y: ship.y + Math.sin(ship.a) * side * SHIP_R,
            vx: side * 40 + ship.vx, vy: ship.vy + api.rng.range(-12, 12),
            life: 0.25, size: 1.6, color: PAL.cyan, glow: 6, drag: 2,
          });
        }
      }
      ship.av *= Math.exp(-RCS_DAMP * dt);
      ship.av = clamp(ship.av, -MAX_SPIN, MAX_SPIN);
      ship.a += ship.av * dt;
      if (ship.a > Math.PI) ship.a -= TAU;
      if (ship.a < -Math.PI) ship.a += TAU;

      /* --- main engine -------------------------------------------------- */
      thrusting = (api.input.isDown('a') || api.input.isDown('up')) && ship.fuel > 0;
      throttle = lerp(throttle, thrusting ? 1 : 0, clamp(dt * 14, 0, 1));
      if (thrusting) {
        // Thrust along the hull's facing vector (nose points up at a = 0).
        ship.vx += Math.sin(ship.a) * THRUST * dt;
        ship.vy -= Math.cos(ship.a) * THRUST * dt;
        ship.fuel = Math.max(0, ship.fuel - BURN_MAIN * dt);
        if (api.rng.chance(dt * 30)) api.sfx('thrust', { vol: 0.28 });
      }

      ship.vy += gravity * dt;
      ship.x += ship.vx * dt;
      ship.y += ship.vy * dt;

      // The world wraps horizontally so a bad drift is recoverable.
      if (ship.x < -SHIP_R) ship.x += VIEW_W + SHIP_R * 2;
      if (ship.x > VIEW_W + SHIP_R) ship.x -= VIEW_W + SHIP_R * 2;
      if (ship.y < -60) { ship.y = -60; ship.vy = Math.max(ship.vy, 0); }

      /* --- exhaust + ground wash --------------------------------------- */
      const alt = groundAt(ship.x) - (ship.y + SHIP_R);
      if (thrusting) {
        const ex = ship.x - Math.sin(ship.a) * SHIP_R;
        const ey = ship.y + Math.cos(ship.a) * SHIP_R;
        api.particles.emit({
          x: ex, y: ey,
          vx: -Math.sin(ship.a) * 120 + api.rng.range(-18, 18) + ship.vx,
          vy: Math.cos(ship.a) * 120 + api.rng.range(-18, 18) + ship.vy,
          life: 0.3, size: api.rng.range(2, 4),
          color: api.rng.chance(0.4) ? PAL.yellow : PAL.orange,
          glow: 10, drag: 2.5,
        });
        // Dust kicked outward once the exhaust plume reaches the surface.
        dustT -= dt;
        if (alt < 55 && dustT <= 0) {
          dustT = 0.03;
          const gy = groundAt(ship.x);
          const dir = api.rng.sign();
          api.particles.emit({
            x: ship.x + api.rng.range(-6, 6), y: gy - 1,
            vx: dir * api.rng.range(50, 150) * (1 - alt / 55),
            vy: -api.rng.range(4, 26),
            life: 0.5, size: api.rng.range(1.5, 3.4),
            color: api.rng.chance(0.5) ? '#6d7a92' : '#3d4a63',
            drag: 1.6, gravity: 30, additive: false,
          });
        }
      }

      contact();

      // Only poke the DOM HUD when the displayed fuel figure actually moves.
      const f = Math.round(ship.fuel);
      if (phase === 'fly' && f !== statusFuel) {
        statusFuel = f;
        api.setStatus({ LEVEL: level, LANDERS: landers, FUEL: f });
      }
    },

    render(ctx) {
      const W = VIEW_W;
      const H = VIEW_H;

      ctx.fillStyle = '#04060e';
      ctx.fillRect(0, 0, W, H);

      // Stars sit in screen space so the landing zoom doesn't smear them.
      ctx.save();
      for (const s of stars) {
        ctx.globalAlpha = 0.25 + s.z * 0.6;
        ctx.fillStyle = s.z > 0.8 ? '#dbe9ff' : '#7f98c4';
        ctx.fillRect(s.x | 0, s.y | 0, s.z > 0.8 ? 2 : 1, s.z > 0.8 ? 2 : 1);
      }
      ctx.restore();

      const alt = ground ? groundAt(ship.x) - (ship.y + SHIP_R) : 999;

      /* Push in for the last few metres — the classic "hold your breath" shot. */
      const zt = phase === 'fly' ? clamp((90 - alt) / 70, 0, 1) : 0.6;
      const zoom = 1 + zt * 1.05;
      const fx = lerp(W / 2, ship.x, zt);
      const fy = lerp(H / 2, ship.y + 20, zt);

      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-fx, -fy);

      /* --- terrain as one filled vector polygon ------------------------- */
      ctx.beginPath();
      ctx.moveTo(-40, H + 60);
      for (let i = 0; i <= COLS; i++) ctx.lineTo(i * STEP, ground[i]);
      ctx.lineTo(W + 40, ground[COLS]);
      ctx.lineTo(W + 40, H + 60);
      ctx.closePath();
      ctx.fillStyle = '#0d1726';
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = PAL.cyan;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = PAL.cyan;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(0, ground[0]);
      for (let i = 1; i <= COLS; i++) ctx.lineTo(i * STEP, ground[i]);
      ctx.stroke();
      ctx.restore();

      /* --- pads --------------------------------------------------------- */
      for (const p of pads) {
        ctx.save();
        ctx.shadowColor = PAL.lime;
        ctx.shadowBlur = 10;
        ctx.fillStyle = PAL.lime;
        ctx.fillRect(p.x1, p.y - 2, p.x2 - p.x1, 3);
        ctx.restore();
        // Marker lights at both ends.
        const blink = 0.55 + 0.45 * Math.sin(api.time * 5 + p.x1);
        ctx.fillStyle = alpha(PAL.yellow, blink);
        ctx.fillRect(p.x1 - 1, p.y - 6, 2, 4);
        ctx.fillRect(p.x2 - 1, p.y - 6, 2, 4);
        text(ctx, 'x' + p.mult, (p.x1 + p.x2) / 2, p.y - 16,
          { size: 9, color: PAL.lime, align: 'center' });
      }

      /* --- ship --------------------------------------------------------- */
      if (phase !== 'crash') {
        ctx.save();
        ctx.translate(ship.x, ship.y);
        ctx.rotate(ship.a);

        // Thruster flame, scaled by throttle with a flicker.
        if (throttle > 0.02) {
          const len = (10 + throttle * 26) * (0.82 + Math.random() * 0.36);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = alpha(PAL.orange, 0.85);
          ctx.beginPath();
          ctx.moveTo(-4.5, SHIP_R - 2);
          ctx.lineTo(4.5, SHIP_R - 2);
          ctx.lineTo(0, SHIP_R - 2 + len);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = alpha(PAL.yellow, 0.95);
          ctx.beginPath();
          ctx.moveTo(-2, SHIP_R - 2);
          ctx.lineTo(2, SHIP_R - 2);
          ctx.lineTo(0, SHIP_R - 2 + len * 0.55);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }

        ctx.strokeStyle = phase === 'landed' ? PAL.lime : PAL.white;
        ctx.lineWidth = 1.6;
        ctx.lineJoin = 'round';
        // Hull.
        ctx.beginPath();
        ctx.moveTo(0, -SHIP_R - 3);
        ctx.lineTo(6, -1);
        ctx.lineTo(4, 5);
        ctx.lineTo(-4, 5);
        ctx.lineTo(-6, -1);
        ctx.closePath();
        ctx.stroke();
        // Legs + pads.
        ctx.beginPath();
        ctx.moveTo(-4, 5); ctx.lineTo(-SHIP_R, SHIP_R);
        ctx.moveTo(4, 5); ctx.lineTo(SHIP_R, SHIP_R);
        ctx.moveTo(-SHIP_R - 2, SHIP_R); ctx.lineTo(-SHIP_R + 2, SHIP_R);
        ctx.moveTo(SHIP_R - 2, SHIP_R); ctx.lineTo(SHIP_R + 2, SHIP_R);
        ctx.stroke();
        // Cockpit.
        ctx.fillStyle = alpha(PAL.cyan, 0.85);
        ctx.beginPath();
        ctx.arc(0, -2, 2.2, 0, TAU);
        ctx.fill();
        ctx.restore();
      }

      api.particles.render(ctx);
      ctx.restore();

      /* --- HUD ---------------------------------------------------------- */
      drawHud(ctx, alt);

      if (phase !== 'fly' && msg) {
        const y = H * 0.3;
        text(ctx, msg, W / 2, y, { size: 15, color: msgColor, align: 'center', glow: 12 });
        if (bonusLines) {
          let ly = y + 24;
          for (const [label, val] of bonusLines) {
            text(ctx, label, W / 2 - 70, ly, { size: 9, color: PAL.dim });
            if (val !== '') {
              text(ctx, '+' + val, W / 2 + 70, ly, { size: 9, color: PAL.yellow, align: 'right' });
            }
            ly += 12;
          }
        }
      }
    },

    destroy() {},
  };

  /* ------------------------------------------------------------------ hud */

  function gauge(ctx, x, y, w, label, value, frac, color) {
    text(ctx, label, x, y, { size: 8, color: PAL.dim });
    text(ctx, value, x + w, y, { size: 9, color, align: 'right' });
    ctx.fillStyle = alpha(PAL.dim, 0.3);
    ctx.fillRect(x, y + 11, w, 3);
    ctx.fillStyle = color;
    ctx.fillRect(x, y + 11, w * clamp(frac, 0, 1), 3);
  }

  function drawHud(ctx, alt) {
    const W = VIEW_W;
    const vy = ship.vy;
    const vx = ship.vx;
    const safeVy = vy <= MAX_TOUCH_VY;
    const safeVx = Math.abs(vx) <= MAX_TOUCH_VX;
    const safeTilt = Math.abs(ship.a) <= MAX_TILT;

    ctx.save();
    ctx.fillStyle = alpha('#050a14', 0.72);
    ctx.fillRect(0, 0, W, 40);
    ctx.strokeStyle = alpha(PAL.cyan, 0.25);
    ctx.beginPath();
    ctx.moveTo(0, 40.5);
    ctx.lineTo(W, 40.5);
    ctx.stroke();
    ctx.restore();

    gauge(ctx, 8, 6, 72, 'ALTITUDE', Math.max(0, Math.round(alt)).toString(),
      alt / 260, PAL.cyan);
    gauge(ctx, 92, 6, 72, 'V-SPEED', vy.toFixed(0),
      Math.abs(vy) / (MAX_TOUCH_VY * 3), safeVy ? PAL.green : PAL.red);
    gauge(ctx, 176, 6, 72, 'H-SPEED', vx.toFixed(0),
      Math.abs(vx) / (MAX_TOUCH_VX * 3), safeVx ? PAL.green : PAL.red);
    gauge(ctx, 260, 6, 78, 'FUEL', Math.round(ship.fuel).toString(),
      ship.fuel / ship.maxFuel, ship.fuel > ship.maxFuel * 0.25 ? PAL.yellow : PAL.red);

    /* Tilt indicator: an artificial horizon arc with a hull marker. */
    const tx = W - 56;
    const ty = 22;
    ctx.save();
    ctx.strokeStyle = alpha(PAL.dim, 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(tx, ty, 14, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    // Safe wedge.
    ctx.strokeStyle = alpha(PAL.green, 0.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(tx, ty, 14, -Math.PI / 2 - MAX_TILT, -Math.PI / 2 + MAX_TILT);
    ctx.stroke();
    ctx.strokeStyle = safeTilt ? PAL.green : PAL.red;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + Math.sin(ship.a) * 13, ty - Math.cos(ship.a) * 13);
    ctx.stroke();
    ctx.restore();
    text(ctx, 'TILT', tx, ty + 6, { size: 8, color: PAL.dim, align: 'center' });

    text(ctx, 'G ' + gravity.toFixed(1), W - 8, 6, { size: 9, color: PAL.violet, align: 'right' });

    if (ship.fuel <= 0 && phase === 'fly') {
      text(ctx, 'FUEL DEPLETED — BALLISTIC', W / 2, 50, {
        size: 11, align: 'center', glow: 10,
        color: Math.floor(api.time * 6) % 2 ? PAL.red : PAL.orange,
      });
    }

    // Remaining landers, drawn as little hulls.
    for (let i = 0; i < landers - (phase === 'crash' ? 0 : 1); i++) {
      ctx.save();
      ctx.strokeStyle = PAL.dim;
      ctx.lineWidth = 1;
      polygon(ctx, 12 + i * 12, VIEW_H - 10, 4, 3, -Math.PI / 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}
