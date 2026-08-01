/**
 * 01 — NEON CYBER-SNAKE
 * Grid serpent with a directional input buffer, wrap-around portals,
 * destructible datawalls and four power-ups.
 */

import { PAL, TAU, alpha, glowRect, text } from '../core/fx.js';

const COLS = 24;
const ROWS = 20;
const CELL = 20;

const POWERS = {
  speed: { color: PAL.yellow, label: 'OVERCLOCK', dur: 6 },
  ghost: { color: PAL.violet, label: 'GHOST', dur: 7 },
  breaker: { color: PAL.orange, label: 'BREAKER', dur: 8 },
  multi: { color: PAL.magenta, label: 'x3 SCORE', dur: 8 },
};
const POWER_KEYS = Object.keys(POWERS);

export const meta = {
  id: 'snake',
  title: 'NEON CYBER-SNAKE',
  short: 'CYBER-SNAKE',
  category: 'ARCADE',
  desc: 'Grid-locked serpent in a neon datagrid. Edges are portals, walls are '
      + 'destructible, and four power-ups rewrite the rules mid-run.',
  accent: PAL.lime,
  view: { w: COLS * CELL, h: ROWS * CELL },
  controls: [
    'ARROWS / WASD — turn',
    'SPACE — dash (burns 1 length)',
    'P — pause',
  ],
  touch: { dpad: true, buttons: [{ id: 'a', label: 'DASH' }] },
  art(ctx, w, h, accent) {
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 12;
    ctx.fillStyle = accent;
    const s = 15;
    const path = [[2, 3], [3, 3], [4, 3], [5, 3], [5, 4], [5, 5], [6, 5], [7, 5]];
    for (const [cx, cy] of path) ctx.fillRect(20 + cx * s, 22 + cy * s, s - 3, s - 3);
    ctx.fillStyle = PAL.magenta;
    ctx.shadowColor = PAL.magenta;
    ctx.fillRect(20 + 10 * s, 22 + 2 * s, s - 3, s - 3);
    ctx.fillStyle = PAL.yellow;
    ctx.shadowColor = PAL.yellow;
    ctx.fillRect(20 + 9 * s, 22 + 6 * s, s - 3, s - 3);
    ctx.restore();
  },
};

