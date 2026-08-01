/**
 * 05 — PIXEL TOWER DEFENSE
 * A fixed winding track, four towers with genuinely different behaviour
 * (single-target gatling, slowing aura, continuous beam, arcing splash),
 * three upgrade tiers with sell-for-refund, and waves of scouts, armoured
 * tanks, flyers and bosses. Everything is driven by taps: the build menu
 * opens inline on the cell you touch.
 */

import {
  PAL, TAU, alpha, mix, clamp, lerp, dist, text, roundRect, polygon, glowCircle,
} from '../core/fx.js';

/* ------------------------------------------------------------- geometry */

const CELL = 24;
const GRID_W = 20;
const GRID_H = 13;
const FIELD_H = GRID_H * CELL;    // 312
const BAR_H = 48;
const VIEW_W = GRID_W * CELL;     // 480
const VIEW_H = FIELD_H + BAR_H;   // 360

/** The track, in grid cells. The first point sits off-screen (the spawn). */
const WAYPOINTS = [
  [-1, 1], [3, 1], [3, 4], [8, 4], [8, 1], [13, 1],
  [13, 7], [2, 7], [2, 10], [16, 10], [16, 5], [18, 5],
];

const gx2px = (gx) => (gx + 0.5) * CELL;
const gy2px = (gy) => (gy + 0.5) * CELL;

/* -------------------------------------------------------------- towers */

const TOWERS = {
  gatling: {
    name: 'GATLING', short: 'GAT', cost: 40, color: PAL.cyan,
    range: 76, rate: 7, dmg: 5, air: true,
    blurb: 'FAST · SINGLE TARGET',
  },
  freezer: {
    name: 'FREEZER', short: 'FRZ', cost: 55, color: PAL.blue,
    range: 64, rate: 0, dmg: 0, slow: 0.45, air: true,
    blurb: 'SLOWING AURA · NO DAMAGE',
  },
  laser: {
    name: 'LASER', short: 'LAS', cost: 85, color: PAL.magenta,
    range: 90, rate: 0, dps: 54, air: true,
    blurb: 'CONTINUOUS BEAM · HIGH DPS',
  },
  artillery: {
    name: 'ARTILLERY', short: 'ART', cost: 95, color: PAL.orange,
    range: 122, rate: 0.62, dmg: 46, splash: 38, air: false,
    blurb: 'ARCING SPLASH · GROUND ONLY',
  },
};
const TOWER_KEYS = ['gatling', 'freezer', 'laser', 'artillery'];

/* ------------------------------------------------------------- enemies */

const ENEMIES = {
  grunt: { name: 'GRUNT', hp: 42, speed: 30, bounty: 6, color: PAL.lime, r: 7, armor: 0, leak: 1 },
  scout: { name: 'SCOUT', hp: 26, speed: 66, bounty: 8, color: PAL.yellow, r: 6, armor: 0, leak: 1 },
  tank: { name: 'TANK', hp: 150, speed: 19, bounty: 18, color: PAL.orange, r: 10, armor: 0.45, leak: 3 },
  flyer: { name: 'FLYER', hp: 58, speed: 48, bounty: 12, color: PAL.violet, r: 7, armor: 0, leak: 2, flying: true },
  boss: { name: 'BOSS', hp: 1100, speed: 15, bounty: 150, color: PAL.red, r: 15, armor: 0.5, leak: 8 },
};

const START_GOLD = 145;
const BASE_HP = 20;
const FINAL_WAVE = 30;
const PREP_TIME = 14;

