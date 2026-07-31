/**
 * 15 — GEOMETRY VECTOR WARFARE
 *
 * A twin-stick arena in full additive-neon vector style: every entity is a
 * stroked polygon drawn under `globalCompositeOperation = 'lighter'`, the floor
 * grid is warped by whatever gravity or shockwave is currently bending space,
 * and every death showers the arena with debris.
 *
 * Three abilities sit on meters: a tap of FIRE while the RICOCHET meter is full
 * throws a wall-bouncing beam, BOMB drops a black hole that crushes a cluster
 * and then detonates, EMP rings out and stuns everything it touches.
 */

import { PAL, TAU, clamp, damp, alpha, polygon, text } from '../core/fx.js';

const VIEW_W = 480;
const VIEW_H = 360;
const PAD = 12;                       // arena wall inset

const PLAYER_SPEED = 190;
const PLAYER_R = 8;
const BULLET_SPEED = 430;
const FIRE_RATE = 0.115;              // seconds between shots
const INVULN = 2.0;

const CD_LASER = 6.0;
const CD_BOMB = 13.0;
const CD_EMP = 9.0;

const HOLE_LIFE = 2.3;
const EMP_MAX_R = 250;
const LASER_BOUNCES = 4;
const MAX_MULT = 8;
const LIVES = 3;
const BOSS_EVERY = 5;

/** Enemy archetypes — shape, colour, brains and payout all in one table. */
const KINDS = {
  square: { sides: 4, inner: 0, r: 10, hp: 1, color: PAL.cyan, speed: 52, points: 25, rot: 0.9 },
  dart: { sides: 3, inner: 0, r: 10, hp: 1, color: PAL.magenta, speed: 78, points: 40, rot: 2.4 },
  diamond: { sides: 4, inner: 0.42, r: 11, hp: 2, color: PAL.yellow, speed: 90, points: 60, rot: 1.2 },
  hex: { sides: 6, inner: 0, r: 14, hp: 2, color: PAL.lime, speed: 44, points: 30, rot: 0.7 },
  boss: { sides: 8, inner: 0.52, r: 34, hp: 26, color: PAL.violet, speed: 34, points: 900, rot: 1.6 },
};

/* Distance from a point to a line segment — the ricochet beam's hit test. */
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

export const meta = {
  id: 'vectorwar',
  title: 'GEOMETRY VECTOR WARFARE',
  short: 'VECTOR WAR',
  category: 'SHOOTER',
  desc: 'Neon vector arena survival. Shapes swarm, dash, dodge and split — answer '
      + 'with a ricochet beam, a black hole and an EMP shockwave.',
  accent: PAL.violet,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'WASD / STICK — move',
    'MOUSE / DRAG — aim',
    'A or CLICK — fire (tap fires RICOCHET when charged)',
    'B — black hole bomb',
    'C — EMP shockwave',
  ],
  touch: {
    stick: true,
    buttons: [
      { id: 'a', label: 'FIRE' },
      { id: 'b', label: 'BOMB' },
      { id: 'c', label: 'EMP' },
    ],
  },
  art(ctx, w, h, accent) {
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Warped grid.
    ctx.strokeStyle = alpha(accent, 0.28);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const x = (i * w) / 8;
      ctx.moveTo(x, 0);
      for (let y = 0; y <= h; y += 15) ctx.lineTo(x + Math.sin(y * 0.05 + i) * 5, y);
    }
    for (let j = 0; j <= 6; j++) {
      const y = (j * h) / 6;
      ctx.moveTo(0, y);
      for (let x = 0; x <= w; x += 15) ctx.lineTo(x, y + Math.cos(x * 0.05 + j) * 5);
    }
    ctx.stroke();
    // Shapes.
    const shapes = [
      [58, 52, 16, 4, PAL.cyan], [178, 40, 14, 3, PAL.magenta],
      [200, 128, 15, 6, PAL.lime], [40, 132, 13, 4, PAL.yellow],
    ];
    ctx.lineWidth = 2;
    for (const [x, y, r, s, c] of shapes) {
      ctx.strokeStyle = c;
      ctx.shadowColor = c;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      for (let i = 0; i < s; i++) {
        const a = (i / s) * Math.PI * 2 + 0.4;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
    // Player + tracer.
    ctx.strokeStyle = PAL.white;
    ctx.shadowColor = PAL.white;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.moveTo(112, 78); ctx.lineTo(132, 92); ctx.lineTo(112, 106); ctx.lineTo(118, 92);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = PAL.yellow;
    ctx.shadowColor = PAL.yellow;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(136, 92); ctx.lineTo(196, 92);
    ctx.stroke();
    ctx.restore();
  },
};

