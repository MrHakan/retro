/**
 * 21 — RETRO CANVAS PINBALL
 *
 * A real table, not a bounce-the-square toy. The ball is a circle with velocity
 * and gravity; the table is a soup of line segments (walls, orbit arcs, lane
 * guides, slingshots, drop targets) and circles (pop bumpers, posts, the lock
 * saucer). Integration is substepped so a 1100 px/s ball can never tunnel a
 * wall, and the flippers are modelled as line segments rotating about a pivot —
 * a ball struck by a moving flipper picks up the flipper's surface velocity,
 * which is the whole reason pinball feels the way it does.
 */

import { PAL, TAU, clamp, alpha, mix, reflect, segIntersect, text } from '../core/fx.js';

/* ------------------------------------------------------------------ table */

const W = 380;
const H = 580;

const CX = 190;          // centre of both orbit arcs
const CY = 200;
const R_OUT = 166;       // outer wall arc
const R_IN = 130;        // orbit divider arc
const ORBIT_END = 2.234; // 128°, where the orbit spits the ball back out

const GRAVITY = 900;
const DRAIN_Y = 546;
const BALL_R = 7;
const PLUNGE_X = 338;
const PLUNGE_Y = 513;

const FLIP_LEN = 52;
const FLIP_R = 6.5;
const L_PIVOT = { x: 110, y: 476 };
const R_PIVOT = { x: 234, y: 476 };
const L_REST = 0.50;
const L_UP = -0.52;
const R_REST = Math.PI - 0.50;
const R_UP = Math.PI + 0.52;

const NEON_LETTERS = ['N', 'E', 'O', 'N'];
const ROLLOVERS = [
  { x: 104, y: 150 }, { x: 146, y: 130 }, { x: 238, y: 130 }, { x: 280, y: 150 },
];

/** Seven-segment masks, bit order a b c d e f g. */
const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

