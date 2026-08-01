/**
 * 04 — 16-BIT ROGUELIKE DUNGEON
 * A proper turn-based crawl: BSP-generated floors, recursive-shadowcasting
 * field of view with three-state fog, a Dijkstra flow field for monster
 * pathing, bump combat with XP and levelling, locked chests, and permadeath.
 * The world only ticks when you act.
 */

import { PAL, alpha, mix, clamp, text, roundRect } from '../core/fx.js';

/* ------------------------------------------------------------- geometry */

const TILE = 16;
const VIEW_COLS = 30;
const VIEW_ROWS = 18;
const LOG_H = 72;
const VIEW_W = VIEW_COLS * TILE;             // 480
const MAP_VIEW_H = VIEW_ROWS * TILE;         // 288
const VIEW_H = MAP_VIEW_H + LOG_H;           // 360

const MAP_W = 52;
const MAP_H = 34;

const WALL = 0;
const FLOOR = 1;
const STAIRS = 2;

const LIGHT = 8;                             // torch radius, in tiles
const FAR = 9999;

/* Eight octant transforms used by the shadowcaster. */
const OCTANTS = [
  [1, 0, 0, 1], [0, 1, 1, 0], [0, -1, 1, 0], [-1, 0, 0, 1],
  [-1, 0, 0, -1], [0, -1, -1, 0], [0, 1, -1, 0], [1, 0, 0, -1],
];

const MONSTERS = {
  goblin: {
    glyph: 'g', color: PAL.lime, name: 'goblin',
    hp: 6, atk: 4, def: 0, xp: 6, speed: 120, sight: 7,
  },
  orc: {
    glyph: 'o', color: PAL.orange, name: 'orc',
    hp: 15, atk: 8, def: 2, xp: 14, speed: 80, sight: 8,
  },
  boss: {
    glyph: 'B', color: PAL.red, name: 'dungeon lord',
    hp: 42, atk: 12, def: 4, xp: 70, speed: 100, sight: 11,
  },
};

const ITEM_ART = {
  potion: { glyph: '!', color: PAL.magenta, name: 'health potion' },
  gold: { glyph: '$', color: PAL.yellow, name: 'gold' },
  key: { glyph: '~', color: PAL.cyan, name: 'rusted key' },
  chest: { glyph: '&', color: PAL.violet, name: 'locked chest' },
};

export const meta = {
  id: 'roguelike',
  title: '16-BIT ROGUELIKE DUNGEON',
  short: 'ROGUELIKE',
  category: 'STRATEGY',
  desc: 'Turn-based dungeon crawl with BSP floors, shadowcast fog of war, '
      + 'flow-field monster AI, locked chests and permadeath.',
  accent: PAL.lime,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'ARROWS / WASD — step (bump to attack)',
    'SPACE — wait one turn',
    'K — quaff a potion',
    'Walk onto > to descend',
  ],
  touch: { dpad: true, buttons: [{ id: 'a', label: 'WAIT' }, { id: 'b', label: 'QUAFF' }] },
  art(ctx, w, h, accent) {
    const t = 15;
    ctx.save();
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, w, h);
    // A lit room fading into explored gloom.
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 14; x++) {
        const px = 18 + x * t;
        const py = 20 + y * t;
        const d = Math.hypot(x - 6, y - 4);
        const lit = d < 4.2;
        const edge = x === 0 || y === 0 || x === 13 || y === 8;
        if (edge) {
          ctx.fillStyle = lit ? '#2c4370' : '#141d33';
          ctx.fillRect(px, py, t - 1, t - 1);
          ctx.fillStyle = alpha('#ffffff', lit ? 0.16 : 0.05);
          ctx.fillRect(px, py, t - 1, 2);
        } else {
          ctx.fillStyle = alpha(lit ? '#7f97c4' : '#37456a', lit ? 0.9 : 0.5);
          ctx.fillRect(px + t / 2 - 1, py + t / 2 - 1, 2, 2);
        }
      }
    }
    ctx.font = 'bold 15px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const glyphs = [
      ['@', 6, 4, accent], ['g', 3, 2, PAL.lime], ['o', 9, 6, PAL.orange],
      ['$', 4, 6, PAL.yellow], ['!', 8, 2, PAL.magenta], ['>', 11, 4, PAL.cyan],
    ];
    for (const [g, x, y, c] of glyphs) {
      ctx.fillStyle = c;
      ctx.shadowColor = c;
      ctx.shadowBlur = 8;
      ctx.fillText(g, 18 + x * t + t / 2, 20 + y * t + t / 2);
    }
    ctx.shadowBlur = 0;
    // Message-log strip.
    ctx.fillStyle = alpha('#0b0f1a', 0.95);
    ctx.fillRect(0, h - 26, w, 26);
    ctx.fillStyle = PAL.dim;
    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('You hit the goblin for 4.', 8, h - 17);
    ctx.fillStyle = PAL.yellow;
    ctx.fillText('You found 12 gold.', 8, h - 7);
    ctx.restore();
  },
};

