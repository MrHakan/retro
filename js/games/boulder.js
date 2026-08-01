/**
 * 18 — BOULDER MINE DIGGER
 * A cave of dirt, bedrock, boulders and gems. Dig tunnels, push rocks, drop them
 * on the monsters patrolling the seams, collect your quota and reach the exit
 * before the shift timer runs out.
 *
 * The whole game is the gravity pass in `physicsTick()`: a bottom-up sweep of
 * the grid where boulders and diamonds fall into empty space and roll off the
 * shoulders of anything round. Everything else — pushing, crushing, chain
 * reactions — falls out of that one rule.
 */

import { PAL, TAU, RNG, alpha, clamp, damp, polygon, roundRect, text } from '../core/fx.js';

/* ------------------------------------------------------------------ setup */

const CELL = 24;
const VIEW_W = 480;
const VIEW_H = 360;
const HUD_H = 24;
const PLAY_H = VIEW_H - HUD_H;

const PHYS_DT = 1 / 9;      // grid physics: 9 ticks per second
const MOVE_DT = 0.095;      // the digger steps a little faster than the rocks
const ENEMY_EVERY = 2;      // monsters move every N physics ticks
const MAX_LEVEL = 6;

/** Tile ids. The grid is a flat Uint8Array of these. */
const T = {
  EMPTY: 0,
  DIRT: 1,
  WALL: 2,
  BOULDER: 3,
  DIAMOND: 4,
  EXIT: 5,
};

/** Things a boulder can roll off the shoulder of. */
const ROUND = new Set([T.BOULDER, T.DIAMOND, T.WALL]);

/** up, right, down, left — index is the enemy `dir`. */
const DIRS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export const meta = {
  id: 'boulder',
  title: 'BOULDER MINE DIGGER',
  short: 'BOULDER',
  category: 'PUZZLE',
  desc: 'Tunnel through the seam, crush the monsters under falling rock and '
      + 'haul out your gem quota before the shift timer expires.',
  accent: PAL.yellow,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'ARROWS / WASD — dig & walk',
    'PUSH — walk into a boulder with space behind it',
    'P — pause',
  ],
  touch: { dpad: true },
  art(ctx, w, h, accent) {
    ctx.save();
    const s = 24;
    // Dirt field with a carved tunnel.
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 10; x++) {
        const tunnel = (y === 3 && x > 1 && x < 8) || (x === 7 && y > 2 && y < 7);
        ctx.fillStyle = tunnel ? '#0a0d14' : (x + y) % 2 ? '#553a1f' : '#4b3319';
        ctx.fillRect(x * s, y * s - 6, s - 1, s - 1);
      }
    }
    // Bedrock band.
    ctx.fillStyle = '#2b3a55';
    for (let x = 0; x < 10; x += 2) ctx.fillRect(x * s, 138, s * 2 - 2, s - 2);
    // Boulders.
    ctx.fillStyle = '#8e9bb5';
    for (const [bx, by] of [[2, 2], [5, 2], [8, 5]]) {
      ctx.beginPath();
      ctx.arc(bx * s + s / 2, by * s + s / 2 - 6, s * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
    // Gems.
    ctx.shadowColor = accent;
    ctx.shadowBlur = 12;
    ctx.fillStyle = accent;
    for (const [gx, gy] of [[3, 3], [6, 3], [7, 5]]) {
      const cx = gx * s + s / 2;
      const cy = gy * s + s / 2 - 6;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 9);
      ctx.lineTo(cx + 8, cy);
      ctx.lineTo(cx, cy + 9);
      ctx.lineTo(cx - 8, cy);
      ctx.closePath();
      ctx.fill();
    }
    // The digger.
    ctx.shadowColor = PAL.cyan;
    ctx.fillStyle = PAL.cyan;
    roundRect(ctx, 2 * s + 4, 3 * s + 1, s - 8, s - 8, 4);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#04070c';
    ctx.fillRect(2 * s + 8, 3 * s + 5, 3, 3);
    ctx.fillRect(2 * s + 13, 3 * s + 5, 3, 3);
    ctx.restore();
  },
};