export function create(api) {
  const L = PAD;
  const R = VIEW_W - PAD;
  const T = PAD;
  const B = VIEW_H - PAD;

  let player, bullets, enemies, holes, shocks, beams;
  let wave, waveT, spawnQueue, lives, mult, chainT, kills, bestMult, over;
  let cdLaser, cdBomb, cdEmp;
  let aimX, aimY, aimAge, fireT, gridT, statusKey;

  const warpOut = { x: 0, y: 0 };

  /* ---------------------------------------------------------------- spawn */

  function spawnEnemy(kind, x, y, gen = 0) {
    const k = KINDS[kind];
    const scale = gen ? 0.62 : 1;
    enemies.push({
      kind, gen,
      x, y,
      vx: 0, vy: 0,
      r: k.r * scale,
      hp: Math.max(1, Math.round(k.hp * (gen ? 0.5 : 1) + (kind === 'boss' ? wave : 0))),
      maxHp: 0,
      speed: k.speed * (1 + wave * 0.035) * (gen ? 1.25 : 1),
      color: k.color,
      rot: api.rng.angle(),
      vr: k.rot * api.rng.sign(),
      stun: 0,
      dashT: api.rng.range(0.4, 1.6),
      shootT: 2.2,
      spawnT: 0.55,
      flash: 0,
    });
    const e = enemies[enemies.length - 1];
    e.maxHp = e.hp;
    return e;
  }

  /** A ring of light where something is about to materialise. */
  function edgePoint() {
    const side = api.rng.int(0, 3);
    const m = 26;
    if (side === 0) return { x: api.rng.range(L + m, R - m), y: T + m };
    if (side === 1) return { x: R - m, y: api.rng.range(T + m, B - m) };
    if (side === 2) return { x: api.rng.range(L + m, R - m), y: B - m };
    return { x: L + m, y: api.rng.range(T + m, B - m) };
  }

  function startWave() {
    wave++;
    const pool = ['square'];
    if (wave >= 2) pool.push('dart');
    if (wave >= 3) pool.push('diamond');
    if (wave >= 4) pool.push('hex');

    spawnQueue = [];
    let t = 0.5;
    if (wave % BOSS_EVERY === 0) {
      spawnQueue.push({ kind: 'boss', t: 0.9 });
      t = 1.6;
    }
    const n = Math.min(22, 4 + wave * 2);
    for (let i = 0; i < n; i++) {
      spawnQueue.push({ kind: api.rng.pick(pool), t });
      t += api.rng.range(0.14, 0.42);
    }
    api.sfx('alert');
    api.particles.popText(VIEW_W / 2, VIEW_H * 0.34, 'WAVE ' + wave, PAL.violet, 1.4);
    pushStatus();
  }

  function pushStatus() {
    const key = wave + '|' + lives + '|' + mult;
    if (key === statusKey) return;
    statusKey = key;
    api.setStatus({ WAVE: wave, LIVES: Math.max(0, lives), MULT: 'x' + mult });
  }

  /* ------------------------------------------------------------- combat   */

  function addKill(e, chainPoints) {
    kills++;
    chainT = 2.0;
    if (kills % 5 === 0 && mult < MAX_MULT) {
      mult++;
      bestMult = Math.max(bestMult, mult);
      api.sfx('combo', { detune: mult });
    }
    const pts = Math.round(chainPoints * mult);
    api.addScore(pts);
    if (mult > 1) api.particles.popText(e.x, e.y - 10, '+' + pts, e.color, 0.7);
    pushStatus();
  }

  function killEnemy(e, i) {
    enemies.splice(i, 1);
    api.particles.burst(e.x, e.y, e.kind === 'boss' ? 34 : 12, {
      speed: e.kind === 'boss' ? 260 : 150, life: 0.7, size: 2.6,
      color: [e.color, PAL.white], glow: 12, drag: 1.8, shape: 'spark',
    });
    addKill(e, KINDS[e.kind].points * (e.gen ? 0.5 : 1));

    if (e.kind === 'hex' && e.gen === 0) {
      // Hexes shatter into a pair of faster, smaller hexes.
      for (let s = 0; s < 2; s++) {
        const a = api.rng.angle();
        const c = spawnEnemy('hex', e.x + Math.cos(a) * 12, e.y + Math.sin(a) * 12, 1);
        c.vx = Math.cos(a) * 120;
        c.vy = Math.sin(a) * 120;
        c.spawnT = 0.15;
      }
      api.sfx('brick');
    } else if (e.kind === 'boss') {
      api.shakeScreen(20, 3);
      api.sfx('explosion');
      api.particles.burst(e.x, e.y, 26, {
        speed: 130, life: 1.2, size: 3.4, color: [PAL.violet, PAL.magenta, PAL.white],
        glow: 16, drag: 1.2, shape: 'ring',
      });
    } else {
      api.sfx('hit', { vol: 0.5, detune: api.rng.range(-2, 4) });
    }
  }

  function damage(e, i, amount) {
    e.hp -= amount;
    e.flash = 0.12;
    if (e.hp <= 0) killEnemy(e, i);
  }

  function hitPlayer() {
    if (player.invuln > 0 || over) return;
    lives--;
    mult = 1;
    player.invuln = INVULN;
    api.sfx('explosion');
    api.shakeScreen(18, 4);
    api.vibrate(160);
    api.particles.burst(player.x, player.y, 30, {
      speed: 220, life: 0.9, size: 3, color: [PAL.white, PAL.red, PAL.orange],
      glow: 14, drag: 1.4,
    });
    // Clear breathing room: shove everything away from the wreck.
    for (const e of enemies) {
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      const d = Math.hypot(dx, dy) || 1;
      e.vx += (dx / d) * 260;
      e.vy += (dy / d) * 260;
      e.stun = Math.max(e.stun, 0.5);
    }
    pushStatus();
    if (lives <= 0) {
      over = true;
      api.gameOver({
        message: 'ARENA BREACHED',
        stats: { WAVE: wave, KILLS: kills, 'BEST MULT': 'x' + bestMult },
      });
    }
  }

  /* ------------------------------------------------------------- weapons  */

  function shoot(ax, ay) {
    bullets.push({
      x: player.x + ax * 12, y: player.y + ay * 12,
      vx: ax * BULLET_SPEED, vy: ay * BULLET_SPEED,
      life: 1.3,
    });
    api.sfx('shoot', { vol: 0.28, detune: api.rng.range(-2, 2) });
    api.particles.emit({
      x: player.x + ax * 14, y: player.y + ay * 14,
      vx: ax * 60, vy: ay * 60, life: 0.14, size: 3,
      color: PAL.yellow, glow: 8, drag: 4,
    });
  }

  /** Trace a beam that reflects off the arena walls up to LASER_BOUNCES times. */
  function fireLaser(ax, ay) {
    cdLaser = CD_LASER;
    let x = player.x;
    let y = player.y;
    let dx = ax;
    let dy = ay;
    const pts = [{ x, y }];
    for (let b = 0; b <= LASER_BOUNCES; b++) {
      // Distance to each wall along the current direction; take the nearest.
      let t = Infinity;
      let axis = 0;
      if (dx > 1e-6) { const tt = (R - x) / dx; if (tt < t) { t = tt; axis = 1; } }
      if (dx < -1e-6) { const tt = (L - x) / dx; if (tt < t) { t = tt; axis = 1; } }
      if (dy > 1e-6) { const tt = (B - y) / dy; if (tt < t) { t = tt; axis = 2; } }
      if (dy < -1e-6) { const tt = (T - y) / dy; if (tt < t) { t = tt; axis = 2; } }
      if (!isFinite(t)) break;
      x += dx * t;
      y += dy * t;
      pts.push({ x, y });
      if (b === LASER_BOUNCES) break;
      if (axis === 1) dx = -dx; else dy = -dy;
      // Nudge off the wall so the next trace doesn't re-hit it at t = 0.
      x += dx * 0.01;
      y += dy * 0.01;
    }

    beams.push({ pts, life: 0.34 });
    api.sfx('laser');
    api.shakeScreen(5, 8);

    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (e.spawnT > 0) continue;
      for (let p = 0; p < pts.length - 1; p++) {
        if (segDist(e.x, e.y, pts[p].x, pts[p].y, pts[p + 1].x, pts[p + 1].y) < e.r + 5) {
          damage(e, i, 3);
          break;
        }
      }
    }
    for (const p of pts) {
      api.particles.burst(p.x, p.y, 5, {
        speed: 110, life: 0.4, size: 2, color: [PAL.yellow, PAL.white], glow: 10, drag: 3,
      });
    }
  }

  function dropHole(ax, ay) {
    cdBomb = CD_BOMB;
    holes.push({
      x: clamp(player.x + ax * 90, L + 30, R - 30),
      y: clamp(player.y + ay * 90, T + 30, B - 30),
      life: HOLE_LIFE, r: 0, strength: 0,
    });
    api.sfx('charge');
    api.shakeScreen(4, 6);
  }

  function detonate(h) {
    api.sfx('explosion');
    api.shakeScreen(22, 3);
    api.vibrate(120);
    api.particles.burst(h.x, h.y, 34, {
      speed: 300, life: 0.8, size: 3.2, color: [PAL.violet, PAL.magenta, PAL.white],
      glow: 16, drag: 1.6,
    });
    shocks.push({ x: h.x, y: h.y, r: 0, maxR: 130, life: 0.45, maxLife: 0.45, kill: true });
  }

  function fireEmp() {
    cdEmp = CD_EMP;
    shocks.push({
      x: player.x, y: player.y, r: 0, maxR: EMP_MAX_R,
      life: 0.55, maxLife: 0.55, kill: false,
    });
    api.sfx('zap');
    api.shakeScreen(9, 6);
  }

  /* --------------------------------------------------------------- warp   */

  /** Displacement applied to the arena grid at (x, y). Writes into `warpOut`. */
  function warp(x, y) {
    let ox = Math.sin(y * 0.045 + gridT * 1.2) * 2.2;
    let oy = Math.cos(x * 0.045 + gridT * 0.9) * 2.2;
    for (const h of holes) {
      const dx = h.x - x;
      const dy = h.y - y;
      const d = Math.hypot(dx, dy) + 6;
      const f = Math.min(30, 2200 / d) * h.strength;
      ox += (dx / d) * f;
      oy += (dy / d) * f;
    }
    for (const s of shocks) {
      const dx = x - s.x;
      const dy = y - s.y;
      const d = Math.hypot(dx, dy) + 1;
      const band = Math.max(0, 1 - Math.abs(d - s.r) / 30);
      ox += (dx / d) * band * 16;
      oy += (dy / d) * band * 16;
    }
    warpOut.x = x + ox;
    warpOut.y = y + oy;
  }

  /* ------------------------------------------------------------- lifecycle */

  return {
    init() {
      player = { x: VIEW_W / 2, y: VIEW_H / 2, vx: 0, vy: 0, invuln: 1.2, aim: 0 };
      bullets = [];
      enemies = [];
      holes = [];
      shocks = [];
      beams = [];
      spawnQueue = [];
      wave = 0;
      waveT = 1.2;
      lives = LIVES;
      mult = 1;
      bestMult = 1;
      chainT = 0;
      kills = 0;
      over = false;
      cdLaser = 0;
      cdBomb = 0;
      cdEmp = 0;
      aimX = VIEW_W / 2;
      aimY = VIEW_H / 2 - 60;
      aimAge = 99;
      fireT = 0;
      gridT = 0;
      statusKey = '';
      pushStatus();
    },

    update(dt) {
      if (over) return;
      gridT += dt;
      aimAge += dt;

      /* --- movement ---------------------------------------------------- */
      const sx = api.input.stick.x;
      const sy = api.input.stick.y;
      const mag = Math.hypot(sx, sy);
      const nx = mag > 1 ? sx / mag : sx;
      const ny = mag > 1 ? sy / mag : sy;
      player.vx = damp(player.vx, nx * PLAYER_SPEED, 12, dt);
      player.vy = damp(player.vy, ny * PLAYER_SPEED, 12, dt);
      player.x = clamp(player.x + player.vx * dt, L + PLAYER_R, R - PLAYER_R);
      player.y = clamp(player.y + player.vy * dt, T + PLAYER_R, B - PLAYER_R);
      if (player.invuln > 0) player.invuln -= dt;

      // Engine trail.
      if (mag > 0.15 && api.rng.chance(dt * 40)) {
        api.particles.emit({
          x: player.x - nx * 8, y: player.y - ny * 8,
          vx: -nx * 50 + api.rng.range(-20, 20), vy: -ny * 50 + api.rng.range(-20, 20),
          life: 0.3, size: 2, color: PAL.cyan, glow: 8, drag: 3,
        });
      }

      /* --- aim: pointer if it was used recently, else heading ----------- */
      const p = api.input.pointer;
      if (p.down && p.inside) { aimX = p.x; aimY = p.y; aimAge = 0; }
      let ax;
      let ay;
      if (aimAge < 4) {
        ax = aimX - player.x;
        ay = aimY - player.y;
      } else {
        ax = nx;
        ay = ny;
      }
      let al = Math.hypot(ax, ay);
      if (al < 0.001) { ax = Math.cos(player.aim); ay = Math.sin(player.aim); al = 1; }
      ax /= al;
      ay /= al;
      player.aim = Math.atan2(ay, ax);

      /* --- weapons ------------------------------------------------------ */
      if (cdLaser > 0) cdLaser -= dt;
      if (cdBomb > 0) cdBomb -= dt;
      if (cdEmp > 0) cdEmp -= dt;

      fireT -= dt;
      const firing = api.input.isDown('a') || (p.down && p.inside);
      if (firing && fireT <= 0) {
        fireT = FIRE_RATE;
        shoot(ax, ay);
      }

      /* --- bullets ------------------------------------------------------ */
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        // Black holes bend the shots too — free curve shots near a well.
        for (const h of holes) {
          const dx = h.x - b.x;
          const dy = h.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 22500) {
            const d = Math.sqrt(d2) + 4;
            const f = (900 * h.strength) / d;
            b.vx += (dx / d) * f * dt;
            b.vy += (dy / d) * f * dt;
          }
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        if (b.life <= 0 || b.x < L || b.x > R || b.y < T || b.y > B) {
          if (b.life > 0) {
            api.particles.burst(clamp(b.x, L, R), clamp(b.y, T, B), 3, {
              speed: 70, life: 0.25, size: 2, color: PAL.yellow, glow: 8, drag: 4,
            });
          }
          bullets.splice(i, 1);
        }
      }

      /* --- spawn queue --------------------------------------------------- */
      for (let i = spawnQueue.length - 1; i >= 0; i--) {
        spawnQueue[i].t -= dt;
        if (spawnQueue[i].t <= 0) {
          const pt = edgePoint();
          spawnEnemy(spawnQueue[i].kind, pt.x, pt.y);
          spawnQueue.splice(i, 1);
        }
      }

      /* --- enemies ------------------------------------------------------- */
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        e.rot += e.vr * dt;
        if (e.flash > 0) e.flash -= dt;

        if (e.spawnT > 0) {
          e.spawnT -= dt;
          if (e.spawnT <= 0) {
            api.particles.burst(e.x, e.y, 6, {
              speed: 90, life: 0.35, size: 2, color: e.color, glow: 10, drag: 3,
            });
          }
          continue;
        }

        const dx = player.x - e.x;
        const dy = player.y - e.y;
        const d = Math.hypot(dx, dy) || 1;

        if (e.stun > 0) {
          e.stun -= dt;
        } else {
          switch (e.kind) {
            case 'square': {
              const k = Math.min(1, dt * 2.4);
              e.vx += ((dx / d) * e.speed - e.vx) * k;
              e.vy += ((dy / d) * e.speed - e.vy) * k;
              break;
            }
            case 'dart': {
              // Charge in bursts: line up, then commit at four times the speed.
              e.dashT -= dt;
              if (e.dashT <= 0) {
                e.dashT = api.rng.range(1.1, 2.0);
                e.vx = (dx / d) * e.speed * 4.2;
                e.vy = (dy / d) * e.speed * 4.2;
                api.sfx('blip', { vol: 0.25, detune: 6 });
              } else {
                const f = Math.exp(-2.6 * dt);
                e.vx *= f;
                e.vy *= f;
                e.vx += (dx / d) * e.speed * dt * 1.4;
                e.vy += (dy / d) * e.speed * dt * 1.4;
              }
              break;
            }
            case 'diamond': {
              // Orbit the player, but slide sideways out of any incoming shot.
              let ex = -dy / d;
              let ey = dx / d;
              let dodge = 0;
              for (const b of bullets) {
                const bx = b.x - e.x;
                const by = b.y - e.y;
                const bd = Math.hypot(bx, by);
                if (bd < 70) {
                  const side = bx * e.vy - by * e.vx;
                  dodge += (side > 0 ? -1 : 1) * (1 - bd / 70);
                }
              }
              const k = Math.min(1, dt * 3);
              const tx = (dx / d) * e.speed * 0.45 + ex * e.speed * (0.8 + dodge * 1.6);
              const ty = (dy / d) * e.speed * 0.45 + ey * e.speed * (0.8 + dodge * 1.6);
              e.vx += (tx - e.vx) * k;
              e.vy += (ty - e.vy) * k;
              break;
            }
            case 'hex': {
              const w = Math.sin(gridT * 2 + e.rot) * 0.5;
              const k = Math.min(1, dt * 1.6);
              e.vx += ((dx / d) * e.speed - dy / d * e.speed * w - e.vx) * k;
              e.vy += ((dy / d) * e.speed + dx / d * e.speed * w - e.vy) * k;
              break;
            }
            case 'boss': {
              const k = Math.min(1, dt * 1.2);
              e.vx += ((dx / d) * e.speed - e.vx) * k;
              e.vy += ((dy / d) * e.speed - e.vy) * k;
              e.shootT -= dt;
              if (e.shootT <= 0) {
                e.shootT = 2.6;
                for (let s = 0; s < 2; s++) {
                  const a = api.rng.angle();
                  const c = spawnEnemy('square', e.x + Math.cos(a) * 34, e.y + Math.sin(a) * 34);
                  c.spawnT = 0.3;
                }
                api.sfx('alert', { vol: 0.5 });
              }
              break;
            }
            default: break;
          }
        }

        // Gravity wells drag everything toward the singularity.
        for (const h of holes) {
          const hx = h.x - e.x;
          const hy = h.y - e.y;
          const hd = Math.hypot(hx, hy) + 6;
          if (hd < 190) {
            const f = (14000 * h.strength) / (hd * hd) + 40 * h.strength;
            e.vx += (hx / hd) * f * dt;
            e.vy += (hy / hd) * f * dt;
            if (hd < 26 + h.r * 0.2) damage(e, i, dt * 9);
          }
        }

        e.x += e.vx * dt;
        e.y += e.vy * dt;

        // Walls bounce enemies back into play.
        if (e.x < L + e.r) { e.x = L + e.r; e.vx = Math.abs(e.vx) * 0.7; }
        if (e.x > R - e.r) { e.x = R - e.r; e.vx = -Math.abs(e.vx) * 0.7; }
        if (e.y < T + e.r) { e.y = T + e.r; e.vy = Math.abs(e.vy) * 0.7; }
        if (e.y > B - e.r) { e.y = B - e.r; e.vy = -Math.abs(e.vy) * 0.7; }

        if (e.hp <= 0) continue; // already removed by a well

        // Bullet hits.
        for (let j = bullets.length - 1; j >= 0; j--) {
          const b = bullets[j];
          if (Math.abs(b.x - e.x) > e.r + 4 || Math.abs(b.y - e.y) > e.r + 4) continue;
          if (Math.hypot(b.x - e.x, b.y - e.y) > e.r + 4) continue;
          bullets.splice(j, 1);
          api.particles.burst(b.x, b.y, 4, {
            speed: 90, life: 0.3, size: 2, color: [e.color, PAL.white], glow: 10, drag: 3,
          });
          damage(e, i, 1);
          break;
        }
        if (e.hp <= 0) continue;

        // Contact with the player, tested against the post-move position.
        if (Math.hypot(player.x - e.x, player.y - e.y) < e.r + PLAYER_R) hitPlayer();
      }

      /* --- black holes ---------------------------------------------------- */
      for (let i = holes.length - 1; i >= 0; i--) {
        const h = holes[i];
        h.life -= dt;
        h.strength = clamp((HOLE_LIFE - h.life) / 0.4, 0, 1) * clamp(h.life / 0.3, 0, 1);
        h.r = 10 + Math.sin(gridT * 8) * 2 + (1 - h.life / HOLE_LIFE) * 12;
        if (api.rng.chance(dt * 30)) {
          const a = api.rng.angle();
          api.particles.emit({
            x: h.x + Math.cos(a) * 60, y: h.y + Math.sin(a) * 60,
            vx: -Math.cos(a) * 150, vy: -Math.sin(a) * 150,
            life: 0.4, size: 2, color: PAL.violet, glow: 10, drag: 0.4,
          });
        }
        if (h.life <= 0) {
          detonate(h);
          holes.splice(i, 1);
        }
      }

      /* --- shockwaves ------------------------------------------------------ */
      for (let i = shocks.length - 1; i >= 0; i--) {
        const s = shocks[i];
        s.life -= dt;
        const t = 1 - clamp(s.life / s.maxLife, 0, 1);
        const prev = s.r;
        s.r = s.maxR * Math.sqrt(t);
        for (let j = enemies.length - 1; j >= 0; j--) {
          const e = enemies[j];
          if (e.spawnT > 0) continue;
          const d = Math.hypot(e.x - s.x, e.y - s.y);
          if (d > prev - e.r && d <= s.r + e.r) {
            const nxE = (e.x - s.x) / (d || 1);
            const nyE = (e.y - s.y) / (d || 1);
            if (s.kill) {
              damage(e, j, 4);
            } else {
              e.stun = Math.max(e.stun, 1.6);
              e.vx = nxE * 320;
              e.vy = nyE * 320;
              api.particles.burst(e.x, e.y, 3, {
                speed: 60, life: 0.3, size: 2, color: PAL.cyan, glow: 8, drag: 3,
              });
            }
          }
        }
        if (s.life <= 0) shocks.splice(i, 1);
      }

      /* --- beams ----------------------------------------------------------- */
      for (let i = beams.length - 1; i >= 0; i--) {
        beams[i].life -= dt;
        if (beams[i].life <= 0) beams.splice(i, 1);
      }

      /* --- ability triggers ------------------------------------------------ */
      if (api.input.consume('b')) {
        if (cdBomb <= 0) dropHole(ax, ay);
        else api.sfx('deny', { vol: 0.4 });
      }
      if (api.input.consume('c')) {
        if (cdEmp <= 0) fireEmp();
        else api.sfx('deny', { vol: 0.4 });
      }

      /* --- multiplier decay ------------------------------------------------ */
      if (chainT > 0) {
        chainT -= dt;
        if (chainT <= 0 && mult > 1) {
          mult = Math.max(1, mult - 1);
          chainT = 2.0;
          pushStatus();
        }
      }

      /* --- wave flow ------------------------------------------------------- */
      if (!enemies.length && !spawnQueue.length) {
        waveT -= dt;
        if (waveT <= 0) {
          waveT = 2.2;
          if (wave > 0) api.addScore(100 * wave);
          startWave();
        }
      }
    },

    handleInput(e) {
      if (e.type === 'pointerdown' || e.type === 'pointermove') {
        if (e.x >= 0 && e.x <= VIEW_W && e.y >= 0 && e.y <= VIEW_H) {
          aimX = e.x;
          aimY = e.y;
          aimAge = 0;
        }
      }
      if (e.type === 'press' && e.action === 'a' && cdLaser <= 0 && !over) {
        // A tap of FIRE cashes in the charged ricochet beam.
        fireLaser(Math.cos(player.aim), Math.sin(player.aim));
      }
    },

    render(ctx) {
      const W = VIEW_W;
      const H = VIEW_H;

      ctx.fillStyle = '#04050b';
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      /* --- warped arena grid --------------------------------------------- */
      const cols = 16;
      const rows = 12;
      ctx.strokeStyle = alpha(PAL.blue, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= cols; i++) {
        const x = L + ((R - L) * i) / cols;
        for (let j = 0; j <= rows; j++) {
          const y = T + ((B - T) * j) / rows;
          warp(x, y);
          if (j === 0) ctx.moveTo(warpOut.x, warpOut.y);
          else ctx.lineTo(warpOut.x, warpOut.y);
        }
      }
      for (let j = 0; j <= rows; j++) {
        const y = T + ((B - T) * j) / rows;
        for (let i = 0; i <= cols; i++) {
          const x = L + ((R - L) * i) / cols;
          warp(x, y);
          if (i === 0) ctx.moveTo(warpOut.x, warpOut.y);
          else ctx.lineTo(warpOut.x, warpOut.y);
        }
      }
      ctx.stroke();

      /* --- arena wall ------------------------------------------------------ */
      ctx.strokeStyle = PAL.violet;
      ctx.lineWidth = 2;
      ctx.shadowColor = PAL.violet;
      ctx.shadowBlur = 14;
      ctx.strokeRect(L, T, R - L, B - T);
      ctx.shadowBlur = 0;

      /* --- black holes ----------------------------------------------------- */
      for (const h of holes) {
        const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, 70 * (0.4 + h.strength));
        g.addColorStop(0, alpha(PAL.violet, 0.9 * h.strength));
        g.addColorStop(0.45, alpha(PAL.magenta, 0.28 * h.strength));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(h.x, h.y, 70 * (0.4 + h.strength), 0, TAU);
        ctx.fill();
        ctx.strokeStyle = alpha(PAL.white, 0.8 * h.strength);
        ctx.lineWidth = 2;
        polygon(ctx, h.x, h.y, h.r, 6, gridT * 3);
        ctx.stroke();
      }

      /* --- shockwaves ------------------------------------------------------ */
      for (const s of shocks) {
        const a = clamp(s.life / s.maxLife, 0, 1);
        ctx.strokeStyle = alpha(s.kill ? PAL.magenta : PAL.cyan, a * 0.9);
        ctx.lineWidth = 2 + a * 4;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, TAU);
        ctx.stroke();
        ctx.strokeStyle = alpha(PAL.white, a * 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 0.82, 0, TAU);
        ctx.stroke();
      }

      /* --- ricochet beams --------------------------------------------------- */
      for (const bm of beams) {
        const a = clamp(bm.life / 0.34, 0, 1);
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass ? alpha(PAL.white, a) : alpha(PAL.yellow, a * 0.7);
          ctx.lineWidth = pass ? 2 : 9 * a;
          ctx.beginPath();
          ctx.moveTo(bm.pts[0].x, bm.pts[0].y);
          for (let i = 1; i < bm.pts.length; i++) ctx.lineTo(bm.pts[i].x, bm.pts[i].y);
          ctx.stroke();
        }
      }

      /* --- bullets ---------------------------------------------------------- */
      ctx.strokeStyle = PAL.yellow;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = PAL.yellow;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (const b of bullets) {
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - b.vx * 0.018, b.y - b.vy * 0.018);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      /* --- enemies ----------------------------------------------------------- */
      for (const e of enemies) {
        if (e.spawnT > 0) {
          // Materialisation telegraph.
          const t = 1 - e.spawnT / 0.55;
          ctx.strokeStyle = alpha(e.color, 0.35 + t * 0.5);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r + 22 * (1 - t), 0, TAU);
          ctx.stroke();
          continue;
        }
        const col = e.flash > 0 ? PAL.white : e.color;
        ctx.strokeStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = e.kind === 'boss' ? 22 : 12;
        ctx.lineWidth = e.kind === 'boss' ? 3 : 2;
        const k = KINDS[e.kind];
        polygon(ctx, e.x, e.y, e.r, k.sides, e.rot, k.inner * e.r);
        ctx.stroke();
        if (e.kind === 'boss') {
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = alpha(PAL.magenta, 0.8);
          polygon(ctx, e.x, e.y, e.r * 0.55, k.sides, -e.rot * 1.5);
          ctx.stroke();
        }
        if (e.stun > 0) {
          ctx.strokeStyle = alpha(PAL.cyan, 0.5 + 0.4 * Math.sin(gridT * 20));
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r + 4, 0, TAU);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
      }

      /* --- player ------------------------------------------------------------ */
      const blink = player.invuln > 0 && Math.floor(gridT * 14) % 2 === 0;
      if (!blink) {
        ctx.save();
        ctx.translate(player.x, player.y);
        ctx.rotate(player.aim);
        ctx.strokeStyle = PAL.white;
        ctx.shadowColor = PAL.cyan;
        ctx.shadowBlur = 18;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(13, 0);
        ctx.lineTo(-8, 8);
        ctx.lineTo(-4, 0);
        ctx.lineTo(-8, -8);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }

      api.particles.render(ctx);
      ctx.restore();

      /* --- HUD ---------------------------------------------------------------- */
      drawMeters(ctx);
    },

    destroy() {},
  };

  /* --------------------------------------------------------------- meters  */

  function meter(ctx, x, y, w, label, cd, max, color) {
    const ready = cd <= 0;
    const frac = ready ? 1 : 1 - cd / max;
    ctx.fillStyle = alpha(PAL.dim, 0.35);
    ctx.fillRect(x, y, w, 5);
    ctx.fillStyle = ready ? color : alpha(color, 0.55);
    ctx.fillRect(x, y, w * frac, 5);
    if (ready) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.strokeRect(x - 0.5, y - 0.5, w + 1, 6);
      ctx.restore();
    }
    text(ctx, label, x, y - 10, { size: 8, color: ready ? color : PAL.dim });
  }

  function drawMeters(ctx) {
    const y = VIEW_H - 12;
    meter(ctx, 14, y, 74, 'RICOCHET', cdLaser, CD_LASER, PAL.yellow);
    meter(ctx, 100, y, 74, 'BLACK HOLE', cdBomb, CD_BOMB, PAL.violet);
    meter(ctx, 186, y, 74, 'EMP', cdEmp, CD_EMP, PAL.cyan);

    if (mult > 1) {
      text(ctx, 'x' + mult, VIEW_W - 16, VIEW_H - 26, {
        size: 20, color: PAL.magenta, align: 'right', glow: 12,
      });
    }
    // Lives as little ships.
    for (let i = 0; i < Math.max(0, lives - 1); i++) {
      ctx.save();
      ctx.strokeStyle = PAL.cyan;
      ctx.lineWidth = 1;
      ctx.translate(VIEW_W - 22 - i * 14, 16);
      ctx.beginPath();
      ctx.moveTo(6, 0); ctx.lineTo(-4, 4); ctx.lineTo(-2, 0); ctx.lineTo(-4, -4);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
    if (!enemies.length && !spawnQueue.length && waveT > 0 && wave > 0) {
      text(ctx, 'WAVE CLEARED', VIEW_W / 2, VIEW_H * 0.42, {
        size: 14, color: PAL.lime, align: 'center', glow: 12,
      });
    }
  }
}
