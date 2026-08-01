/**
 * 17 — CYBER CROSSER
 * Hop-by-hop lane crossing. Five lanes of neon traffic, five lanes of data-river,
 * five home slots at the top. Logs, turtles and lily pads carry you across the
 * water; trucks, crocodiles, sinking pads and the countdown clock do not care.
 *
 * The board is a strict grid — every hop lands snapped to a cell — but the hop
 * itself is a short tween with a squash so the movement reads as animation
 * rather than teleportation.
 */

import { PAL, TAU, alpha, clamp, roundRect, text } from '../core/fx.js';

/* ----------------------------------------------------------------- layout */

const CELL = 32;
const COLS = 15;
const ROWS = 13;
const VIEW_W = COLS * CELL;   // 480
const VIEW_H = ROWS * CELL;   // 416

const ROW_HOME = 0;           // goal slots
const RIVER_TOP = 1;          // river lanes occupy rows 1..5
const RIVER_BOT = 5;
const ROW_MEDIAN = 6;         // safe verge between water and road
const ROAD_TOP = 7;           // road lanes occupy rows 7..11
const ROAD_BOT = 11;
const ROW_START = 12;         // safe verge, spawn row

const HOME_COLS = [1, 4, 7, 10, 13];
const START_COL = 7;

const HOP_TIME = 0.11;        // seconds of tween per hop
const HOP_REST = 0.05;        // grounded window between auto-repeat hops
const MAX_LEVEL = 8;

/* Vehicle archetypes. Trucks are the wide, fast, unforgiving ones. */
const VEHICLES = {
  bike:  { cells: 0.75, speed: 122, gap: [2.6, 4.4], body: PAL.magenta },
  car:   { cells: 1.45, speed: 76,  gap: [2.4, 4.0], body: PAL.cyan },
  truck: { cells: 2.70, speed: 108, gap: [3.2, 5.4], body: PAL.orange },
};

/* Which river furniture floats in each of the five water lanes (top → bottom). */
const RIVER_KINDS = ['log', 'pad', 'turtle', 'croc', 'log'];
/* Which vehicle rides each of the five road lanes (top → bottom). */
const ROAD_KINDS = ['truck', 'car', 'bike', 'car', 'truck'];

const rowY = (r) => r * CELL;

export const meta = {
  id: 'crosser',
  title: 'CYBER CROSSER',
  short: 'CROSSER',
  category: 'ARCADE',
  desc: 'Hop the neon highway, ride logs and turtles across the datastream, and '
      + 'fill all five home slots before the clock — or a truck — runs you down.',
  accent: PAL.lime,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'ARROWS / WASD — hop one cell',
    'HOLD — hop repeatedly',
    'P — pause',
  ],
  touch: { dpad: true },
  art(ctx, w, h, accent) {
    ctx.save();
    // Bands: home, water, verge, road, verge.
    const band = (y, hh, c) => { ctx.fillStyle = c; ctx.fillRect(0, y, w, hh); };
    band(0, 30, '#17243a');
    band(30, 62, '#0b2b52');
    band(92, 16, '#123a1c');
    band(108, 56, '#101319');
    band(164, 16, '#123a1c');

    // Home slots.
    for (let i = 0; i < 5; i++) {
      const x = 12 + i * 44;
      ctx.fillStyle = i < 2 ? accent : '#0a1120';
      ctx.fillRect(x, 6, 30, 18);
      ctx.strokeStyle = alpha(accent, 0.6);
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 0.5, 6.5, 29, 17);
    }
    // Logs.
    ctx.fillStyle = '#6b4523';
    ctx.fillRect(20, 38, 86, 16);
    ctx.fillRect(140, 68, 74, 16);
    ctx.fillStyle = '#8a5c30';
    ctx.fillRect(20, 38, 86, 5);
    // Road dashes.
    ctx.strokeStyle = alpha(PAL.white, 0.25);
    ctx.setLineDash([10, 10]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 136); ctx.lineTo(w, 136);
    ctx.stroke();
    ctx.setLineDash([]);
    // A truck and a car.
    ctx.shadowBlur = 10;
    ctx.shadowColor = PAL.orange;
    ctx.fillStyle = PAL.orange;
    ctx.fillRect(24, 114, 72, 18);
    ctx.shadowColor = PAL.cyan;
    ctx.fillStyle = PAL.cyan;
    ctx.fillRect(150, 142, 40, 16);
    // The crosser itself, mid-hop on the verge.
    ctx.shadowColor = accent;
    ctx.shadowBlur = 14;
    ctx.fillStyle = accent;
    roundRect(ctx, 110, 90, 22, 20, 6);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#04070c';
    ctx.fillRect(115, 95, 4, 4);
    ctx.fillRect(124, 95, 4, 4);
    ctx.restore();
  },
};