export function create(api) {
  /* --- level state --- */
  let gw, gh;                 // grid dimensions in cells
  let grid, fall, moved;      // tiles / falling flags / processed-this-tick
  let px, py, faceX, faceY;   // digger cell + facing
  let exitX, exitY, exitOpen;
  let enemies, blasts;
  let need, got, convertEnemies;
  let levelSeed;

  /* --- run state --- */
  let level, lives, timeLeft, timeMax;
  let phase, phaseT, deathMsg, over;
  let physAcc, moveAcc, tickCount;
  let queuedDir, digAnim, camX, camY, sparkT, landPitch;

  const idx = (x, y) => y * gw + x;
  const inside = (x, y) => x >= 0 && y >= 0 && x < gw && y < gh;

  function enemyAt(x, y) {
    for (const e of enemies) if (e.x === x && e.y === y) return e;
    return null;
  }
  const playerAt = (x, y) => px === x && py === y;

  /* ------------------------------------------------------------ generation */

  /**
   * Levels grow with the shift number. Generation is seeded so that dying and
   * restarting hands you back the exact same cave.
   */
  function levelDims(l) {
    return {
      w: Math.min(34, 20 + (l - 1) * 3),
      h: Math.min(24, 14 + (l - 1) * 2),
    };
  }

  function generate(l, seed) {
    const rng = new RNG(seed);
    const d = levelDims(l);
    gw = d.w;
    gh = d.h;
    grid = new Uint8Array(gw * gh);
    fall = new Uint8Array(gw * gh);
    moved = new Uint8Array(gw * gh);
    enemies = [];
    blasts = [];

    // Solid dirt inside an indestructible bedrock frame.
    grid.fill(T.DIRT);
    for (let x = 0; x < gw; x++) { grid[idx(x, 0)] = T.WALL; grid[idx(x, gh - 1)] = T.WALL; }
    for (let y = 0; y < gh; y++) { grid[idx(0, y)] = T.WALL; grid[idx(gw - 1, y)] = T.WALL; }

    // Bedrock blobs — random walks that leave chunky, diggable-around shapes.
    const blobs = 4 + l * 2;
    for (let b = 0; b < blobs; b++) {
      let x = rng.int(2, gw - 3);
      let y = rng.int(2, gh - 3);
      const len = rng.int(4, 10);
      for (let i = 0; i < len; i++) {
        grid[idx(x, y)] = T.WALL;
        if (rng.chance(0.5)) grid[idx(clamp(x + rng.sign(), 1, gw - 2), y)] = T.WALL;
        x = clamp(x + rng.int(-1, 1), 1, gw - 2);
        y = clamp(y + rng.int(-1, 1), 1, gh - 2);
      }
    }

    // Caverns for the monsters to patrol.
    const caves = 2 + l;
    const caveSpots = [];
    for (let c = 0; c < caves; c++) {
      const cx = rng.int(4, gw - 5);
      const cy = rng.int(3, gh - 4);
      const rw = rng.int(2, 4);
      const rh = rng.int(2, 3);
      for (let y = cy - rh; y <= cy + rh; y++) {
        for (let x = cx - rw; x <= cx + rw; x++) {
          if (!inside(x, y) || x === 0 || y === 0 || x === gw - 1 || y === gh - 1) continue;
          if (Math.abs(x - cx) + Math.abs(y - cy) <= rw) grid[idx(x, y)] = T.EMPTY;
        }
      }
      caveSpots.push({ x: cx, y: cy });
    }

    // Boulders and gems scattered through the dirt.
    const boulderRate = 0.11 + l * 0.012;
    const gemRate = 0.045 + l * 0.004;
    for (let y = 1; y < gh - 1; y++) {
      for (let x = 1; x < gw - 1; x++) {
        const i = idx(x, y);
        if (grid[i] !== T.DIRT) continue;
        if (rng.chance(boulderRate)) grid[i] = T.BOULDER;
        else if (rng.chance(gemRate)) { grid[i] = T.DIAMOND; }
      }
    }

    // Digger start (top-left) and exit (bottom-right), both cleared out.
    px = 2;
    py = 2;
    faceX = 1;
    faceY = 0;
    for (let y = py - 1; y <= py + 1; y++) {
      for (let x = px - 1; x <= px + 1; x++) {
        if (inside(x, y) && grid[idx(x, y)] !== T.WALL) grid[idx(x, y)] = T.EMPTY;
      }
    }
    // Nothing may hang over the digger's head at spawn.
    for (let y = py - 1; y >= 1; y--) {
      const t = grid[idx(px, y)];
      if (t === T.BOULDER || t === T.DIAMOND) grid[idx(px, y)] = T.DIRT;
      else if (t === T.WALL) break;
    }

    exitX = gw - 3;
    exitY = gh - 3;
    grid[idx(exitX, exitY)] = T.EXIT;
    for (let y = exitY - 1; y <= exitY + 1; y++) {
      for (let x = exitX - 1; x <= exitX + 1; x++) {
        if (!inside(x, y) || grid[idx(x, y)] === T.EXIT) continue;
        if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) continue;
        if (grid[idx(x, y)] === T.WALL) grid[idx(x, y)] = T.DIRT;
      }
    }

    // Verify the cave is playable before committing to it: the exit must be
    // reachable, and there must be more reachable gems than the quota asks for.
    if (!floodFill().exit) carveCorridor();
    const reach = floodFill();
    const want = 6 + l * 3;
    let gems = reach.gems;
    if (gems < want + 2) {
      // Top the seam up from dirt the digger can definitely get to.
      const dirt = reach.cells.filter((i) => grid[i] === T.DIRT);
      rng.shuffle(dirt);
      for (const i of dirt) {
        if (gems >= want + 2) break;
        grid[i] = T.DIAMOND;
        gems++;
      }
    }
    need = Math.max(1, Math.min(want, gems));
    got = 0;
    convertEnemies = l >= 3;

    // Monsters go into the caverns, never next to the digger.
    const wanted = Math.min(1 + l, 6);
    for (const spot of caveSpots) {
      if (enemies.length >= wanted) break;
      const cell = nearestEmpty(spot.x, spot.y);
      if (!cell) continue;
      if (Math.abs(cell.x - px) + Math.abs(cell.y - py) < 6) continue;
      enemies.push({
        x: cell.x, y: cell.y,
        dir: rng.int(0, 3),
        hand: rng.chance(0.5) ? -1 : 1,
        wob: rng.range(0, TAU),
      });
    }

    exitOpen = false;
    timeMax = Math.max(75, 150 - l * 10);
    timeLeft = timeMax;
  }

  /**
   * BFS from the digger over everything that is not bedrock — dirt can always
   * be dug and rocks can be dug around, so this is the set of cells the run can
   * ever touch. Used to prove the exit and the gem quota are attainable.
   */
  function floodFill() {
    const seen = new Uint8Array(gw * gh);
    const cells = [idx(px, py)];
    seen[cells[0]] = 1;
    let gems = 0;
    let exitFound = false;
    for (let head = 0; head < cells.length; head++) {
      const i = cells[head];
      const x = i % gw;
      const y = (i / gw) | 0;
      if (grid[i] === T.DIAMOND) gems++;
      if (grid[i] === T.EXIT) { exitFound = true; continue; }
      for (const d of DIRS) {
        const nx = x + d.x;
        const ny = y + d.y;
        if (!inside(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (seen[ni] || grid[ni] === T.WALL) continue;
        seen[ni] = 1;
        cells.push(ni);
      }
    }
    return { gems, exit: exitFound, cells };
  }

  /** Fallback when generation walls the exit off: cut an L through the bedrock. */
  function carveCorridor() {
    let x = px;
    let y = py;
    while (x !== exitX) {
      x += Math.sign(exitX - x);
      if (grid[idx(x, y)] === T.WALL) grid[idx(x, y)] = T.DIRT;
    }
    while (y !== exitY) {
      y += Math.sign(exitY - y);
      if (grid[idx(x, y)] === T.WALL) grid[idx(x, y)] = T.DIRT;
    }
  }

  function nearestEmpty(cx, cy) {
    for (let r = 0; r < 6; r++) {
      for (let y = cy - r; y <= cy + r; y++) {
        for (let x = cx - r; x <= cx + r; x++) {
          if (!inside(x, y)) continue;
          if (grid[idx(x, y)] === T.EMPTY && !enemyAt(x, y)) return { x, y };
        }
      }
    }
    return null;
  }

  /* --------------------------------------------------------------- physics */

  /**
   * One gravity pass, bottom-up. `moved` stops an object being stepped twice in
   * the same tick, `fall` remembers whether it is already in motion — which is
   * the difference between a lethal rock and a harmless one.
   */
  function physicsTick() {
    moved.fill(0);
    let landings = 0;

    for (let y = gh - 2; y >= 1; y--) {
      for (let x = 1; x < gw - 1; x++) {
        const i = idx(x, y);
        const t = grid[i];
        if (t !== T.BOULDER && t !== T.DIAMOND) continue;
        if (moved[i]) continue;

        const bi = idx(x, y + 1);
        const below = grid[bi];

        if (below === T.EMPTY) {
          if (enemyAt(x, y + 1)) {
            // Only a rock already in motion crushes; a resting one waits.
            if (fall[i]) explode(x, y + 1, true);
            continue;
          }
          if (playerAt(x, y + 1)) {
            if (fall[i]) {
              killPlayer(t === T.DIAMOND ? 'BURIED BY FALLING GEMS' : 'CRUSHED BY A BOULDER');
              shift(i, bi, t, 1);
            }
            continue;                       // a resting rock just sits on your hat
          }
          shift(i, bi, t, 1);
          continue;
        }

        if (ROUND.has(below)) {
          // Roll off the shoulder: the side cell AND the diagonal below it must
          // both be free. Left is tried first, exactly like the arcade original.
          let rolled = false;
          for (let k = 0; k < 2 && !rolled; k++) {
            const sx = k === 0 ? x - 1 : x + 1;
            if (!inside(sx, y)) continue;
            const si = idx(sx, y);
            const di = idx(sx, y + 1);
            if (grid[si] !== T.EMPTY || grid[di] !== T.EMPTY) continue;
            if (enemyAt(sx, y) || playerAt(sx, y) || playerAt(sx, y + 1)) continue;
            shift(i, si, t, 1);
            rolled = true;
          }
          if (rolled) continue;
        }

        if (fall[i]) {
          // Landed: thump, dust, and a nudge to the screen.
          fall[i] = 0;
          landings++;
          api.particles.burst(x * CELL + CELL / 2, y * CELL + CELL, 4, {
            speed: 55, life: 0.35, size: 2, color: '#8b7a5e', glow: 0,
            drag: 3, gravity: 180, spread: Math.PI, dir: -Math.PI / 2, additive: false,
          });
        }
      }
    }

    if (landings > 0) {
      api.shakeScreen(Math.min(5, 1.6 + landings * 0.9), 7);
      landPitch = Math.min(landPitch + landings, 6);
      api.sfx('drop', { vol: Math.min(0.5, 0.22 + landings * 0.06), detune: -landPitch });
    } else if (landPitch > 0) {
      landPitch = Math.max(0, landPitch - 1);
    }

    tickCount++;
    if (tickCount % ENEMY_EVERY === 0) enemyTick();
  }

  /** Move a tile between cells, carrying its falling flag. */
  function shift(from, to, tile, falling) {
    grid[from] = T.EMPTY;
    fall[from] = 0;
    grid[to] = tile;
    fall[to] = falling;
    moved[to] = 1;
  }

  /** 3x3 blast: clears everything soft, optionally leaving gems behind. */
  function explode(cx, cy, fromEnemy) {
    const toGems = fromEnemy && convertEnemies;
    api.shakeScreen(9, 5);
    api.hitStop(0.05);
    api.sfx('explosion', { vol: 0.5 });
    api.vibrate(60);

    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (!inside(x, y)) continue;
        const i = idx(x, y);
        if (grid[i] === T.WALL || grid[i] === T.EXIT) continue;
        grid[i] = toGems ? T.DIAMOND : T.EMPTY;
        fall[i] = 0;
        blasts.push({ x, y, t: 0.34 });
        if (playerAt(x, y)) killPlayer('CAUGHT IN THE BLAST');
      }
    }
    // Anything living inside the blast is gone.
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (Math.abs(e.x - cx) <= 1 && Math.abs(e.y - cy) <= 1) {
        enemies.splice(i, 1);
        api.addScore(120);
        api.particles.popText(e.x * CELL + CELL / 2, e.y * CELL, '+120', PAL.orange);
      }
    }
    api.particles.burst(cx * CELL + CELL / 2, cy * CELL + CELL / 2, 22, {
      speed: 150, life: 0.6, size: 3, color: [PAL.orange, PAL.yellow, PAL.white],
      glow: 10, drag: 2.2,
    });
  }

  /* --------------------------------------------------------------- enemies */

  /**
   * Wall-follower: try the hand-side turn first, then straight on, then the
   * other side, then double back. With a left hand and a right hand in the mix
   * the monsters sweep tunnels in both directions.
   */
  function enemyTick() {
    for (const e of enemies) {
      const order = [
        (e.dir + (e.hand > 0 ? 1 : 3)) % 4,
        e.dir,
        (e.dir + (e.hand > 0 ? 3 : 1)) % 4,
        (e.dir + 2) % 4,
      ];
      for (const d of order) {
        const nx = e.x + DIRS[d].x;
        const ny = e.y + DIRS[d].y;
        if (!inside(nx, ny) || grid[idx(nx, ny)] !== T.EMPTY) continue;
        if (enemyAt(nx, ny)) continue;
        e.x = nx;
        e.y = ny;
        e.dir = d;
        break;
      }
      if (playerAt(e.x, e.y)) killPlayer('EATEN BY A CAVE MONSTER');
    }
  }

  /* ---------------------------------------------------------------- digger */

  function tryMove(dx, dy) {
    if (phase !== 'play') return;
    const nx = px + dx;
    const ny = py + dy;
    if (!inside(nx, ny)) return;
    faceX = dx;
    faceY = dy;
    const i = idx(nx, ny);
    const t = grid[i];

    if (t === T.WALL) { api.sfx('deny', { vol: 0.25 }); return; }

    if (t === T.EXIT) {
      if (!exitOpen) { api.sfx('deny', { vol: 0.3 }); return; }
      completeLevel();
      return;
    }

    if (t === T.BOULDER) {
      // Horizontal pushes only, and never a rock that is already in motion.
      if (dy !== 0 || fall[i]) { api.sfx('deny', { vol: 0.2 }); return; }
      const bx = nx + dx;
      if (!inside(bx, ny) || grid[idx(bx, ny)] !== T.EMPTY || enemyAt(bx, ny)) {
        api.sfx('deny', { vol: 0.2 });
        return;
      }
      shift(i, idx(bx, ny), T.BOULDER, 0);
      api.sfx('bounce', { vol: 0.3, detune: -6 });
      api.particles.burst(nx * CELL + CELL / 2, ny * CELL + CELL / 2, 5, {
        speed: 50, life: 0.3, size: 2, color: '#9aa7bd', drag: 3, additive: false,
      });
    } else if (t === T.DIRT) {
      grid[i] = T.EMPTY;
      digAnim = 0.14;
      api.sfx('step', { vol: 0.32, detune: (Math.random() * 4 - 2) | 0 });
      api.particles.burst(nx * CELL + CELL / 2, ny * CELL + CELL / 2, 6, {
        speed: 60, life: 0.35, size: 2.2, color: ['#6b4a24', '#8a6633'],
        drag: 3.2, gravity: 140, additive: false,
      });
      api.addScore(1);
    } else if (t === T.DIAMOND) {
      grid[i] = T.EMPTY;
      got++;
      api.addScore(35 + level * 5);
      api.sfx('coin', { detune: Math.min(14, got * 0.7) });
      api.particles.burst(nx * CELL + CELL / 2, ny * CELL + CELL / 2, 12, {
        speed: 100, life: 0.5, size: 2.4, color: [PAL.yellow, PAL.white], glow: 10, drag: 2.6,
      });
      if (got >= need && !exitOpen) openExit();
      api.setStatus({ LEVEL: level, GEMS: `${got}/${need}`, LIVES: lives });
    }

    grid[idx(nx, ny)] = T.EMPTY;
    px = nx;
    py = ny;
    if (enemyAt(px, py)) killPlayer('WALKED INTO A CAVE MONSTER');
  }

  function openExit() {
    exitOpen = true;
    api.sfx('levelup');
    api.particles.popText(exitX * CELL + CELL / 2, exitY * CELL - 6, 'EXIT OPEN', PAL.lime, 1.6);
    api.particles.burst(exitX * CELL + CELL / 2, exitY * CELL + CELL / 2, 18, {
      speed: 120, life: 0.8, size: 2.6, color: [PAL.lime, PAL.white], glow: 12, drag: 2,
    });
  }

  /* ----------------------------------------------------------------- flow  */

  function startLevel(l, fresh) {
    level = l;
    if (fresh) levelSeed = api.rng.int(1, 0x7ffffff);
    generate(l, levelSeed);
    physAcc = 0;
    moveAcc = 0;
    tickCount = 0;
    queuedDir = null;
    digAnim = 0;
    landPitch = 0;
    camX = clamp(px * CELL - VIEW_W / 2, 0, Math.max(0, gw * CELL - VIEW_W));
    camY = clamp(py * CELL - PLAY_H / 2, 0, Math.max(0, gh * CELL - PLAY_H));
    phase = 'intro';
    phaseT = 0;
    api.setStatus({ LEVEL: level, GEMS: `0/${need}`, LIVES: lives });
  }

  function completeLevel() {
    phase = 'clear';
    phaseT = 0;
    const bonus = 500 * level + Math.round(timeLeft) * 6;
    api.addScore(bonus);
    api.sfx('victory');
    api.shakeScreen(4, 5);
    api.particles.burst(px * CELL + CELL / 2, py * CELL + CELL / 2, 26, {
      speed: 160, life: 0.9, size: 3, color: [PAL.lime, PAL.cyan, PAL.white], glow: 12, drag: 1.8,
    });
  }

  function killPlayer(reason) {
    if (phase !== 'play') return;
    phase = 'dying';
    phaseT = 0;
    deathMsg = reason;
    lives--;
    api.setStatus({ LEVEL: level, GEMS: `${got}/${need}`, LIVES: Math.max(0, lives) });
    api.shakeScreen(12, 5);
    api.hitStop(0.08);
    api.flash(PAL.orange, 0.4);
    api.vibrate(150);
    api.sfx('explosion');
    api.particles.burst(px * CELL + CELL / 2, py * CELL + CELL / 2, 26, {
      speed: 160, life: 0.8, size: 3, color: [PAL.cyan, PAL.white, PAL.red], glow: 10, drag: 2,
    });
  }

  /* ------------------------------------------------------------------ draw */

  /** Deterministic per-cell noise so dirt speckles never crawl between frames. */
  function cellHash(x, y) {
    let h = (x * 73856093) ^ (y * 19349663);
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    return (h ^ (h >>> 15)) >>> 0;
  }

  function drawTile(ctx, x, y, t) {
    const sx = x * CELL;
    const sy = y * CELL;

    switch (t) {
      case T.DIRT: {
        const h = cellHash(x, y);
        ctx.fillStyle = h & 1 ? '#513718' : '#5b3f1d';
        ctx.fillRect(sx, sy, CELL, CELL);
        ctx.fillStyle = alpha('#000000', 0.25);
        ctx.fillRect(sx, sy + CELL - 3, CELL, 3);
        ctx.fillStyle = '#775229';
        for (let k = 0; k < 3; k++) {
          const hx = (h >> (k * 5)) & 15;
          const hy = (h >> (k * 5 + 4)) & 15;
          ctx.fillRect(sx + 2 + hx, sy + 2 + hy, 2, 2);
        }
        break;
      }
      case T.WALL: {
        ctx.fillStyle = '#26334c';
        ctx.fillRect(sx, sy, CELL, CELL);
        ctx.fillStyle = '#38496b';
        ctx.fillRect(sx + 1, sy + 1, CELL - 2, CELL * 0.42);
        ctx.fillStyle = '#1a2436';
        ctx.fillRect(sx + 1, sy + CELL * 0.5, CELL - 2, 2);
        ctx.fillRect(sx + CELL * 0.5, sy + CELL * 0.5, 2, CELL * 0.5 - 1);
        break;
      }
      case T.BOULDER: {
        const cx = sx + CELL / 2;
        const cy = sy + CELL / 2;
        ctx.fillStyle = '#71809b';
        ctx.beginPath();
        ctx.arc(cx, cy, CELL * 0.44, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#93a2bd';
        ctx.beginPath();
        ctx.arc(cx - 2, cy - 2.5, CELL * 0.3, 0, TAU);
        ctx.fill();
        ctx.fillStyle = alpha('#ffffff', 0.5);
        ctx.beginPath();
        ctx.arc(cx - CELL * 0.16, cy - CELL * 0.18, 2, 0, TAU);
        ctx.fill();
        break;
      }
      case T.DIAMOND: {
        const cx = sx + CELL / 2;
        const cy = sy + CELL / 2;
        const ph = (cellHash(x, y) & 255) / 255;
        const pulse = 0.5 + 0.5 * Math.sin(sparkT * 3 + ph * TAU);
        ctx.fillStyle = PAL.yellow;
        polygon(ctx, cx, cy, CELL * 0.42, 4, Math.PI / 4);
        ctx.fill();
        ctx.fillStyle = alpha(PAL.white, 0.55 + pulse * 0.35);
        polygon(ctx, cx, cy - 1, CELL * 0.2, 4, Math.PI / 4);
        ctx.fill();
        // Sparkle: a small cross that blinks across the facet.
        if (pulse > 0.72) {
          const s = 3 + pulse * 3;
          ctx.strokeStyle = alpha(PAL.white, pulse);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx - s, cy - 3); ctx.lineTo(cx + s, cy - 3);
          ctx.moveTo(cx, cy - 3 - s); ctx.lineTo(cx, cy - 3 + s);
          ctx.stroke();
        }
        break;
      }
      case T.EXIT: {
        ctx.save();
        if (exitOpen) {
          const p = 0.5 + 0.5 * Math.sin(sparkT * 6);
          ctx.shadowColor = PAL.lime;
          ctx.shadowBlur = 10 + p * 14;
          ctx.fillStyle = PAL.lime;
          ctx.fillRect(sx + 2, sy + 2, CELL - 4, CELL - 4);
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#04140a';
          ctx.fillRect(sx + 6, sy + 6 + p * 2, CELL - 12, CELL - 12 - p * 4);
        } else {
          ctx.fillStyle = '#1b2333';
          ctx.fillRect(sx, sy, CELL, CELL);
          ctx.strokeStyle = alpha(PAL.dim, 0.9);
          ctx.lineWidth = 2;
          ctx.strokeRect(sx + 3.5, sy + 3.5, CELL - 7, CELL - 7);
          ctx.fillStyle = PAL.dim;
          ctx.fillRect(sx + CELL / 2 - 2, sy + CELL / 2 - 1, 4, 5);
        }
        ctx.restore();
        break;
      }
      default:
        break;
    }
  }

  function drawEnemy(ctx, e) {
    const cx = e.x * CELL + CELL / 2;
    const cy = e.y * CELL + CELL / 2;
    const spin = sparkT * 2.4 + e.wob;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin);
    ctx.fillStyle = PAL.magenta;
    polygon(ctx, 0, 0, CELL * 0.44, 6, 0, CELL * 0.26);
    ctx.fill();
    ctx.rotate(-spin);
    ctx.fillStyle = '#2a0a1c';
    ctx.beginPath();
    ctx.arc(0, 0, CELL * 0.24, 0, TAU);
    ctx.fill();
    ctx.fillStyle = PAL.white;
    const gx = DIRS[e.dir].x * 2.5;
    const gy = DIRS[e.dir].y * 2.5;
    ctx.fillRect(gx - 4, gy - 2, 3, 3);
    ctx.fillRect(gx + 1, gy - 2, 3, 3);
    ctx.restore();
  }

  function drawPlayer(ctx) {
    const cx = px * CELL + CELL / 2;
    const cy = py * CELL + CELL / 2;
    const squash = digAnim > 0 ? digAnim / 0.14 : 0;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1 + squash * 0.14 * Math.abs(faceX), 1 + squash * 0.14 * Math.abs(faceY));
    ctx.shadowColor = PAL.cyan;
    ctx.shadowBlur = 10;
    ctx.fillStyle = PAL.cyan;
    roundRect(ctx, -CELL * 0.36, -CELL * 0.36, CELL * 0.72, CELL * 0.72, 4);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Visor pointed the way we last dug.
    ctx.fillStyle = '#04070c';
    ctx.fillRect(-5 + faceX * 2, -4 + faceY * 2, 10, 5);
    ctx.fillStyle = PAL.yellow;
    ctx.fillRect(-4 + faceX * 2, -3 + faceY * 2, 3, 3);
    ctx.fillRect(1 + faceX * 2, -3 + faceY * 2, 3, 3);
    // Helmet lamp glow in the dig direction.
    if (digAnim > 0) {
      ctx.fillStyle = alpha(PAL.yellow, squash * 0.4);
      ctx.fillRect(faceX * CELL * 0.4 - 3, faceY * CELL * 0.4 - 3, 6, 6);
    }
    ctx.restore();
  }

  function drawHud(ctx, W) {
    ctx.save();
    ctx.fillStyle = alpha('#04070c', 0.92);
    ctx.fillRect(0, 0, W, HUD_H);
    ctx.strokeStyle = alpha(PAL.cyan, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HUD_H - 0.5);
    ctx.lineTo(W, HUD_H - 0.5);
    ctx.stroke();
    ctx.restore();

    text(ctx, `SHIFT ${level}/${MAX_LEVEL}`, 8, 8, { size: 10, color: PAL.dim });

    // Gem counter, tinted lime the moment the quota is met.
    const gemCol = got >= need ? PAL.lime : PAL.yellow;
    const gx = 104;
    ctx.save();
    ctx.fillStyle = gemCol;
    polygon(ctx, gx, HUD_H / 2, 6, 4, Math.PI / 4);
    ctx.fill();
    ctx.restore();
    text(ctx, `${got}/${need}`, gx + 12, 8, { size: 10, color: gemCol, glow: got >= need ? 8 : 0 });

    const low = timeLeft < 20;
    text(ctx, `TIME ${Math.ceil(timeLeft)}`, W / 2 + 40, 8, {
      size: 10, color: low ? PAL.red : PAL.white, align: 'center',
      glow: low ? 8 : 0,
    });

    for (let i = 0; i < Math.max(0, lives); i++) {
      ctx.fillStyle = PAL.cyan;
      roundRect(ctx, W - 16 - i * 13, 7, 9, 9, 2);
      ctx.fill();
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  return {
    init() {
      lives = 3;
      over = false;
      sparkT = 0;
      deathMsg = '';
      startLevel(1, true);
    },

    update(dt) {
      if (over) return;
      sparkT += dt;

      for (let i = blasts.length - 1; i >= 0; i--) {
        blasts[i].t -= dt;
        if (blasts[i].t <= 0) blasts.splice(i, 1);
      }

      // Camera eases toward the digger and stops at the cave walls.
      const tx = clamp(px * CELL + CELL / 2 - VIEW_W / 2, 0, Math.max(0, gw * CELL - VIEW_W));
      const ty = clamp(py * CELL + CELL / 2 - PLAY_H / 2, 0, Math.max(0, gh * CELL - PLAY_H));
      camX = damp(camX, tx, 9, dt);
      camY = damp(camY, ty, 9, dt);

      if (phase === 'intro') {
        phaseT += dt;
        // Let the cave settle while the banner is up.
        physAcc += dt;
        while (physAcc >= PHYS_DT) { physAcc -= PHYS_DT; physicsTick(); }
        if (phaseT > 1.5) { phase = 'play'; phaseT = 0; }
        return;
      }
      if (phase === 'dying') {
        phaseT += dt;
        if (phaseT > 1.1) {
          if (lives <= 0) {
            over = true;
            api.gameOver({
              message: deathMsg,
              stats: { SHIFT: level, GEMS: `${got}/${need}`, SCORE: api.score },
            });
          } else {
            startLevel(level, false);   // same cave, same seed
          }
        }
        return;
      }
      if (phase === 'clear') {
        phaseT += dt;
        if (phaseT > 1.6) {
          if (level >= MAX_LEVEL) {
            over = true;
            api.win({
              message: 'MINE CLEARED',
              stats: { SHIFTS: MAX_LEVEL, LIVES: lives, SCORE: api.score },
            });
          } else {
            startLevel(level + 1, true);
          }
        }
        return;
      }

      /* ---- playing ---- */
      if (digAnim > 0) digAnim = Math.max(0, digAnim - dt);

      timeLeft -= dt;
      if (timeLeft <= 0) {
        timeLeft = 0;
        killPlayer('THE SHIFT TIMER EXPIRED');
        return;
      }

      // Fixed-step grid physics, accumulated from dt.
      physAcc += dt;
      let guard = 4;
      while (physAcc >= PHYS_DT && guard-- > 0) {
        physAcc -= PHYS_DT;
        physicsTick();
        if (phase !== 'play') return;
      }
      if (physAcc > PHYS_DT) physAcc = 0;

      // The digger runs on its own, slightly faster clock.
      moveAcc += dt;
      if (moveAcc >= MOVE_DT) {
        let dx = queuedDir ? queuedDir.x : api.input.axis('left', 'right');
        let dy = queuedDir ? queuedDir.y : api.input.axis('up', 'down');
        queuedDir = null;
        if (dx && dy) dy = 0;          // no diagonal digging
        if (dx || dy) {
          moveAcc = 0;
          tryMove(dx, dy);
        } else {
          moveAcc = MOVE_DT;           // stay primed for an instant first step
        }
      }
    },

    handleInput(e) {
      if (e.type !== 'press') return;
      switch (e.action) {
        case 'up': queuedDir = { x: 0, y: -1 }; break;
        case 'down': queuedDir = { x: 0, y: 1 }; break;
        case 'left': queuedDir = { x: -1, y: 0 }; break;
        case 'right': queuedDir = { x: 1, y: 0 }; break;
        default: break;
      }
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;

      ctx.fillStyle = '#04060a';
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      // Play area is clipped so nothing bleeds into the HUD strip.
      ctx.beginPath();
      ctx.rect(0, HUD_H, W, PLAY_H);
      ctx.clip();
      ctx.translate(-Math.round(camX), HUD_H - Math.round(camY));

      const x0 = Math.max(0, Math.floor(camX / CELL));
      const x1 = Math.min(gw - 1, Math.ceil((camX + W) / CELL));
      const y0 = Math.max(0, Math.floor(camY / CELL));
      const y1 = Math.min(gh - 1, Math.ceil((camY + PLAY_H) / CELL));

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const t = grid[idx(x, y)];
          if (t !== T.EMPTY) drawTile(ctx, x, y, t);
        }
      }

      // Blast flashes.
      for (const b of blasts) {
        const k = b.t / 0.34;
        ctx.save();
        ctx.globalAlpha = k;
        ctx.fillStyle = k > 0.6 ? PAL.white : PAL.orange;
        const g = (1 - k) * 6;
        ctx.fillRect(b.x * CELL + g, b.y * CELL + g, CELL - g * 2, CELL - g * 2);
        ctx.restore();
      }

      for (const e of enemies) drawEnemy(ctx, e);
      if (phase !== 'dying' && !over) drawPlayer(ctx);

      api.particles.render(ctx);
      ctx.restore();

      drawHud(ctx, W);

      // Off-screen exit pointer once the quota is filled.
      if (exitOpen && phase === 'play') {
        const ex = exitX * CELL + CELL / 2 - camX;
        const ey = exitY * CELL + CELL / 2 - camY + HUD_H;
        if (ex < 0 || ex > W || ey < HUD_H || ey > H) {
          const ax = clamp(ex, 12, W - 12);
          const ay = clamp(ey, HUD_H + 12, H - 12);
          ctx.save();
          ctx.globalAlpha = 0.5 + 0.4 * Math.sin(sparkT * 6);
          ctx.fillStyle = PAL.lime;
          polygon(ctx, ax, ay, 7, 3, Math.atan2(ey - ay, ex - ax));
          ctx.fill();
          ctx.restore();
        }
      }

      // Banners.
      if (phase === 'intro') {
        const a = clamp(Math.min(phaseT * 4, (1.5 - phaseT) * 4), 0, 1);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = alpha('#04070c', 0.8);
        ctx.fillRect(0, H / 2 - 38, W, 76);
        text(ctx, `SHIFT ${level}`, W / 2, H / 2 - 28,
          { size: 22, color: PAL.yellow, align: 'center', glow: 14 });
        text(ctx, `COLLECT ${need} GEMS, THEN FIND THE EXIT`, W / 2, H / 2 + 2,
          { size: 10, color: PAL.white, align: 'center' });
        if (convertEnemies) {
          text(ctx, 'CRUSHED MONSTERS CRYSTALLISE INTO GEMS', W / 2, H / 2 + 18,
            { size: 9, color: PAL.magenta, align: 'center' });
        }
        ctx.restore();
      } else if (phase === 'dying') {
        text(ctx, deathMsg, W / 2, H / 2 - 6,
          { size: 12, color: PAL.red, align: 'center', glow: 10 });
      } else if (phase === 'clear') {
        text(ctx, 'SHIFT COMPLETE', W / 2, H / 2 - 12,
          { size: 20, color: PAL.lime, align: 'center', glow: 14 });
        text(ctx, `TIME BONUS ${Math.round(timeLeft) * 6}`, W / 2, H / 2 + 12,
          { size: 10, color: PAL.cyan, align: 'center' });
      }
    },
  };
}
