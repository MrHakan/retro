/**
 * 02 — TETRIS DX & BLOCK STACKER
 * A guideline-accurate stacker: 7-bag randomiser, full SRS rotation with the
 * JLSTZ and I wall-kick tables, hold, ghost piece, a three-deep preview queue,
 * move-reset lock delay, DAS/ARR auto-shift, T-spin detection (3-corner rule)
 * and Back-to-Back / combo scoring.
 */

import { PAL, alpha, mix, clamp, text, roundRect } from '../core/fx.js';

/* ------------------------------------------------------------- geometry */

const COLS = 10;
const ROWS = 20;
const CELL = 16;

const WELL_X = 108;
const WELL_Y = 36;
const WELL_W = COLS * CELL; // 160
const WELL_H = ROWS * CELL; // 320

const VIEW_W = 360;
const VIEW_H = 380;

/* ------------------------------------------------------------- tuning */

const DAS = 0.15;          // delay before auto-shift kicks in
const ARR = 0.035;         // auto-repeat interval once shifting
const LOCK_DELAY = 0.5;    // grounded grace period
const LOCK_RESETS = 15;    // move-reset cap, guideline standard
const SOFT_MULT = 18;      // soft-drop gravity multiplier
const CLEAR_TIME = 0.26;   // line-clear flash duration
const PREVIEW = 3;         // next-queue pieces shown

/* --------------------------------------------------------------- pieces */

/**
 * Every rotation state is spelled out rather than derived, because SRS is not
 * a pure matrix rotation — the I and O pieces sit off-centre in their boxes and
 * the kick tables assume these exact cell layouts.
 * Cells are [x, y] inside the piece's bounding box, y growing downward.
 */