export function create(api) {
  /** @type {{x:number,y:number}[]} head-first */
  let snake;
  let dir, pendingDirs;
  let stepTime, stepTimer;
  let food, powerUp, walls;
  let grow, alive, level, eaten;
  let active;          // { [power]: secondsRemaining }
  let flash, portalPulse, dashCooldown;

  const key = (x, y) => y * COLS + x;

  function occupied(x, y, ignoreTail = true) {
    const end = ignoreTail ? snake.length - 1 : snake.length;
    for (let i = 0; i < end; i++) if (snake[i].x === x && snake[i].y === y) return true;
    return false;
  }

  function freeCell() {
    for (let tries = 0; tries < 400; tries++) {
      const x = api.rng.int(0, COLS - 1);
      const y = api.rng.int(0, ROWS - 1);
      if (occupied(x, y, false)) continue;
      if (walls.has(key(x, y))) continue;
      if (food && food.x === x && food.y === y) continue;
      if (powerUp && powerUp.x === x && powerUp.y === y) continue;
      return { x, y };
    }
    return { x: 0, y: 0 };
  }

  function spawnFood() {
    food = freeCell();
    food.pulse = 0;
  }

  function spawnPower() {
    const kind = api.rng.pick(POWER_KEYS);
    powerUp = { ...freeCell(), kind, life: 9 };
  }

  function buildWalls(n) {
    walls = new Set();
    for (let i = 0; i < n; i++) {
      // Short horizontal or vertical bars, kept clear of the spawn corridor.
      const horiz = api.rng.chance(0.5);
      const len = api.rng.int(2, 4);
      const x0 = api.rng.int(2, COLS - 3 - (horiz ? len : 0));
      const y0 = api.rng.int(2, ROWS - 3 - (horiz ? 0 : len));
      for (let j = 0; j < len; j++) {
        const x = x0 + (horiz ? j : 0);
        const y = y0 + (horiz ? 0 : j);
        if (y === Math.floor(ROWS / 2) && x < 10) continue; // keep start row open
        walls.add(key(x, y));
      }
    }
  }

  function levelUp() {
    level++;
    api.setStatus({ LEVEL: level, LENGTH: snake.length });
    api.sfx('levelup');
    buildWalls(Math.min(9, level));
    stepTime = Math.max(0.055, 0.135 - level * 0.008);
    flash = 0.35;
  }

  function die(reason) {
    if (!alive) return;
    api.hitStop(0.08);
    api.flash(PAL.red, 0.45);
    alive = false;
    api.shakeScreen(12, 5);
    api.sfx('explosion');
    api.vibrate(120);
    for (const seg of snake) {
      api.particles.burst(seg.x * CELL + CELL / 2, seg.y * CELL + CELL / 2, 3, {
        speed: 120, life: 0.7, size: 3, color: [PAL.lime, PAL.cyan, PAL.white], glow: 8, drag: 2,
      });
    }
    api.gameOver({
      message: reason,
      stats: { LENGTH: snake.length, LEVEL: level, EATEN: eaten },
    });
  }

  function eatFood() {
    eaten++;
    grow += 2;
    const mult = active.multi > 0 ? 3 : 1;
    api.addScore((10 + level * 2) * mult);
    api.sfx('coin', { detune: Math.min(12, eaten * 0.4) });
    api.particles.burst(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, 12, {
      speed: 90, life: 0.5, size: 2.5, color: [PAL.magenta, PAL.white], glow: 10, drag: 3,
    });
    if (mult > 1) {
      api.particles.popText(food.x * CELL + CELL / 2, food.y * CELL, 'x3', PAL.magenta);
    }
    spawnFood();
    if (eaten % 5 === 0) levelUp();
    if (!powerUp && api.rng.chance(0.45)) spawnPower();
    api.setStatus({ LEVEL: level, LENGTH: snake.length + grow });
  }

  function takePower(kind) {
    const p = POWERS[kind];
    active[kind] = p.dur;
    api.sfx('powerup');
    api.addScore(25);
    api.particles.burst(powerUp.x * CELL + CELL / 2, powerUp.y * CELL + CELL / 2, 18, {
      speed: 130, life: 0.7, size: 3, color: [p.color, PAL.white], glow: 12, drag: 2.4,
    });
    api.particles.popText(powerUp.x * CELL + CELL / 2, powerUp.y * CELL - 4, p.label, p.color, 1.1);
    powerUp = null;
  }

  function step() {
    // Consume one buffered turn per step so a fast double-tap can't reverse
    // the snake into its own neck.
    while (pendingDirs.length) {
      const d = pendingDirs.shift();
      if (d.x === -dir.x && d.y === -dir.y && snake.length > 1) continue;
      dir = d;
      break;
    }

    const head = snake[0];
    let nx = head.x + dir.x;
    let ny = head.y + dir.y;

    // Screen edges are portals.
    let warped = false;
    if (nx < 0) { nx = COLS - 1; warped = true; }
    else if (nx >= COLS) { nx = 0; warped = true; }
    if (ny < 0) { ny = ROWS - 1; warped = true; }
    else if (ny >= ROWS) { ny = 0; warped = true; }

    if (warped) {
      portalPulse = 0.4;
      api.sfx('blip', { vol: 0.6 });
      api.particles.burst(nx * CELL + CELL / 2, ny * CELL + CELL / 2, 8, {
        speed: 70, life: 0.4, size: 2, color: PAL.cyan, glow: 10, drag: 3,
      });
    }

    const k = key(nx, ny);

    if (walls.has(k)) {
      if (active.breaker > 0) {
        walls.delete(k);
        api.addScore(15);
        api.sfx('brick');
        api.shakeScreen(4);
        api.particles.burst(nx * CELL + CELL / 2, ny * CELL + CELL / 2, 10, {
          speed: 110, life: 0.5, size: 3, color: [PAL.orange, PAL.yellow], glow: 8, gravity: 60, drag: 1.2,
        });
      } else {
        die('CRASHED INTO A DATAWALL');
        return;
      }
    }

    if (occupied(nx, ny) && active.ghost <= 0) {
      die('BIT YOUR OWN TAIL');
      return;
    }

    snake.unshift({ x: nx, y: ny });
    if (grow > 0) grow--;
    else snake.pop();

    // Neon trail off the tail tip.
    const tail = snake[snake.length - 1];
    api.particles.emit({
      x: tail.x * CELL + CELL / 2 + (Math.random() - 0.5) * 6,
      y: tail.y * CELL + CELL / 2 + (Math.random() - 0.5) * 6,
      vx: (Math.random() - 0.5) * 20,
      vy: (Math.random() - 0.5) * 20,
      life: 0.35, size: 2, color: active.ghost > 0 ? PAL.violet : PAL.lime, glow: 6, drag: 2,
    });

    if (food && nx === food.x && ny === food.y) eatFood();
    if (powerUp && nx === powerUp.x && ny === powerUp.y) takePower(powerUp.kind);
  }

  function dash() {
    if (dashCooldown > 0 || snake.length <= 3) {
      api.sfx('deny');
      return;
    }
    dashCooldown = 1.2;
    snake.pop();
    api.sfx('thrust');
    for (let i = 0; i < 3; i++) step();
    api.shakeScreen(3);
  }

  return {
    init() {
      const my = Math.floor(ROWS / 2);
      snake = [{ x: 6, y: my }, { x: 5, y: my }, { x: 4, y: my }, { x: 3, y: my }];
      dir = { x: 1, y: 0 };
      pendingDirs = [];
      stepTime = 0.135;
      stepTimer = 0;
      grow = 0;
      alive = true;
      level = 1;
      eaten = 0;
      flash = 0;
      portalPulse = 0;
      dashCooldown = 0;
      active = { speed: 0, ghost: 0, breaker: 0, multi: 0 };
      walls = new Set();
      powerUp = null;
      food = null;
      spawnFood();
      api.setStatus({ LEVEL: 1, LENGTH: snake.length });
    },

    update(dt) {
      if (!alive) return;

      for (const k of POWER_KEYS) {
        if (active[k] > 0) {
          active[k] = Math.max(0, active[k] - dt);
          if (active[k] === 0) api.sfx('back', { vol: 0.5 });
        }
      }
      if (dashCooldown > 0) dashCooldown -= dt;
      if (flash > 0) flash -= dt;
      if (portalPulse > 0) portalPulse -= dt;
      if (food) food.pulse += dt;

      if (powerUp) {
        powerUp.life -= dt;
        if (powerUp.life <= 0) powerUp = null;
      } else if (api.rng.chance(dt * 0.06)) {
        spawnPower();
      }

      // Buffer turns from held keys too, so the d-pad feels responsive.
      const ax = api.input.axis('left', 'right');
      const ay = api.input.axis('up', 'down');
      if (pendingDirs.length === 0) {
        if (ax && !ay) this._queue(ax, 0);
        else if (ay && !ax) this._queue(0, ay);
      }

      const interval = stepTime * (active.speed > 0 ? 0.55 : 1);
      stepTimer += dt;
      while (stepTimer >= interval && alive) {
        stepTimer -= interval;
        step();
      }
    },

    _queue(x, y) {
      const last = pendingDirs.length ? pendingDirs[pendingDirs.length - 1] : dir;
      if (last.x === x && last.y === y) return;
      if (last.x === -x && last.y === -y) return;
      if (pendingDirs.length < 2) pendingDirs.push({ x, y });
    },

    handleInput(e) {
      if (e.type !== 'press') return;
      switch (e.action) {
        case 'up': this._queue(0, -1); break;
        case 'down': this._queue(0, 1); break;
        case 'left': this._queue(-1, 0); break;
        case 'right': this._queue(1, 0); break;
        case 'a': dash(); break;
        default: break;
      }
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;

      ctx.fillStyle = '#04070c';
      ctx.fillRect(0, 0, W, H);

      // Datagrid.
      ctx.save();
      ctx.globalAlpha = 0.5 + (flash > 0 ? 0.4 : 0);
      ctx.strokeStyle = flash > 0 ? PAL.lime : '#0f2033';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= COLS; x++) { ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, H); }
      for (let y = 0; y <= ROWS; y++) { ctx.moveTo(0, y * CELL + 0.5); ctx.lineTo(W, y * CELL + 0.5); }
      ctx.stroke();
      ctx.restore();

      // Portal frame — brightens on each wrap.
      const pp = Math.max(0, portalPulse) / 0.4;
      ctx.save();
      ctx.strokeStyle = alpha(PAL.cyan, 0.25 + pp * 0.7);
      ctx.lineWidth = 2 + pp * 3;
      ctx.shadowColor = PAL.cyan;
      ctx.shadowBlur = 8 + pp * 20;
      ctx.strokeRect(1, 1, W - 2, H - 2);
      ctx.restore();

      // Datawalls.
      for (const k of walls) {
        const x = (k % COLS) * CELL;
        const y = Math.floor(k / COLS) * CELL;
        ctx.fillStyle = active.breaker > 0 ? alpha(PAL.orange, 0.55) : '#1c2b46';
        ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
        ctx.strokeStyle = active.breaker > 0 ? PAL.orange : '#2c4370';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3);
      }

      // Food.
      if (food) {
        const t = 0.5 + 0.5 * Math.sin(food.pulse * 6);
        const r = CELL * 0.28 + t * 2.5;
        ctx.save();
        ctx.shadowColor = PAL.magenta;
        ctx.shadowBlur = 14 + t * 10;
        ctx.fillStyle = PAL.magenta;
        ctx.beginPath();
        ctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, r, 0, TAU);
        ctx.fill();
        ctx.restore();
      }

      // Power-up.
      if (powerUp) {
        const p = POWERS[powerUp.kind];
        const blink = powerUp.life < 3 && Math.floor(powerUp.life * 8) % 2 === 0;
        if (!blink) {
          const cx = powerUp.x * CELL + CELL / 2;
          const cy = powerUp.y * CELL + CELL / 2;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(api.time * 2);
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 16;
          ctx.fillStyle = p.color;
          ctx.fillRect(-CELL * 0.3, -CELL * 0.3, CELL * 0.6, CELL * 0.6);
          ctx.restore();
        }
      }

      // Snake body, head-first so the head sits on top.
      const ghosting = active.ghost > 0;
      for (let i = snake.length - 1; i >= 0; i--) {
        const s = snake[i];
        const head = i === 0;
        const t = 1 - i / Math.max(1, snake.length);
        const color = head
          ? (ghosting ? PAL.violet : PAL.white)
          : (ghosting ? alpha(PAL.violet, 0.35 + t * 0.4) : `hsl(${100 + t * 60},100%,${45 + t * 20}%)`);
        ctx.save();
        if (ghosting && !head) ctx.globalAlpha = 0.6;
        ctx.shadowColor = ghosting ? PAL.violet : PAL.lime;
        ctx.shadowBlur = head ? 18 : 8;
        ctx.fillStyle = color;
        const pad = head ? 1 : 2;
        ctx.fillRect(s.x * CELL + pad, s.y * CELL + pad, CELL - pad * 2, CELL - pad * 2);
        ctx.restore();

        if (head) {
          // Eyes point the way you're going.
          ctx.fillStyle = '#05060a';
          const ex = s.x * CELL + CELL / 2 + dir.x * 3;
          const ey = s.y * CELL + CELL / 2 + dir.y * 3;
          const ox = dir.x === 0 ? 4 : 0;
          const oy = dir.y === 0 ? 4 : 0;
          ctx.fillRect(ex - ox - 1.5, ey - oy - 1.5, 3, 3);
          ctx.fillRect(ex + ox - 1.5, ey + oy - 1.5, 3, 3);
        }
      }

      api.particles.render(ctx);

      // Active power-up timers along the bottom edge.
      let bx = 6;
      for (const k of POWER_KEYS) {
        if (active[k] <= 0) continue;
        const p = POWERS[k];
        const w = 62;
        glowRect(ctx, bx, H - 14, w * (active[k] / p.dur), 4, p.color, 8);
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = p.color;
        ctx.strokeRect(bx + 0.5, H - 14.5, w, 5);
        ctx.restore();
        text(ctx, p.label, bx, H - 26, { size: 8, color: p.color });
        bx += w + 8;
      }

      if (dashCooldown > 0) {
        text(ctx, 'DASH ' + dashCooldown.toFixed(1), W - 6, H - 26,
          { size: 8, color: PAL.dim, align: 'right' });
      }
    },
  };
}
