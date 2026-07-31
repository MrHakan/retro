/**
 * 07 — ARKANOID / BREAKOUT REBOUND
 *
 * Deflection is positional, not reflective: where the ball meets the paddle
 * decides the exit angle, so the paddle is an aiming device rather than a wall.
 * Ball motion is substepped and resolved with `circleRect` normals, which keeps
 * the collisions honest even after the speed ramp has had its way.
 *
 * Brick vocabulary: 1/2/3-hit blocks, indestructible steel, and volatile cells
 * that chain-detonate their neighbours. Six procedural layouts cycle across
 * eight levels, each pass stiffening the brick mix.
 */

import { PAL, TAU, clamp, damp, alpha, mix, circleRect, text } from '../core/fx.js';

const VIEW = { w: 420, h: 480 };

/* --------------------------------------------------------------- geometry */

const WALL = 8;                       // side/top frame thickness
const COLS = 11;
const ROWS = 12;
const GX = 12;
const GY = 54;
const BW = (VIEW.w - GX * 2) / COLS;
const BH = 17;

const PADDLE_Y = VIEW.h - 38;
const PADDLE_H = 9;
const PADDLE_W = 74;
const PADDLE_WIDE = 112;
const PADDLE_SPEED = 430;

const BALL_R = 4.5;
const SPEED_BASE = 210;
const SPEED_GROWTH = 5;               // px/s gained per second inside a level
const SPEED_CAP = 400;
const MAX_ANGLE = 1.06;               // ~61 degrees off vertical at the edges
const MAX_LEVEL = 8;

/* ------------------------------------------------------------ brick kinds */

const STEEL = 4;
const BOMB = 5;

const BRICK_COLOR = {
  1: PAL.cyan,
  2: PAL.lime,
  3: PAL.violet,
  [STEEL]: '#7d8aa6',
  [BOMB]: PAL.orange,
};

/* --------------------------------------------------------------- powerups */

const POWERS = {
  M: { name: 'MULTI-BALL', color: PAL.magenta },
  W: { name: 'WIDE PADDLE', color: PAL.lime },
  L: { name: 'LASER CANNON', color: PAL.red },
  G: { name: 'MAGNET GRIP', color: PAL.violet },
  S: { name: 'SLOW BALL', color: PAL.blue },
  P: { name: 'EXTRA LIFE', color: PAL.yellow },
};
const POWER_KEYS = ['M', 'W', 'L', 'G', 'S', 'P'];
const POWER_WEIGHT = [24, 20, 16, 14, 16, 10];

