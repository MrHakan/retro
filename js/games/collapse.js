/**
 * 20 — MATCH-3 BLOCK COLLAPSE
 * A Lumines-style timeline puzzler. Bi-colour 2x2 pieces rain into a wide well;
 * any grid-aligned 2x2 block of a single colour is MARKED, and a scan beam
 * sweeping left-to-right deletes whatever is marked the moment it arrives.
 * Blocks collapse into the gap and can form fresh squares *ahead* of the beam —
 * that cascade is the chain, and chains are where the score lives.
 */

import { PAL, alpha, mix, clamp, text } from '../core/fx.js';

/* ------------------------------------------------------------------ layout */

const COLS = 16;
const ROWS = 10;
const CELL = 26;
const WELL_W = COLS * CELL;            // 416
const WELL_H = ROWS * CELL;            // 260
const VIEW_W = 480;
const VIEW_H = 360;
const WELL_X = (VIEW_W - WELL_W) >> 1; // 32
const WELL_Y = 64;
const WELL_B = WELL_Y + WELL_H;        // 324

/** Colour 0 is "empty"; pieces only ever use 1 and 2. */
const INK = [null, PAL.cyan, PAL.magenta];

/** Thumbnail stack — hand-drawn so the art always shows real 2x2 squares. */
const ART_ROWS = [
  '............',
  '............',
  '.....11.....',
  '....211.....',
  '..2211..22..',
  '..2211.122..',
  '.112211.221.',
  '.1122112211.',
];

export const meta = {
  id: 'collapse',
  title: 'MATCH-3 BLOCK COLLAPSE',
  short: 'COLLAPSE',
  category: 'PUZZLE',
  desc: 'Drop bi-colour 2x2 pieces into the well and build single-colour squares. '
      + 'A scan beam sweeps the field forever — everything it touches that is marked '
      + 'is deleted, and the collapse can chain squares ahead of the line.',
  accent: PAL.cyan,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'LEFT / RIGHT — move piece',
    'UP / SPACE — rotate quadrants',
    'DOWN — soft drop',
    'L — hard drop',
  ],
  touch: { dpad: true, buttons: [{ id: 'a', label: 'ROT' }, { id: 'c', label: 'DROP' }] },
  art(ctx, w, h, accent) {
    ctx.save();
    // Well.
    ctx.fillStyle = '#070c16';
    ctx.fillRect(16, 20, 208, 140);
    ctx.strokeStyle = alpha(accent, 0.5);
    ctx.lineWidth = 2;
    ctx.strokeRect(16, 20, 208, 140);

    const s = 208 / 12;
    for (let y = 0; y < ART_ROWS.length; y++) {
      for (let x = 0; x < 12; x++) {
        const ch = ART_ROWS[y][x];
        if (ch === '.') continue;
        const col = ch === '1' ? accent : PAL.magenta;
        const px = 16 + x * s;
        const py = 20 + (140 - ART_ROWS.length * s) + y * s;
        ctx.fillStyle = mix(col, '#000000', 0.55);
        ctx.fillRect(px + 1, py + 1, s - 2, s - 2);
        ctx.fillStyle = col;
        ctx.fillRect(px + 2, py + 2, s - 4, s - 4);
        ctx.fillStyle = alpha('#ffffff', 0.35);
        ctx.fillRect(px + 2, py + 2, s - 4, 2);
      }
    }

    // Scan beam with a glow trail.
    const bx = 16 + 6.4 * s;
    const g = ctx.createLinearGradient(bx - 46, 0, bx, 0);
    g.addColorStop(0, alpha(PAL.white, 0));
    g.addColorStop(1, alpha(PAL.white, 0.4));
    ctx.fillStyle = g;
    ctx.fillRect(bx - 46, 20, 46, 140);
    ctx.shadowColor = PAL.white;
    ctx.shadowBlur = 16;
    ctx.fillStyle = PAL.white;
    ctx.fillRect(bx - 1.5, 18, 3, 144);
    ctx.restore();
  },
};