const PIECES = {
  I: {
    color: PAL.cyan, kicks: 'I', spawnX: 3,
    rot: [
      [[0, 1], [1, 1], [2, 1], [3, 1]],
      [[2, 0], [2, 1], [2, 2], [2, 3]],
      [[0, 2], [1, 2], [2, 2], [3, 2]],
      [[1, 0], [1, 1], [1, 2], [1, 3]],
    ],
  },
  J: {
    color: PAL.blue, kicks: 'JLSTZ', spawnX: 3,
    rot: [
      [[0, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [2, 0], [1, 1], [1, 2]],
      [[0, 1], [1, 1], [2, 1], [2, 2]],
      [[1, 0], [1, 1], [0, 2], [1, 2]],
    ],
  },
  L: {
    color: PAL.orange, kicks: 'JLSTZ', spawnX: 3,
    rot: [
      [[2, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [1, 1], [1, 2], [2, 2]],
      [[0, 1], [1, 1], [2, 1], [0, 2]],
      [[0, 0], [1, 0], [1, 1], [1, 2]],
    ],
  },
  O: {
    color: PAL.yellow, kicks: null, spawnX: 4,
    rot: [
      [[0, 0], [1, 0], [0, 1], [1, 1]],
      [[0, 0], [1, 0], [0, 1], [1, 1]],
      [[0, 0], [1, 0], [0, 1], [1, 1]],
      [[0, 0], [1, 0], [0, 1], [1, 1]],
    ],
  },
  S: {
    color: PAL.lime, kicks: 'JLSTZ', spawnX: 3,
    rot: [
      [[1, 0], [2, 0], [0, 1], [1, 1]],
      [[1, 0], [1, 1], [2, 1], [2, 2]],
      [[1, 1], [2, 1], [0, 2], [1, 2]],
      [[0, 0], [0, 1], [1, 1], [1, 2]],
    ],
  },
  T: {
    color: PAL.violet, kicks: 'JLSTZ', spawnX: 3,
    rot: [
      [[1, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [1, 1], [2, 1], [1, 2]],
      [[0, 1], [1, 1], [2, 1], [1, 2]],
      [[1, 0], [0, 1], [1, 1], [1, 2]],
    ],
  },
  Z: {
    color: PAL.red, kicks: 'JLSTZ', spawnX: 3,
    rot: [
      [[0, 0], [1, 0], [1, 1], [2, 1]],
      [[2, 0], [1, 1], [2, 1], [1, 2]],
      [[0, 1], [1, 1], [1, 2], [2, 2]],
      [[1, 0], [0, 1], [1, 1], [0, 2]],
    ],
  },
};
const TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

/**
 * SRS wall kicks. Keys are `from→to` rotation indices; values are the five
 * offsets tried in order. The published tables use y-up, so the y component is
 * already negated here for canvas coordinates.
 */
const KICKS = {
  JLSTZ: {
    '01': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '10': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '12': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '21': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '23': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '32': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '30': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '03': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  },
  I: {
    '01': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
    '10': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
    '12': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
    '21': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
    '23': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
    '32': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
    '30': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
    '03': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  },
};

/** Corner order used by the T-spin test: TL, TR, BL, BR. */
const CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
/** Which two corners face the T's nub, per rotation state. */
const FRONT = [[0, 1], [1, 3], [2, 3], [0, 2]];

export const meta = {
  id: 'tetris',
  title: 'TETRIS DX & BLOCK STACKER',
  short: 'TETRIS DX',
  category: 'PUZZLE',
  desc: 'The full modern stacker: 7-bag pieces, SRS kicks, hold and ghost, '
      + 'move-reset lock delay, T-spins and Back-to-Back bonuses.',
  accent: PAL.cyan,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'LEFT / RIGHT — shift (auto-repeat)',
    'DOWN — soft drop',
    'UP / L — hard drop',
    'SPACE — rotate CW',
    'Z — rotate CCW',
    'K — hold piece',
  ],
  touch: { dpad: true, buttons: [{ id: 'a', label: 'ROT' }, { id: 'b', label: 'HOLD' }, { id: 'c', label: 'DROP' }] },
  art(ctx, w, h, accent) {
    const c = 13;
    const ox = w / 2 - c * 5;
    const oy = 14;
    // Well frame.
    ctx.save();
    ctx.strokeStyle = alpha(accent, 0.55);
    ctx.lineWidth = 2;
    ctx.strokeRect(ox - 3, oy - 3, c * 10 + 6, c * 11 + 6);

    // A believable stack: ragged heights with one row about to clear.
    const stack = [
      [0, 8, PAL.violet], [1, 8, PAL.violet], [2, 8, PAL.lime], [3, 8, PAL.blue],
      [4, 8, PAL.orange], [5, 8, PAL.red], [6, 8, PAL.yellow], [7, 8, PAL.cyan],
      [8, 8, PAL.lime], [0, 9, PAL.blue], [1, 9, PAL.blue], [2, 9, PAL.orange],
      [3, 9, PAL.yellow], [5, 9, PAL.violet], [6, 9, PAL.red], [8, 9, PAL.cyan],
      [1, 10, PAL.lime], [2, 10, PAL.lime], [6, 10, PAL.blue],
    ];
    for (const [x, y, col] of stack) {
      ctx.fillStyle = col;
      ctx.fillRect(ox + x * c + 1, oy + y * c + 1, c - 2, c - 2);
      ctx.fillStyle = alpha('#ffffff', 0.3);
      ctx.fillRect(ox + x * c + 1, oy + y * c + 1, c - 2, 2);
    }
    // Row-clear flash on the nearly-full row.
    ctx.fillStyle = alpha(PAL.white, 0.55);
    ctx.fillRect(ox, oy + 8 * c, c * 10, c);

    // Falling S-piece with its ghost.
    ctx.shadowColor = accent;
    ctx.shadowBlur = 12;
    ctx.fillStyle = accent;
    for (const [x, y] of [[4, 1], [5, 1], [3, 2], [4, 2]]) {
      ctx.fillRect(ox + x * c + 1, oy + y * c + 1, c - 2, c - 2);
    }
    ctx.shadowBlur = 0;
    ctx.strokeStyle = alpha(accent, 0.45);
    ctx.lineWidth = 1;
    for (const [x, y] of [[4, 6], [5, 6], [3, 7], [4, 7]]) {
      ctx.strokeRect(ox + x * c + 1.5, oy + y * c + 1.5, c - 3, c - 3);
    }
    ctx.restore();
  },
};

export function create(api) {
  /** @type {(string|null)[][]} board[y][x] holds a piece letter or null. */
  let board;
  let cur;                 // { type, rot, x, y, lockTimer, resets, lowest, kick, spun }
  let bag, queue, holdType, holdUsed;
  let gravTimer, gravInterval;
  let level, lines, combo, b2b, alive;
  let dasDir, dasTimer, arrTimer;
  let clearRows, clearTimer, clearFlash;
  let dropTrail;           // { x, y0, y1, life } hard-drop streak
  let banner;              // { text, color, life }
  let pieces, tetrises, tspins, startedAt;

  /* ------------------------------------------------------------ helpers */

  const blocked = (x, y) => {
    if (x < 0 || x >= COLS || y >= ROWS) return true;
    if (y < 0) return false;             // open air above the well
    return board[y][x] !== null;
  };

  function collides(type, rot, px, py) {
    const cells = PIECES[type].rot[rot];
    for (let i = 0; i < cells.length; i++) {
      if (blocked(px + cells[i][0], py + cells[i][1])) return true;
    }
    return false;
  }

  /** Refill the preview queue from shuffled 7-bags so droughts stay bounded. */
  function pump() {
    while (queue.length <= PREVIEW + 1) {
      if (!bag.length) bag = api.rng.shuffle(TYPES.slice());
      queue.push(bag.pop());
    }
  }

  function spawn(type) {
    const p = PIECES[type];
    cur = {
      type,
      rot: 0,
      x: p.spawnX,
      y: 0,
      lockTimer: 0,
      resets: 0,
      lowest: 0,
      kick: 0,
      spun: false,
    };
    gravTimer = 0;
    // Block-out: the spawn cells are already occupied.
    if (collides(type, 0, cur.x, cur.y)) topOut();
  }

  function nextPiece() {
    pump();
    spawn(queue.shift());
    holdUsed = false;
  }

  function ghostY() {
    let y = cur.y;
    while (!collides(cur.type, cur.rot, cur.x, y + 1)) y++;
    return y;
  }

  /** Called whenever the piece successfully moves or rotates while grounded. */
  function touchLock() {
    if (cur.lockTimer > 0 && cur.resets < LOCK_RESETS) {
      cur.resets++;
      cur.lockTimer = 0;
    }
  }

  function tryMove(dx, dy) {
    if (!cur || collides(cur.type, cur.rot, cur.x + dx, cur.y + dy)) return false;
    cur.x += dx;
    cur.y += dy;
    if (dx) cur.spun = false;
    if (cur.y > cur.lowest) {
      cur.lowest = cur.y;
      cur.lockTimer = 0;
      cur.resets = 0;
    } else {
      touchLock();
    }
    return true;
  }

  function rotate(dir) {
    if (!cur) return;
    const p = PIECES[cur.type];
    const to = (cur.rot + dir + 4) % 4;
    if (!p.kicks) {                       // O piece: rotation is a no-op
      api.sfx('rotate', { vol: 0.4 });
      return;
    }
    const table = KICKS[p.kicks][`${cur.rot}${to}`];
    for (let i = 0; i < table.length; i++) {
      const [kx, ky] = table[i];
      if (!collides(cur.type, to, cur.x + kx, cur.y + ky)) {
        cur.rot = to;
        cur.x += kx;
        cur.y += ky;
        cur.kick = i;
        cur.spun = true;                  // last successful action was a spin
        if (cur.y > cur.lowest) {
          cur.lowest = cur.y;
          cur.lockTimer = 0;
          cur.resets = 0;
        } else touchLock();
        api.sfx('rotate', { vol: 0.55, detune: dir > 0 ? 0 : -3 });
        return;
      }
    }
    api.sfx('deny', { vol: 0.3 });
  }

  function doHold() {
    if (!cur || holdUsed || clearRows) {
      api.sfx('deny', { vol: 0.45 });
      return;
    }
    holdUsed = true;
    const swap = holdType;
    holdType = cur.type;
    if (swap) spawn(swap);
    else {
      pump();
      spawn(queue.shift());
    }
    api.sfx('select', { vol: 0.6 });
  }

  /* ----------------------------------------------------------- t-spins  */

  /**
   * 3-corner rule: a T that locked straight after a rotation with at least
   * three of its diagonal neighbours filled scored a spin. It counts as a full
   * T-spin when both corners facing the nub are filled, or when the piece got
   * there through the final (TST) kick — otherwise it is a mini.
   */
  function detectSpin() {
    if (cur.type !== 'T' || !cur.spun) return null;
    const cx = cur.x + 1;
    const cy = cur.y + 1;
    let count = 0;
    const filled = [false, false, false, false];
    for (let i = 0; i < 4; i++) {
      filled[i] = blocked(cx + CORNERS[i][0], cy + CORNERS[i][1]);
      if (filled[i]) count++;
    }
    if (count < 3) return null;
    const [f1, f2] = FRONT[cur.rot];
    return (filled[f1] && filled[f2]) || cur.kick === 4 ? 'full' : 'mini';
  }

  /* ------------------------------------------------------------ locking */

  function lockPiece() {
    const p = PIECES[cur.type];
    const cells = p.rot[cur.rot];
    let above = 0;
    for (const [dx, dy] of cells) {
      const x = cur.x + dx;
      const y = cur.y + dy;
      if (y < 0) { above++; continue; }
      board[y][x] = cur.type;
    }
    api.sfx('drop', { vol: 0.5 });
    pieces++;

    // Lock-out: the whole piece came to rest above the ceiling.
    if (above === cells.length) {
      topOut();
      return;
    }

    const spin = detectSpin();
    const full = [];
    for (let y = 0; y < ROWS; y++) {
      let solid = true;
      for (let x = 0; x < COLS; x++) if (!board[y][x]) { solid = false; break; }
      if (solid) full.push(y);
    }

    award(full.length, spin);

    if (full.length) {
      clearRows = full;
      clearTimer = CLEAR_TIME;
      clearFlash = 1;
      for (const y of full) {
        for (let x = 0; x < COLS; x++) {
          const type = board[y][x];
          api.particles.emit({
            x: WELL_X + x * CELL + CELL / 2 + (Math.random() - 0.5) * CELL,
            y: WELL_Y + y * CELL + CELL / 2,
            vx: (x - COLS / 2) * 26 + (Math.random() - 0.5) * 60,
            vy: (Math.random() - 0.5) * 110,
            life: 0.45 + Math.random() * 0.3,
            size: 3,
            color: type ? PIECES[type].color : PAL.white,
            glow: 8,
            drag: 2.2,
            gravity: 90,
          });
        }
      }
      api.shakeScreen(full.length >= 4 ? 9 : 3 + full.length, 7);
      cur = null;
    } else {
      nextPiece();
    }
  }

  /** Score, combo, B2B and the on-canvas banner for one lock. */
  function award(n, spin) {
    const hard = n === 4 || (spin && n > 0);
    let base = 0;
    let label = '';

    if (spin === 'full') {
      base = [400, 800, 1200, 1600][Math.min(n, 3)];
      label = n ? `T-SPIN ${['', 'SINGLE', 'DOUBLE', 'TRIPLE'][n]}` : 'T-SPIN';
      tspins++;
    } else if (spin === 'mini') {
      base = [100, 200, 400][Math.min(n, 2)];
      label = n ? 'T-SPIN MINI ' + (n === 1 ? 'SINGLE' : 'DOUBLE') : 'T-SPIN MINI';
      tspins++;
    } else if (n > 0) {
      base = [0, 100, 300, 500, 800][n];
      label = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'][n];
      if (n === 4) tetrises++;
    }

    let bonus = false;
    if (n > 0) {
      if (hard && b2b) { base = Math.floor(base * 1.5); bonus = true; }
      b2b = hard;
      combo++;
      if (combo > 0) api.addScore(50 * combo * level);
    } else {
      combo = -1;                         // a dry lock always breaks the chain
    }

    if (base > 0) api.addScore(base * level);

    if (n > 0) {
      lines += n;
      const nextLevel = 1 + Math.floor(lines / 10);
      if (nextLevel > level) {
        level = nextLevel;
        gravInterval = gravityFor(level);
        api.sfx('levelup');
        banner = { text: 'LEVEL ' + level, color: PAL.yellow, life: 1.4 };
      }
      api.sfx(n >= 4 ? 'tetris' : 'clear', { detune: Math.min(10, combo * 1.5) });
      if (combo > 0) api.sfx('combo', { vol: 0.5, detune: Math.min(14, combo * 2) });
    }

    if (label) {
      banner = {
        text: (bonus ? 'B2B ' : '') + label + (combo > 0 ? `  x${combo + 1}` : ''),
        color: spin ? PAL.violet : n >= 4 ? PAL.cyan : PAL.white,
        life: 1.3,
      };
      api.particles.popText(WELL_X + WELL_W / 2, WELL_Y + WELL_H * 0.34, label,
        spin ? PAL.violet : PAL.cyan, 1.1);
    }

    api.setStatus({ LEVEL: level, LINES: lines, COMBO: Math.max(0, combo) });
  }

  /** Guideline gravity curve, seconds per row. */
  function gravityFor(lv) {
    return Math.max(0.02, Math.pow(0.8 - (lv - 1) * 0.007, lv - 1));
  }

  function collapse() {
    // Rebuild the board without the cleared rows — cheaper and simpler than
    // splicing rows one at a time.
    const kept = [];
    for (let y = 0; y < ROWS; y++) if (!clearRows.includes(y)) kept.push(board[y]);
    while (kept.length < ROWS) kept.unshift(new Array(COLS).fill(null));
    board = kept;
    clearRows = null;
    nextPiece();
  }

  function hardDrop() {
    if (!cur) return;
    const gy = ghostY();
    const cells = gy - cur.y;
    if (cells > 0) api.addScore(cells * 2);
    dropTrail = { x: cur.x, y0: cur.y, y1: gy, type: cur.type, life: 0.22 };
    cur.y = gy;
    cur.spun = false;
    api.shakeScreen(3 + Math.min(6, cells * 0.35), 9);
    api.vibrate(18);
    api.sfx('thrust', { vol: 0.5 });
    lockPiece();
  }

  function topOut() {
    if (!alive) return;
    alive = false;
    cur = null;
    api.shakeScreen(14, 4);
    api.hitStop(0.07);
    api.flash(PAL.magenta, 0.35);
    api.sfx('explosion');
    api.vibrate(160);
    // Dissolve the stack.
    for (let y = 0; y < ROWS; y += 2) {
      for (let x = 0; x < COLS; x += 2) {
        const t = board[y][x];
        if (!t) continue;
        api.particles.emit({
          x: WELL_X + x * CELL + CELL / 2,
          y: WELL_Y + y * CELL + CELL / 2,
          vx: (Math.random() - 0.5) * 90,
          vy: -40 - Math.random() * 90,
          life: 0.8, size: 3, color: PIECES[t].color, glow: 8, gravity: 180, drag: 0.8,
        });
      }
    }
    api.gameOver({
      message: 'BLOCKED OUT',
      stats: {
        LEVEL: level,
        LINES: lines,
        TETRIS: tetrises,
        'T-SPINS': tspins,
        PIECES: pieces,
        TIME: Math.round(api.time - startedAt) + 's',
      },
    });
  }

  /* ------------------------------------------------------------ drawing */

  /** One bevelled neon block; no shadowBlur so a full well stays cheap. */
  function drawBlock(ctx, px, py, size, color, bright = 0) {
    const c = bright > 0 ? mix(color, '#ffffff', clamp(bright, 0, 1)) : color;
    ctx.fillStyle = alpha(c, 0.9);
    ctx.fillRect(px + 1, py + 1, size - 2, size - 2);
    ctx.fillStyle = alpha('#ffffff', 0.28);
    ctx.fillRect(px + 1, py + 1, size - 2, Math.max(1, size * 0.16));
    ctx.fillStyle = alpha('#000000', 0.3);
    ctx.fillRect(px + 1, py + size - 1 - Math.max(1, size * 0.14), size - 2, Math.max(1, size * 0.14));
    ctx.strokeStyle = alpha(c, 0.95);
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 1.5, py + 1.5, size - 3, size - 3);
  }

  /** Draw a piece centred inside a panel box. */
  function drawMini(ctx, type, cx, cy, size) {
    const cells = PIECES[type].rot[0];
    let minX = 9;
    let maxX = -9;
    let minY = 9;
    let maxY = -9;
    for (const [x, y] of cells) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const ox = cx - ((maxX - minX + 1) * size) / 2 - minX * size;
    const oy = cy - ((maxY - minY + 1) * size) / 2 - minY * size;
    for (const [x, y] of cells) drawBlock(ctx, ox + x * size, oy + y * size, size, PIECES[type].color);
  }

  function panel(ctx, x, y, w, h, label, tint) {
    ctx.save();
    ctx.fillStyle = alpha(PAL.bgAlt, 0.8);
    roundRect(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = alpha(tint, 0.4);
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4);
    ctx.stroke();
    ctx.restore();
    if (label) text(ctx, label, x, y - 11, { size: 9, color: alpha(tint, 0.85) });
  }

  /* --------------------------------------------------------- lifecycle  */

  return {
    init() {
      board = [];
      for (let y = 0; y < ROWS; y++) board.push(new Array(COLS).fill(null));
      bag = [];
      queue = [];
      holdType = null;
      holdUsed = false;
      level = 1;
      lines = 0;
      combo = -1;
      b2b = false;
      alive = true;
      pieces = 0;
      tetrises = 0;
      tspins = 0;
      startedAt = api.time;
      gravInterval = gravityFor(1);
      gravTimer = 0;
      dasDir = 0;
      dasTimer = 0;
      arrTimer = 0;
      clearRows = null;
      clearTimer = 0;
      clearFlash = 0;
      dropTrail = null;
      banner = null;
      pump();
      nextPiece();
      api.setStatus({ LEVEL: 1, LINES: 0, COMBO: 0 });
    },

    update(dt) {
      if (!alive) return;

      if (clearFlash > 0) clearFlash = Math.max(0, clearFlash - dt / CLEAR_TIME);
      if (dropTrail) {
        dropTrail.life -= dt;
        if (dropTrail.life <= 0) dropTrail = null;
      }
      if (banner) {
        banner.life -= dt;
        if (banner.life <= 0) banner = null;
      }

      // Line-clear freeze: the well holds still while the row flashes out.
      if (clearRows) {
        clearTimer -= dt;
        if (clearTimer <= 0) collapse();
        return;
      }
      if (!cur) return;

      /* ---- DAS / ARR horizontal auto-shift ---- */
      const l = api.input.isDown('left');
      const r = api.input.isDown('right');
      const dir = (r ? 1 : 0) - (l ? 1 : 0);
      if (dir !== dasDir) {
        dasDir = dir;
        dasTimer = 0;
        arrTimer = 0;
        if (dir && tryMove(dir, 0)) api.sfx('blip', { vol: 0.18 });
      } else if (dir) {
        dasTimer += dt;
        if (dasTimer >= DAS) {
          arrTimer += dt;
          let guard = 0;
          while (arrTimer >= ARR && guard++ < COLS) {
            arrTimer -= ARR;
            if (!tryMove(dir, 0)) { arrTimer = 0; break; }
          }
        }
      }

      /* ---- gravity + soft drop ---- */
      const soft = api.input.isDown('down');
      const interval = soft ? Math.min(gravInterval, 1 / (SOFT_MULT * 3)) : gravInterval;
      const grounded = collides(cur.type, cur.rot, cur.x, cur.y + 1);

      if (!grounded) {
        gravTimer += dt;
        let guard = 0;
        while (gravTimer >= interval && guard++ < ROWS) {
          gravTimer -= interval;
          if (collides(cur.type, cur.rot, cur.x, cur.y + 1)) break;
          cur.y++;
          cur.spun = false;
          if (soft) api.addScore(1);
          if (cur.y > cur.lowest) {
            cur.lowest = cur.y;
            cur.lockTimer = 0;
            cur.resets = 0;
          }
        }
        // Falling again after a step-off resets the grace timer.
        if (!collides(cur.type, cur.rot, cur.x, cur.y + 1)) cur.lockTimer = 0;
      } else {
        cur.lockTimer += dt;
        if (cur.lockTimer >= LOCK_DELAY) lockPiece();
      }
    },

    handleInput(e) {
      if (!alive) return;
      if (e.type === 'press') {
        switch (e.action) {
          case 'a': rotate(1); break;
          case 'b': doHold(); break;
          case 'c': hardDrop(); break;
          case 'up': hardDrop(); break;
          default: break;
        }
        return;
      }
      // Keyboard-only nicety: a counter-clockwise spin. Everything the game
      // needs is still reachable from the declared touch layout.
      if (e.type === 'key' && !e.repeat && (e.code === 'KeyZ' || e.code === 'ControlLeft')) rotate(-1);
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;

      /* ---- backdrop ---- */
      ctx.fillStyle = '#05070d';
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#0d1730';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 30) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
      for (let y = 0; y <= H; y += 30) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
      ctx.stroke();
      ctx.restore();

      text(ctx, 'TETRIS DX', W / 2, 10, { size: 13, color: PAL.cyan, align: 'center', glow: 10 });

      /* ---- well ---- */
      ctx.fillStyle = '#080b14';
      ctx.fillRect(WELL_X, WELL_Y, WELL_W, WELL_H);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#152242';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < COLS; x++) {
        ctx.moveTo(WELL_X + x * CELL + 0.5, WELL_Y);
        ctx.lineTo(WELL_X + x * CELL + 0.5, WELL_Y + WELL_H);
      }
      for (let y = 1; y < ROWS; y++) {
        ctx.moveTo(WELL_X, WELL_Y + y * CELL + 0.5);
        ctx.lineTo(WELL_X + WELL_W, WELL_Y + y * CELL + 0.5);
      }
      ctx.stroke();
      ctx.restore();

      /* ---- settled blocks ---- */
      for (let y = 0; y < ROWS; y++) {
        const row = board[y];
        for (let x = 0; x < COLS; x++) {
          const t = row[x];
          if (!t) continue;
          drawBlock(ctx, WELL_X + x * CELL, WELL_Y + y * CELL, CELL, PIECES[t].color);
        }
      }

      /* ---- line-clear flash ---- */
      if (clearRows) {
        const k = clamp(clearTimer / CLEAR_TIME, 0, 1);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const y of clearRows) {
          ctx.fillStyle = alpha(PAL.white, 0.25 + 0.6 * k);
          const inset = (1 - k) * (WELL_W / 2);
          ctx.fillRect(WELL_X + inset, WELL_Y + y * CELL, WELL_W - inset * 2, CELL);
        }
        ctx.restore();
      }

      /* ---- hard-drop streak ---- */
      if (dropTrail) {
        const a = dropTrail.life / 0.22;
        const cells = PIECES[dropTrail.type].rot[0];
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = alpha(PIECES[dropTrail.type].color, 0.28 * a);
        for (const [dx] of cells) {
          ctx.fillRect(WELL_X + (dropTrail.x + dx) * CELL + 3, WELL_Y + dropTrail.y0 * CELL,
            CELL - 6, (dropTrail.y1 - dropTrail.y0) * CELL);
        }
        ctx.restore();
      }

      /* ---- ghost + active piece ---- */
      if (cur) {
        const col = PIECES[cur.type].color;
        const cells = PIECES[cur.type].rot[cur.rot];
        const gy = ghostY();
        if (gy !== cur.y) {
          ctx.save();
          ctx.strokeStyle = alpha(col, 0.5);
          ctx.fillStyle = alpha(col, 0.09);
          ctx.lineWidth = 1;
          for (const [dx, dy] of cells) {
            const px = WELL_X + (cur.x + dx) * CELL;
            const py = WELL_Y + (gy + dy) * CELL;
            ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
            ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
          }
          ctx.restore();
        }
        // Settling piece brightens toward white as the lock delay runs out.
        const bright = cur.lockTimer > 0 ? 0.15 + 0.65 * (cur.lockTimer / LOCK_DELAY) : 0;
        ctx.save();
        ctx.shadowColor = col;
        ctx.shadowBlur = 10;
        for (const [dx, dy] of cells) {
          const py = cur.y + dy;
          if (py < 0) continue;
          drawBlock(ctx, WELL_X + (cur.x + dx) * CELL, WELL_Y + py * CELL, CELL, col, bright);
        }
        ctx.restore();
      }

      api.particles.render(ctx);

      /* ---- well frame ---- */
      ctx.save();
      ctx.strokeStyle = alpha(PAL.cyan, 0.35 + clearFlash * 0.6);
      ctx.lineWidth = 2 + clearFlash * 2;
      ctx.shadowColor = PAL.cyan;
      ctx.shadowBlur = 8 + clearFlash * 22;
      ctx.strokeRect(WELL_X - 1, WELL_Y - 1, WELL_W + 2, WELL_H + 2);
      ctx.restore();

      /* ---- HOLD panel ---- */
      panel(ctx, 14, 56, 76, 50, 'HOLD', holdUsed ? PAL.dim : PAL.magenta);
      if (holdType) {
        ctx.save();
        if (holdUsed) ctx.globalAlpha = 0.35;
        drawMini(ctx, holdType, 52, 81, 11);
        ctx.restore();
      }

      /* ---- NEXT panel ---- */
      panel(ctx, 284, 56, 62, 44, 'NEXT', PAL.cyan);
      for (let i = 1; i < PREVIEW; i++) panel(ctx, 288, 56 + i * 48, 54, 40, null, PAL.dim);
      for (let i = 0; i < PREVIEW && i < queue.length; i++) {
        drawMini(ctx, queue[i], 315, i === 0 ? 78 : 76 + i * 48, i === 0 ? 11 : 9);
      }

      /* ---- side stats ---- */
      const stat = (label, val, y, color) => {
        text(ctx, label, 14, y, { size: 8, color: PAL.dim });
        text(ctx, String(val), 90, y - 2, { size: 12, color, align: 'right' });
      };
      stat('LEVEL', level, 126, PAL.yellow);
      stat('LINES', lines, 148, PAL.lime);
      stat('COMBO', combo > 0 ? 'x' + (combo + 1) : '—', 170, combo > 0 ? PAL.magenta : PAL.dim);
      stat('B2B', b2b ? 'ON' : '—', 192, b2b ? PAL.violet : PAL.dim);
      stat('BEST', api.highScore(), 214, PAL.dim);

      // Gravity readout — a small nod to how fast things are about to get.
      text(ctx, 'GRAVITY', 14, 240, { size: 8, color: PAL.dim });
      const gw = 76;
      const gp = clamp(1 - gravInterval / gravityFor(1), 0, 1);
      ctx.fillStyle = alpha(PAL.white, 0.12);
      ctx.fillRect(14, 252, gw, 4);
      ctx.fillStyle = mix(PAL.lime, PAL.red, gp);
      ctx.fillRect(14, 252, gw * gp, 4);

      /* ---- banner ---- */
      if (banner) {
        const a = clamp(banner.life / 0.5, 0, 1);
        ctx.save();
        ctx.globalAlpha = a;
        text(ctx, banner.text, W / 2, VIEW_H - 20, {
          size: 12, color: banner.color, align: 'center', glow: 12,
        });
        ctx.restore();
      } else {
        text(ctx, api.isTouch ? 'ROT · HOLD · DROP' : 'SPACE ROTATE   K HOLD   UP DROP',
          W / 2, VIEW_H - 18, { size: 8, color: alpha(PAL.dim, 0.8), align: 'center' });
      }

      // Danger glow when the stack creeps toward the ceiling.
      let top = ROWS;
      for (let y = 0; y < ROWS && top === ROWS; y++) {
        for (let x = 0; x < COLS; x++) if (board[y][x]) { top = y; break; }
      }
      if (top < 5) {
        const d = (5 - top) / 5;
        ctx.save();
        ctx.globalAlpha = 0.25 * d * (0.6 + 0.4 * Math.sin(api.time * 8));
        ctx.fillStyle = PAL.red;
        ctx.fillRect(WELL_X, WELL_Y, WELL_W, 5 * CELL);
        ctx.restore();
      }
    },

    destroy() {
      board = null;
      cur = null;
    },
  };
}