export const meta = {
  id: 'pinball',
  title: 'RETRO CANVAS PINBALL',
  short: 'PINBALL',
  category: 'ARCADE',
  desc: 'A physically simulated table: rotating flippers with real angular impulse, '
      + 'pop bumpers, drop targets, an orbit ramp, a spinner, rollover lanes and a '
      + '3-ball multiball lock. Nudge to save it — nudge too much and you tilt.',
  accent: PAL.yellow,
  view: { w: W, h: H },
  controls: [
    'LEFT / RIGHT — flippers',
    'SPACE — hold to charge plunger',
    'K — nudge (careful: TILT)',
  ],
  touch: {
    buttons: [
      { id: 'left', label: '◀L' },
      { id: 'right', label: 'R▶' },
      { id: 'a', label: 'PLUNGE' },
      { id: 'b', label: 'NUDGE' },
    ],
  },
  art(ctx, w, h, accent) {
    ctx.save();
    ctx.fillStyle = '#080b14';
    ctx.fillRect(0, 0, w, h);

    // Table outline: arched top, straight sides.
    ctx.strokeStyle = alpha(accent, 0.85);
    ctx.lineWidth = 3;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(58, 168);
    ctx.lineTo(58, 74);
    ctx.arc(120, 74, 62, Math.PI, 0);
    ctx.lineTo(182, 168);
    ctx.stroke();

    // Pop bumpers.
    const bump = [[96, 72], [144, 72], [120, 42]];
    for (const [bx, by] of bump) {
      ctx.shadowColor = PAL.magenta;
      ctx.strokeStyle = PAL.magenta;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(bx, by, 11, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = alpha(PAL.magenta, 0.35);
      ctx.fill();
    }

    // Drop target bank.
    ctx.shadowColor = PAL.lime;
    ctx.fillStyle = PAL.lime;
    for (let i = 0; i < 4; i++) ctx.fillRect(80 + i * 17, 108, 12, 5);

    // Flippers.
    ctx.strokeStyle = PAL.cyan;
    ctx.shadowColor = PAL.cyan;
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(84, 148); ctx.lineTo(112, 162);
    ctx.moveTo(156, 148); ctx.lineTo(128, 162);
    ctx.stroke();

    // Ball with a motion trail.
    for (let i = 4; i >= 0; i--) {
      ctx.globalAlpha = 0.16 * i;
      ctx.fillStyle = PAL.white;
      ctx.beginPath();
      ctx.arc(150 - i * 5, 104 + i * 7, 6 - i * 0.5, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowColor = PAL.white;
    ctx.shadowBlur = 14;
    ctx.fillStyle = PAL.white;
    ctx.beginPath();
    ctx.arc(150, 104, 6.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  },
};

export function create(api) {
  /* --- table geometry, built once in init() --- */
  let walls;      // [{x1,y1,x2,y2,rest,kind}]
  let bumpers;    // [{x,y,r,rest,kick,score,flash,kind}]
  let targets;    // [{x1,y1,x2,y2,down,reset}]
  let saucer, spinner, orbitGate;

  /* --- run state --- */
  let balls, ball, ballsLeft, over;
  let flipL, flipR;
  let plunge, plungeHeld, launchGlow;
  let lockCount, multiball, multMul, bonusMul;
  let neon, targetsDown, bankBonus;
  let spinnerAngle, spinnerSpin, spinCount;
  let comboTimer, loops;
  let nudges, tilt, tiltWarn;
  let msg, msgTime, sfxCool;
  let stats;

  /* ------------------------------------------------------------- geometry */

  const seg = (x1, y1, x2, y2, kind = 'wall', rest = 0.62) => ({ x1, y1, x2, y2, kind, rest });

  /** Chop an arc into chords. Angles are maths-style (CCW, y up). */
  function arcSegs(out, cx, cy, r, a0, a1, n, kind, rest) {
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n;
      const t1 = a0 + ((a1 - a0) * (i + 1)) / n;
      out.push(seg(
        cx + Math.cos(t0) * r, cy - Math.sin(t0) * r,
        cx + Math.cos(t1) * r, cy - Math.sin(t1) * r,
        kind, rest,
      ));
    }
  }

  function buildTable() {
    walls = [];

    // Outer shell: left wall, arched top, shooter-lane outer wall, lane floor.
    walls.push(seg(24, 200, 24, 430));
    walls.push(seg(24, 430, 58, 516));              // left outlane guide
    arcSegs(walls, CX, CY, R_OUT, Math.PI, 0, 22, 'wall', 0.62);
    walls.push(seg(356, 200, 356, 520));
    walls.push(seg(356, 520, 320, 520));            // shooter lane floor
    walls.push(seg(320, 200, 320, 520));            // lane divider / right wall
    walls.push(seg(320, 430, 286, 516));            // right outlane guide

    // Orbit divider: the inner arc that turns the shooter lane into a full loop.
    arcSegs(walls, CX, CY, R_IN, 0, ORBIT_END, 16, 'wall', 0.62);

    // Slingshot bodies. The hypotenuse is the live face.
    walls.push(seg(78, 338, 78, 410));
    walls.push(seg(78, 410, 126, 404));
    walls.push(seg(126, 404, 78, 338, 'sling', 0.7));
    walls.push(seg(266, 338, 266, 410));
    walls.push(seg(266, 410, 218, 404));
    walls.push(seg(218, 404, 266, 338, 'sling', 0.7));

    // Inlane / outlane dividers.
    walls.push(seg(78, 410, 100, 470));
    walls.push(seg(266, 410, 244, 470));

    bumpers = [
      { x: 130, y: 208, r: 16, rest: 0.55, kick: 330, score: 250, flash: 0, kind: 'pop' },
      { x: 196, y: 172, r: 16, rest: 0.55, kick: 330, score: 250, flash: 0, kind: 'pop' },
      { x: 256, y: 214, r: 16, rest: 0.55, kick: 330, score: 250, flash: 0, kind: 'pop' },
      { x: 96, y: 292, r: 7, rest: 0.8, kick: 0, score: 25, flash: 0, kind: 'post' },
      { x: 248, y: 292, r: 7, rest: 0.8, kick: 0, score: 25, flash: 0, kind: 'post' },
    ];

    // Four drop targets along a gently tilted bank so a resting ball rolls off.
    targets = [];
    const bx0 = 118; const by0 = 322; const bx1 = 222; const by1 = 338;
    const bl = Math.hypot(bx1 - bx0, by1 - by0);
    const ux = (bx1 - bx0) / bl; const uy = (by1 - by0) / bl;
    for (let i = 0; i < 4; i++) {
      const s0 = (bl / 4) * i + 2;
      const s1 = (bl / 4) * (i + 1) - 2;
      targets.push({
        x1: bx0 + ux * s0, y1: by0 + uy * s0,
        x2: bx0 + ux * s1, y2: by0 + uy * s1,
        kind: 'target', rest: 0.55, down: false, flash: 0,
      });
    }

    saucer = { x: 290, y: 262, r: 13 };
    spinner = { x1: 320, y1: 330, x2: 356, y2: 330 };
    orbitGate = {
      x1: CX + Math.cos(ORBIT_END) * R_IN, y1: CY - Math.sin(ORBIT_END) * R_IN,
      x2: CX + Math.cos(ORBIT_END) * R_OUT, y2: CY - Math.sin(ORBIT_END) * R_OUT,
    };
  }

  /* -------------------------------------------------------------- scoring */

  function mult() {
    return bonusMul * (multiball ? multMul : 1);
  }

  function points(n, x, y, label) {
    api.addScore(Math.round(n * mult()));
    if (label) api.particles.popText(x, y, label, PAL.yellow, 0.9);
  }

  function say(t, life = 1.6) {
    msg = t;
    msgTime = life;
  }

  function blip(name, o) {
    if (sfxCool > 0) return;
    sfxCool = 0.045;
    api.sfx(name, o);
  }

  /* -------------------------------------------------------------- physics */

  /**
   * Resolve a ball against a surface whose outward normal at the contact point
   * is (nx, ny). `vpx/vpy` is the surface's own velocity (non-zero only for
   * flippers). Returns the impact speed so callers can score and play sound.
   */
  function bounce(b, nx, ny, depth, rest, vpx = 0, vpy = 0) {
    b.x += nx * (depth + 0.06);
    b.y += ny * (depth + 0.06);
    const rvx = b.vx - vpx;
    const rvy = b.vy - vpy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return 0;
    if (vn > -14) {
      // Resting contact — cancel the normal component so the ball slides along
      // the surface instead of buzzing against it.
      b.vx = rvx - vn * nx + vpx;
      b.vy = rvy - vn * ny + vpy;
      b.vx *= 0.994;
      b.vy *= 0.994;
      return 0;
    }
    const rv = reflect(rvx, rvy, nx, ny, rest);
    b.vx = rv.x + vpx;
    b.vy = rv.y + vpy;
    return -vn;
  }

  /** Circle vs line segment. Returns the impact speed, or 0 for no contact. */
  function hitSeg(b, s, rest) {
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    const l2 = dx * dx + dy * dy;
    let t = ((b.x - s.x1) * dx + (b.y - s.y1) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = s.x1 + t * dx;
    const py = s.y1 + t * dy;
    let nx = b.x - px;
    let ny = b.y - py;
    let d = Math.hypot(nx, ny);
    if (d > b.r) return 0;
    if (d < 1e-6) { nx = -dy; ny = dx; d = Math.sqrt(l2); }
    nx /= d;
    ny /= d;
    return bounce(b, nx, ny, b.r - d, rest ?? s.rest);
  }

  function hitCircle(b, c) {
    const dx = b.x - c.x;
    const dy = b.y - c.y;
    const rr = b.r + c.r;
    let d = Math.hypot(dx, dy);
    if (d > rr) return 0;
    if (d < 1e-6) d = 1e-6;
    const nx = dx / d;
    const ny = dy / d;
    const imp = bounce(b, nx, ny, rr - d, c.rest);
    if (imp > 0 && c.kick) {
      b.vx += nx * c.kick;
      b.vy += ny * c.kick;
    }
    return imp;
  }

  /** Flipper: a rotating capsule. The contact point carries omega * r. */
  function hitFlipper(b, f) {
    const dx = Math.cos(f.angle) * FLIP_LEN;
    const dy = Math.sin(f.angle) * FLIP_LEN;
    const l2 = dx * dx + dy * dy;
    let t = ((b.x - f.px) * dx + (b.y - f.py) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = f.px + t * dx;
    const cy = f.py + t * dy;
    let nx = b.x - cx;
    let ny = b.y - cy;
    let d = Math.hypot(nx, ny);
    const rad = b.r + FLIP_R;
    if (d > rad) return;
    if (d < 1e-6) { nx = -dy; ny = dx; d = Math.sqrt(l2); }
    nx /= d;
    ny /= d;

    // Velocity of the flipper surface at the contact point.
    const rx = cx - f.px;
    const ry = cy - f.py;
    const vpx = -f.omega * ry;
    const vpy = f.omega * rx;

    const imp = bounce(b, nx, ny, rad - d, 0.42, vpx, vpy);
    if (Math.abs(f.omega) > 3.5) {
      // Extra snap so a well-timed flip launches the ball up the table.
      const boost = Math.min(Math.abs(f.omega) * 10, 300);
      b.vx += nx * boost;
      b.vy += ny * boost;
      blip('bounce', { vol: 0.5, detune: 6 });
    } else if (imp > 90) {
      blip('bounce', { vol: 0.35, detune: -4 });
    }
  }

  function stepFlipper(f, h) {
    const target = f.held && !tilt ? f.up : f.rest;
    const prev = f.angle;
    const rate = (f.held && !tilt ? 27 : 15) * h;
    const d = target - f.angle;
    if (Math.abs(d) <= rate) f.angle = target;
    else f.angle += Math.sign(d) * rate;
    f.omega = (f.angle - prev) / h;
  }

  /* ------------------------------------------------------------- triggers */

  function crossed(b, s) {
    return segIntersect(b.px, b.py, b.x, b.y, s.x1, s.y1, s.x2, s.y2) !== null;
  }

  function checkTriggers(b) {
    // Spinner sits across the shooter lane; every pass rips off some points.
    if (crossed(b, spinner)) {
      const sp = Math.hypot(b.vx, b.vy);
      const spins = clamp(Math.round(sp / 90), 1, 8);
      spinCount += spins;
      spinnerSpin = Math.sign(b.vy || 1) * -clamp(sp / 22, 4, 26);
      points(60 * spins, 338, 320, null);
      api.sfx('zap', { vol: 0.35, detune: spins });
      comboTimer = 2.4;
    }

    // Completing the orbit past the divider is the ramp shot.
    if (crossed(b, orbitGate)) {
      if (comboTimer > 0) {
        loops++;
        points(1500 * Math.min(loops, 6), orbitGate.x1, orbitGate.y1, 'LOOP x' + Math.min(loops, 6));
        api.sfx('powerup', { vol: 0.6, detune: Math.min(loops * 2, 12) });
        api.shakeScreen(3);
      } else {
        points(400, orbitGate.x1, orbitGate.y1, 'ORBIT');
        api.sfx('blip', { vol: 0.5 });
      }
      comboTimer = 2.4;
    }

    // Rollover lanes spell NEON.
    for (let i = 0; i < ROLLOVERS.length; i++) {
      const r = ROLLOVERS[i];
      if (neon[i]) continue;
      if ((b.x - r.x) ** 2 + (b.y - r.y) ** 2 < 196) {
        neon[i] = 1;
        api.sfx('coin', { vol: 0.55, detune: i * 3 });
        points(200, r.x, r.y - 10, null);
        if (neon.every((v) => v)) completeNeon();
      }
    }

    // Lock saucer.
    if (!b.hold && (b.x - saucer.x) ** 2 + (b.y - saucer.y) ** 2 < (saucer.r + 2) ** 2) {
      b.hold = 0.75;
      b.x = saucer.x;
      b.y = saucer.y;
      b.vx = 0;
      b.vy = 0;
      api.sfx('pickup', { vol: 0.7 });
    }
  }

  function completeNeon() {
    bonusMul = Math.min(bonusMul + 1, 6);
    stats.neon++;
    api.addScore(Math.round(5000 * mult()));
    say('N E O N  —  MULT x' + bonusMul, 2);
    api.sfx('levelup');
    api.shakeScreen(5);
    for (const r of ROLLOVERS) {
      api.particles.burst(r.x, r.y, 8, {
        speed: 150, life: 0.7, size: 3, color: [PAL.yellow, PAL.white], glow: 12, drag: 2.4,
      });
    }
    neon = [0, 0, 0, 0];
    api.setStatus({ BALL: ball, MULT: 'x' + mult() });
  }

  function ejectSaucer(b) {
    lockCount++;
    stats.locks++;
    b.vx = -180 - api.rng.range(0, 60);
    b.vy = -420;
    b.y = saucer.y - saucer.r - b.r - 1;
    points(2000, saucer.x, saucer.y - 18, 'LOCK ' + lockCount);
    api.sfx('thrust', { vol: 0.7 });
    api.shakeScreen(4);
    if (lockCount >= 3 && !multiball) startMultiball();
    else say('BALL LOCKED  ' + lockCount + '/3', 1.4);
  }

  function startMultiball() {
    multiball = true;
    multMul = 3;
    lockCount = 0;
    stats.multiballs++;
    say('MULTIBALL!  x3', 2.4);
    api.sfx('horn');
    api.shakeScreen(9, 4);
    for (let i = 0; i < 2; i++) {
      balls.push(makeBall(150 + i * 90, 120, api.rng.range(-70, 70), 40));
    }
    api.setStatus({ BALL: ball, MULT: 'x' + mult() });
  }

  function knockTarget(t, i) {
    t.down = true;
    t.flash = 0.4;
    targetsDown++;
    points(750, (t.x1 + t.x2) / 2, (t.y1 + t.y2) / 2 - 10, null);
    api.sfx('brick', { vol: 0.7, detune: i * 2 });
    api.particles.burst((t.x1 + t.x2) / 2, (t.y1 + t.y2) / 2, 8, {
      speed: 140, life: 0.5, size: 2.6, color: [PAL.lime, PAL.white], glow: 10, drag: 2.6,
    });
    if (targetsDown >= targets.length) {
      bankBonus = 1.6;
      stats.banks++;
      api.addScore(Math.round(8000 * mult()));
      say('TARGET BANK  +8000', 2);
      api.sfx('victory', { vol: 0.5 });
      api.shakeScreen(6);
    }
  }

  /* ----------------------------------------------------------------- flow */

  function makeBall(x, y, vx = 0, vy = 0) {
    return {
      x, y, vx, vy, px: x, py: y, r: BALL_R,
      hold: 0, slow: 0, trail: [],
    };
  }

  function serve() {
    balls = [makeBall(PLUNGE_X, PLUNGE_Y)];
    plunge = 0;
    tilt = false;
    tiltWarn = 0;
    nudges.length = 0;
    comboTimer = 0;
    loops = 0;
    api.setStatus({ BALL: ball, MULT: 'x' + mult() });
  }

  function drainBall(b, i) {
    balls.splice(i, 1);
    api.particles.burst(b.x, DRAIN_Y, 10, {
      speed: 120, life: 0.6, size: 2.5, color: [PAL.red, PAL.orange], glow: 8, drag: 2.2,
    });
    if (balls.length > 0) {
      api.sfx('miss', { vol: 0.5 });
      if (multiball && balls.length === 1) {
        multiball = false;
        multMul = 1;
        say('MULTIBALL OVER', 1.2);
        api.setStatus({ BALL: ball, MULT: 'x' + mult() });
      }
      return;
    }
    // Last ball on the table is gone.
    multiball = false;
    multMul = 1;
    api.sfx('hurt');
    api.shakeScreen(6);
    if (ball >= ballsLeft) {
      finish();
    } else {
      ball++;
      say('BALL ' + ball, 1.6);
      serve();
    }
  }

  function finish() {
    if (over) return;
    over = true;
    api.gameOver({
      message: 'GAME OVER — BALL ' + ballsLeft + ' DRAINED',
      stats: {
        BUMPERS: stats.bumpers,
        BANKS: stats.banks,
        LOCKS: stats.locks,
        MULTIBALL: stats.multiballs,
        SPINS: spinCount,
        'NEON SETS': stats.neon,
      },
    });
  }

  function nudge() {
    if (over || tilt || balls.length === 0) return;
    nudges.push(api.time);
    while (nudges.length && api.time - nudges[0] > 2.6) nudges.shift();
    const dir = api.rng.sign();
    for (const b of balls) {
      if (b.hold > 0) continue;
      b.vx += dir * 90 + (CX - b.x) * 0.25;
      b.vy -= 130;
    }
    api.shakeScreen(5, 7);
    api.sfx('kick', { vol: 0.5 });
    api.vibrate(30);
    if (nudges.length >= 3) {
      tilt = true;
      tiltWarn = 1;
      flipL.held = false;
      flipR.held = false;
      say('TILT!', 2.4);
      api.sfx('alert');
      api.shakeScreen(12, 4);
    } else if (nudges.length === 2) {
      tiltWarn = 0.8;
    }
  }

  /* ----------------------------------------------------------------- draw */

  function drawSegDigit(ctx, x, y, w, h, mask, color) {
    const t = Math.max(2, h * 0.12);
    const half = (h - 3 * t) / 2;
    const on = (bit, rx, ry, rw, rh) => {
      const lit = (mask & bit) !== 0;
      ctx.fillStyle = lit ? color : alpha(color, 0.08);
      ctx.fillRect(x + rx, y + ry, rw, rh);
    };
    on(0x01, t, 0, w - 2 * t, t);                    // a
    on(0x02, w - t, t, t, half);                     // b
    on(0x04, w - t, 2 * t + half, t, half);          // c
    on(0x08, t, h - t, w - 2 * t, t);                // d
    on(0x10, 0, 2 * t + half, t, half);              // e
    on(0x20, 0, t, t, half);                         // f
    on(0x40, t, t + half, w - 2 * t, t);             // g
  }

  function drawScoreLED(ctx, value, x, y, digits, dw, dh, color) {
    const s = String(Math.min(value, 10 ** digits - 1)).padStart(digits, ' ');
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    for (let i = 0; i < digits; i++) {
      const ch = s[i];
      const mask = ch === ' ' ? 0 : SEG[+ch];
      drawSegDigit(ctx, x + i * (dw + 4), y, dw, dh, mask, color);
    }
    ctx.restore();
  }

  function lamp(ctx, x, y, r, color, lit, label) {
    ctx.save();
    if (lit) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = color;
    } else {
      ctx.fillStyle = alpha(color, 0.14);
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = alpha(color, lit ? 0.9 : 0.3);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    if (label) {
      text(ctx, label, x, y - 4, {
        size: 9, color: lit ? '#05060a' : alpha(color, 0.55), align: 'center',
      });
    }
  }

  return {
    init() {
      buildTable();
      balls = [];
      ball = 1;
      ballsLeft = 3;
      over = false;
      lockCount = 0;
      multiball = false;
      multMul = 1;
      bonusMul = 1;
      neon = [0, 0, 0, 0];
      targetsDown = 0;
      bankBonus = 0;
      spinnerAngle = 0;
      spinnerSpin = 0;
      spinCount = 0;
      comboTimer = 0;
      loops = 0;
      nudges = [];
      tilt = false;
      tiltWarn = 0;
      msg = '';
      msgTime = 0;
      sfxCool = 0;
      plunge = 0;
      plungeHeld = false;
      launchGlow = 0;
      stats = { bumpers: 0, banks: 0, locks: 0, multiballs: 0, neon: 0 };

      flipL = { px: L_PIVOT.x, py: L_PIVOT.y, angle: L_REST, omega: 0, rest: L_REST, up: L_UP, held: false };
      flipR = { px: R_PIVOT.x, py: R_PIVOT.y, angle: R_REST, omega: 0, rest: R_REST, up: R_UP, held: false };

      serve();
      say('BALL 1', 1.6);
    },

    update(dt) {
      if (over) return;

      if (sfxCool > 0) sfxCool -= dt;
      if (msgTime > 0) msgTime -= dt;
      if (comboTimer > 0) comboTimer -= dt;
      if (tiltWarn > 0) tiltWarn -= dt;
      if (launchGlow > 0) launchGlow -= dt;
      for (const bm of bumpers) if (bm.flash > 0) bm.flash -= dt;
      for (const t of targets) if (t.flash > 0) t.flash -= dt;
      spinnerAngle += spinnerSpin * dt;
      spinnerSpin *= Math.exp(-1.6 * dt);

      // Drop-target bank resets a beat after the last one falls.
      if (bankBonus > 0) {
        bankBonus -= dt;
        if (bankBonus <= 0) {
          for (const t of targets) t.down = false;
          targetsDown = 0;
          api.sfx('select', { vol: 0.4 });
        }
      }

      /* ---- flipper buttons -------------------------------------------- */
      flipL.held = api.input.isDown('left');
      flipR.held = api.input.isDown('right');

      /* ---- plunger ----------------------------------------------------- */
      const onLane = balls.find((b) => b.x > 322 && b.y > 470 && Math.abs(b.vy) < 40 && !b.hold);
      const holdA = api.input.isDown('a');
      if (onLane) {
        if (holdA) {
          if (!plungeHeld) api.sfx('charge', { vol: 0.45 });
          plunge = Math.min(1, plunge + dt * 1.3);
          onLane.y = PLUNGE_Y + plunge * 16;
          onLane.vx = 0;
          onLane.vy = 0;
          plungeHeld = true;
        } else if (plungeHeld) {
          onLane.vy = -(430 + plunge * 700);
          onLane.vx = api.rng.range(-8, 8);
          api.sfx('shoot', { vol: 0.6, detune: plunge * 8 });
          launchGlow = 0.4;
          api.shakeScreen(2 + plunge * 3);
          plunge = 0;
          plungeHeld = false;
        }
      } else {
        plungeHeld = false;
        plunge = Math.max(0, plunge - dt * 2);
      }

      /* ---- substepped integration -------------------------------------- */
      let fastest = 0;
      for (const b of balls) {
        if (b.hold > 0) continue;
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > fastest) fastest = sp;
      }
      const steps = clamp(Math.ceil((fastest * dt) / 2.5), 4, 16);
      const h = dt / steps;
      const drag = Math.exp(-0.22 * h);

      for (let s = 0; s < steps; s++) {
        stepFlipper(flipL, h);
        stepFlipper(flipR, h);

        for (let i = 0; i < balls.length; i++) {
          const b = balls[i];
          if (b.hold > 0) continue;
          if (b === onLane && plungeHeld) continue;

          b.px = b.x;
          b.py = b.y;
          b.vy += GRAVITY * h;
          b.vx *= drag;
          b.vy *= drag;
          b.x += b.vx * h;
          b.y += b.vy * h;

          for (let w = 0; w < walls.length; w++) {
            const wl = walls[w];
            const imp = hitSeg(b, wl);
            if (imp <= 0) continue;
            if (wl.kind === 'sling') {
              // Kick along the contact normal — recompute it cheaply from the
              // post-bounce velocity direction.
              const nx = -(wl.y2 - wl.y1);
              const ny = wl.x2 - wl.x1;
              const l = Math.hypot(nx, ny) || 1;
              const sx = (b.vx * nx + b.vy * ny) >= 0 ? 1 : -1;
              b.vx += (nx / l) * 250 * sx;
              b.vy += (ny / l) * 250 * sx;
              points(120, b.x, b.y - 10, null);
              api.sfx('snare', { vol: 0.4 });
              api.shakeScreen(2);
              api.particles.burst(b.x, b.y, 5, {
                speed: 130, life: 0.35, size: 2.2, color: [PAL.orange, PAL.white], glow: 8, drag: 3,
              });
            } else if (imp > 120) {
              blip('bounce', { vol: 0.22, detune: -6 });
            }
          }

          for (let t = 0; t < targets.length; t++) {
            const tg = targets[t];
            if (tg.down) continue;
            if (hitSeg(b, tg) > 0) knockTarget(tg, t);
          }

          for (let c = 0; c < bumpers.length; c++) {
            const bm = bumpers[c];
            const imp = hitCircle(b, bm);
            if (imp <= 0) continue;
            bm.flash = 0.3;
            if (bm.kind === 'pop') {
              stats.bumpers++;
              points(bm.score, bm.x, bm.y - 18, null);
              api.sfx('kick', { vol: 0.45, detune: 4 });
              api.shakeScreen(2.5);
              api.particles.burst(bm.x, bm.y, 6, {
                speed: 160, life: 0.4, size: 2.4, color: [PAL.magenta, PAL.white], glow: 10, drag: 3,
              });
            } else {
              points(bm.score, bm.x, bm.y, null);
              blip('bounce', { vol: 0.2, detune: 8 });
            }
          }

          // Tilted flippers are dead weight, but they are still solid: they
          // simply never leave their rest angle, so omega stays at zero.
          hitFlipper(b, flipL);
          hitFlipper(b, flipR);

          checkTriggers(b);
        }
      }

      /* ---- per-frame ball bookkeeping ---------------------------------- */
      for (let i = balls.length - 1; i >= 0; i--) {
        const b = balls[i];

        if (b.hold > 0) {
          b.hold -= dt;
          if (b.hold <= 0) ejectSaucer(b);
          continue;
        }

        b.trail.push(b.x, b.y);
        if (b.trail.length > 20) b.trail.splice(0, 2);

        // Anti-stuck: a ball that has barely moved for a while gets a shove.
        const sp = Math.hypot(b.vx, b.vy);
        const parked = b === onLane;
        if (sp < 26 && !parked) {
          b.slow += dt;
          if (b.slow > 4.5) {
            b.slow = 0;
            b.vx += api.rng.range(-140, 140);
            b.vy -= 190;
            api.sfx('blip', { vol: 0.4 });
          }
        } else {
          b.slow = 0;
        }

        if (b.y > DRAIN_Y) drainBall(b, i);
      }

      if (balls.length === 0 && !over) finish();
    },

    handleInput(e) {
      if (e.type !== 'press' || over) return;
      if (e.action === 'b') nudge();
      // Flipper buttons also shuffle the lit rollover lanes, like a real table.
      if (e.action === 'left' || e.action === 'right') {
        const dir = e.action === 'left' ? -1 : 1;
        const next = neon.slice();
        for (let i = 0; i < neon.length; i++) {
          next[(i + dir + neon.length) % neon.length] = neon[i];
        }
        neon = next;
        if (neon.every((v) => v)) completeNeon();
      }
    },

    render(ctx) {
      /* ---- cabinet backdrop ---- */
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#0a1024');
      g.addColorStop(0.55, '#070a16');
      g.addColorStop(1, '#04060c');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      /* ---- playfield inlay ---- */
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = '#101c33';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let y = 40; y < H; y += 28) { ctx.moveTo(24, y + 0.5); ctx.lineTo(356, y + 0.5); }
      ctx.stroke();
      ctx.restore();

      // Orbit lane floor: the band between the two arcs.
      ctx.save();
      ctx.strokeStyle = alpha(PAL.violet, 0.16);
      ctx.lineWidth = R_OUT - R_IN;
      ctx.beginPath();
      ctx.arc(CX, CY, (R_OUT + R_IN) / 2, -ORBIT_END, 0);
      ctx.stroke();
      ctx.restore();

      /* ---- static walls ---- */
      ctx.save();
      ctx.lineCap = 'round';
      ctx.shadowColor = PAL.blue;
      ctx.shadowBlur = 6;
      ctx.strokeStyle = '#4a6ea8';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (const s of walls) {
        if (s.kind === 'sling') continue;
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.stroke();
      ctx.restore();

      /* ---- slingshots ---- */
      const slingTri = [
        [[78, 338], [78, 410], [126, 404]],
        [[266, 338], [266, 410], [218, 404]],
      ];
      for (const tri of slingTri) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(tri[0][0], tri[0][1]);
        ctx.lineTo(tri[1][0], tri[1][1]);
        ctx.lineTo(tri[2][0], tri[2][1]);
        ctx.closePath();
        ctx.fillStyle = alpha(PAL.orange, 0.2);
        ctx.fill();
        ctx.shadowColor = PAL.orange;
        ctx.shadowBlur = 8;
        ctx.strokeStyle = PAL.orange;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();
      }

      /* ---- rollover lanes ---- */
      for (let i = 0; i < ROLLOVERS.length; i++) {
        lamp(ctx, ROLLOVERS[i].x, ROLLOVERS[i].y, 9, PAL.yellow, !!neon[i], NEON_LETTERS[i]);
      }

      /* ---- drop targets ---- */
      for (const t of targets) {
        const cx = (t.x1 + t.x2) / 2;
        const cy = (t.y1 + t.y2) / 2;
        const a = Math.atan2(t.y2 - t.y1, t.x2 - t.x1);
        const len = Math.hypot(t.x2 - t.x1, t.y2 - t.y1);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a);
        if (t.down) {
          ctx.fillStyle = alpha(PAL.lime, 0.12);
          ctx.fillRect(-len / 2, -1.5, len, 3);
        } else {
          ctx.shadowColor = PAL.lime;
          ctx.shadowBlur = t.flash > 0 ? 20 : 8;
          ctx.fillStyle = t.flash > 0 ? PAL.white : PAL.lime;
          ctx.fillRect(-len / 2, -5, len, 10);
          ctx.fillStyle = alpha('#000000', 0.35);
          ctx.fillRect(-len / 2, 1, len, 4);
        }
        ctx.restore();
      }

      /* ---- lock saucer ---- */
      ctx.save();
      ctx.shadowColor = PAL.violet;
      ctx.shadowBlur = 12;
      ctx.strokeStyle = PAL.violet;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(saucer.x, saucer.y, saucer.r, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = alpha(PAL.violet, 0.22);
      ctx.fill();
      ctx.restore();
      for (let i = 0; i < 3; i++) {
        lamp(ctx, saucer.x - 14 + i * 14, saucer.y + 24, 4, PAL.violet, i < lockCount, null);
      }
      text(ctx, 'LOCK', saucer.x, saucer.y + 32, { size: 8, color: PAL.dim, align: 'center' });

      /* ---- spinner ---- */
      ctx.save();
      ctx.translate((spinner.x1 + spinner.x2) / 2, spinner.y1);
      const sw = Math.abs(Math.cos(spinnerAngle)) * 15 + 1;
      ctx.shadowColor = PAL.cyan;
      ctx.shadowBlur = 10;
      ctx.fillStyle = alpha(PAL.cyan, 0.8);
      ctx.fillRect(-sw, -7, sw * 2, 14);
      ctx.strokeStyle = PAL.cyan;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-17, 0);
      ctx.lineTo(17, 0);
      ctx.stroke();
      ctx.restore();

      /* ---- bumpers ---- */
      for (const bm of bumpers) {
        const f = bm.flash > 0 ? bm.flash / 0.3 : 0;
        const col = bm.kind === 'pop' ? PAL.magenta : PAL.cyan;
        ctx.save();
        ctx.shadowColor = col;
        ctx.shadowBlur = 10 + f * 24;
        ctx.fillStyle = alpha(col, 0.25 + f * 0.55);
        ctx.beginPath();
        ctx.arc(bm.x, bm.y, bm.r * (1 + f * 0.16), 0, TAU);
        ctx.fill();
        ctx.strokeStyle = f > 0 ? PAL.white : col;
        ctx.lineWidth = 3;
        ctx.stroke();
        if (bm.kind === 'pop') {
          ctx.beginPath();
          ctx.arc(bm.x, bm.y, bm.r * 0.42, 0, TAU);
          ctx.fillStyle = f > 0 ? PAL.white : alpha(col, 0.8);
          ctx.fill();
        }
        ctx.restore();
      }

      /* ---- flippers ---- */
      for (const f of [flipL, flipR]) {
        const tx = f.px + Math.cos(f.angle) * FLIP_LEN;
        const ty = f.py + Math.sin(f.angle) * FLIP_LEN;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.shadowColor = tilt ? PAL.red : PAL.cyan;
        ctx.shadowBlur = Math.abs(f.omega) > 4 ? 22 : 10;
        ctx.strokeStyle = tilt ? PAL.red : (f.held ? PAL.white : PAL.cyan);
        ctx.lineWidth = FLIP_R * 2;
        ctx.beginPath();
        ctx.moveTo(f.px, f.py);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.strokeStyle = alpha('#000000', 0.35);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(f.px, f.py);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.fillStyle = PAL.dim;
        ctx.beginPath();
        ctx.arc(f.px, f.py, 3.5, 0, TAU);
        ctx.fill();
        ctx.restore();
      }

      /* ---- balls with trails ---- */
      for (const b of balls) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < b.trail.length; i += 2) {
          const t = i / Math.max(2, b.trail.length);
          ctx.globalAlpha = 0.05 + t * 0.2;
          ctx.fillStyle = PAL.cyan;
          ctx.beginPath();
          ctx.arc(b.trail[i], b.trail[i + 1], b.r * (0.35 + t * 0.6), 0, TAU);
          ctx.fill();
        }
        ctx.restore();

        ctx.save();
        ctx.shadowColor = PAL.white;
        ctx.shadowBlur = 14;
        const bg = ctx.createRadialGradient(b.x - 2.5, b.y - 3, 1, b.x, b.y, b.r);
        bg.addColorStop(0, '#ffffff');
        bg.addColorStop(0.55, '#c9dcf2');
        bg.addColorStop(1, '#5f7ba8');
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fill();
        ctx.restore();
      }

      api.particles.render(ctx);

      /* ---- plunger + power meter ---- */
      ctx.save();
      const plY = 520 + 4;
      ctx.strokeStyle = PAL.dim;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(PLUNGE_X, plY + plunge * 16);
      ctx.lineTo(PLUNGE_X, plY + 20);
      ctx.stroke();
      ctx.fillStyle = launchGlow > 0 ? PAL.white : PAL.orange;
      ctx.fillRect(PLUNGE_X - 9, plY + plunge * 16 - 4, 18, 5);
      ctx.restore();

      const meterH = 90;
      const meterY = 420;
      ctx.fillStyle = '#0c1424';
      ctx.fillRect(362, meterY, 10, meterH);
      ctx.save();
      ctx.shadowColor = PAL.orange;
      ctx.shadowBlur = 10;
      ctx.fillStyle = mix(PAL.lime, PAL.red, plunge);
      ctx.fillRect(362, meterY + meterH * (1 - plunge), 10, meterH * plunge);
      ctx.restore();
      text(ctx, 'PWR', 367, meterY - 12, { size: 7, color: PAL.dim, align: 'center' });

      /* ---- apron: LED score, ball, multiplier ---- */
      ctx.fillStyle = '#070b14';
      ctx.fillRect(0, 542, W, H - 542);
      ctx.save();
      ctx.strokeStyle = alpha(PAL.blue, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 543);
      ctx.lineTo(W, 543);
      ctx.stroke();
      ctx.restore();

      drawScoreLED(ctx, api.score, 118, 550, 8, 12, 22, tilt ? PAL.red : PAL.yellow);

      text(ctx, 'BALL', 14, 548, { size: 8, color: PAL.dim });
      for (let i = 0; i < ballsLeft; i++) {
        lamp(ctx, 20 + i * 14, 564, 5, PAL.cyan, i < ballsLeft - ball + 1, null);
      }

      text(ctx, 'MULT', W - 62, 548, { size: 8, color: PAL.dim });
      text(ctx, 'x' + mult(), W - 62, 558,
        { size: 16, color: multiball ? PAL.magenta : PAL.white, glow: multiball ? 12 : 0 });

      /* ---- overlays ---- */
      if (tilt) {
        ctx.save();
        ctx.globalAlpha = 0.25 + 0.2 * Math.sin(api.time * 14);
        ctx.fillStyle = PAL.red;
        ctx.fillRect(0, 0, W, 542);
        ctx.restore();
        text(ctx, 'TILT', W / 2, 250, { size: 46, color: PAL.red, align: 'center', glow: 24 });
        text(ctx, 'FLIPPERS DEAD UNTIL NEXT BALL', W / 2, 300,
          { size: 10, color: PAL.white, align: 'center' });
      } else if (tiltWarn > 0) {
        text(ctx, 'DANGER — TILT', W / 2, 250,
          { size: 16, color: PAL.orange, align: 'center', glow: 12 });
      }

      if (msgTime > 0 && msg) {
        const a = clamp(msgTime, 0, 1);
        ctx.save();
        ctx.globalAlpha = a;
        text(ctx, msg, W / 2, 470, { size: 15, color: PAL.yellow, align: 'center', glow: 14 });
        ctx.restore();
      }

      if (comboTimer > 0) {
        text(ctx, 'COMBO', 30, 250, { size: 9, color: PAL.violet });
        ctx.fillStyle = alpha(PAL.violet, 0.8);
        ctx.fillRect(30, 262, 40 * (comboTimer / 2.4), 3);
      }

      text(ctx, 'SPINS ' + spinCount, 30, 480, { size: 8, color: PAL.dim });
      text(ctx, 'LOOPS ' + loops, 30, 492, { size: 8, color: PAL.dim });
    },

    destroy() {
      balls = [];
    },
  };
}