export function create(api) {
  /* Board state — parallel arrays indexed `y * COLS + x`. */
  let cell;      // Uint8Array, colour index (0 = empty)
  let mark;      // Uint8Array, 1 = currently part of a complete 2x2
  let doom;      // Uint8Array, 1 = committed to this sweep, dies on beam contact
  let off;       // Float32Array, visual y offset in px (<= 0 while collapsing)
  let squares;   // top-left indices of every complete 2x2, rebuilt by remark()

  let piece, next;                    // { q:[tl,tr,br,bl], x, y }
  let beam, beamSpeed;                // beam x in px across the well
  let fallSpeed, lockTimer;
  let level, levelTimer, cleared, bestChain;
  let chain, sweepCells;
  let erasing;                        // disintegration animations
  let alive, moveDir, moveTimer;
  let flash, chainFlash, sweepFlash, dropFlash;

  const idx = (x, y) => y * COLS + x;

  /* ------------------------------------------------------------- pieces -- */

  /** Four random quadrants, clockwise from top-left. */
  function randQuad() {
    return [api.rng.int(1, 2), api.rng.int(1, 2), api.rng.int(1, 2), api.rng.int(1, 2)];
  }

  /** Can a 2x2 piece sit with its top-left cell at (px, py)? Rows < 0 are free. */
  function fits(px, py) {
    if (px < 0 || px + 1 >= COLS) return false;
    if (py + 1 >= ROWS) return false;
    for (let dy = 0; dy < 2; dy++) {
      const y = py + dy;
      if (y < 0) continue;
      if (cell[idx(px, y)] || cell[idx(px + 1, y)]) return false;
    }
    return true;
  }

  function spawn() {
    piece = { q: next, x: (COLS >> 1) - 1, y: -2 };
    next = randQuad();
    lockTimer = 0.14;
  }

  function tryMove(dx) {
    if (!piece) return;
    const nx = piece.x + dx;
    if (fits(nx, Math.ceil(piece.y))) {
      piece.x = nx;
      api.sfx('blip', { vol: 0.28 });
    }
  }

  /** Rotation cycles the four quadrant colours around the block. */
  function rotate() {
    if (!piece) return;
    const q = piece.q;
    piece.q = [q[3], q[0], q[1], q[2]];
    api.sfx('rotate', { vol: 0.55 });
    api.particles.emit({
      x: WELL_X + (piece.x + 1) * CELL,
      y: WELL_Y + (piece.y + 1) * CELL,
      life: 0.22, size: CELL * 0.5, shape: 'ring', color: PAL.white, glow: 8,
    });
  }

  function landingRow() {
    let r = Math.floor(piece.y);
    while (fits(piece.x, r + 1)) r++;
    return r;
  }

  function hardDrop() {
    if (!piece) return;
    const r = landingRow();
    const travelled = Math.max(0, r - piece.y);
    api.addScore(Math.round(travelled * 2));
    piece.y = r;
    dropFlash = 0.18;
    api.shakeScreen(2.5);
    lockPiece();
  }

  function place(x, y, c) {
    const i = idx(x, y);
    cell[i] = c;
    off[i] = 0;
    doom[i] = 0;
  }

  function lockPiece() {
    const r = Math.floor(piece.y);
    if (r < 0) {                       // the stack pushed out of the well
      die();
      return;
    }
    const q = piece.q;
    place(piece.x, r, q[0]);
    place(piece.x + 1, r, q[1]);
    place(piece.x + 1, r + 1, q[2]);
    place(piece.x, r + 1, q[3]);
    api.sfx('drop', { vol: 0.6, detune: -2 });
    settle();
    remark();
    spawn();
  }

  /* -------------------------------------------------------------- board -- */

  /** Column-wise gravity. Moved cells get a negative offset so they animate. */
  function settle() {
    for (let x = 0; x < COLS; x++) {
      let write = ROWS - 1;
      for (let y = ROWS - 1; y >= 0; y--) {
        const i = idx(x, y);
        if (!cell[i]) continue;
        if (write !== y) {
          const w = idx(x, write);
          cell[w] = cell[i];
          doom[w] = doom[i];
          off[w] = off[i] - (write - y) * CELL;
          cell[i] = 0;
          doom[i] = 0;
          off[i] = 0;
        }
        write--;
      }
    }
  }

  /** Rebuild the marked set: every grid-aligned 2x2 block of one colour. */
  function remark() {
    mark.fill(0);
    squares.length = 0;
    for (let y = 0; y < ROWS - 1; y++) {
      for (let x = 0; x < COLS - 1; x++) {
        const i = idx(x, y);
        const c = cell[i];
        if (!c) continue;
        if (cell[i + 1] !== c || cell[i + COLS] !== c || cell[i + COLS + 1] !== c) continue;
        mark[i] = 1;
        mark[i + 1] = 1;
        mark[i + COLS] = 1;
        mark[i + COLS + 1] = 1;
        squares.push(i);
      }
    }
  }

  /** How many complete squares sit strictly right of column `c`? */
  function squaresAhead(c) {
    let n = 0;
    for (let s = 0; s < squares.length; s++) if (squares[s] % COLS > c) n++;
    return n;
  }

  /* --------------------------------------------------------------- beam -- */

  /**
   * The beam has reached column `c`. Every square that touches the column is
   * committed (so the far half still dies next column even though the pair is
   * broken), then the committed cells in this column disintegrate.
   */
  function eraseColumn(c) {
    for (let s = 0; s < squares.length; s++) {
      const i = squares[s];
      const sx = i % COLS;
      if (sx !== c && sx + 1 !== c) continue;
      doom[i] = 1;
      doom[i + 1] = 1;
      doom[i + COLS] = 1;
      doom[i + COLS + 1] = 1;
    }

    let n = 0;
    for (let y = 0; y < ROWS; y++) {
      const i = idx(c, y);
      if (!cell[i] || !doom[i]) continue;
      const col = INK[cell[i]];
      erasing.push({ x: c, y, color: col, t: 0, life: 0.32 });
      api.particles.burst(WELL_X + c * CELL + CELL / 2, WELL_Y + y * CELL + CELL / 2, 3, {
        speed: 130, life: 0.45, size: 2.6, color: [col, PAL.white], glow: 9, drag: 2.6,
      });
      cell[i] = 0;
      doom[i] = 0;
      mark[i] = 0;
      off[i] = 0;
      n++;
    }
    if (!n) return;

    const before = squaresAhead(c);
    settle();
    remark();
    const after = squaresAhead(c);

    cleared += n;
    sweepCells += n;
    const pts = Math.round(n * (10 + 6 * chain) * level);
    api.addScore(pts);
    api.sfx('clear', { vol: 0.6, detune: clamp(chain * 2, 0, 12) });

    // A collapse that builds new squares in front of the beam is a chain link.
    if (after > before) {
      chain++;
      bestChain = Math.max(bestChain, chain);
      chainFlash = 0.55;
      api.sfx('combo', { vol: 0.7, detune: clamp(chain * 2, 0, 14) });
      api.particles.popText(
        WELL_X + c * CELL + CELL,
        WELL_Y + WELL_H * 0.35,
        'CHAIN x' + (chain + 1),
        PAL.yellow, 1.1,
      );
      api.shakeScreen(2 + chain);
    }

    if (cleared >= level * 48) levelUp();
  }

  /** Erase every column whose trigger line lies in [a, b). */
  function sweepRange(a, b) {
    for (let c = 0; c < COLS; c++) {
      const t = c * CELL + CELL * 0.5;
      if (t >= a && t < b) eraseColumn(c);
    }
  }

  /** The beam wrapped: cash in whatever it collected on the way across. */
  function endSweep() {
    if (sweepCells > 0) {
      const bonus = Math.round(sweepCells * sweepCells * 2.2 * level * (1 + chain * 0.5));
      api.addScore(bonus);
      api.particles.popText(WELL_X + WELL_W / 2, WELL_Y + 26, `SWEEP ${sweepCells} +${bonus}`,
        sweepCells >= 12 ? PAL.yellow : PAL.white, 1.3);
      api.sfx(sweepCells >= 12 ? 'perfect' : 'tetris', { vol: 0.6 });
      sweepFlash = 0.5;
      api.setStatus({ LEVEL: level, CLEARED: cleared });
    }
    sweepCells = 0;
    chain = 0;
  }

  /* --------------------------------------------------------------- flow -- */

  function levelUp() {
    level++;
    levelTimer = 34;
    fallSpeed = 1.5 + level * 0.34;
    beamSpeed = WELL_W / clamp(3.4 - level * 0.16, 1.25, 3.4);
    flash = 0.45;
    api.sfx('levelup');
    api.setStatus({ LEVEL: level, CLEARED: cleared });
  }

  function die() {
    if (!alive) return;
    api.hitStop(0.07);
    api.flash(PAL.magenta, 0.35);
    alive = false;
    api.shakeScreen(14, 5);
    api.sfx('explosion');
    api.vibrate(140);
    for (let i = 0; i < cell.length; i += 2) {
      if (!cell[i]) continue;
      const x = i % COLS;
      const y = (i / COLS) | 0;
      api.particles.burst(WELL_X + x * CELL + CELL / 2, WELL_Y + y * CELL + CELL / 2, 2, {
        speed: 160, life: 0.8, size: 3, color: [INK[cell[i]], PAL.white], glow: 8,
        gravity: 220, drag: 1.1,
      });
    }
    api.gameOver({
      message: 'THE WELL OVERFLOWED',
      stats: { LEVEL: level, CLEARED: cleared, 'BEST CHAIN': bestChain + 1 },
    });
  }

  /* --------------------------------------------------------------- draw -- */

  function drawBlock(ctx, px, py, size, color, hot, pulse) {
    const s = size - 1;
    ctx.fillStyle = mix(color, '#000000', 0.62);
    ctx.fillRect(px, py, s, s);
    ctx.fillStyle = hot ? mix(color, '#ffffff', 0.25 + pulse * 0.35) : color;
    ctx.fillRect(px + 2, py + 2, s - 4, s - 4);
    // Bevel: light from the top-left, shadow to the bottom-right.
    ctx.fillStyle = alpha('#ffffff', 0.4);
    ctx.fillRect(px + 2, py + 2, s - 4, 2);
    ctx.fillRect(px + 2, py + 2, 2, s - 4);
    ctx.fillStyle = alpha('#000000', 0.34);
    ctx.fillRect(px + 2, py + s - 4, s - 4, 2);
    ctx.fillRect(px + s - 4, py + 2, 2, s - 4);
    if (hot) {
      ctx.strokeStyle = alpha(PAL.white, 0.5 + pulse * 0.5);
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
    }
  }

  function drawPreview(ctx, q, px, py, size) {
    const map = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) {
      drawBlock(ctx, px + map[i][0] * size, py + map[i][1] * size, size, INK[q[i]], false, 0);
    }
  }

  return {
    init() {
      const n = COLS * ROWS;
      cell = new Uint8Array(n);
      mark = new Uint8Array(n);
      doom = new Uint8Array(n);
      off = new Float32Array(n);
      squares = [];
      erasing = [];

      level = 1;
      levelTimer = 34;
      cleared = 0;
      chain = 0;
      bestChain = 0;
      sweepCells = 0;
      fallSpeed = 1.5 + level * 0.34;
      beamSpeed = WELL_W / 3.24;
      beam = 0;
      alive = true;
      moveDir = 0;
      moveTimer = 0;
      flash = 0;
      chainFlash = 0;
      sweepFlash = 0;
      dropFlash = 0;

      next = randQuad();
      spawn();
      api.setStatus({ LEVEL: 1, CLEARED: 0 });
    },

    update(dt) {
      if (!alive) return;

      /* cosmetic timers */
      if (flash > 0) flash -= dt;
      if (chainFlash > 0) chainFlash -= dt;
      if (sweepFlash > 0) sweepFlash -= dt;
      if (dropFlash > 0) dropFlash -= dt;
      for (let i = erasing.length - 1; i >= 0; i--) {
        const e = erasing[i];
        e.t += dt;
        if (e.t >= e.life) {
          erasing[i] = erasing[erasing.length - 1];
          erasing.pop();
        }
      }
      // Collapsed blocks ease back up to their grid slot.
      const ease = 780 * dt;
      for (let i = 0; i < off.length; i++) {
        if (off[i] < 0) off[i] = Math.min(0, off[i] + ease);
      }

      levelTimer -= dt;
      if (levelTimer <= 0) levelUp();

      /* horizontal move with a short auto-repeat, driven purely by held state
         so the d-pad and the keyboard behave identically */
      const dir = api.input.axis('left', 'right');
      if (dir !== moveDir) {
        moveDir = dir;
        moveTimer = 0.2;
        if (dir) tryMove(dir);
      } else if (dir) {
        moveTimer -= dt;
        if (moveTimer <= 0) {
          moveTimer = 0.06;
          tryMove(dir);
        }
      }

      /* fall — stepped so a fast soft drop cannot skip a landing */
      const soft = api.input.isDown('down');
      let rem = fallSpeed * (soft ? 9 : 1) * dt;
      let landed = false;
      while (rem > 0) {
        const step = Math.min(rem, 0.34);
        const ny = piece.y + step;
        if (fits(piece.x, Math.ceil(ny))) {
          piece.y = ny;
          rem -= step;
        } else {
          piece.y = Math.floor(piece.y);
          landed = true;
          break;
        }
      }
      if (landed) {
        lockTimer -= dt;
        if (lockTimer <= 0) lockPiece();
      } else {
        lockTimer = 0.14;
      }

      /* the timeline never stops */
      if (!alive) return;
      const prev = beam;
      beam += beamSpeed * dt;
      if (beam >= WELL_W) {
        sweepRange(prev, WELL_W);
        endSweep();
        beam -= WELL_W;
        sweepRange(-1, beam);
      } else {
        sweepRange(prev, beam);
      }
    },

    handleInput(e) {
      if (e.type !== 'press' || !alive) return;
      switch (e.action) {
        case 'a': case 'up': rotate(); break;
        case 'c': case 'b': hardDrop(); break;
        default: break;
      }
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;
      const pulse = 0.5 + 0.5 * Math.sin(api.time * 7);

      /* backdrop */
      ctx.fillStyle = '#04060c';
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#101c31';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 40) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
      for (let y = 0; y <= H; y += 40) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
      ctx.stroke();
      ctx.restore();

      /* well floor */
      ctx.fillStyle = '#070c17';
      ctx.fillRect(WELL_X, WELL_Y, WELL_W, WELL_H);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#16233d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= COLS; x++) {
        ctx.moveTo(WELL_X + x * CELL + 0.5, WELL_Y);
        ctx.lineTo(WELL_X + x * CELL + 0.5, WELL_B);
      }
      for (let y = 0; y <= ROWS; y++) {
        ctx.moveTo(WELL_X, WELL_Y + y * CELL + 0.5);
        ctx.lineTo(WELL_X + WELL_W, WELL_Y + y * CELL + 0.5);
      }
      ctx.stroke();
      ctx.restore();

      /* the beam's soft trail is painted underneath the blocks so it reads as
         a light sweeping across the floor of the well */
      const bx = WELL_X + beam;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const trail = ctx.createLinearGradient(bx - 84, 0, bx, 0);
      trail.addColorStop(0, alpha(PAL.cyan, 0));
      trail.addColorStop(1, alpha(PAL.cyan, 0.22));
      ctx.fillStyle = trail;
      ctx.fillRect(Math.max(WELL_X, bx - 84), WELL_Y, Math.min(84, bx - WELL_X), WELL_H);
      ctx.restore();

      /* everything inside the well is clipped so pieces entering from above
         never spill over the HUD */
      ctx.save();
      ctx.beginPath();
      ctx.rect(WELL_X, WELL_Y, WELL_W, WELL_H);
      ctx.clip();

      /* settled blocks */
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const i = idx(x, y);
          const c = cell[i];
          if (!c) continue;
          const hot = mark[i] === 1 || doom[i] === 1;
          drawBlock(ctx, WELL_X + x * CELL, WELL_Y + y * CELL + off[i], CELL, INK[c], hot, pulse);
        }
      }

      /* outline every complete square so the player can plan around the beam */
      ctx.save();
      ctx.lineWidth = 2;
      ctx.shadowBlur = 8;
      for (let s = 0; s < squares.length; s++) {
        const i = squares[s];
        const x = i % COLS;
        const y = (i / COLS) | 0;
        const col = INK[cell[i]] || PAL.white;
        ctx.strokeStyle = alpha(PAL.white, 0.55 + pulse * 0.4);
        ctx.shadowColor = col;
        ctx.strokeRect(WELL_X + x * CELL + 1.5, WELL_Y + y * CELL + 1.5, CELL * 2 - 3, CELL * 2 - 3);
      }
      ctx.restore();

      /* disintegration */
      for (let e = 0; e < erasing.length; e++) {
        const a = erasing[e];
        const t = a.t / a.life;
        const px = WELL_X + a.x * CELL + CELL / 2;
        const py = WELL_Y + a.y * CELL + CELL / 2;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 1 - t;
        ctx.translate(px, py);
        ctx.rotate(t * 1.2);
        const s = CELL * (1 - t * 0.65);
        ctx.fillStyle = a.color;
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.strokeStyle = PAL.white;
        ctx.lineWidth = 2;
        const r = CELL * (0.4 + t * 1.1);
        ctx.strokeRect(-r, -r, r * 2, r * 2);
        ctx.restore();
      }

      /* ghost landing outline + the live piece */
      if (alive && piece) {
        const gr = landingRow();
        if (gr > piece.y) {
          ctx.save();
          ctx.globalAlpha = 0.22;
          ctx.strokeStyle = PAL.white;
          ctx.lineWidth = 2;
          ctx.strokeRect(WELL_X + piece.x * CELL + 2, WELL_Y + gr * CELL + 2, CELL * 2 - 4, CELL * 2 - 4);
          ctx.restore();
        }
        const map = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const py = WELL_Y + piece.y * CELL;
        for (let i = 0; i < 4; i++) {
          drawBlock(ctx, WELL_X + (piece.x + map[i][0]) * CELL, py + map[i][1] * CELL,
            CELL, INK[piece.q[i]], dropFlash > 0, 1);
        }
      }

      /* the beam itself sits on top of everything in the well */
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = PAL.white;
      ctx.shadowBlur = 20;
      ctx.fillStyle = alpha(PAL.white, 0.9);
      ctx.fillRect(bx - 1.5, WELL_Y, 3, WELL_H);
      ctx.fillStyle = alpha(PAL.cyan, 0.5);
      ctx.fillRect(bx - 5, WELL_Y, 10, WELL_H);
      ctx.restore();

      ctx.restore(); // end well clip

      api.particles.render(ctx);

      /* well frame — flashes on level up and on a fat sweep */
      const frameHot = Math.max(flash > 0 ? flash / 0.45 : 0, sweepFlash > 0 ? sweepFlash / 0.5 : 0);
      ctx.save();
      ctx.strokeStyle = frameHot > 0 ? mix(PAL.cyan, PAL.white, frameHot) : alpha(PAL.cyan, 0.45);
      ctx.lineWidth = 2 + frameHot * 3;
      ctx.shadowColor = PAL.cyan;
      ctx.shadowBlur = 10 + frameHot * 22;
      ctx.strokeRect(WELL_X - 1, WELL_Y - 1, WELL_W + 2, WELL_H + 2);
      ctx.restore();

      /* ---- top panel ---- */
      text(ctx, 'TIMELINE', WELL_X, 14, { size: 9, color: PAL.dim });
      text(ctx, 'LV ' + level, WELL_X, 28, { size: 16, color: PAL.cyan, glow: 8 });

      if (sweepCells > 0) {
        text(ctx, 'SWEEP ' + sweepCells, WELL_X + 78, 30, { size: 11, color: PAL.white });
      }
      if (chain > 0) {
        const cf = chainFlash > 0 ? chainFlash / 0.55 : 0;
        text(ctx, 'CHAIN x' + (chain + 1), WELL_X + 78, 14,
          { size: 12 + cf * 4, color: PAL.yellow, glow: 6 + cf * 14 });
      }

      // Next piece preview.
      const pvx = WELL_X + WELL_W - 44;
      text(ctx, 'NEXT', pvx + 22, 12, { size: 9, color: PAL.dim, align: 'center' });
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = PAL.dim;
      ctx.lineWidth = 1;
      ctx.strokeRect(pvx - 3.5, 22.5, 51, 39);
      ctx.restore();
      drawPreview(ctx, next, pvx + 3, 26, 19);

      /* ---- bottom strip: beam position + level clock ---- */
      const barY = WELL_B + 12;
      ctx.fillStyle = '#0d1728';
      ctx.fillRect(WELL_X, barY, WELL_W, 5);
      ctx.save();
      ctx.shadowColor = PAL.cyan;
      ctx.shadowBlur = 10;
      ctx.fillStyle = PAL.cyan;
      ctx.fillRect(WELL_X + beam - 8, barY, 16, 5);
      ctx.restore();

      const lvT = clamp(1 - levelTimer / 34, 0, 1);
      ctx.fillStyle = '#0d1728';
      ctx.fillRect(WELL_X, barY + 12, WELL_W, 3);
      ctx.fillStyle = alpha(PAL.violet, 0.9);
      ctx.fillRect(WELL_X, barY + 12, WELL_W * lvT, 3);
      text(ctx, 'NEXT LEVEL', WELL_X, barY + 18, { size: 8, color: PAL.dim });
      text(ctx, 'CLEARED ' + cleared, WELL_X + WELL_W, barY + 18,
        { size: 8, color: PAL.dim, align: 'right' });
    },

    destroy() {
      erasing = [];
      squares = [];
    },
  };
}