export function create(api) {
  const rng = api.rng;

  let backdrop;                 // pre-rendered static bands (offscreen canvas)
  let roadLanes, riverLanes;
  let homes;                    // [{col, filled, fly, pop}]
  let player;
  let lives, level, homesFilled;
  let timeLeft, timeMax, bestRow;
  let phase, phaseT, deathMsg;  // 'play' | 'dying' | 'home' | 'clear'
  let hornCd, beepCd, waveT, over;
  let queued;                   // one buffered hop direction

  /* ------------------------------------------------------------ backdrop */

  /**
   * The bands never move, so they are rasterised once into an offscreen canvas
   * and blitted each frame — far cheaper than re-stroking the asphalt texture
   * and every verge dash sixty times a second.
   */
  function buildBackdrop() {
    const c = document.createElement('canvas');
    c.width = VIEW_W;
    c.height = VIEW_H;
    const g = c.getContext('2d');

    // Home band.
    const hg = g.createLinearGradient(0, 0, 0, CELL);
    hg.addColorStop(0, '#1b2a44');
    hg.addColorStop(1, '#101a2c');
    g.fillStyle = hg;
    g.fillRect(0, 0, VIEW_W, CELL);

    // Barrier hedges between the slots.
    for (let cx = 0; cx < COLS; cx++) {
      if (HOME_COLS.includes(cx)) continue;
      g.fillStyle = '#14351f';
      g.fillRect(cx * CELL, 2, CELL, CELL - 2);
      g.fillStyle = alpha(PAL.green, 0.18);
      for (let i = 0; i < 6; i++) {
        const px = cx * CELL + 3 + ((i * 11) % (CELL - 6));
        const py = 5 + ((i * 7) % (CELL - 10));
        g.fillRect(px, py, 4, 4);
      }
    }

    // River band.
    const wg = g.createLinearGradient(0, rowY(RIVER_TOP), 0, rowY(RIVER_BOT + 1));
    wg.addColorStop(0, '#062a4d');
    wg.addColorStop(0.5, '#03203d');
    wg.addColorStop(1, '#061f38');
    g.fillStyle = wg;
    g.fillRect(0, rowY(RIVER_TOP), VIEW_W, CELL * 5);
    g.fillStyle = alpha(PAL.cyan, 0.055);
    for (let i = 0; i < 150; i++) {
      const px = rng.range(0, VIEW_W);
      const py = rng.range(rowY(RIVER_TOP), rowY(RIVER_BOT + 1));
      g.fillRect(px, py, rng.range(4, 14), 1);
    }

    // Verges (median + start).
    for (const r of [ROW_MEDIAN, ROW_START]) {
      const vg = g.createLinearGradient(0, rowY(r), 0, rowY(r + 1));
      vg.addColorStop(0, '#0f3320');
      vg.addColorStop(1, '#0a2416');
      g.fillStyle = vg;
      g.fillRect(0, rowY(r), VIEW_W, CELL);
      g.fillStyle = alpha(PAL.lime, 0.14);
      for (let i = 0; i < 60; i++) {
        g.fillRect(rng.range(0, VIEW_W), rowY(r) + rng.range(2, CELL - 4), 3, 2);
      }
    }

    // Road band.
    g.fillStyle = '#0e1118';
    g.fillRect(0, rowY(ROAD_TOP), VIEW_W, CELL * 5);
    g.fillStyle = alpha(PAL.white, 0.03);
    for (let i = 0; i < 260; i++) {
      g.fillRect(rng.range(0, VIEW_W), rng.range(rowY(ROAD_TOP), rowY(ROAD_BOT + 1)), 2, 2);
    }
    // Dashed lane separators, solid kerbs.
    g.strokeStyle = alpha(PAL.yellow, 0.35);
    g.lineWidth = 2;
    g.setLineDash([12, 12]);
    for (let r = ROAD_TOP + 1; r <= ROAD_BOT; r++) {
      g.beginPath();
      g.moveTo(0, rowY(r) + 0.5);
      g.lineTo(VIEW_W, rowY(r) + 0.5);
      g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = alpha(PAL.white, 0.4);
    g.beginPath();
    g.moveTo(0, rowY(ROAD_TOP) + 1);
    g.lineTo(VIEW_W, rowY(ROAD_TOP) + 1);
    g.moveTo(0, rowY(ROAD_BOT + 1) - 1);
    g.lineTo(VIEW_W, rowY(ROAD_BOT + 1) - 1);
    g.stroke();

    return c;
  }

  /* ---------------------------------------------------------------- lanes */

  /** Traffic lane. `dir` is +1 (rightward) or -1. */
  function makeRoadLane(index, lvl) {
    const kind = ROAD_KINDS[index];
    const v = VEHICLES[kind];
    const dir = index % 2 === 0 ? 1 : -1;
    const pace = 1 + (lvl - 1) * 0.13;
    const lane = {
      row: ROAD_TOP + index,
      y: rowY(ROAD_TOP + index),
      dir,
      kind,
      speed: v.speed * pace * rng.range(0.9, 1.12),
      gapMin: Math.max(1.5, v.gap[0] - (lvl - 1) * 0.16),
      gapMax: Math.max(2.2, v.gap[1] - (lvl - 1) * 0.22),
      items: [],
    };
    fillLane(lane, () => ({
      kind,
      w: v.cells * CELL,
      tint: v.body,
      honked: false,
      wobble: rng.range(0, TAU),
    }));
    return lane;
  }

  /** Water lane full of rideable furniture. */
  function makeRiverLane(index, lvl) {
    const kind = RIVER_KINDS[index];
    const dir = index % 2 === 0 ? 1 : -1;
    const pace = 1 + (lvl - 1) * 0.11;
    const lane = {
      row: RIVER_TOP + index,
      y: rowY(RIVER_TOP + index),
      dir,
      kind,
      speed: (kind === 'pad' ? 44 : kind === 'turtle' ? 52 : 62) * pace * rng.range(0.92, 1.1),
      gapMin: kind === 'pad' ? 1.6 : 1.4,
      gapMax: (kind === 'pad' ? 3.0 : 2.6) + Math.max(0, 1.2 - lvl * 0.15),
      items: [],
    };
    // From level 2 a crocodile slips into the log lanes as well.
    const crocOdds = kind === 'croc' ? 0.55 : lvl >= 2 ? 0.1 + lvl * 0.03 : 0;
    fillLane(lane, () => {
      if (rng.chance(crocOdds)) return makeCroc(lvl);
      switch (kind) {
        case 'pad': return makePad(lvl);
        case 'turtle': return makeTurtles(lvl);
        default: return makeLog(lvl);
      }
    });
    return lane;
  }

  function makeLog(lvl) {
    const cells = Math.max(2, 3.4 - (lvl - 1) * 0.22);
    return { kind: 'log', w: cells * CELL, ride: true, knots: rng.int(2, 4) };
  }

  function makeTurtles(lvl) {
    const n = rng.int(2, lvl >= 4 ? 2 : 3);
    return { kind: 'turtle', w: n * CELL, ride: true, n, bob: rng.range(0, TAU) };
  }

  /** Lily pads submerge on a timer, telegraphed by a bubbling warning. */
  function makePad(lvl) {
    const cycle = Math.max(3.4, 5.6 - lvl * 0.28);
    return {
      kind: 'pad',
      w: CELL,
      ride: true,
      cycle,
      sinkDur: 1.25,
      warnDur: 1.0,
      t: rng.range(0, cycle),
      sunk: false,
      warn: 0,
      bubbled: false,
    };
  }

  /** Crocodile: rideable back, lethal head at the leading end. */
  function makeCroc() {
    return {
      kind: 'croc',
      w: 3 * CELL,
      ride: true,
      jaw: rng.range(0, TAU),
    };
  }

  /** Lay items out across the lane with randomised gaps, front and back. */
  function fillLane(lane, factory) {
    let x = -rng.range(0, CELL * 4);
    while (x < VIEW_W + CELL * 3) {
      const item = factory();
      item.x = x;
      lane.items.push(item);
      x += item.w + rng.range(lane.gapMin, lane.gapMax) * CELL;
    }
  }

  /** Move a lane and recycle anything that has left the board. */
  function updateLane(lane, dt) {
    const items = lane.items;
    const v = lane.dir * lane.speed;
    for (const it of items) it.x += v * dt;

    const margin = CELL * 2;
    for (const it of items) {
      if (lane.dir > 0 && it.x > VIEW_W + margin) {
        let min = Infinity;
        for (const o of items) if (o !== it && o.x < min) min = o.x;
        it.x = Math.min(min, 0) - rng.range(lane.gapMin, lane.gapMax) * CELL - it.w;
        it.honked = false;
      } else if (lane.dir < 0 && it.x + it.w < -margin) {
        let max = -Infinity;
        for (const o of items) if (o !== it && o.x + o.w > max) max = o.x + o.w;
        it.x = Math.max(max, VIEW_W) + rng.range(lane.gapMin, lane.gapMax) * CELL;
        it.honked = false;
      }
    }
  }

  /** Advance the per-item animation clocks (sinking pads, snapping jaws). */
  function animateRiver(dt) {
    for (const lane of riverLanes) {
      for (const it of lane.items) {
        if (it.kind === 'pad') {
          it.t = (it.t + dt) % it.cycle;
          const toSink = it.cycle - it.t;
          it.sunk = toSink <= it.sinkDur;
          it.warn = !it.sunk && toSink <= it.sinkDur + it.warnDur
            ? 1 - (toSink - it.sinkDur) / it.warnDur
            : 0;
          if (it.warn > 0.02 && !it.bubbled) {
            it.bubbled = true;
            api.particles.burst(it.x + it.w / 2, lane.y + CELL / 2, 5, {
              speed: 26, life: 0.7, size: 1.8, color: PAL.cyan, glow: 6, drag: 1.4, vy: -14,
            });
          }
          if (!it.sunk && it.warn === 0) it.bubbled = false;
        } else if (it.kind === 'croc') {
          it.jaw += dt * 3.1;
        } else if (it.kind === 'turtle') {
          it.bob += dt * 2.6;
        }
      }
    }
  }

  /** The lethal head cell of a crocodile, in world pixels. */
  function crocHead(lane, it) {
    return lane.dir > 0 ? it.x + it.w - CELL : it.x;
  }

  /* --------------------------------------------------------------- player */

  function resetPlayer() {
    const x = START_COL * CELL + CELL / 2;
    const y = rowY(ROW_START) + CELL / 2;
    player = {
      col: START_COL,
      row: ROW_START,
      x, y,
      fromX: x, fromY: y, toX: x, toY: y,
      hopping: false,
      hopT: 0,
      rest: 0,
      face: { x: 0, y: -1 },
      land: 0,
      pendingRow: ROW_START,
      pendingCol: START_COL,
    };
    bestRow = ROW_START;
    queued = null;
  }

  /** Put a fresh crosser on the start verge and restart the countdown. */
  function startLife() {
    resetPlayer();
    timeLeft = timeMax;
    beepCd = 0;
    phase = 'play';
    phaseT = 0;
  }

  /** Begin a hop, if one is legal right now. */
  function tryHop(dx, dy) {
    if (phase !== 'play' || over) return;
    if (player.hopping || player.rest > 0) {
      queued = { x: dx, y: dy };
      return;
    }
    const col = clamp(Math.round((player.x - CELL / 2) / CELL), 0, COLS - 1);
    const nc = clamp(col + dx, 0, COLS - 1);
    const nr = clamp(player.row + dy, 0, ROWS - 1);
    if (nc === col && nr === player.row) {
      api.sfx('deny', { vol: 0.35 });
      return;
    }

    // The home row is walled except at the five slots.
    if (nr === ROW_HOME) {
      const slot = homes.findIndex((s) => s.col === nc);
      if (slot < 0 || homes[slot].filled) {
        api.sfx('deny', { vol: 0.5 });
        api.shakeScreen(2.5);
        player.face = { x: dx, y: dy };
        player.land = 0.12;
        return;
      }
    }

    player.face = { x: dx, y: dy };
    player.fromX = player.x;
    player.fromY = player.y;
    player.toX = nc * CELL + CELL / 2;
    player.toY = rowY(nr) + CELL / 2;
    player.hopping = true;
    player.hopT = 0;
    player.pendingRow = nr;
    player.pendingCol = nc;
    api.sfx('step', { vol: 0.5, detune: dy < 0 ? 2 : 0 });
  }

  /** Called the instant a hop lands on its cell. */
  function land() {
    player.hopping = false;
    player.hopT = 0;
    player.rest = HOP_REST;
    player.land = 0.11;
    player.x = player.toX;
    player.y = player.toY;
    player.row = player.pendingRow;
    player.col = player.pendingCol;

    // Score only forward progress — retreating never pays.
    if (player.row < bestRow) {
      api.addScore(10 * (bestRow - player.row));
      bestRow = player.row;
    }

    if (player.row === ROW_HOME) {
      const slot = homes.findIndex((s) => s.col === player.col);
      if (slot >= 0 && !homes[slot].filled) fillHome(slot);
      return;
    }

    if (player.row === ROW_MEDIAN || player.row === ROW_START) {
      api.particles.burst(player.x, player.y + 8, 4, {
        speed: 40, life: 0.3, size: 2, color: PAL.lime, glow: 5, drag: 3,
      });
    }
  }

  /* ---------------------------------------------------------------- goals */

  function fillHome(slot) {
    const home = homes[slot];
    home.filled = true;
    home.pop = 1;
    homesFilled++;

    const timeBonus = Math.round(timeLeft) * 8;
    let gained = 60 + timeBonus;
    if (home.fly) {
      gained += 200;
      home.fly = false;
      api.particles.popText(home.col * CELL + CELL / 2, 6, '+200 FLY', PAL.yellow, 1.2);
      api.sfx('powerup');
    }
    api.addScore(gained);
    api.sfx('coin', { detune: homesFilled * 1.5 });
    api.particles.popText(home.col * CELL + CELL / 2, CELL, '+' + gained, PAL.lime, 1.0);
    api.particles.burst(home.col * CELL + CELL / 2, CELL / 2, 16, {
      speed: 110, life: 0.7, size: 2.6, color: [PAL.lime, PAL.white, PAL.cyan], glow: 10, drag: 2.4,
    });
    api.vibrate(30);

    api.setStatus({ LEVEL: level, LIVES: lives, HOMES: `${homesFilled}/5` });

    if (homesFilled >= HOME_COLS.length) {
      phase = 'clear';
      phaseT = 0;
      const bonus = 500 * level + Math.round(timeLeft) * 12;
      api.addScore(bonus);
      api.sfx('levelup');
      api.shakeScreen(5, 4);
    } else {
      phase = 'home';
      phaseT = 0;
    }
  }

  function nextLevel() {
    level++;
    if (level > MAX_LEVEL) {
      over = true;
      api.win({
        message: 'ALL SECTORS CROSSED',
        stats: { LEVELS: MAX_LEVEL, LIVES: lives, SCORE: api.score },
      });
      return;
    }
    homes = HOME_COLS.map((col) => ({ col, filled: false, fly: false, pop: 0 }));
    homesFilled = 0;
    timeMax = Math.max(17, 32 - (level - 1) * 2);
    buildLanes();
    api.setStatus({ LEVEL: level, LIVES: lives, HOMES: '0/5' });
    startLife();
  }

  function buildLanes() {
    roadLanes = [];
    riverLanes = [];
    for (let i = 0; i < 5; i++) roadLanes.push(makeRoadLane(i, level));
    for (let i = 0; i < 5; i++) riverLanes.push(makeRiverLane(i, level));
  }

  /* ---------------------------------------------------------------- death */

  function die(reason, wet) {
    if (phase !== 'play' || over) return;
    api.hitStop(0.07);
    api.flash(PAL.red, 0.4);
    phase = 'dying';
    phaseT = 0;
    deathMsg = reason;
    lives--;
    api.setStatus({ LEVEL: level, LIVES: Math.max(0, lives), HOMES: `${homesFilled}/5` });
    api.shakeScreen(wet ? 6 : 11, 5);
    api.vibrate(140);
    api.sfx(wet ? 'splash' : 'hit');

    if (wet) {
      // Water column plus a spreading ring.
      api.particles.burst(player.x, player.y, 18, {
        speed: 90, life: 0.8, size: 2.4, color: [PAL.cyan, PAL.white, PAL.blue],
        glow: 8, drag: 1.6, gravity: 220, vy: -70,
      });
      api.particles.emit({
        x: player.x, y: player.y, life: 0.55, size: 6, color: PAL.cyan,
        shape: 'ring', glow: 10,
      });
    } else {
      api.particles.burst(player.x, player.y, 20, {
        speed: 150, life: 0.6, size: 2.8, color: [PAL.lime, PAL.yellow, PAL.white],
        glow: 9, drag: 2.2,
      });
    }
  }

  function afterDeath() {
    if (lives <= 0) {
      over = true;
      api.gameOver({
        message: deathMsg,
        stats: { LEVEL: level, HOMES: `${homesFilled}/5`, SCORE: api.score },
      });
      return;
    }
    startLife();
  }

  /* ----------------------------------------------------------- collisions */

  function overlapsPlayer(x, y, w, h) {
    return player.x - 9 < x + w && player.x + 9 > x
        && player.y - 9 < y + h && player.y + 9 > y;
  }

  /** Traffic is checked continuously, even mid-hop — you can hop into a truck. */
  function checkTraffic(dt) {
    hornCd -= dt;
    for (const lane of roadLanes) {
      const vy = lane.y + 6;
      const vh = CELL - 12;
      for (const it of lane.items) {
        if (overlapsPlayer(it.x, vy, it.w, vh)) {
          die(it.kind === 'truck' ? 'FLATTENED BY A TRUCK' : 'RUN DOWN IN TRAFFIC', false);
          return;
        }
        // A near miss in this or an adjacent lane earns a horn blast.
        const near = Math.abs(it.x + it.w / 2 - player.x) < CELL * 1.6;
        const rowGap = Math.abs(lane.y + CELL / 2 - player.y);
        if (near && rowGap < CELL * 1.6 && !it.honked && hornCd <= 0) {
          it.honked = true;
          hornCd = 0.5;
          api.sfx('horn', {
            vol: it.kind === 'truck' ? 0.5 : 0.3,
            detune: it.kind === 'truck' ? -5 : it.kind === 'bike' ? 6 : 0,
            pan: clamp((it.x + it.w / 2 - player.x) / (CELL * 3), -1, 1),
          });
        }
        if (!near) it.honked = false;
      }
    }
  }

  /** Water is only judged when grounded, so a hop is never unfairly drowned. */
  function checkRiver(dt) {
    const lane = riverLanes[player.row - RIVER_TOP];
    let carrier = null;
    for (const it of lane.items) {
      if (player.x >= it.x && player.x <= it.x + it.w) { carrier = it; break; }
    }
    if (!carrier) {
      die('DROWNED IN THE DATASTREAM', true);
      return;
    }
    if (carrier.kind === 'pad' && carrier.sunk) {
      die('THE LILY PAD SANK', true);
      return;
    }
    if (carrier.kind === 'croc') {
      const hx = crocHead(lane, carrier);
      if (player.x >= hx && player.x <= hx + CELL) {
        die('SNAPPED BY A CROCODILE', false);
        return;
      }
    }

    // Riding: inherit the lane velocity outright so we stay glued to the item.
    player.x += lane.dir * lane.speed * dt;
    if (player.x < 6 || player.x > VIEW_W - 6) {
      die('SWEPT OFF THE GRID', true);
    }
  }

  /* ----------------------------------------------------------------- draw */

  function drawVehicle(ctx, lane, it) {
    const y = lane.y + 5;
    const h = CELL - 10;
    const cx = it.x + it.w / 2;
    ctx.save();
    ctx.shadowColor = it.tint;
    ctx.shadowBlur = 8;
    ctx.fillStyle = it.tint;

    if (it.kind === 'bike') {
      roundRect(ctx, it.x + 2, y + 4, it.w - 4, h - 8, 3);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = PAL.white;
      ctx.fillRect(cx - 2, y + 1, 4, 5);
    } else {
      roundRect(ctx, it.x, y, it.w, h, it.kind === 'truck' ? 3 : 5);
      ctx.fill();
      ctx.shadowBlur = 0;
      // Cargo box / cabin split.
      ctx.fillStyle = alpha('#04070c', 0.55);
      if (it.kind === 'truck') {
        const cabW = CELL * 0.7;
        const cabX = lane.dir > 0 ? it.x + it.w - cabW : it.x;
        ctx.fillRect(cabX + 3, y + 3, cabW - 6, h - 6);
        ctx.fillStyle = alpha(PAL.white, 0.12);
        for (let i = 1; i < 4; i++) {
          const rx = it.x + (it.w / 4) * i;
          ctx.fillRect(rx, y + 3, 2, h - 6);
        }
      } else {
        ctx.fillRect(it.x + 5, y + 4, it.w - 10, h - 8);
        ctx.fillStyle = alpha(PAL.white, 0.25);
        ctx.fillRect(it.x + 7, y + 5, it.w - 14, 3);
      }
    }

    // Head/tail lights on the leading edge.
    const front = lane.dir > 0 ? it.x + it.w - 2 : it.x;
    ctx.fillStyle = PAL.yellow;
    ctx.shadowColor = PAL.yellow;
    ctx.shadowBlur = 10;
    ctx.fillRect(front, y + 2, 2, 3);
    ctx.fillRect(front, y + h - 5, 2, 3);
    ctx.restore();
  }

  function drawLog(ctx, lane, it) {
    const y = lane.y + 6;
    const h = CELL - 12;
    ctx.fillStyle = '#5c3a1e';
    roundRect(ctx, it.x, y, it.w, h, 5);
    ctx.fill();
    ctx.fillStyle = '#7a4f28';
    roundRect(ctx, it.x + 2, y + 2, it.w - 4, h * 0.45, 4);
    ctx.fill();
    ctx.strokeStyle = alpha('#2d1a0c', 0.8);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i <= it.knots; i++) {
      const kx = it.x + (it.w / (it.knots + 1)) * i;
      ctx.moveTo(kx, y + 2);
      ctx.lineTo(kx, y + h - 2);
    }
    ctx.stroke();
  }

  function drawTurtles(ctx, lane, it) {
    for (let i = 0; i < it.n; i++) {
      const cx = it.x + CELL / 2 + i * CELL;
      const cy = lane.y + CELL / 2 + Math.sin(it.bob + i * 0.9) * 1.6;
      ctx.fillStyle = '#1e6b4a';
      ctx.beginPath();
      ctx.arc(cx, cy, CELL * 0.36, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#2fa06c';
      ctx.beginPath();
      ctx.arc(cx, cy, CELL * 0.24, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#154f36';
      const hx = cx + lane.dir * CELL * 0.42;
      ctx.beginPath();
      ctx.arc(hx, cy, 3.2, 0, TAU);
      ctx.fill();
      // Shell plates.
      ctx.strokeStyle = alpha('#0b2f20', 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        const a = it.bob * 0 + (k / 3) * TAU;
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * CELL * 0.33, cy + Math.sin(a) * CELL * 0.33);
      }
      ctx.stroke();
    }
  }

  function drawPad(ctx, lane, it) {
    const cx = it.x + it.w / 2;
    const cy = lane.y + CELL / 2;
    if (it.sunk) {
      // Only a ripple remains while it is under.
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = PAL.cyan;
      ctx.lineWidth = 1;
      const r = CELL * 0.24 + (it.sinkDur - (it.cycle - it.t)) * 6;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.abs(r) % (CELL * 0.5) + 4, 0, TAU);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const warnPulse = it.warn > 0 ? 0.5 + 0.5 * Math.sin(it.warn * 28) : 0;
    ctx.save();
    if (it.warn > 0) {
      ctx.shadowColor = PAL.red;
      ctx.shadowBlur = 6 + warnPulse * 12;
    }
    ctx.fillStyle = it.warn > 0 ? (warnPulse > 0.5 ? '#4b7a2c' : '#2f6b2a') : '#2f7a3a';
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.42 * (1 - it.warn * 0.12), 0, TAU);
    ctx.fill();
    ctx.restore();
    // Pad notch + veins.
    ctx.fillStyle = '#0a2436';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + CELL * 0.42, cy - 4);
    ctx.lineTo(cx + CELL * 0.42, cy + 4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = alpha('#8dff4a', 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = 0.9 + (k / 4) * (TAU - 1.8);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * CELL * 0.38, cy + Math.sin(a) * CELL * 0.38);
    }
    ctx.stroke();
  }

  function drawCroc(ctx, lane, it) {
    const y = lane.y + 6;
    const h = CELL - 12;
    const hx = crocHead(lane, it);
    // Body.
    ctx.fillStyle = '#2c5f2b';
    roundRect(ctx, it.x, y, it.w, h, 5);
    ctx.fill();
    ctx.fillStyle = '#3d7d38';
    roundRect(ctx, it.x + 2, y + 2, it.w - 4, h * 0.4, 3);
    ctx.fill();
    // Back ridges over the safe segments.
    ctx.fillStyle = '#1c4420';
    for (let i = 0; i < 6; i++) {
      const rx = it.x + 6 + i * (it.w - 12) / 6;
      if (rx > hx - 2 && rx < hx + CELL) continue;
      ctx.fillRect(rx, y - 2, 4, 4);
    }
    // Head segment: always lethal, and it snaps to say so.
    const open = Math.max(0, Math.sin(it.jaw)) ** 2;
    ctx.save();
    ctx.shadowColor = PAL.red;
    ctx.shadowBlur = 4 + open * 12;
    ctx.fillStyle = open > 0.35 ? '#7a2320' : '#3f6b34';
    roundRect(ctx, hx + 1, y - 1, CELL - 2, h + 2, 4);
    ctx.fill();
    ctx.restore();
    // Jaws + eye.
    const mouthX = lane.dir > 0 ? hx + CELL - 3 : hx + 3;
    ctx.strokeStyle = PAL.white;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mouthX, y + h / 2 - open * 5);
    ctx.lineTo(mouthX - lane.dir * (CELL - 8), y + h / 2);
    ctx.moveTo(mouthX, y + h / 2 + open * 5);
    ctx.lineTo(mouthX - lane.dir * (CELL - 8), y + h / 2);
    ctx.stroke();
    ctx.fillStyle = PAL.yellow;
    ctx.beginPath();
    ctx.arc(hx + CELL / 2, y + 4, 2, 0, TAU);
    ctx.fill();
  }

  function drawPlayer(ctx) {
    if (phase === 'dying' && phaseT > 0.05) {
      // Flattened / sunk marker while the death animation plays.
      ctx.save();
      ctx.globalAlpha = clamp(1 - phaseT / 0.9, 0, 1);
      ctx.strokeStyle = PAL.white;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(player.x, player.y, 4 + phaseT * 16, 0, TAU);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Squash: stretch along the travel axis mid-hop, flatten on landing.
    let sx = 1;
    let sy = 1;
    if (player.hopping) {
      const t = player.hopT / HOP_TIME;
      const pop = Math.sin(t * Math.PI);
      if (player.face.y !== 0) { sy = 1 + pop * 0.3; sx = 1 - pop * 0.16; }
      else { sx = 1 + pop * 0.3; sy = 1 - pop * 0.16; }
    } else if (player.land > 0) {
      const k = player.land / 0.11;
      sy = 1 - k * 0.28;
      sx = 1 + k * 0.22;
    }

    const size = CELL * 0.62;
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.scale(sx, sy);
    ctx.rotate(Math.atan2(player.face.y, player.face.x) + Math.PI / 2);
    ctx.shadowColor = PAL.lime;
    ctx.shadowBlur = 12;
    // Legs.
    ctx.fillStyle = '#5fbf2a';
    ctx.fillRect(-size * 0.62, -size * 0.1, size * 0.3, size * 0.34);
    ctx.fillRect(size * 0.32, -size * 0.1, size * 0.3, size * 0.34);
    // Body.
    ctx.fillStyle = PAL.lime;
    roundRect(ctx, -size / 2, -size / 2, size, size, 5);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Eyes look where you are headed.
    ctx.fillStyle = '#04070c';
    ctx.fillRect(-size * 0.28, -size * 0.42, size * 0.22, size * 0.22);
    ctx.fillRect(size * 0.06, -size * 0.42, size * 0.22, size * 0.22);
    ctx.fillStyle = PAL.white;
    ctx.fillRect(-size * 0.24, -size * 0.38, size * 0.08, size * 0.08);
    ctx.fillRect(size * 0.1, -size * 0.38, size * 0.08, size * 0.08);
    ctx.restore();
  }

  function drawHomes(ctx) {
    for (const home of homes) {
      const x = home.col * CELL;
      if (home.filled) {
        const pop = home.pop;
        ctx.save();
        ctx.shadowColor = PAL.lime;
        ctx.shadowBlur = 10 + pop * 20;
        ctx.fillStyle = alpha(PAL.lime, 0.85);
        roundRect(ctx, x + 4 - pop * 2, 5 - pop * 2, CELL - 8 + pop * 4, CELL - 10 + pop * 4, 5);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#04070c';
        ctx.fillRect(x + 10, 12, 4, 4);
        ctx.fillRect(x + CELL - 14, 12, 4, 4);
      } else {
        ctx.save();
        ctx.strokeStyle = alpha(PAL.cyan, 0.5 + 0.25 * Math.sin(waveT * 3 + home.col));
        ctx.lineWidth = 2;
        ctx.shadowColor = PAL.cyan;
        ctx.shadowBlur = 8;
        roundRect(ctx, x + 3.5, 4.5, CELL - 7, CELL - 9, 4);
        ctx.stroke();
        ctx.restore();
        if (home.fly) {
          // The bonus fly buzzes in place.
          const fx = x + CELL / 2 + Math.sin(waveT * 9) * 3;
          const fy = CELL / 2 + Math.cos(waveT * 12) * 2;
          ctx.save();
          ctx.shadowColor = PAL.yellow;
          ctx.shadowBlur = 10;
          ctx.fillStyle = PAL.yellow;
          ctx.fillRect(fx - 3, fy - 2, 6, 4);
          ctx.fillStyle = alpha(PAL.white, 0.7);
          ctx.fillRect(fx - 6, fy - 4, 4, 2);
          ctx.fillRect(fx + 2, fy - 4, 4, 2);
          ctx.restore();
        }
      }
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  return {
    init() {
      lives = 3;
      level = 1;
      over = false;
      homesFilled = 0;
      hornCd = 0;
      beepCd = 0;
      waveT = 0;
      deathMsg = '';
      timeMax = 32;
      timeLeft = timeMax;
      homes = HOME_COLS.map((col) => ({ col, filled: false, fly: false, pop: 0 }));
      buildLanes();
      backdrop = buildBackdrop();
      startLife();
      api.setStatus({ LEVEL: 1, LIVES: 3, HOMES: '0/5' });
    },

    update(dt) {
      if (over) return;
      waveT += dt;

      // The world keeps flowing during death and scoring pauses.
      for (const lane of roadLanes) updateLane(lane, dt);
      for (const lane of riverLanes) updateLane(lane, dt);
      animateRiver(dt);
      for (const home of homes) if (home.pop > 0) home.pop = Math.max(0, home.pop - dt * 3);

      if (phase === 'dying') {
        phaseT += dt;
        if (phaseT > 0.85) afterDeath();
        return;
      }
      if (phase === 'home') {
        phaseT += dt;
        if (phaseT > 0.5) startLife();
        return;
      }
      if (phase === 'clear') {
        phaseT += dt;
        if (phaseT > 1.4) nextLevel();
        return;
      }

      /* ---- playing ---- */
      if (player.land > 0) player.land = Math.max(0, player.land - dt);
      if (player.rest > 0) player.rest = Math.max(0, player.rest - dt);

      // Countdown. It is per life and it is merciless.
      timeLeft -= dt;
      if (timeLeft <= 5 && timeLeft > 0) {
        beepCd -= dt;
        if (beepCd <= 0) {
          beepCd = timeLeft < 2.5 ? 0.3 : 0.6;
          api.sfx('alert', { vol: 0.3, detune: 6 - timeLeft });
        }
      }
      if (timeLeft <= 0) {
        timeLeft = 0;
        die('THE CLOCK RAN OUT', false);
        return;
      }

      // Hop tween.
      if (player.hopping) {
        player.hopT += dt;
        const t = clamp(player.hopT / HOP_TIME, 0, 1);
        // Ease-out so the landing reads as a thump, not a glide.
        const e = 1 - (1 - t) * (1 - t);
        player.x = player.fromX + (player.toX - player.fromX) * e;
        player.y = player.fromY + (player.toY - player.fromY) * e;
        if (t >= 1) land();
      } else {
        // Held direction auto-repeats once the rest window elapses.
        if (player.rest <= 0) {
          if (queued) {
            const q = queued;
            queued = null;
            tryHop(q.x, q.y);
          } else {
            const ax = api.input.axis('left', 'right');
            const ay = api.input.axis('up', 'down');
            if (ay) tryHop(0, ay);
            else if (ax) tryHop(ax, 0);
          }
        }
      }

      if (phase !== 'play') return;

      // Hazards. Traffic bites at any time; water only judges a grounded frog.
      checkTraffic(dt);
      if (phase !== 'play') return;
      if (!player.hopping && player.row >= RIVER_TOP && player.row <= RIVER_BOT) {
        checkRiver(dt);
      }

      // A fly occasionally lands in an empty slot.
      if (!homes.some((s) => s.fly) && rng.chance(dt * 0.09)) {
        const open = homes.filter((s) => !s.filled);
        if (open.length) {
          const pick = rng.pick(open);
          pick.fly = true;
          pick.flyLife = 6;
          api.sfx('blip', { vol: 0.4 });
        }
      }
      for (const home of homes) {
        if (home.fly) {
          home.flyLife -= dt;
          if (home.flyLife <= 0) home.fly = false;
        }
      }
    },

    handleInput(e) {
      if (e.type !== 'press') return;
      switch (e.action) {
        case 'up': tryHop(0, -1); break;
        case 'down': tryHop(0, 1); break;
        case 'left': tryHop(-1, 0); break;
        case 'right': tryHop(1, 0); break;
        default: break;
      }
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;

      ctx.fillStyle = PAL.bg;
      ctx.fillRect(0, 0, W, H);
      if (backdrop) ctx.drawImage(backdrop, 0, 0);

      // Animated water shimmer over the static river band.
      ctx.save();
      ctx.strokeStyle = alpha(PAL.cyan, 0.16);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let r = RIVER_TOP; r <= RIVER_BOT; r++) {
        const y = rowY(r) + CELL / 2;
        const off = (waveT * 26 * (r % 2 ? -1 : 1)) % 48;
        for (let x = -48; x < W; x += 48) {
          ctx.moveTo(x + off, y - 5);
          ctx.lineTo(x + off + 22, y - 5);
          ctx.moveTo(x + off + 12, y + 7);
          ctx.lineTo(x + off + 32, y + 7);
        }
      }
      ctx.stroke();
      ctx.restore();

      drawHomes(ctx);

      // River furniture.
      for (const lane of riverLanes) {
        for (const it of lane.items) {
          if (it.x > W + CELL || it.x + it.w < -CELL) continue;
          if (it.kind === 'log') drawLog(ctx, lane, it);
          else if (it.kind === 'turtle') drawTurtles(ctx, lane, it);
          else if (it.kind === 'pad') drawPad(ctx, lane, it);
          else drawCroc(ctx, lane, it);
        }
      }

      // Traffic.
      for (const lane of roadLanes) {
        for (const it of lane.items) {
          if (it.x > W + CELL || it.x + it.w < -CELL) continue;
          drawVehicle(ctx, lane, it);
        }
      }

      if (!over) drawPlayer(ctx);

      api.particles.render(ctx);

      // Countdown bar across the bottom verge.
      const frac = clamp(timeLeft / timeMax, 0, 1);
      const barW = (W - 16) * frac;
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = '#04070c';
      ctx.fillRect(8, H - 10, W - 16, 5);
      ctx.restore();
      const barCol = frac > 0.5 ? PAL.lime : frac > 0.22 ? PAL.yellow : PAL.red;
      ctx.save();
      ctx.shadowColor = barCol;
      ctx.shadowBlur = frac < 0.22 ? 12 : 6;
      ctx.fillStyle = barCol;
      ctx.fillRect(8, H - 10, barW, 5);
      ctx.restore();
      text(ctx, 'TIME', 8, H - 22, { size: 8, color: alpha(barCol, 0.9) });

      // Remaining lives as little frog pips.
      for (let i = 0; i < Math.max(0, lives - 1); i++) {
        ctx.save();
        ctx.shadowColor = PAL.lime;
        ctx.shadowBlur = 6;
        ctx.fillStyle = PAL.lime;
        roundRect(ctx, W - 16 - i * 12, H - 24, 9, 9, 2);
        ctx.fill();
        ctx.restore();
      }

      // Phase banners.
      if (phase === 'clear') {
        ctx.save();
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = '#04070c';
        ctx.fillRect(0, H / 2 - 30, W, 60);
        ctx.restore();
        text(ctx, `SECTOR ${level} CLEAR`, W / 2, H / 2 - 18,
          { size: 20, color: PAL.lime, align: 'center', glow: 14 });
        text(ctx, level >= MAX_LEVEL ? 'FINAL CROSSING' : 'FASTER LANES AHEAD', W / 2, H / 2 + 8,
          { size: 10, color: PAL.cyan, align: 'center' });
      } else if (phase === 'dying') {
        text(ctx, deathMsg, W / 2, H / 2 - 6,
          { size: 12, color: PAL.red, align: 'center', glow: 10 });
      }
    },
  };
}