export const meta = {
  id: 'towerdefense',
  title: 'PIXEL TOWER DEFENSE',
  short: 'TOWER DEF',
  category: 'STRATEGY',
  desc: 'Four genuinely different towers, three upgrade tiers and thirty waves '
      + 'of scouts, armoured tanks, flyers and bosses down one winding track.',
  accent: PAL.orange,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'TAP A CELL — open the build menu',
    'TAP A TOWER — upgrade or sell',
    'SPACE — send the next wave early',
    'K — sell the selected tower',
  ],
  touch: { buttons: [{ id: 'a', label: 'WAVE' }, { id: 'b', label: 'SELL' }] },
  art(ctx, w, h, accent) {
    ctx.save();
    ctx.fillStyle = '#070a12';
    ctx.fillRect(0, 0, w, h);
    // Faint build grid.
    ctx.strokeStyle = alpha('#16233d', 0.9);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 20) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    for (let y = 0; y <= h; y += 20) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
    ctx.stroke();
    // The track.
    const pts = [[0, 40], [70, 40], [70, 110], [150, 110], [150, 50], [210, 50], [210, 150], [240, 150]];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1d2b47';
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    ctx.strokeStyle = alpha(accent, 0.5);
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Creeps.
    const creeps = [[70, 78, PAL.lime], [150, 84, PAL.yellow], [186, 50, PAL.orange]];
    for (const [x, y, c] of creeps) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = alpha('#000', 0.6);
      ctx.fillRect(x - 7, y - 11, 14, 3);
      ctx.fillStyle = PAL.lime;
      ctx.fillRect(x - 7, y - 11, 10, 3);
    }
    // Towers + range ring + beam.
    const towers = [[40, 90, PAL.cyan], [110, 70, PAL.magenta], [190, 110, accent]];
    for (const [x, y, c] of towers) {
      ctx.fillStyle = alpha(c, 0.18);
      ctx.strokeStyle = alpha(c, 0.5);
      ctx.lineWidth = 1;
      ctx.fillRect(x - 9, y - 9, 18, 18);
      ctx.strokeRect(x - 9.5, y - 9.5, 19, 19);
      ctx.fillStyle = c;
      ctx.shadowColor = c;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.strokeStyle = alpha(PAL.magenta, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(110, 70, 44, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = PAL.magenta;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(110, 70);
    ctx.lineTo(150, 84);
    ctx.stroke();
    // Base core.
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 14;
    polygon(ctx, 236, 150, 11, 6);
    ctx.fill();
    ctx.restore();
  },
};

export function create(api) {
  /* ------------------------------------------------------------- state */

  let pathCells;             // Set of 'gx,gy' occupied by the track
  let track;                 // pixel-space waypoints
  let segLen, totalLen;
  let towers, enemies, shots, rings;
  let gold, baseHp, wave, waveActive, prep, spawnQueue, spawnTimer;
  let sel, popup, armed;
  let alive, won;
  let leaks, killCount, goldEarned;
  let banner, hoverCell;
  let bg;                    // pre-rendered static backdrop (grid + track)

  const cellKey = (gx, gy) => gx + ',' + gy;

  /* ---------------------------------------------------------- the track */

  function buildTrack() {
    track = WAYPOINTS.map(([gx, gy]) => ({ x: gx2px(gx), y: gy2px(gy) }));
    segLen = [];
    totalLen = 0;
    for (let i = 0; i < track.length - 1; i++) {
      const l = dist(track[i].x, track[i].y, track[i + 1].x, track[i + 1].y);
      segLen.push(l);
      totalLen += l;
    }
    // Mark every grid cell the track passes through as unbuildable.
    pathCells = new Set();
    for (let i = 0; i < WAYPOINTS.length - 1; i++) {
      const [x1, y1] = WAYPOINTS[i];
      const [x2, y2] = WAYPOINTS[i + 1];
      const steps = Math.abs(x2 - x1) + Math.abs(y2 - y1);
      for (let s = 0; s <= steps; s++) {
        const t = steps ? s / steps : 0;
        const gx = Math.round(lerp(x1, x2, t));
        const gy = Math.round(lerp(y1, y2, t));
        pathCells.add(cellKey(gx, gy));
        // A little shoulder so towers never visually overlap the track.
        pathCells.add(cellKey(gx, gy));
      }
    }
  }

  const baseCell = WAYPOINTS[WAYPOINTS.length - 1];
  const buildable = (gx, gy) =>
    gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H && !pathCells.has(cellKey(gx, gy));

  function towerAt(gx, gy) {
    for (const t of towers) if (t.gx === gx && t.gy === gy) return t;
    return null;
  }

  /** Position + facing at a distance along the track. */
  function along(d) {
    let rem = clamp(d, 0, totalLen);
    for (let i = 0; i < segLen.length; i++) {
      if (rem <= segLen[i] || i === segLen.length - 1) {
        const t = segLen[i] ? clamp(rem / segLen[i], 0, 1) : 0;
        const a = track[i];
        const b = track[i + 1];
        return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), ang: Math.atan2(b.y - a.y, b.x - a.x) };
      }
      rem -= segLen[i];
    }
    const last = track[track.length - 1];
    return { x: last.x, y: last.y, ang: 0 };
  }

  /* -------------------------------------------------------------- waves */

  function waveComposition(n) {
    const q = [];
    const push = (kind, count) => { for (let i = 0; i < count; i++) q.push(kind); };
    if (n % 10 === 0) {
      push('tank', 2 + Math.floor(n / 10));
      push('grunt', 8);
      if (n >= 20) push('flyer', 6);
      api.rng.shuffle(q);
      q.push('boss');                       // the boss always brings up the rear
      return q;
    }
    push('grunt', 5 + Math.floor(n * 1.1));
    if (n >= 3) push('scout', 2 + Math.floor(n * 0.6));
    if (n >= 5) push('tank', 1 + Math.floor(n * 0.32));
    if (n >= 7) push('flyer', 2 + Math.floor(n * 0.42));
    return api.rng.shuffle(q);
  }

  function startWave() {
    if (waveActive || !alive) return;
    // Sending early pays a small bounty for the seconds you gave up.
    const early = Math.max(0, Math.floor(prep));
    if (early > 0) {
      gold += early * 2;
      api.particles.popText(VIEW_W / 2, FIELD_H - 30, '+' + early * 2 + 'g EARLY', PAL.yellow);
    }
    wave++;
    waveActive = true;
    spawnQueue = waveComposition(wave);
    spawnTimer = 0;
    prep = PREP_TIME;
    api.sfx('horn');
    banner = {
      text: wave % 10 === 0 ? `WAVE ${wave} — BOSS` : `WAVE ${wave}`,
      color: wave % 10 === 0 ? PAL.red : PAL.cyan,
      life: 1.8,
    };
    syncStatus();
  }

  function spawnEnemy(kind) {
    const E = ENEMIES[kind];
    const scale = 1 + (wave - 1) * 0.21;
    const hp = Math.round(E.hp * (kind === 'boss' ? 1 + (wave / 10 - 1) * 0.8 : scale));
    enemies.push({
      kind,
      hp,
      maxHp: hp,
      d: 0,
      x: track[0].x,
      y: track[0].y,
      ang: 0,
      speed: E.speed * (kind === 'boss' ? 1 : 1 + (wave - 1) * 0.012),
      slow: 0,
      slowT: 0,
      hurt: 0,
      bob: api.rng.range(0, TAU),
    });
  }

  /* ------------------------------------------------------------ economy */

  function towerStats(t) {
    const T = TOWERS[t.kind];
    const lv = t.level - 1;
    return {
      range: T.range * (1 + lv * 0.16),
      dmg: (T.dmg || 0) * (1 + lv * 0.62),
      dps: (T.dps || 0) * (1 + lv * 0.62),
      rate: T.rate * (1 + lv * 0.28),
      slow: T.slow ? Math.min(0.72, T.slow + lv * 0.11) : 0,
      splash: T.splash ? T.splash * (1 + lv * 0.2) : 0,
    };
  }

  const upgradeCost = (t) => Math.round(TOWERS[t.kind].cost * (t.level === 1 ? 0.95 : 1.6));
  const sellValue = (t) => Math.round(t.invested * 0.6);

  function build(kind, gx, gy) {
    const T = TOWERS[kind];
    if (gold < T.cost) {
      api.sfx('deny');
      api.particles.popText(gx2px(gx), gy2px(gy) - 10, 'NEED ' + T.cost + 'g', PAL.red);
      return false;
    }
    if (!buildable(gx, gy) || towerAt(gx, gy)) {
      api.sfx('deny');
      return false;
    }
    gold -= T.cost;
    towers.push({
      kind, gx, gy,
      x: gx2px(gx), y: gy2px(gy),
      level: 1, cd: 0, invested: T.cost,
      ang: -Math.PI / 2, target: null, beam: 0, pulse: 0,
    });
    api.sfx('select');
    api.particles.burst(gx2px(gx), gy2px(gy), 12, {
      speed: 90, life: 0.4, size: 2.4, color: [T.color, PAL.white], glow: 9, drag: 3,
    });
    syncStatus();
    return true;
  }

  function upgrade(t) {
    if (t.level >= 3) { api.sfx('deny'); return; }
    const cost = upgradeCost(t);
    if (gold < cost) {
      api.sfx('deny');
      api.particles.popText(t.x, t.y - 12, 'NEED ' + cost + 'g', PAL.red);
      return;
    }
    gold -= cost;
    t.invested += cost;
    t.level++;
    api.sfx('powerup');
    api.particles.burst(t.x, t.y, 16, {
      speed: 110, life: 0.5, size: 2.6, color: [TOWERS[t.kind].color, PAL.white], glow: 11, drag: 2.6,
    });
    api.particles.popText(t.x, t.y - 14, 'LV' + t.level, TOWERS[t.kind].color);
    syncStatus();
  }

  function sell(t) {
    const refund = sellValue(t);
    gold += refund;
    towers.splice(towers.indexOf(t), 1);
    if (sel === t) sel = null;
    popup = null;
    api.sfx('coin');
    api.particles.popText(t.x, t.y - 12, '+' + refund + 'g', PAL.yellow);
    api.particles.burst(t.x, t.y, 10, {
      speed: 80, life: 0.4, size: 2.2, color: PAL.yellow, glow: 8, drag: 3,
    });
    syncStatus();
  }

  function syncStatus() {
    api.setStatus({ WAVE: wave, GOLD: gold, BASE: Math.max(0, baseHp) });
  }

  /* ------------------------------------------------------------- combat */

  function damage(e, amount, color) {
    const E = ENEMIES[e.kind];
    const dealt = amount * (1 - E.armor);
    e.hp -= dealt;
    e.hurt = 0.1;
    if (e.hp > 0) return;
    killEnemy(e, color);
  }

  function killEnemy(e, color) {
    const E = ENEMIES[e.kind];
    const bounty = Math.round(E.bounty * (1 + (wave - 1) * 0.04));
    gold += bounty;
    goldEarned += bounty;
    killCount++;
    api.addScore(bounty * 2);
    api.sfx(e.kind === 'boss' ? 'explosion' : 'boom', { vol: e.kind === 'boss' ? 0.8 : 0.28 });
    api.particles.burst(e.x, e.y, e.kind === 'boss' ? 30 : 10, {
      speed: e.kind === 'boss' ? 200 : 110, life: 0.55, size: 2.6,
      color: [color || E.color, PAL.white], glow: 9, drag: 2.6, shape: 'spark',
    });
    if (e.kind === 'boss') api.shakeScreen(12, 4);
    const i = enemies.indexOf(e);
    if (i >= 0) enemies.splice(i, 1);
    syncStatus();
  }

  function leak(e) {
    const E = ENEMIES[e.kind];
    baseHp -= E.leak;
    leaks++;
    api.sfx('hurt');
    api.shakeScreen(6 + E.leak, 6);
    api.vibrate(60);
    api.particles.burst(e.x, e.y, 14, {
      speed: 130, life: 0.6, size: 3, color: [PAL.red, PAL.white], glow: 10, drag: 2.4,
    });
    api.particles.popText(e.x, e.y - 14, '-' + E.leak, PAL.red);
    const i = enemies.indexOf(e);
    if (i >= 0) enemies.splice(i, 1);
    syncStatus();
    if (baseHp <= 0) lose();
  }

  /** Pick the enemy furthest along the track that this tower can actually hit. */
  function acquire(t, stats) {
    const T = TOWERS[t.kind];
    let best = null;
    let bestD = -1;
    for (const e of enemies) {
      if (!T.air && ENEMIES[e.kind].flying) continue;
      if (dist(t.x, t.y, e.x, e.y) > stats.range) continue;
      if (e.d > bestD) { bestD = e.d; best = e; }
    }
    return best;
  }

  function fire(t, stats, e) {
    const T = TOWERS[t.kind];
    if (t.kind === 'gatling') {
      shots.push({
        type: 'bullet', x: t.x, y: t.y, target: e,
        vx: 0, vy: 0, speed: 320, dmg: stats.dmg, color: T.color, life: 1.2,
      });
      api.sfx('shoot', { vol: 0.1, detune: api.rng.range(-4, 4) });
      api.particles.emit({
        x: t.x + Math.cos(t.ang) * 8, y: t.y + Math.sin(t.ang) * 8,
        life: 0.09, size: 4, color: T.color, glow: 8, shape: 'circle', shrink: 30,
      });
    } else {
      // Artillery leads its target and lobs a shell along a visible arc.
      const flight = 0.75;
      const lead = e.speed * (1 - e.slow) * flight;
      const p = along(e.d + lead);
      shots.push({
        type: 'shell', x0: t.x, y0: t.y, tx: p.x, ty: p.y, x: t.x, y: t.y,
        t: 0, dur: flight, dmg: stats.dmg, splash: stats.splash, color: T.color,
      });
      api.sfx('shotgun', { vol: 0.3 });
      api.shakeScreen(1.6, 12);
    }
  }

  function splash(x, y, radius, dmg, color) {
    rings.push({ x, y, r: 4, maxR: radius, life: 0.4, color });
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (ENEMIES[e.kind].flying) continue;      // artillery is ground-only
      const d = dist(x, y, e.x, e.y);
      if (d > radius) continue;
      damage(e, dmg * (1 - (d / radius) * 0.45), color);
    }
    api.particles.burst(x, y, 12, {
      speed: 150, life: 0.45, size: 3, color: [color, PAL.white], glow: 10, drag: 3,
    });
    api.sfx('boom', { vol: 0.35 });
  }

  /* --------------------------------------------------------------- flow */

  function lose() {
    if (!alive) return;
    api.hitStop(0.09);
    api.flash(PAL.red, 0.45);
    alive = false;
    api.shakeScreen(16, 3);
    api.gameOver({
      message: 'THE CORE FELL',
      stats: { WAVE: wave, KILLS: killCount, LEAKS: leaks, GOLD: goldEarned, TOWERS: towers.length },
    });
  }

  function victory() {
    if (!alive) return;
    alive = false;
    won = true;
    api.addScore(baseHp * 250);
    api.win({
      message: 'THE CORE HELD',
      stats: { WAVE: wave, BASE: baseHp, KILLS: killCount, LEAKS: leaks, GOLD: goldEarned },
    });
  }

  /* ---------------------------------------------------------- pop-up UI */

  function closePopup() {
    popup = null;
    sel = null;
  }

  /** Inline build menu anchored to the tapped cell. */
  function openBuildMenu(gx, gy) {
    const bw = 42;
    const bh = 40;
    const cols = TOWER_KEYS.length;
    const w = cols * bw + 8;
    const h = bh + 16;
    let x = clamp(gx2px(gx) - w / 2, 4, VIEW_W - w - 4);
    let y = gy2px(gy) - h - 12;
    if (y < 4) y = gy2px(gy) + 16;
    const buttons = TOWER_KEYS.map((kind, i) => ({
      kind,
      x: x + 4 + i * bw,
      y: y + 12,
      w: bw - 3,
      h: bh,
      fn: () => { build(kind, gx, gy); closePopup(); },
    }));
    popup = { kind: 'build', x, y, w, h, gx, gy, title: 'BUILD', buttons };
    sel = null;
  }

  /** Upgrade / sell panel for an existing tower. */
  function openTowerMenu(t) {
    const w = 118;
    const h = 46;
    let x = clamp(t.x - w / 2, 4, VIEW_W - w - 4);
    let y = t.y - h - 14;
    if (y < 4) y = t.y + 16;
    const buttons = [
      {
        label: t.level >= 3 ? 'MAX' : 'UPGRADE',
        sub: t.level >= 3 ? 'LV3' : upgradeCost(t) + 'g',
        color: t.level >= 3 ? PAL.dim : PAL.lime,
        x: x + 4, y: y + 14, w: 54, h: 28,
        fn: () => { upgrade(t); if (sel) openTowerMenu(t); },
      },
      {
        label: 'SELL',
        sub: '+' + sellValue(t) + 'g',
        color: PAL.yellow,
        x: x + 60, y: y + 14, w: 54, h: 28,
        fn: () => sell(t),
      },
    ];
    popup = { kind: 'tower', x, y, w, h, tower: t, title: TOWERS[t.kind].name + ' LV' + t.level, buttons };
    sel = t;
  }

  function hitButton(px, py) {
    if (!popup) return null;
    for (const b of popup.buttons) {
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b;
    }
    return null;
  }

  /* ------------------------------------------------------- bottom bar UI */

  const barButtons = [];

  function layoutBar() {
    barButtons.length = 0;
    const y = FIELD_H + 5;
    for (let i = 0; i < TOWER_KEYS.length; i++) {
      barButtons.push({ id: 'pal:' + TOWER_KEYS[i], kind: TOWER_KEYS[i], x: 96 + i * 47, y, w: 44, h: 38 });
    }
    barButtons.push({ id: 'wave', x: 288, y, w: 94, h: 38 });
  }

  function hitBar(px, py) {
    for (const b of barButtons) {
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b;
    }
    return null;
  }

  /* ------------------------------------------------------------ backdrop */

  /**
   * The grid and the track never change, so they are painted once into an
   * offscreen canvas and blitted each frame.
   */
  function renderBackdrop() {
    const c = document.createElement('canvas');
    c.width = VIEW_W;
    c.height = FIELD_H;
    const g = c.getContext('2d');

    g.fillStyle = '#070a12';
    g.fillRect(0, 0, VIEW_W, FIELD_H);
    g.strokeStyle = alpha('#16233d', 0.85);
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= GRID_W; x++) { g.moveTo(x * CELL + 0.5, 0); g.lineTo(x * CELL + 0.5, FIELD_H); }
    for (let y = 0; y <= GRID_H; y++) { g.moveTo(0, y * CELL + 0.5); g.lineTo(VIEW_W, y * CELL + 0.5); }
    g.stroke();

    // Track bed.
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(track[0].x, track[0].y);
    for (let i = 1; i < track.length; i++) g.lineTo(track[i].x, track[i].y);
    g.strokeStyle = '#141d31';
    g.lineWidth = CELL - 1;
    g.stroke();
    g.strokeStyle = '#1e2c49';
    g.lineWidth = CELL - 7;
    g.stroke();
    // Centre dashes.
    g.strokeStyle = alpha(PAL.orange, 0.35);
    g.lineWidth = 2;
    g.setLineDash([5, 9]);
    g.stroke();
    g.setLineDash([]);

    // Spawn mouth.
    g.fillStyle = alpha(PAL.red, 0.5);
    g.fillRect(0, track[0].y - CELL / 2, 5, CELL);
    return c;
  }

  /* -------------------------------------------------------------- draw   */

  function drawTower(ctx, t) {
    const T = TOWERS[t.kind];
    const s = towerStats(t);
    ctx.save();
    // Pad.
    ctx.fillStyle = alpha(T.color, 0.16);
    roundRect(ctx, t.x - 10, t.y - 10, 20, 20, 3);
    ctx.fill();
    ctx.strokeStyle = alpha(T.color, 0.65);
    ctx.lineWidth = 1;
    roundRect(ctx, t.x - 10.5, t.y - 10.5, 21, 21, 3);
    ctx.stroke();

    ctx.translate(t.x, t.y);
    if (t.kind === 'freezer') {
      ctx.rotate(api.time * 0.9);
      ctx.strokeStyle = T.color;
      ctx.lineWidth = 2;
      polygon(ctx, 0, 0, 7, 6);
      ctx.stroke();
      ctx.fillStyle = alpha(T.color, 0.5);
      ctx.fill();
    } else {
      ctx.rotate(t.ang);
      ctx.fillStyle = T.color;
      if (t.kind === 'artillery') {
        ctx.fillRect(-3, -4, 14, 8);
        ctx.fillStyle = alpha('#000', 0.35);
        ctx.fillRect(8, -4, 3, 8);
      } else if (t.kind === 'laser') {
        ctx.fillRect(-2, -2.5, 15, 5);
      } else {
        ctx.fillRect(-2, -3.5, 12, 3);
        ctx.fillRect(-2, 0.5, 12, 3);
      }
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Level pips.
    for (let i = 0; i < t.level; i++) {
      ctx.fillStyle = i < t.level ? PAL.white : PAL.dim;
      ctx.fillRect(t.x - 6 + i * 5, t.y + 12, 3, 2);
    }

    // Freezer aura.
    if (t.kind === 'freezer') {
      const pulse = 0.5 + 0.5 * Math.sin(api.time * 2.2);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(t.x, t.y, s.range * 0.2, t.x, t.y, s.range);
      g.addColorStop(0, alpha(T.color, 0.18 + pulse * 0.07));
      g.addColorStop(1, alpha(T.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(t.x, t.y, s.range, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = alpha(T.color, 0.22 + pulse * 0.12);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(t.x, t.y, s.range, 0, TAU);
      ctx.stroke();
    }
  }

  function drawEnemy(ctx, e) {
    const E = ENEMIES[e.kind];
    const flying = !!E.flying;
    const lift = flying ? 7 + Math.sin(api.time * 5 + e.bob) * 2 : 0;
    const col = e.hurt > 0 ? PAL.white : (e.slow > 0 ? mix(E.color, PAL.cyan, 0.55) : E.color);

    if (flying) {
      // Shadow on the ground sells the altitude.
      ctx.fillStyle = alpha('#000000', 0.35);
      ctx.beginPath();
      ctx.ellipse(e.x, e.y + 3, E.r * 0.8, E.r * 0.35, 0, 0, TAU);
      ctx.fill();
    }
    const ey = e.y - lift;

    ctx.save();
    ctx.translate(e.x, ey);
    ctx.rotate(e.ang);
    ctx.fillStyle = col;
    ctx.strokeStyle = alpha('#000000', 0.5);
    ctx.lineWidth = 1;
    if (e.kind === 'tank' || e.kind === 'boss') {
      ctx.fillRect(-E.r, -E.r * 0.75, E.r * 2, E.r * 1.5);
      ctx.fillStyle = alpha('#000000', 0.3);
      ctx.fillRect(-E.r, -E.r * 0.75, E.r * 2, 3);
      ctx.fillStyle = alpha(PAL.white, 0.7);
      ctx.fillRect(E.r * 0.2, -2, E.r * 0.9, 4);
    } else if (flying) {
      ctx.beginPath();
      ctx.moveTo(E.r, 0);
      ctx.lineTo(-E.r * 0.6, -E.r);
      ctx.lineTo(-E.r * 0.2, 0);
      ctx.lineTo(-E.r * 0.6, E.r);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, E.r, 0, TAU);
      ctx.fill();
      ctx.fillStyle = alpha('#000000', 0.4);
      ctx.beginPath();
      ctx.arc(E.r * 0.3, 0, E.r * 0.35, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    if (e.slow > 0) {
      ctx.strokeStyle = alpha(PAL.cyan, 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(e.x, ey, E.r + 3, 0, TAU);
      ctx.stroke();
    }

    // Health bar.
    const bw = E.r * 2.2;
    const frac = clamp(e.hp / e.maxHp, 0, 1);
    ctx.fillStyle = alpha('#000000', 0.65);
    ctx.fillRect(e.x - bw / 2, ey - E.r - 7, bw, 3);
    ctx.fillStyle = mix(PAL.red, PAL.lime, frac);
    ctx.fillRect(e.x - bw / 2, ey - E.r - 7, bw * frac, 3);
    if (E.armor > 0) {
      ctx.fillStyle = PAL.blue;
      ctx.fillRect(e.x - bw / 2 - 4, ey - E.r - 7, 3, 3);
    }
  }

  function drawPopup(ctx) {
    if (!popup) return;
    ctx.save();
    ctx.fillStyle = alpha('#070b14', 0.95);
    roundRect(ctx, popup.x, popup.y, popup.w, popup.h, 4);
    ctx.fill();
    ctx.strokeStyle = alpha(PAL.cyan, 0.55);
    ctx.lineWidth = 1;
    roundRect(ctx, popup.x + 0.5, popup.y + 0.5, popup.w - 1, popup.h - 1, 4);
    ctx.stroke();
    text(ctx, popup.title, popup.x + 5, popup.y + 3, { size: 7, color: PAL.dim });

    for (const b of popup.buttons) {
      if (popup.kind === 'build') {
        const T = TOWERS[b.kind];
        const can = gold >= T.cost;
        ctx.fillStyle = alpha(T.color, can ? 0.2 : 0.06);
        roundRect(ctx, b.x, b.y, b.w, b.h, 3);
        ctx.fill();
        ctx.strokeStyle = alpha(T.color, can ? 0.8 : 0.25);
        roundRect(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 3);
        ctx.stroke();
        towerIcon(ctx, b.kind, b.x + b.w / 2, b.y + 13, can ? 1 : 0.3);
        text(ctx, T.cost + 'g', b.x + b.w / 2, b.y + b.h - 11,
          { size: 8, color: can ? PAL.yellow : PAL.dim, align: 'center' });
      } else {
        ctx.fillStyle = alpha(b.color, 0.18);
        roundRect(ctx, b.x, b.y, b.w, b.h, 3);
        ctx.fill();
        ctx.strokeStyle = alpha(b.color, 0.75);
        roundRect(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 3);
        ctx.stroke();
        text(ctx, b.label, b.x + b.w / 2, b.y + 5, { size: 8, color: b.color, align: 'center' });
        text(ctx, b.sub, b.x + b.w / 2, b.y + 16, { size: 8, color: PAL.white, align: 'center' });
      }
    }
    ctx.restore();
  }

  function towerIcon(ctx, kind, x, y, a = 1) {
    const T = TOWERS[kind];
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = T.color;
    ctx.strokeStyle = T.color;
    ctx.lineWidth = 1.5;
    switch (kind) {
      case 'gatling':
        ctx.fillRect(x - 6, y - 2, 12, 2);
        ctx.fillRect(x - 6, y + 1, 12, 2);
        break;
      case 'freezer':
        polygon(ctx, x, y, 6, 6);
        ctx.stroke();
        break;
      case 'laser':
        ctx.fillRect(x - 7, y - 1.5, 14, 3);
        ctx.fillRect(x - 2, y - 5, 4, 10);
        break;
      default:
        ctx.fillRect(x - 5, y - 3, 10, 6);
        ctx.beginPath();
        ctx.moveTo(x + 5, y - 3);
        ctx.lineTo(x + 8, y - 6);
        ctx.stroke();
    }
    ctx.restore();
  }

  /* --------------------------------------------------------- lifecycle  */

  return {
    init() {
      buildTrack();
      layoutBar();
      bg = renderBackdrop();
      towers = [];
      enemies = [];
      shots = [];
      rings = [];
      gold = START_GOLD;
      goldEarned = 0;
      baseHp = BASE_HP;
      wave = 0;
      waveActive = false;
      prep = PREP_TIME;
      spawnQueue = [];
      spawnTimer = 0;
      sel = null;
      popup = null;
      armed = null;
      alive = true;
      won = false;
      leaks = 0;
      killCount = 0;
      hoverCell = null;
      banner = { text: 'DEFEND THE CORE', color: PAL.orange, life: 2.2 };
      syncStatus();
    },

    update(dt) {
      if (!alive) return;

      if (banner) {
        banner.life -= dt;
        if (banner.life <= 0) banner = null;
      }

      /* ---- wave pacing ---- */
      if (!waveActive) {
        prep -= dt;
        if (prep <= 0) startWave();
      } else if (spawnQueue.length) {
        spawnTimer -= dt;
        if (spawnTimer <= 0) {
          spawnTimer = Math.max(0.26, 0.85 - wave * 0.018);
          spawnEnemy(spawnQueue.shift());
        }
      } else if (enemies.length === 0) {
        waveActive = false;
        const bonus = 22 + wave * 7;
        gold += bonus;
        goldEarned += bonus;
        api.addScore(bonus * 3);
        api.sfx('levelup');
        api.particles.popText(VIEW_W / 2, FIELD_H / 2, 'WAVE CLEAR +' + bonus + 'g', PAL.lime, 1.4);
        prep = PREP_TIME;
        syncStatus();
        if (wave >= FINAL_WAVE) { victory(); return; }
      }

      /* ---- enemies ---- */
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        if (e.hurt > 0) e.hurt -= dt;
        if (e.slowT > 0) {
          e.slowT -= dt;
          if (e.slowT <= 0) e.slow = 0;
        }
        e.d += e.speed * (1 - e.slow) * dt;
        if (e.d >= totalLen) { leak(e); continue; }
        const p = along(e.d);
        e.x = p.x;
        e.y = p.y;
        e.ang = p.ang;
      }
      if (!alive) return;

      /* ---- towers ---- */
      for (const t of towers) {
        const T = TOWERS[t.kind];
        const s = towerStats(t);

        if (t.kind === 'freezer') {
          // Aura: refresh the slow on everything standing inside the ring.
          t.pulse += dt;
          for (const e of enemies) {
            if (dist(t.x, t.y, e.x, e.y) <= s.range) {
              e.slow = Math.max(e.slow, s.slow);
              e.slowT = 0.35;
            }
          }
          continue;
        }

        const target = acquire(t, s);
        t.target = target;
        if (target) {
          const want = Math.atan2(target.y - t.y, target.x - t.x);
          t.ang = want;
        }

        if (t.kind === 'laser') {
          if (target) {
            t.beam = Math.min(1, t.beam + dt * 5);
            damage(target, s.dps * dt, T.color);
            if (api.rng.chance(dt * 12)) {
              api.particles.emit({
                x: target.x, y: target.y, vx: api.rng.range(-40, 40), vy: api.rng.range(-40, 40),
                life: 0.2, size: 2, color: T.color, glow: 8, drag: 3,
              });
            }
          } else {
            t.beam = Math.max(0, t.beam - dt * 6);
          }
          continue;
        }

        t.cd -= dt;
        if (target && t.cd <= 0) {
          t.cd = 1 / s.rate;
          fire(t, s, target);
        }
      }
      if (!alive) return;

      /* ---- projectiles ---- */
      for (let i = shots.length - 1; i >= 0; i--) {
        const p = shots[i];
        if (p.type === 'bullet') {
          const tgt = p.target;
          if (!tgt || enemies.indexOf(tgt) < 0) { shots.splice(i, 1); continue; }
          const a = Math.atan2(tgt.y - p.y, tgt.x - p.x);
          p.vx = Math.cos(a) * p.speed;
          p.vy = Math.sin(a) * p.speed;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.life -= dt;
          if (p.life <= 0) { shots.splice(i, 1); continue; }
          if (dist(p.x, p.y, tgt.x, tgt.y) < ENEMIES[tgt.kind].r + 3) {
            damage(tgt, p.dmg, p.color);
            shots.splice(i, 1);
          }
        } else {
          p.t += dt;
          const k = clamp(p.t / p.dur, 0, 1);
          p.x = lerp(p.x0, p.tx, k);
          p.y = lerp(p.y0, p.ty, k) - Math.sin(k * Math.PI) * 34;
          if (k >= 1) {
            splash(p.tx, p.ty, p.splash, p.dmg, p.color);
            shots.splice(i, 1);
          }
        }
      }

      /* ---- splash rings ---- */
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.life -= dt;
        r.r = lerp(4, r.maxR, 1 - clamp(r.life / 0.4, 0, 1));
        if (r.life <= 0) rings.splice(i, 1);
      }

      /* ---- pointer hover, for the range preview while armed ---- */
      const ptr = api.input.pointer;
      if (armed && ptr.y < FIELD_H) {
        hoverCell = { gx: Math.floor(ptr.x / CELL), gy: Math.floor(ptr.y / CELL) };
      } else hoverCell = null;
    },

    handleInput(e) {
      if (!alive) return;

      if (e.type === 'press') {
        if (e.action === 'a') { startWave(); return; }
        if (e.action === 'b') { if (sel) sell(sel); else api.sfx('deny'); return; }
      }

      if (e.type !== 'pointerdown') return;
      const { x, y } = e;

      /* ---- bottom bar ---- */
      if (y >= FIELD_H) {
        const b = hitBar(x, y);
        if (!b) return;
        if (b.id === 'wave') { startWave(); return; }
        armed = armed === b.kind ? null : b.kind;
        closePopup();
        api.sfx('blip');
        return;
      }

      /* ---- an open pop-up eats the tap first ---- */
      const hit = hitButton(x, y);
      if (hit) { hit.fn(); return; }
      if (popup) { closePopup(); api.sfx('back', { vol: 0.4 }); return; }

      const gx = Math.floor(x / CELL);
      const gy = Math.floor(y / CELL);
      const existing = towerAt(gx, gy);
      if (existing) {
        armed = null;
        openTowerMenu(existing);
        api.sfx('blip');
        return;
      }
      if (!buildable(gx, gy)) {
        api.sfx('deny', { vol: 0.4 });
        closePopup();
        return;
      }
      if (armed) {
        build(armed, gx, gy);
        return;
      }
      openBuildMenu(gx, gy);
      api.sfx('blip');
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;

      ctx.fillStyle = PAL.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(bg, 0, 0);

      /* ---- buildable hint while a tower type is armed ---- */
      if (armed) {
        ctx.save();
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = TOWERS[armed].color;
        for (let gy = 0; gy < GRID_H; gy++) {
          for (let gx = 0; gx < GRID_W; gx++) {
            if (!buildable(gx, gy) || towerAt(gx, gy)) continue;
            ctx.fillRect(gx * CELL + 2, gy * CELL + 2, CELL - 4, CELL - 4);
          }
        }
        ctx.restore();
        if (hoverCell && buildable(hoverCell.gx, hoverCell.gy)) {
          const T = TOWERS[armed];
          ctx.save();
          ctx.strokeStyle = alpha(T.color, 0.5);
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(gx2px(hoverCell.gx), gy2px(hoverCell.gy), T.range, 0, TAU);
          ctx.stroke();
          ctx.restore();
        }
      }

      /* ---- base core ---- */
      const bx = gx2px(baseCell[0]);
      const by = gy2px(baseCell[1]);
      const pulse = 0.7 + 0.3 * Math.sin(api.time * 3);
      glowCircle(ctx, bx, by, 9 * pulse, baseHp > BASE_HP * 0.35 ? PAL.cyan : PAL.red, 16);
      ctx.save();
      ctx.strokeStyle = alpha(PAL.white, 0.6);
      ctx.lineWidth = 1.5;
      polygon(ctx, bx, by, 12, 6, api.time * 0.6);
      ctx.stroke();
      ctx.restore();

      /* ---- range preview for the selected tower / build menu ---- */
      if (sel) {
        const s = towerStats(sel);
        ctx.save();
        ctx.fillStyle = alpha(TOWERS[sel.kind].color, 0.07);
        ctx.beginPath();
        ctx.arc(sel.x, sel.y, s.range, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = alpha(TOWERS[sel.kind].color, 0.55);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      } else if (popup && popup.kind === 'build') {
        ctx.save();
        ctx.strokeStyle = alpha(PAL.white, 0.35);
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.strokeRect(popup.gx * CELL + 1.5, popup.gy * CELL + 1.5, CELL - 3, CELL - 3);
        ctx.restore();
      }

      /* ---- towers ---- */
      for (const t of towers) drawTower(ctx, t);

      /* ---- laser beams ---- */
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const t of towers) {
        if (t.kind !== 'laser' || !t.target || t.beam <= 0.02) continue;
        const flick = 0.75 + Math.random() * 0.25;
        ctx.strokeStyle = alpha(TOWERS.laser.color, 0.5 * t.beam * flick);
        ctx.lineWidth = 5 * t.beam;
        ctx.beginPath();
        ctx.moveTo(t.x, t.y);
        ctx.lineTo(t.target.x, t.target.y);
        ctx.stroke();
        ctx.strokeStyle = alpha(PAL.white, 0.9 * t.beam * flick);
        ctx.lineWidth = 1.6 * t.beam;
        ctx.stroke();
      }
      ctx.restore();

      /* ---- enemies ---- */
      for (const e of enemies) drawEnemy(ctx, e);

      /* ---- projectiles ---- */
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const p of shots) {
        if (p.type === 'bullet') {
          const sp = Math.hypot(p.vx, p.vy) || 1;
          ctx.strokeStyle = alpha(p.color, 0.9);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - (p.vx / sp) * 7, p.y - (p.vy / sp) * 7);
          ctx.stroke();
        } else {
          // Dotted arc showing where the shell is headed.
          const k = clamp(p.t / p.dur, 0, 1);
          ctx.strokeStyle = alpha(p.color, 0.22);
          ctx.setLineDash([2, 5]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let s = 0; s <= 10; s++) {
            const u = s / 10;
            const ax = lerp(p.x0, p.tx, u);
            const ay = lerp(p.y0, p.ty, u) - Math.sin(u * Math.PI) * 34;
            if (s === 0) ctx.moveTo(ax, ay);
            else ctx.lineTo(ax, ay);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.2 - k * 0.8, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();

      /* ---- splash rings ---- */
      ctx.save();
      for (const r of rings) {
        ctx.globalAlpha = clamp(r.life / 0.4, 0, 1) * 0.8;
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();

      api.particles.render(ctx);

      drawPopup(ctx);

      /* ---- banner ---- */
      if (banner) {
        ctx.save();
        ctx.globalAlpha = clamp(banner.life / 0.7, 0, 1);
        text(ctx, banner.text, W / 2, FIELD_H * 0.32, {
          size: 20, color: banner.color, align: 'center', glow: 14,
        });
        ctx.restore();
      }

      /* ---- bottom bar ---- */
      ctx.fillStyle = '#080b14';
      ctx.fillRect(0, FIELD_H, W, BAR_H);
      ctx.strokeStyle = alpha(PAL.orange, 0.4);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, FIELD_H + 0.5);
      ctx.lineTo(W, FIELD_H + 0.5);
      ctx.stroke();

      text(ctx, gold + 'g', 6, FIELD_H + 6, { size: 12, color: PAL.yellow, glow: 6 });
      text(ctx, 'CORE', 6, FIELD_H + 22, { size: 7, color: PAL.dim });
      const hpFrac = clamp(baseHp / BASE_HP, 0, 1);
      ctx.fillStyle = alpha('#ffffff', 0.12);
      ctx.fillRect(34, FIELD_H + 21, 52, 6);
      ctx.fillStyle = mix(PAL.red, PAL.cyan, hpFrac);
      ctx.fillRect(34, FIELD_H + 21, 52 * hpFrac, 6);
      text(ctx, `WAVE ${wave}/${FINAL_WAVE}`, 6, FIELD_H + 33, { size: 8, color: PAL.cyan });

      // Tower palette.
      for (const b of barButtons) {
        if (b.id === 'wave') continue;
        const T = TOWERS[b.kind];
        const can = gold >= T.cost;
        const on = armed === b.kind;
        ctx.fillStyle = alpha(T.color, on ? 0.32 : can ? 0.14 : 0.05);
        roundRect(ctx, b.x, b.y, b.w, b.h, 3);
        ctx.fill();
        ctx.strokeStyle = alpha(T.color, on ? 1 : can ? 0.6 : 0.2);
        ctx.lineWidth = on ? 2 : 1;
        roundRect(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 3);
        ctx.stroke();
        towerIcon(ctx, b.kind, b.x + b.w / 2, b.y + 12, can ? 1 : 0.3);
        text(ctx, T.short, b.x + b.w / 2, b.y + 20, { size: 7, color: can ? PAL.white : PAL.dim, align: 'center' });
        text(ctx, T.cost + 'g', b.x + b.w / 2, b.y + 28, { size: 8, color: can ? PAL.yellow : PAL.dim, align: 'center' });
      }

      // Next-wave button.
      const wb = barButtons[barButtons.length - 1];
      const ready = !waveActive;
      ctx.fillStyle = alpha(ready ? PAL.lime : PAL.dim, ready ? 0.2 : 0.08);
      roundRect(ctx, wb.x, wb.y, wb.w, wb.h, 3);
      ctx.fill();
      ctx.strokeStyle = alpha(ready ? PAL.lime : PAL.dim, ready ? 0.9 : 0.3);
      ctx.lineWidth = 1;
      roundRect(ctx, wb.x + 0.5, wb.y + 0.5, wb.w - 1, wb.h - 1, 3);
      ctx.stroke();
      text(ctx, ready ? 'SEND WAVE ' + (wave + 1) : 'WAVE ' + wave + ' RUNNING',
        wb.x + wb.w / 2, wb.y + 7, { size: 8, color: ready ? PAL.lime : PAL.dim, align: 'center' });
      if (ready) {
        const frac = clamp(prep / PREP_TIME, 0, 1);
        ctx.fillStyle = alpha('#ffffff', 0.12);
        ctx.fillRect(wb.x + 6, wb.y + 20, wb.w - 12, 6);
        ctx.fillStyle = PAL.lime;
        ctx.fillRect(wb.x + 6, wb.y + 20, (wb.w - 12) * frac, 6);
        text(ctx, 'AUTO IN ' + Math.ceil(prep) + 's', wb.x + wb.w / 2, wb.y + 28,
          { size: 7, color: PAL.dim, align: 'center' });
      } else {
        text(ctx, enemies.length + spawnQueue.length + ' LEFT', wb.x + wb.w / 2, wb.y + 22,
          { size: 9, color: PAL.white, align: 'center' });
      }

      // Rules legend — flying units and what can reach them.
      text(ctx, 'FLYERS', W - 6, FIELD_H + 6, { size: 8, color: PAL.violet, align: 'right' });
      text(ctx, 'HIT BY GAT/FRZ/LAS', W - 6, FIELD_H + 17, { size: 7, color: PAL.dim, align: 'right' });
      text(ctx, 'ARTILLERY = GROUND ONLY', W - 6, FIELD_H + 27, { size: 7, color: PAL.orange, align: 'right' });
      text(ctx, sel ? TOWERS[sel.kind].blurb : (armed ? TOWERS[armed].blurb : 'TAP A CELL TO BUILD'),
        W - 6, FIELD_H + 37, { size: 7, color: PAL.dim, align: 'right' });

      if (!alive) {
        text(ctx, won ? 'CORE HELD' : 'CORE LOST', W / 2, FIELD_H * 0.45, {
          size: 26, color: won ? PAL.lime : PAL.red, align: 'center', glow: 16,
        });
      }
    },

    destroy() {
      bg = null;
      towers = enemies = shots = rings = null;
    },
  };
}