export function create(api) {
  /* ------------------------------------------------------------- state */

  let tiles, explored, visible, dmap;
  let rooms, monsters, items;
  let player;
  let depth, turns, alive;
  let log, banner, hitFx;
  let repeatTimer, stepTimer;
  let killCount, floorsCleared;

  const idx = (x, y) => y * MAP_W + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
  const isWall = (x, y) => !inBounds(x, y) || tiles[idx(x, y)] === WALL;
  const walkable = (x, y) => inBounds(x, y) && tiles[idx(x, y)] !== WALL;

  function say(msg, color = PAL.white) {
    log.push({ msg, color });
    if (log.length > 24) log.shift();
  }

  /* --------------------------------------------------- map generation  */

  function carveRoom(r) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) tiles[idx(x, y)] = FLOOR;
    }
  }

  function carveH(x1, x2, y) {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      if (inBounds(x, y)) tiles[idx(x, y)] = FLOOR;
    }
  }

  function carveV(y1, y2, x) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      if (inBounds(x, y)) tiles[idx(x, y)] = FLOOR;
    }
  }

  /** L-shaped corridor between two room centres, elbow flipped at random. */
  function connect(a, b) {
    if (api.rng.chance(0.5)) {
      carveH(a.cx, b.cx, a.cy);
      carveV(a.cy, b.cy, b.cx);
    } else {
      carveV(a.cy, b.cy, a.cx);
      carveH(a.cx, b.cx, b.cy);
    }
  }

  function placeRoom(rect) {
    const maxW = Math.min(11, rect.w - 2);
    const maxH = Math.min(8, rect.h - 2);
    const w = api.rng.int(4, Math.max(4, maxW));
    const h = api.rng.int(3, Math.max(3, maxH));
    const x = rect.x + api.rng.int(1, Math.max(1, rect.w - w - 1));
    const y = rect.y + api.rng.int(1, Math.max(1, rect.h - h - 1));
    const room = { x, y, w, h, cx: Math.floor(x + w / 2), cy: Math.floor(y + h / 2) };
    carveRoom(room);
    rooms.push(room);
    return room;
  }

  /**
   * Real BSP: keep bisecting the rectangle until the leaves are small, drop a
   * room in every leaf, then connect siblings on the way back up the tree so
   * the whole floor is guaranteed reachable.
   */
  function bsp(rect, depthLeft) {
    const MIN_LEAF = 10;
    const canSplitV = rect.w >= MIN_LEAF * 2;
    const canSplitH = rect.h >= MIN_LEAF * 2;
    if (depthLeft <= 0 || (!canSplitV && !canSplitH)) return placeRoom(rect);

    let vertical;
    if (canSplitV && canSplitH) {
      // Split across the long axis so rooms stay roughly square.
      if (rect.w / rect.h > 1.3) vertical = true;
      else if (rect.h / rect.w > 1.3) vertical = false;
      else vertical = api.rng.chance(0.5);
    } else vertical = canSplitV;

    let a;
    let b;
    if (vertical) {
      const cut = api.rng.int(MIN_LEAF, rect.w - MIN_LEAF);
      a = bsp({ x: rect.x, y: rect.y, w: cut, h: rect.h }, depthLeft - 1);
      b = bsp({ x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h }, depthLeft - 1);
    } else {
      const cut = api.rng.int(MIN_LEAF, rect.h - MIN_LEAF);
      a = bsp({ x: rect.x, y: rect.y, w: rect.w, h: cut }, depthLeft - 1);
      b = bsp({ x: rect.x, y: rect.y + cut, w: rect.w, h: rect.h - cut }, depthLeft - 1);
    }
    connect(a, b);
    return api.rng.chance(0.5) ? a : b;      // representative passed upward
  }

  function randomFloorIn(room) {
    return {
      x: api.rng.int(room.x, room.x + room.w - 1),
      y: api.rng.int(room.y, room.y + room.h - 1),
    };
  }

  function occupied(x, y) {
    if (player && player.x === x && player.y === y) return true;
    for (const m of monsters) if (m.x === x && m.y === y) return true;
    for (const it of items) if (it.x === x && it.y === y) return true;
    return false;
  }

  function freeSpotIn(room) {
    for (let i = 0; i < 30; i++) {
      const p = randomFloorIn(room);
      if (walkable(p.x, p.y) && !occupied(p.x, p.y)) return p;
    }
    return null;
  }

  function spawnMonster(kind, room) {
    const spot = freeSpotIn(room);
    if (!spot) return;
    const M = MONSTERS[kind];
    const scale = 1 + (depth - 1) * 0.22;
    monsters.push({
      kind,
      x: spot.x,
      y: spot.y,
      hp: Math.round(M.hp * scale),
      maxHp: Math.round(M.hp * scale),
      atk: M.atk + Math.floor((depth - 1) * 0.7),
      def: M.def + Math.floor((depth - 1) * 0.4),
      xp: Math.round(M.xp * (1 + (depth - 1) * 0.3)),
      speed: M.speed,
      sight: M.sight,
      energy: 0,
      alerted: false,
      lastX: -1,
      lastY: -1,
      hurt: 0,
      fleeing: false,
      charge: 0,
    });
  }

  function addItem(kind, room, val = 0) {
    const spot = freeSpotIn(room);
    if (!spot) return;
    items.push({ kind, x: spot.x, y: spot.y, val, opened: false });
  }

  function generate() {
    tiles = new Uint8Array(MAP_W * MAP_H);
    explored = new Uint8Array(MAP_W * MAP_H);
    visible = new Uint8Array(MAP_W * MAP_H);
    dmap = new Int16Array(MAP_W * MAP_H);
    rooms = [];
    monsters = [];
    items = [];

    bsp({ x: 1, y: 1, w: MAP_W - 2, h: MAP_H - 2 }, 4);

    // The player starts in the first room; the stairs go in the furthest one.
    const start = rooms[0];
    player.x = start.cx;
    player.y = start.cy;

    let far = rooms[0];
    let best = -1;
    for (const r of rooms) {
      const d = Math.abs(r.cx - start.cx) + Math.abs(r.cy - start.cy);
      if (d > best) { best = d; far = r; }
    }
    tiles[idx(far.cx, far.cy)] = STAIRS;

    // Populate every room but the one you spawn in.
    for (let i = 1; i < rooms.length; i++) {
      const room = rooms[i];
      const budget = 1 + Math.floor(depth / 2);
      for (let k = 0; k < budget; k++) {
        if (api.rng.chance(0.62)) {
          spawnMonster(api.rng.chance(clamp(0.25 + depth * 0.07, 0, 0.72)) ? 'orc' : 'goblin', room);
        }
      }
      if (api.rng.chance(0.45)) addItem('gold', room, api.rng.int(6, 18) + depth * 4);
      if (api.rng.chance(0.3)) addItem('potion', room);
      if (api.rng.chance(0.3)) addItem('key', room);
      if (api.rng.chance(0.28)) addItem('chest', room, api.rng.int(30, 70) + depth * 12);
    }
    // Guarantee at least one key and one potion per floor so a locked chest is
    // never a dead end.
    if (!items.some((i) => i.kind === 'key')) addItem('key', api.rng.pick(rooms.slice(1)) || rooms[0]);
    if (!items.some((i) => i.kind === 'potion')) addItem('potion', api.rng.pick(rooms.slice(1)) || rooms[0]);
    if (depth >= 4) spawnMonster('boss', far);

    computeFov();
    buildFlow();
  }

  /* ---------------------------------------------------------- fov ----- */

  /**
   * Recursive shadowcasting: for each octant, walk out row by row narrowing the
   * visible slope span whenever a wall interrupts it. Gives symmetric, gap-free
   * lighting far cheaper than raycasting every tile.
   */
  function castLight(cx, cy, row, startSlope, endSlope, radius, xx, xy, yx, yy) {
    if (startSlope < endSlope) return;
    let start = startSlope;
    let newStart = 0;
    let blocked = false;
    for (let distance = row; distance <= radius && !blocked; distance++) {
      const dy = -distance;
      for (let dx = -distance; dx <= 0; dx++) {
        const mx = cx + dx * xx + dy * xy;
        const my = cy + dx * yx + dy * yy;
        const lSlope = (dx - 0.5) / (dy + 0.5);
        const rSlope = (dx + 0.5) / (dy - 0.5);
        if (start < rSlope) continue;
        if (endSlope > lSlope) break;
        if (inBounds(mx, my) && dx * dx + dy * dy <= radius * radius) {
          visible[idx(mx, my)] = 1;
          explored[idx(mx, my)] = 1;
        }
        if (blocked) {
          if (isWall(mx, my)) {
            newStart = rSlope;
          } else {
            blocked = false;
            start = newStart;
          }
        } else if (isWall(mx, my) && distance < radius) {
          blocked = true;
          castLight(cx, cy, distance + 1, start, lSlope, radius, xx, xy, yx, yy);
          newStart = rSlope;
        }
      }
    }
  }

  function computeFov() {
    visible.fill(0);
    visible[idx(player.x, player.y)] = 1;
    explored[idx(player.x, player.y)] = 1;
    for (const [xx, xy, yx, yy] of OCTANTS) {
      castLight(player.x, player.y, 1, 1, 0, LIGHT, xx, xy, yx, yy);
    }
  }

  /** Bresenham line-of-sight, used by monsters to decide if they've seen you. */
  function hasLos(x0, y0, x1, y1) {
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (let guard = 0; guard < 200; guard++) {
      if (x === x1 && y === y1) return true;
      if (!(x === x0 && y === y0) && isWall(x, y)) return false;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    return false;
  }

  /* ------------------------------------------------------- pathfinding  */

  /**
   * Dijkstra flow field over the walkable grid, seeded at the player. Every
   * monster then simply steps to the neighbouring tile with the lower value —
   * one O(tiles) sweep per turn beats running A* once per monster.
   */
  function buildFlow() {
    dmap.fill(FAR);
    const queue = new Int32Array(MAP_W * MAP_H);
    let head = 0;
    let tail = 0;
    const s = idx(player.x, player.y);
    dmap[s] = 0;
    queue[tail++] = s;
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % MAP_W;
      const cy = (cur / MAP_W) | 0;
      const d = dmap[cur] + 1;
      for (let i = 0; i < 4; i++) {
        const nx = cx + (i === 0 ? 1 : i === 1 ? -1 : 0);
        const ny = cy + (i === 2 ? 1 : i === 3 ? -1 : 0);
        if (!walkable(nx, ny)) continue;
        const n = idx(nx, ny);
        if (dmap[n] <= d) continue;
        dmap[n] = d;
        queue[tail++] = n;
      }
    }
  }

  /* ------------------------------------------------------------ combat  */

  function monsterAt(x, y) {
    for (const m of monsters) if (m.x === x && m.y === y) return m;
    return null;
  }

  function itemAt(x, y) {
    for (const it of items) if (it.x === x && it.y === y) return it;
    return null;
  }

  function bloodBurst(x, y, color, n = 8) {
    api.particles.burst(x * TILE + TILE / 2 - camX() * TILE, y * TILE + TILE / 2 - camY() * TILE, n, {
      speed: 90, life: 0.45, size: 2.4, color: [color, PAL.white], glow: 7, drag: 3, gravity: 120,
    });
  }

  function playerAttack(m) {
    const roll = api.rng.int(1, player.atk) + Math.floor(player.atk / 2);
    const dmg = Math.max(1, roll - m.def);
    m.hp -= dmg;
    m.hurt = 0.18;
    m.alerted = true;
    api.sfx('hit', { vol: 0.55, detune: api.rng.range(-3, 3) });
    api.shakeScreen(2.5, 12);
    bloodBurst(m.x, m.y, MONSTERS[m.kind].color, 7);
    say(`You hit the ${MONSTERS[m.kind].name} for ${dmg}.`, PAL.white);
    if (m.hp <= 0) {
      monsters.splice(monsters.indexOf(m), 1);
      killCount++;
      say(`The ${MONSTERS[m.kind].name} dies!`, PAL.lime);
      api.sfx('explosion', { vol: 0.4 });
      bloodBurst(m.x, m.y, MONSTERS[m.kind].color, 14);
      gainXp(m.xp);
      if (m.kind === 'boss') {
        say('The dungeon lord falls. Its hoard spills out.', PAL.yellow);
        player.gold += 80 + depth * 25;
        player.potions++;
      }
    } else if (m.kind === 'goblin' && m.hp < m.maxHp * 0.3 && !m.fleeing) {
      m.fleeing = true;
      say('The goblin panics and flees!', PAL.dim);
    }
  }

  function monsterAttack(m) {
    const roll = api.rng.int(1, m.atk) + Math.floor(m.atk / 3);
    const dmg = Math.max(1, roll - player.def);
    player.hp -= dmg;
    hitFx = 0.4;
    api.sfx('hurt', { vol: 0.6 });
    api.shakeScreen(4, 9);
    api.vibrate(40);
    say(`The ${MONSTERS[m.kind].name} hits you for ${dmg}.`, PAL.red);
    if (player.hp <= 0) die(MONSTERS[m.kind].name);
  }

  function gainXp(n) {
    player.xp += n;
    while (player.xp >= player.next) {
      player.xp -= player.next;
      player.level++;
      player.maxHp += 6;
      player.hp = player.maxHp;
      player.atk += 2;
      if (player.level % 2 === 0) player.def += 1;
      player.next = Math.round(player.next * 1.55) + 6;
      say(`You reach level ${player.level}!`, PAL.yellow);
      api.sfx('levelup');
      banner = { text: 'LEVEL ' + player.level, color: PAL.yellow, life: 1.6 };
    }
  }

  function die(by) {
    if (!alive) return;
    alive = false;
    api.shakeScreen(14, 4);
    api.sfx('gameover');
    bloodBurst(player.x, player.y, PAL.red, 24);
    say(`You are slain by the ${by}.`, PAL.red);
    api.gameOver({
      message: 'SLAIN BY THE ' + by.toUpperCase(),
      stats: {
        FLOOR: depth,
        LEVEL: player.level,
        GOLD: player.gold,
        XP: player.totalXp,
        KILLS: killCount,
        TURNS: turns,
      },
    });
  }

  /* --------------------------------------------------------- interaction */

  function pickUp(it) {
    if (it.kind === 'gold') {
      player.gold += it.val;
      say(`You found ${it.val} gold.`, PAL.yellow);
      api.sfx('coin');
    } else if (it.kind === 'potion') {
      player.potions++;
      say('You pick up a health potion.', PAL.magenta);
      api.sfx('pickup');
    } else if (it.kind === 'key') {
      player.keys++;
      say('You pocket a rusted key.', PAL.cyan);
      api.sfx('pickup', { detune: 5 });
    }
    items.splice(items.indexOf(it), 1);
    api.particles.burst(
      it.x * TILE + TILE / 2 - camX() * TILE, it.y * TILE + TILE / 2 - camY() * TILE, 9,
      { speed: 70, life: 0.5, size: 2.2, color: ITEM_ART[it.kind].color, glow: 9, drag: 3 },
    );
  }

  function openChest(chest) {
    if (player.keys <= 0) {
      say('The chest is locked. You need a key.', PAL.dim);
      api.sfx('deny');
      return false;
    }
    player.keys--;
    chest.opened = true;
    player.gold += chest.val;
    player.potions++;
    gainXp(8 + depth * 3);
    say(`The chest yields ${chest.val} gold and a potion.`, PAL.yellow);
    api.sfx('powerup');
    items.splice(items.indexOf(chest), 1);
    api.particles.burst(
      chest.x * TILE + TILE / 2 - camX() * TILE, chest.y * TILE + TILE / 2 - camY() * TILE, 20,
      { speed: 120, life: 0.7, size: 2.6, color: [PAL.yellow, PAL.white], glow: 11, drag: 2.4, gravity: 90 },
    );
    return true;
  }

  function quaff() {
    if (player.potions <= 0) {
      say('You have no potions.', PAL.dim);
      api.sfx('deny');
      return false;
    }
    player.potions--;
    const heal = Math.min(player.maxHp - player.hp, 12 + depth * 2);
    player.hp += heal;
    say(heal > 0 ? `You quaff a potion and recover ${heal} HP.` : 'The potion tastes of nothing.', PAL.magenta);
    api.sfx('powerup', { vol: 0.6 });
    api.particles.burst(
      player.x * TILE + TILE / 2 - camX() * TILE, player.y * TILE + TILE / 2 - camY() * TILE, 14,
      { speed: 80, life: 0.6, size: 2.4, color: [PAL.magenta, PAL.white], glow: 10, drag: 3, gravity: -40 },
    );
    return true;
  }

  function descend() {
    depth++;
    floorsCleared++;
    api.sfx('levelup');
    banner = { text: 'DEPTH ' + depth, color: PAL.cyan, life: 1.8 };
    say(`You descend to floor ${depth}. The air grows colder.`, PAL.cyan);
    generate();
  }

  /* ------------------------------------------------------------- turns  */

  function step(dx, dy) {
    if (!alive || (dx === 0 && dy === 0)) return;
    const nx = player.x + dx;
    const ny = player.y + dy;

    const m = monsterAt(nx, ny);
    if (m) {
      playerAttack(m);
      endTurn();
      return;
    }
    const it = itemAt(nx, ny);
    if (it && it.kind === 'chest') {
      if (openChest(it)) endTurn();
      return;
    }
    if (!walkable(nx, ny)) {
      api.sfx('blip', { vol: 0.15 });
      return;
    }
    player.x = nx;
    player.y = ny;
    api.sfx('step', { vol: 0.18, detune: api.rng.range(-4, 4) });
    const under = itemAt(nx, ny);
    if (under) pickUp(under);
    if (tiles[idx(nx, ny)] === STAIRS) {
      descend();
      return;
    }
    endTurn();
  }

  function wait() {
    if (!alive) return;
    say('You steady your breath.', PAL.dim);
    endTurn();
  }

  /** Advance the world exactly one player-turn worth of time. */
  function endTurn() {
    if (!alive) return;
    turns++;
    computeFov();
    buildFlow();

    // Slow natural regeneration keeps a long crawl survivable.
    if (turns % 14 === 0 && player.hp < player.maxHp) player.hp++;

    for (let i = monsters.length - 1; i >= 0; i--) {
      const m = monsters[i];
      m.energy += m.speed;
      let guard = 0;
      while (m.energy >= 100 && alive && guard++ < 3) {
        m.energy -= 100;
        monsterTurn(m);
      }
      if (!alive) break;
    }

    api.setScore(player.gold + depth * 100 + player.totalXp);
    api.setStatus({
      FLOOR: depth,
      HP: `${Math.max(0, player.hp)}/${player.maxHp}`,
      LVL: player.level,
      GOLD: player.gold,
    });
  }

  function monsterTurn(m) {
    const sees = hasLos(m.x, m.y, player.x, player.y)
      && Math.abs(m.x - player.x) + Math.abs(m.y - player.y) <= m.sight * 1.5;
    if (sees) {
      if (!m.alerted && m.kind !== 'goblin') api.sfx('alert', { vol: 0.2 });
      m.alerted = true;
      m.lastX = player.x;
      m.lastY = player.y;
    }

    const adjacent = Math.abs(m.x - player.x) <= 1 && Math.abs(m.y - player.y) <= 1
      && !(m.x === player.x && m.y === player.y);

    if (adjacent && !m.fleeing) {
      monsterAttack(m);
      return;
    }

    if (m.fleeing) {
      moveAlongFlow(m, +1);                  // uphill: away from the player
      if (m.hp >= m.maxHp * 0.6) m.fleeing = false;
      return;
    }

    if (m.alerted && dmap[idx(m.x, m.y)] < FAR) {
      // The dungeon lord lunges two tiles every few turns.
      const steps = m.kind === 'boss' && ++m.charge % 4 === 0 ? 2 : 1;
      for (let s = 0; s < steps; s++) {
        if (Math.abs(m.x - player.x) <= 1 && Math.abs(m.y - player.y) <= 1) break;
        moveAlongFlow(m, -1);
      }
      // Lose interest once you've been out of sight for a while.
      if (!sees && api.rng.chance(0.06)) m.alerted = false;
      return;
    }

    if (api.rng.chance(0.45)) {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const d = api.rng.pick(dirs);
      tryStep(m, m.x + d[0], m.y + d[1]);
    }
  }

  /** Step to the neighbour with the lowest (or highest) flow-field value. */
  function moveAlongFlow(m, sign) {
    let bestX = m.x;
    let bestY = m.y;
    let bestV = dmap[idx(m.x, m.y)];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [dx, dy] of dirs) {
      const nx = m.x + dx;
      const ny = m.y + dy;
      if (!walkable(nx, ny) || monsterAt(nx, ny)) continue;
      if (nx === player.x && ny === player.y) continue;
      const v = dmap[idx(nx, ny)];
      if (v >= FAR) continue;
      if (sign < 0 ? v < bestV : v > bestV) {
        bestV = v;
        bestX = nx;
        bestY = ny;
      }
    }
    if (bestX !== m.x || bestY !== m.y) tryStep(m, bestX, bestY);
  }

  function tryStep(m, nx, ny) {
    if (!walkable(nx, ny)) return;
    if (nx === player.x && ny === player.y) return;
    if (monsterAt(nx, ny)) return;
    if (itemAt(nx, ny) && itemAt(nx, ny).kind === 'chest') return;
    m.x = nx;
    m.y = ny;
  }

  /* ------------------------------------------------------------ camera  */

  function camX() {
    return clamp(player.x - Math.floor(VIEW_COLS / 2), 0, MAP_W - VIEW_COLS);
  }

  function camY() {
    return clamp(player.y - Math.floor(VIEW_ROWS / 2), 0, MAP_H - VIEW_ROWS);
  }

  /* ------------------------------------------------------------ drawing */

  function glyph(ctx, ch, tx, ty, color, size = 14, glowAmt = 8) {
    text(ctx, ch, tx * TILE + TILE / 2, ty * TILE + TILE / 2, {
      size, color, align: 'center', baseline: 'middle', glow: glowAmt,
    });
  }

  /* --------------------------------------------------------- lifecycle  */

  return {
    init() {
      player = {
        x: 0, y: 0,
        hp: 26, maxHp: 26,
        atk: 6, def: 1,
        level: 1, xp: 0, totalXp: 0, next: 16,
        gold: 0, keys: 0, potions: 2,
      };
      depth = 1;
      turns = 0;
      alive = true;
      killCount = 0;
      floorsCleared = 0;
      log = [];
      banner = { text: 'DEPTH 1', color: PAL.cyan, life: 1.8 };
      hitFx = 0;
      repeatTimer = 0;
      stepTimer = 0;
      generate();
      say('You enter the dungeon. Torchlight gutters.', PAL.dim);
      say('Bump into monsters to attack. Find > to descend.', PAL.dim);
      api.setScore(0);
      api.setStatus({ FLOOR: 1, HP: `${player.hp}/${player.maxHp}`, LVL: 1, GOLD: 0 });
    },

    update(dt) {
      if (banner) {
        banner.life -= dt;
        if (banner.life <= 0) banner = null;
      }
      if (hitFx > 0) hitFx = Math.max(0, hitFx - dt * 2.4);
      for (const m of monsters) if (m.hurt > 0) m.hurt -= dt;
      if (!alive) return;

      // Turn-based, but a held direction auto-repeats so the d-pad feels sane.
      const dx = api.input.axis('left', 'right');
      const dy = api.input.axis('up', 'down');
      if (dx || dy) {
        repeatTimer += dt;
        if (repeatTimer >= 0.34) {
          stepTimer += dt;
          let guard = 0;
          while (stepTimer >= 0.11 && alive && guard++ < 4) {
            stepTimer -= 0.11;
            step(dx, dy);
          }
        }
      } else {
        repeatTimer = 0;
        stepTimer = 0;
      }
    },

    handleInput(e) {
      if (e.type !== 'press' || !alive) return;
      const dx = api.input.axis('left', 'right');
      const dy = api.input.axis('up', 'down');
      switch (e.action) {
        case 'up': case 'down': case 'left': case 'right':
          repeatTimer = 0;
          stepTimer = 0;
          step(dx, dy);
          break;
        case 'a': wait(); break;
        case 'b': if (quaff()) endTurn(); break;
        default: break;
      }
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;
      const cx = camX();
      const cy = camY();

      ctx.fillStyle = '#04050a';
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(-cx * TILE, -cy * TILE);

      /* ---- tiles: three-state fog ---- */
      for (let y = cy; y < cy + VIEW_ROWS; y++) {
        for (let x = cx; x < cx + VIEW_COLS; x++) {
          if (!inBounds(x, y)) continue;
          const i = idx(x, y);
          if (!explored[i]) continue;
          const lit = visible[i] === 1;
          const px = x * TILE;
          const py = y * TILE;
          const t = tiles[i];
          if (t === WALL) {
            // Only draw walls that border something walkable — solid rock stays
            // black, which reads far better than a field of grey bricks.
            let edge = false;
            for (let j = 0; j < 8 && !edge; j++) {
              const ox = [1, -1, 0, 0, 1, 1, -1, -1][j];
              const oy = [0, 0, 1, -1, 1, -1, 1, -1][j];
              if (walkable(x + ox, y + oy)) edge = true;
            }
            if (!edge) continue;
            ctx.fillStyle = lit ? '#2b3d63' : '#141c2f';
            ctx.fillRect(px, py, TILE, TILE);
            ctx.fillStyle = alpha('#ffffff', lit ? 0.14 : 0.05);
            ctx.fillRect(px, py, TILE, 2);
            ctx.fillStyle = alpha('#000000', 0.35);
            ctx.fillRect(px, py + TILE - 2, TILE, 2);
          } else {
            ctx.fillStyle = lit ? '#0d1424' : '#080b12';
            ctx.fillRect(px, py, TILE, TILE);
            ctx.fillStyle = alpha(lit ? '#7f97c4' : '#37456a', lit ? 0.75 : 0.4);
            ctx.fillRect(px + TILE / 2 - 1, py + TILE / 2 - 1, 2, 2);
          }
        }
      }

      /* ---- stairs (remembered once seen) ---- */
      for (let y = cy; y < cy + VIEW_ROWS; y++) {
        for (let x = cx; x < cx + VIEW_COLS; x++) {
          if (!inBounds(x, y) || !explored[idx(x, y)]) continue;
          if (tiles[idx(x, y)] !== STAIRS) continue;
          const lit = visible[idx(x, y)] === 1;
          glyph(ctx, '>', x, y, lit ? PAL.cyan : alpha(PAL.cyan, 0.35), 15, lit ? 12 : 0);
        }
      }

      /* ---- items ---- */
      for (const it of items) {
        const i = idx(it.x, it.y);
        if (!explored[i]) continue;
        const lit = visible[i] === 1;
        const art = ITEM_ART[it.kind];
        const bob = lit ? Math.sin(api.time * 3 + it.x * 1.7) * 1.2 : 0;
        ctx.save();
        ctx.translate(0, bob);
        glyph(ctx, art.glyph, it.x, it.y, lit ? art.color : alpha(art.color, 0.3), 15, lit ? 10 : 0);
        ctx.restore();
      }

      /* ---- monsters (only while actually visible) ---- */
      for (const m of monsters) {
        if (visible[idx(m.x, m.y)] !== 1) continue;
        const M = MONSTERS[m.kind];
        const col = m.hurt > 0 ? PAL.white : M.color;
        glyph(ctx, M.glyph, m.x, m.y, col, m.kind === 'boss' ? 17 : 15, 10);
        if (m.hp < m.maxHp) {
          const bw = TILE - 4;
          ctx.fillStyle = alpha('#000000', 0.7);
          ctx.fillRect(m.x * TILE + 2, m.y * TILE + TILE - 3, bw, 2);
          ctx.fillStyle = mix(PAL.red, PAL.lime, m.hp / m.maxHp);
          ctx.fillRect(m.x * TILE + 2, m.y * TILE + TILE - 3, bw * (m.hp / m.maxHp), 2);
        }
        if (m.alerted) {
          ctx.fillStyle = PAL.red;
          ctx.fillRect(m.x * TILE + TILE / 2 - 1, m.y * TILE - 3, 2, 4);
        }
      }

      /* ---- player ---- */
      if (alive) {
        glyph(ctx, '@', player.x, player.y, PAL.white, 16, 14);
      } else {
        glyph(ctx, '%', player.x, player.y, PAL.red, 16, 12);
      }

      ctx.restore();

      /* ---- torch vignette ---- */
      const pcx = (player.x - cx) * TILE + TILE / 2;
      const pcy = (player.y - cy) * TILE + TILE / 2;
      const flick = LIGHT * TILE * (0.94 + 0.06 * Math.sin(api.time * 9));
      const g = ctx.createRadialGradient(pcx, pcy, flick * 0.35, pcx, pcy, flick * 1.15);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, MAP_VIEW_H);

      api.particles.render(ctx);

      /* ---- banner ---- */
      if (banner) {
        ctx.save();
        ctx.globalAlpha = clamp(banner.life / 0.6, 0, 1);
        text(ctx, banner.text, W / 2, MAP_VIEW_H * 0.4, {
          size: 20, color: banner.color, align: 'center', glow: 14,
        });
        ctx.restore();
      }

      /* ---- damage flash ---- */
      if (hitFx > 0) {
        ctx.save();
        ctx.fillStyle = alpha(PAL.red, hitFx * 0.28);
        ctx.fillRect(0, 0, W, MAP_VIEW_H);
        ctx.restore();
      }

      /* ---- status + message log ---- */
      ctx.fillStyle = '#080b14';
      ctx.fillRect(0, MAP_VIEW_H, W, LOG_H);
      ctx.strokeStyle = alpha(PAL.lime, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, MAP_VIEW_H + 0.5);
      ctx.lineTo(W, MAP_VIEW_H + 0.5);
      ctx.stroke();

      const sy = MAP_VIEW_H + 6;
      // HP bar.
      const hpFrac = clamp(player.hp / player.maxHp, 0, 1);
      ctx.fillStyle = alpha('#ffffff', 0.1);
      roundRect(ctx, 8, sy + 1, 96, 9, 2);
      ctx.fill();
      ctx.fillStyle = mix(PAL.red, PAL.lime, hpFrac);
      roundRect(ctx, 8, sy + 1, 96 * hpFrac, 9, 2);
      ctx.fill();
      text(ctx, `${Math.max(0, player.hp)}/${player.maxHp}`, 56, sy + 2,
        { size: 8, color: PAL.bg, align: 'center' });

      const info = [
        ['LV', player.level, PAL.cyan],
        ['ATK', player.atk, PAL.orange],
        ['DEF', player.def, PAL.blue],
        ['XP', `${player.xp}/${player.next}`, PAL.violet],
        ['$', player.gold, PAL.yellow],
        ['KEY', player.keys, PAL.cyan],
        ['POT', player.potions, PAL.magenta],
        ['FLR', depth, PAL.lime],
      ];
      let ix = 116;
      for (const [label, val, color] of info) {
        text(ctx, label, ix, sy + 2, { size: 8, color: PAL.dim });
        const vw = String(val).length * 6 + 4;
        text(ctx, String(val), ix + label.length * 6 + 5, sy + 1, { size: 9, color });
        ix += label.length * 6 + vw + 10;
      }

      // The last four lines of the log, oldest dimmest.
      const shown = log.slice(-4);
      for (let i = 0; i < shown.length; i++) {
        const e = shown[i];
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.65 * ((i + 1) / shown.length);
        text(ctx, e.msg, 8, MAP_VIEW_H + 22 + i * 12, { size: 9, color: e.color });
        ctx.restore();
      }

      if (!alive) {
        text(ctx, 'YOU DIED', W / 2, MAP_VIEW_H * 0.5, {
          size: 26, color: PAL.red, align: 'center', glow: 16,
        });
      }
    },

    destroy() {
      tiles = explored = visible = dmap = null;
      monsters = items = rooms = null;
    },
  };
}