export const meta = {
  id: 'breakout',
  title: 'ARKANOID / BREAKOUT REBOUND',
  short: 'REBOUND',
  category: 'ARCADE',
  desc: 'Positional paddle deflection, chain-detonating bomb bricks and six '
      + 'procedural layouts. Catch capsules for multi-ball, lasers, magnet grip '
      + 'and more across eight escalating levels.',
  accent: PAL.magenta,
  view: VIEW,
  controls: [
    'MOUSE / DRAG — move paddle',
    'LEFT / RIGHT — move paddle',
    'SPACE — launch / fire / release',
  ],
  touch: { buttons: [{ id: 'a', label: 'FIRE' }] },
  art(ctx, w, h, accent) {
    ctx.save();
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);
    const cols = 8;
    const bw = (w - 24) / cols;
    const colors = [PAL.cyan, PAL.lime, PAL.violet, accent];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 1 && (c === 3 || c === 4)) {
          ctx.fillStyle = '#7d8aa6';
        } else {
          ctx.fillStyle = colors[(r + c) % colors.length];
        }
        ctx.globalAlpha = 0.9;
        ctx.fillRect(12 + c * bw + 1, 22 + r * 13, bw - 3, 10);
      }
    }
    ctx.globalAlpha = 1;
    // Ball + trail.
    ctx.fillStyle = PAL.white;
    ctx.shadowColor = PAL.white;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(150, 108, 5, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.35;
    for (let i = 1; i < 5; i++) {
      ctx.beginPath();
      ctx.arc(150 + i * 9, 108 + i * 8, 5 - i * 0.8, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Paddle.
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 16;
    ctx.fillRect(84, 152, 74, 8);
    // Falling capsule.
    ctx.fillStyle = PAL.yellow;
    ctx.shadowColor = PAL.yellow;
    ctx.fillRect(190, 118, 22, 11);
    ctx.restore();
  },
};

export function create(api) {
  /* ---------------------------------------------------------------- state */
  /** @type {({hp:number,max:number,kind:number,flash:number}|null)[]} row-major */
  let bricks;
  let remaining;                  // destructible bricks still standing
  let level, lives, over;

  let paddle;                     // {x, w, targetW, glow}
  let paddleTarget;
  let balls, bolts, caps;
  let ballSpeed, slowT, laserT, magnetT, wideT, laserCd;
  let stickyBall;                 // ball currently glued to the paddle
  let levelBanner;

  /* ------------------------------------------------------------- geometry */

  const left = WALL + 1;
  const right = VIEW.w - WALL - 1;
  const top = WALL + 1;

  const idx = (c, r) => r * COLS + c;
  const brickX = (c) => GX + c * BW + 1;
  const brickY = (r) => GY + r * BH + 1;
  const BRW = BW - 2;
  const BRH = BH - 2;

  /* ------------------------------------------------------------- layouts */

  /**
   * Six hand-shaped procedural patterns. `tier` (0..) hardens the brick mix as
   * the level counter laps the pattern list.
   */
  function buildLevel(lv) {
    bricks = new Array(COLS * ROWS).fill(null);
    const pattern = (lv - 1) % 6;
    const tier = Math.floor((lv - 1) / 6);
    const harden = (base) => clamp(base + tier, 1, 3);

    const put = (c, r, kind) => {
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS || !kind) return;
      const hp = kind === STEEL ? Infinity : (kind === BOMB ? 1 : kind);
      bricks[idx(c, r)] = { hp, max: hp, kind, flash: 0 };
    };

    switch (pattern) {
      case 0: { // CLASSIC ROWS — hp climbs with height, a steel band on top
        const rows = 6 + Math.min(2, tier);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < COLS; c++) {
            if (r === 0 && tier > 0) { put(c, r, STEEL); continue; }
            const k = harden(1 + ((rows - r - 1) / 2) | 0);
            put(c, r, api.rng.chance(0.06) ? BOMB : k);
          }
        }
        break;
      }
      case 1: { // PYRAMID
        const rows = 8;
        const mid = (COLS - 1) / 2;
        for (let r = 0; r < rows; r++) {
          const span = Math.floor((r / (rows - 1)) * mid) + 1;
          for (let c = 0; c < COLS; c++) {
            if (Math.abs(c - mid) > span) continue;
            const edge = Math.abs(Math.abs(c - mid) - span) < 0.5;
            put(c, r, edge && r > 3 ? STEEL : harden(1 + (r > 4 ? 1 : 0)));
          }
        }
        put(Math.round(mid), 0, BOMB);
        break;
      }
      case 2: { // CHECKERBOARD with a steel weave
        for (let r = 0; r < 9; r++) {
          for (let c = 0; c < COLS; c++) {
            if ((c + r) % 2) continue;
            if ((c + r) % 6 === 0 && r > 2) put(c, r, STEEL);
            else put(c, r, api.rng.chance(0.08) ? BOMB : harden(1 + (r % 3 === 0 ? 1 : 0)));
          }
        }
        break;
      }
      case 3: { // DIAMOND
        const mid = (COLS - 1) / 2;
        const rows = 10;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < COLS; c++) {
            const d = Math.abs(c - mid) + Math.abs(r - rows / 2) * 0.9;
            if (d > mid + 0.6) continue;
            if (d < 1.6) put(c, r, BOMB);
            else if (d > mid - 0.9) put(c, r, harden(3));
            else put(c, r, harden(1 + ((mid - d) / 2) | 0));
          }
        }
        break;
      }
      case 4: { // FORTRESS — steel shell, volatile core
        const r0 = 1;
        const r1 = 8;
        for (let r = r0; r <= r1; r++) {
          for (let c = 1; c < COLS - 1; c++) {
            const shell = r === r0 || r === r1 || c === 1 || c === COLS - 2;
            const core = r > r0 + 1 && r < r1 - 1 && c > 2 && c < COLS - 3;
            if (shell) put(c, r, STEEL);
            else if (core) put(c, r, (r + c) % 5 === 0 ? BOMB : harden(2));
            else put(c, r, harden(1));
          }
        }
        // Two gaps in the shell, otherwise the core is unreachable.
        bricks[idx(1, r0 + 2)] = null;
        bricks[idx(COLS - 2, r1 - 2)] = null;
        break;
      }
      default: { // WAVE
        for (let c = 0; c < COLS; c++) {
          const base = 2 + Math.round(2.6 + Math.sin((c / COLS) * TAU * 1.5) * 2.4);
          for (let r = base - 3; r <= base + 2; r++) {
            if (r < 0 || r >= ROWS) continue;
            const k = r === base + 2 ? STEEL : harden(1 + (r === base ? 1 : 0));
            put(c, r, api.rng.chance(0.07) ? BOMB : k);
          }
        }
        break;
      }
    }

    remaining = 0;
    for (const b of bricks) if (b && b.kind !== STEEL) remaining++;
  }

  /* -------------------------------------------------------------- helpers */

  function newBall(x, y, vx, vy) {
    return { x, y, vx, vy, r: BALL_R, stuck: false, off: 0, trail: [] };
  }

  function effSpeed() {
    return ballSpeed * (slowT > 0 ? 0.66 : 1);
  }

  function serve() {
    balls.length = 0;
    const b = newBall(paddle.x, PADDLE_Y - BALL_R - 1, 0, -1);
    b.stuck = true;
    b.off = 0;
    balls.push(b);
    stickyBall = b;
  }

  function launch(b) {
    b.stuck = false;
    stickyBall = null;
    const t = clamp(b.off / (paddle.w / 2), -1, 1);
    // A dead-centre launch would ping-pong straight up forever; tilt it.
    const a = -Math.PI / 2 + (t === 0 ? api.rng.range(-0.45, 0.45) : t * MAX_ANGLE * 0.7);
    const s = effSpeed();
    b.vx = Math.cos(a) * s;
    b.vy = Math.sin(a) * s;
    api.sfx('bounce', { detune: 4 });
  }

  /** Positional deflection: the contact point picks the exit angle. */
  function paddleBounce(b) {
    const t = clamp((b.x - paddle.x) / (paddle.w / 2 + b.r), -1, 1);
    const a = -Math.PI / 2 + t * MAX_ANGLE;
    const s = effSpeed();
    b.vx = Math.cos(a) * s;
    b.vy = Math.sin(a) * s;
    b.y = PADDLE_Y - b.r - 0.5;
    paddle.glow = 1;
    api.sfx('bounce', { detune: t * 3 });
    api.particles.burst(b.x, PADDLE_Y, 6, {
      speed: 90, life: 0.3, size: 2, dir: -Math.PI / 2, spread: 1.9,
      color: [PAL.magenta, PAL.white], glow: 8, drag: 3,
    });
  }

  function dropCapsule(x, y) {
    let total = 0;
    for (const w of POWER_WEIGHT) total += w;
    let roll = api.rng.range(0, total);
    let kind = 'M';
    for (let i = 0; i < POWER_KEYS.length; i++) {
      roll -= POWER_WEIGHT[i];
      if (roll <= 0) { kind = POWER_KEYS[i]; break; }
    }
    caps.push({ x, y, vy: 92, kind, spin: 0 });
  }

  function collect(cap) {
    const p = POWERS[cap.kind];
    api.sfx('powerup');
    api.addScore(60);
    api.particles.popText(cap.x, cap.y - 8, p.name, p.color, 1.1);
    api.particles.burst(cap.x, cap.y, 14, {
      speed: 120, life: 0.5, size: 2.5, color: [p.color, PAL.white], glow: 10, drag: 2.6,
    });

    switch (cap.kind) {
      case 'M': {
        // Split every live ball into three, capped so the frame budget holds.
        const spawn = [];
        for (const b of balls) {
          if (balls.length + spawn.length >= 6) break;
          for (const da of [-0.42, 0.42]) {
            if (balls.length + spawn.length >= 6) break;
            const a = Math.atan2(b.vy, b.vx) + da;
            const s = effSpeed();
            spawn.push(newBall(b.x, b.y, Math.cos(a) * s, Math.sin(a) * s));
          }
        }
        if (stickyBall) launch(stickyBall);
        for (const b of spawn) balls.push(b);
        break;
      }
      case 'W': wideT = 16; break;
      case 'L': laserT = 14; break;
      case 'G': magnetT = 14; break;
      case 'S': slowT = 9; break;
      case 'P':
        lives++;
        api.setStatus({ LEVEL: level, LIVES: lives });
        break;
      default: break;
    }
  }

  /* --------------------------------------------------------------- bricks */

  function brickPoints(b) {
    if (b.kind === BOMB) return 90;
    return 40 + b.max * 20;
  }

  function crumble(c, r, b, big) {
    const x = brickX(c) + BRW / 2;
    const y = brickY(r) + BRH / 2;
    const col = BRICK_COLOR[b.kind];
    api.particles.burst(x, y, big ? 16 : 9, {
      speed: big ? 190 : 110, life: big ? 0.7 : 0.45, size: 2.6, jitter: BRW * 0.7,
      color: [col, PAL.white, mix(col, PAL.bg, 0.4)], glow: 8, drag: 1.6, gravity: 320,
    });
  }

  /**
   * Damage a brick. Steel only rings. Bombs detonate their 8-neighbourhood and
   * chain through other bombs via the `queue`.
   */
  function hitBrick(c, r, dmg = 1, queue = null) {
    const b = bricks[idx(c, r)];
    if (!b) return false;
    if (b.kind === STEEL) {
      b.flash = 0.18;
      api.sfx('hit', { vol: 0.5, detune: 6 });
      return false;
    }
    b.hp -= dmg;
    b.flash = 0.14;
    if (b.hp > 0) {
      api.sfx('brick', { detune: -3 });
      api.addScore(10);
      api.particles.burst(brickX(c) + BRW / 2, brickY(r) + BRH / 2, 4, {
        speed: 70, life: 0.3, size: 2, color: BRICK_COLOR[b.kind], glow: 6, drag: 2.4, gravity: 260,
      });
      return false;
    }

    // Destroyed.
    bricks[idx(c, r)] = null;
    remaining--;
    api.addScore(brickPoints(b));
    const bomb = b.kind === BOMB;
    crumble(c, r, b, bomb);
    if (bomb) {
      api.sfx('boom');
      api.shakeScreen(7, 6);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
          const nb = bricks[idx(nc, nr)];
          if (!nb) continue;
          if (nb.kind === BOMB && queue) queue.push([nc, nr]);
          else hitBrick(nc, nr, 3, queue);
        }
      }
    } else {
      api.sfx('brick');
    }
    if (api.rng.chance(bomb ? 0.3 : 0.16)) dropCapsule(brickX(c) + BRW / 2, brickY(r) + BRH / 2);
    return true;
  }

  /** Entry point that owns the chain-reaction queue. */
  function damageBrick(c, r, dmg = 1) {
    const queue = [];
    const killed = hitBrick(c, r, dmg, queue);
    let guard = 0;
    while (queue.length && guard++ < 200) {
      const [qc, qr] = queue.shift();
      if (bricks[idx(qc, qr)]) hitBrick(qc, qr, 99, queue);
    }
    return killed;
  }

  /* ---------------------------------------------------------- ball physics */

  /** One substep of motion + resolution. Returns false if the ball is lost. */
  function stepBall(b, dt) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (b.x - b.r < left) { b.x = left + b.r; b.vx = Math.abs(b.vx); api.sfx('blip', { vol: 0.4 }); }
    else if (b.x + b.r > right) { b.x = right - b.r; b.vx = -Math.abs(b.vx); api.sfx('blip', { vol: 0.4 }); }
    if (b.y - b.r < top) { b.y = top + b.r; b.vy = Math.abs(b.vy); api.sfx('blip', { vol: 0.4 }); }

    // --- bricks: only test the cells the ball's disc can actually overlap ---
    if (b.y - b.r < GY + ROWS * BH && b.y + b.r > GY) {
      const c0 = clamp(Math.floor((b.x - b.r - GX) / BW), 0, COLS - 1);
      const c1 = clamp(Math.floor((b.x + b.r - GX) / BW), 0, COLS - 1);
      const r0 = clamp(Math.floor((b.y - b.r - GY) / BH), 0, ROWS - 1);
      const r1 = clamp(Math.floor((b.y + b.r - GY) / BH), 0, ROWS - 1);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (!bricks[idx(c, r)]) continue;
          const hit = circleRect(b.x, b.y, b.r, brickX(c), brickY(r), BRW, BRH);
          if (!hit) continue;
          // Push out along the contact normal, then mirror the velocity.
          b.x += hit.nx * hit.depth;
          b.y += hit.ny * hit.depth;
          const d = b.vx * hit.nx + b.vy * hit.ny;
          if (d < 0) {
            b.vx -= 2 * d * hit.nx;
            b.vy -= 2 * d * hit.ny;
          }
          damageBrick(c, r, 1);
          return true;
        }
      }
    }

    // --- paddle ---
    const px = paddle.x - paddle.w / 2;
    if (b.vy > 0 && circleRect(b.x, b.y, b.r, px, PADDLE_Y, paddle.w, PADDLE_H)) {
      if (magnetT > 0 && !stickyBall) {
        b.stuck = true;
        b.off = clamp(b.x - paddle.x, -paddle.w / 2, paddle.w / 2);
        b.vx = 0;
        b.vy = 0;
        b.y = PADDLE_Y - b.r - 1;
        stickyBall = b;
        api.sfx('pickup', { vol: 0.7 });
      } else {
        paddleBounce(b);
      }
      return true;
    }

    return b.y - b.r <= VIEW.h;
  }

  function loseBall() {
    lives--;
    api.sfx('hurt');
    api.shakeScreen(9, 5);
    api.vibrate(90);
    wideT = laserT = magnetT = slowT = 0;
    caps.length = 0;
    bolts.length = 0;
    api.setStatus({ LEVEL: level, LIVES: Math.max(0, lives) });
    if (lives <= 0) {
      over = true;
      api.gameOver({
        message: 'OUT OF BALLS',
        stats: { LEVEL: level, 'BRICKS LEFT': remaining, CLEARED: `${level - 1}/${MAX_LEVEL}` },
      });
      return;
    }
    ballSpeed = SPEED_BASE + (level - 1) * 14;
    serve();
  }

  function nextLevel() {
    if (level >= MAX_LEVEL) {
      over = true;
      api.win({
        message: 'ALL SECTORS CLEARED',
        stats: { LEVELS: MAX_LEVEL, 'LIVES LEFT': lives, CLEARED: `${MAX_LEVEL}/${MAX_LEVEL}` },
      });
      return;
    }
    level++;
    api.addScore(500 + level * 100);
    api.sfx('levelup');
    levelBanner = 1.6;
    caps.length = 0;
    bolts.length = 0;
    wideT = laserT = magnetT = slowT = 0;
    ballSpeed = SPEED_BASE + (level - 1) * 14;
    buildLevel(level);
    serve();
    api.setStatus({ LEVEL: level, LIVES: lives });
  }

  function fire() {
    if (stickyBall) {
      launch(stickyBall);
      return;
    }
    if (laserT > 0 && laserCd <= 0) {
      laserCd = 0.22;
      const y = PADDLE_Y - 4;
      bolts.push({ x: paddle.x - paddle.w / 2 + 4, y });
      bolts.push({ x: paddle.x + paddle.w / 2 - 4, y });
      api.sfx('laser', { vol: 0.5 });
    }
  }

  /* ------------------------------------------------------------- drawing  */

  function drawBrick(ctx, c, r, b) {
    const x = brickX(c);
    const y = brickY(r);
    const col = BRICK_COLOR[b.kind];

    if (b.kind === STEEL) {
      ctx.fillStyle = '#2a3244';
      ctx.fillRect(x, y, BRW, BRH);
      ctx.strokeStyle = b.flash > 0 ? PAL.white : '#7d8aa6';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, BRW - 1, BRH - 1);
      ctx.strokeStyle = alpha('#9fb0cc', 0.35);
      ctx.beginPath();
      for (let i = -BRH; i < BRW; i += 6) {
        ctx.moveTo(x + i, y + BRH);
        ctx.lineTo(x + i + BRH, y);
      }
      ctx.stroke();
      return;
    }

    if (b.kind === BOMB) {
      const pulse = 0.6 + 0.4 * Math.sin(api.time * 8 + c + r);
      ctx.save();
      ctx.shadowColor = PAL.orange;
      ctx.shadowBlur = 10 * pulse;
      ctx.fillStyle = mix('#3a1c08', PAL.orange, 0.35 + pulse * 0.3);
      ctx.fillRect(x, y, BRW, BRH);
      ctx.restore();
      ctx.fillStyle = PAL.yellow;
      ctx.beginPath();
      ctx.arc(x + BRW / 2, y + BRH / 2, 3.2, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = alpha(PAL.yellow, 0.8);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, BRW - 1, BRH - 1);
      return;
    }

    // Damage reads as both a colour shift and visible cracks.
    const wear = 1 - b.hp / b.max;
    ctx.fillStyle = b.flash > 0 ? PAL.white : mix(col, '#20293c', wear * 0.55);
    ctx.fillRect(x, y, BRW, BRH);
    ctx.fillStyle = alpha(PAL.white, 0.18);
    ctx.fillRect(x, y, BRW, 2);
    ctx.fillStyle = alpha('#000', 0.25);
    ctx.fillRect(x, y + BRH - 2, BRW, 2);
    if (wear > 0) {
      ctx.strokeStyle = alpha('#04070c', 0.75);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + BRW * 0.2, y);
      ctx.lineTo(x + BRW * 0.34, y + BRH * 0.55);
      ctx.lineTo(x + BRW * 0.2, y + BRH);
      if (wear > 0.5) {
        ctx.moveTo(x + BRW * 0.7, y);
        ctx.lineTo(x + BRW * 0.58, y + BRH * 0.5);
        ctx.lineTo(x + BRW * 0.78, y + BRH);
      }
      ctx.stroke();
    }
  }

  function drawPaddle(ctx) {
    const x = paddle.x - paddle.w / 2;
    ctx.save();
    ctx.shadowColor = magnetT > 0 ? PAL.violet : PAL.magenta;
    ctx.shadowBlur = 12 + paddle.glow * 20;
    ctx.fillStyle = magnetT > 0 ? PAL.violet : PAL.magenta;
    ctx.fillRect(x, PADDLE_Y, paddle.w, PADDLE_H);
    ctx.fillStyle = alpha(PAL.white, 0.7 + paddle.glow * 0.3);
    ctx.fillRect(x + 3, PADDLE_Y + 1.5, paddle.w - 6, 2);
    ctx.restore();

    if (laserT > 0) {
      ctx.save();
      ctx.shadowColor = PAL.red;
      ctx.shadowBlur = 10;
      ctx.fillStyle = PAL.red;
      ctx.fillRect(x + 1, PADDLE_Y - 6, 4, 6);
      ctx.fillRect(x + paddle.w - 5, PADDLE_Y - 6, 4, 6);
      ctx.restore();
    }
    if (magnetT > 0) {
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.25 * Math.sin(api.time * 9);
      ctx.strokeStyle = PAL.violet;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(paddle.x, PADDLE_Y + 2, paddle.w * 0.62, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  return {
    init() {
      level = 1;
      lives = 3;
      over = false;
      paddle = { x: VIEW.w / 2, w: PADDLE_W, glow: 0 };
      paddleTarget = VIEW.w / 2;
      balls = [];
      bolts = [];
      caps = [];
      ballSpeed = SPEED_BASE;
      slowT = laserT = magnetT = wideT = 0;
      laserCd = 0;
      stickyBall = null;
      levelBanner = 1.4;
      buildLevel(level);
      serve();
      api.setStatus({ LEVEL: level, LIVES: lives });
    },

    update(dt) {
      if (over) return;

      /* --- timers --- */
      if (levelBanner > 0) levelBanner -= dt;
      if (slowT > 0) slowT -= dt;
      if (laserT > 0) laserT -= dt;
      if (magnetT > 0) magnetT -= dt;
      if (wideT > 0) wideT -= dt;
      if (laserCd > 0) laserCd -= dt;
      paddle.glow = Math.max(0, paddle.glow - dt * 4);
      ballSpeed = Math.min(SPEED_CAP, ballSpeed + SPEED_GROWTH * dt);

      /* --- paddle: keys nudge the same target the pointer sets --- */
      const ax = api.input.axis('left', 'right');
      if (ax) paddleTarget += ax * PADDLE_SPEED * dt;
      paddle.w = damp(paddle.w, wideT > 0 ? PADDLE_WIDE : PADDLE_W, 9, dt);
      const half = paddle.w / 2;
      paddleTarget = clamp(paddleTarget, left + half, right - half);
      paddle.x = clamp(damp(paddle.x, paddleTarget, 30, dt), left + half, right - half);

      /* --- auto-fire while the button is held (lasers) --- */
      if (api.input.isDown('a') && laserT > 0 && !stickyBall) fire();

      /* --- balls: substepped so nothing tunnels at 400 px/s --- */
      const s = effSpeed();
      for (let i = balls.length - 1; i >= 0; i--) {
        const b = balls[i];
        if (b.stuck) {
          b.x = clamp(paddle.x + b.off, left + b.r, right - b.r);
          b.y = PADDLE_Y - b.r - 1;
          b.trail.length = 0;
          continue;
        }
        // Renormalise so power-ups and angle changes never bleed speed away.
        const mag = Math.hypot(b.vx, b.vy) || 1;
        b.vx = (b.vx / mag) * s;
        b.vy = (b.vy / mag) * s;
        // A near-horizontal ball can stall the level; nudge it back off the axis.
        if (Math.abs(b.vy) < s * 0.22) {
          b.vy = (b.vy >= 0 ? 1 : -1) * s * 0.22;
          const nm = Math.hypot(b.vx, b.vy) || 1;
          b.vx = (b.vx / nm) * s;
          b.vy = (b.vy / nm) * s;
        }

        const steps = Math.max(1, Math.ceil((s * dt) / (b.r * 0.8)));
        const sub = dt / steps;
        let alive = true;
        for (let k = 0; k < steps && alive; k++) alive = stepBall(b, sub);

        b.trail.push(b.x, b.y);
        if (b.trail.length > 18) b.trail.splice(0, 2);

        if (!alive) {
          api.particles.burst(b.x, VIEW.h - 4, 10, {
            speed: 130, life: 0.5, size: 2.4, dir: -Math.PI / 2, spread: 2,
            color: [PAL.red, PAL.white], glow: 8, drag: 2.4,
          });
          balls.splice(i, 1);
          if (b === stickyBall) stickyBall = null;
        }
      }
      if (!balls.length) {
        loseBall();
        if (over) return;
      }

      /* --- laser bolts --- */
      for (let i = bolts.length - 1; i >= 0; i--) {
        const p = bolts[i];
        p.y -= 460 * dt;
        let gone = p.y < top;
        if (!gone && p.y < GY + ROWS * BH && p.y > GY) {
          const c = Math.floor((p.x - GX) / BW);
          const r = Math.floor((p.y - GY) / BH);
          if (c >= 0 && c < COLS && r >= 0 && r < ROWS && bricks[idx(c, r)]) {
            damageBrick(c, r, 1);
            gone = true;
          }
        }
        if (gone) bolts.splice(i, 1);
      }

      /* --- falling capsules --- */
      for (let i = caps.length - 1; i >= 0; i--) {
        const cp = caps[i];
        cp.y += cp.vy * dt;
        cp.spin += dt * 4;
        if (cp.y > PADDLE_Y - 6 && cp.y < PADDLE_Y + PADDLE_H + 6
            && Math.abs(cp.x - paddle.x) < paddle.w / 2 + 12) {
          collect(cp);
          caps.splice(i, 1);
        } else if (cp.y > VIEW.h + 12) {
          caps.splice(i, 1);
        }
      }

      /* --- brick flashes + level clear --- */
      for (const b of bricks) if (b && b.flash > 0) b.flash -= dt;
      if (remaining <= 0) nextLevel();
    },

    handleInput(e) {
      if (e.type === 'press' && (e.action === 'a' || e.action === 'up')) fire();
      // The paddle tracks a dragged finger, or the mouse whether or not it is held.
      else if (e.type === 'pointerdown') paddleTarget = e.x;
      else if (e.type === 'pointermove' && (e.down || e.pointerType === 'mouse')) paddleTarget = e.x;
    },

    render(ctx) {
      const W = VIEW.w;
      const H = VIEW.h;

      // Backdrop: deep field + subtle vertical shafts.
      ctx.fillStyle = '#05070d';
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = 0.16;
      for (let i = 0; i < COLS; i++) {
        ctx.fillStyle = i % 2 ? '#0b1120' : '#0d1526';
        ctx.fillRect(GX + i * BW, 0, BW, H);
      }
      ctx.restore();

      // Frame.
      ctx.save();
      ctx.shadowColor = PAL.cyan;
      ctx.shadowBlur = 8;
      ctx.strokeStyle = alpha(PAL.cyan, 0.55);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(WALL, H);
      ctx.lineTo(WALL, WALL);
      ctx.lineTo(W - WALL, WALL);
      ctx.lineTo(W - WALL, H);
      ctx.stroke();
      ctx.restore();

      // Bricks.
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const b = bricks[idx(c, r)];
          if (b) drawBrick(ctx, c, r, b);
        }
      }

      // Capsules with their letter.
      for (const cp of caps) {
        const p = POWERS[cp.kind];
        const w = 22 + Math.sin(cp.spin) * 3;
        ctx.save();
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = p.color;
        ctx.fillRect(cp.x - w / 2, cp.y - 6, w, 12);
        ctx.fillStyle = '#05070d';
        ctx.fillRect(cp.x - w / 2 + 2, cp.y - 4, w - 4, 8);
        ctx.restore();
        text(ctx, cp.kind, cp.x, cp.y, { size: 9, color: p.color, align: 'center', baseline: 'middle' });
      }

      // Laser bolts.
      ctx.save();
      ctx.shadowColor = PAL.red;
      ctx.shadowBlur = 8;
      ctx.fillStyle = PAL.red;
      for (const p of bolts) ctx.fillRect(p.x - 1, p.y - 8, 2, 9);
      ctx.restore();

      drawPaddle(ctx);

      // Ball trails, then the balls.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const b of balls) {
        const n = b.trail.length / 2;
        for (let i = 0; i < n; i++) {
          ctx.globalAlpha = ((i + 1) / n) * 0.3;
          ctx.fillStyle = slowT > 0 ? PAL.blue : PAL.cyan;
          const rr = b.r * (0.3 + (i / n) * 0.6);
          ctx.beginPath();
          ctx.arc(b.trail[i * 2], b.trail[i * 2 + 1], rr, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
      ctx.save();
      ctx.shadowColor = PAL.white;
      ctx.shadowBlur = 14;
      ctx.fillStyle = PAL.white;
      for (const b of balls) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      api.particles.render(ctx);

      // Active power-up ribbon.
      let bx = WALL + 4;
      const ribbon = [['W', wideT, 16], ['L', laserT, 14], ['G', magnetT, 14], ['S', slowT, 9]];
      for (const [k, t, dur] of ribbon) {
        if (t <= 0) continue;
        const p = POWERS[k];
        ctx.fillStyle = alpha(p.color, 0.25);
        ctx.fillRect(bx, H - 12, 46, 4);
        ctx.fillStyle = p.color;
        ctx.fillRect(bx, H - 12, 46 * clamp(t / dur, 0, 1), 4);
        text(ctx, p.name.split(' ')[0], bx, H - 22, { size: 7, color: p.color });
        bx += 52;
      }

      // Life pips.
      for (let i = 0; i < Math.min(lives, 8); i++) {
        ctx.fillStyle = alpha(PAL.magenta, 0.9);
        ctx.fillRect(W - WALL - 6 - i * 9, H - 12, 6, 4);
      }

      if (stickyBall) {
        text(ctx, api.isTouch ? 'TAP FIRE TO LAUNCH' : 'SPACE TO LAUNCH', W / 2, PADDLE_Y - 26,
          { size: 9, color: alpha(PAL.white, 0.7), align: 'center' });
      }

      if (levelBanner > 0) {
        const a = clamp(levelBanner / 1.4, 0, 1);
        ctx.save();
        ctx.globalAlpha = a;
        text(ctx, 'LEVEL ' + level, W / 2, H * 0.42, {
          size: 26, color: PAL.cyan, align: 'center', baseline: 'middle', glow: 16,
        });
        ctx.restore();
      }
    },

    destroy() {
      balls = bolts = caps = null;
    },
  };
}
