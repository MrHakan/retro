/**
 * 22 — STEALTH AGENT: SHADOW ESCAPE
 *
 * Top-down infiltration. Guards and cameras project real field-of-view cones:
 * each is built by casting rays across its arc and clipping every ray at the
 * nearest wall segment, so the resulting polygon carries genuine shadows —
 * step behind a crate and the cone visibly bends around it.
 *
 * Detection is two-part: you must be inside the cone AND have unobstructed
 * line of sight. That keeps the visual and the rule identical, which is the
 * whole contract a stealth game makes with the player.
 */

import {
  PAL, TAU, clamp, dist, alpha, text, glowCircle, angleDelta,
} from '../core/fx.js';

const VIEW_W = 520;
const VIEW_H = 380;

const PLAYER_R = 6;
const SPEED_WALK = 82;
const SPEED_SNEAK = 42;
const SPEED_SPRINT = 132;

const RAYS = 56;            // per cone — enough for clean edges, cheap enough for 60fps
const CONE_RANGE = 132;
const CONE_HALF = 0.42;     // radians either side of facing (~48 degrees total)
const CAM_RANGE = 116;
const CAM_HALF = 0.36;

const DETECT_RATE = 0.85;   // meter per second at full exposure
const DETECT_DECAY = 0.45;
const SUSPICIOUS_AT = 0.34;
const ALERT_AT = 0.74;

const HACK_TIME = 2.4;
const HACK_RADIUS = 22;
const CAMERA_DOWNTIME = 11;

/* ------------------------------------------------------------- levels -- */

/**
 * Hand-authored floorplans. `walls` are [x, y, w, h]; guards carry a waypoint
 * loop; `dark` rectangles are shadow pools that slow detection.
 */
const LEVELS = [
  {
    name: 'SUBLEVEL 01 — ARCHIVE',
    spawn: [40, 330],
    exit: [478, 40, 30, 44],
    walls: [
      [110, 60, 18, 150], [110, 250, 18, 90],
      [240, 0, 18, 130], [240, 210, 18, 170],
      [360, 90, 18, 200],
      [128, 60, 70, 18], [300, 300, 110, 18],
    ],
    dark: [[20, 60, 80, 120], [280, 150, 70, 60]],
    guards: [
      { path: [[180, 90], [180, 320]], speed: 46 },
      { path: [[310, 60], [310, 250], [430, 250]], speed: 40 },
    ],
    cameras: [],
    terminals: [[196, 340]],
    cards: [[196, 120]],
    loot: [[60, 120], [420, 130]],
  },
  {
    name: 'SUBLEVEL 02 — SERVER FARM',
    spawn: [36, 200],
    exit: [478, 168, 30, 44],
    walls: [
      [96, 40, 16, 120], [96, 220, 16, 120],
      [180, 0, 16, 110], [180, 190, 16, 190],
      [264, 40, 16, 300],
      [348, 0, 16, 150], [348, 230, 16, 150],
      [112, 150, 60, 16], [280, 150, 60, 16], [280, 214, 60, 16],
    ],
    dark: [[20, 40, 70, 90], [200, 120, 60, 60], [400, 290, 100, 70]],
    guards: [
      { path: [[140, 70], [140, 320]], speed: 50 },
      { path: [[224, 60], [224, 330]], speed: 44 },
      { path: [[410, 70], [410, 320], [300, 320]], speed: 52 },
    ],
    cameras: [[300, 30, -0.5, 0.9]],
    terminals: [[132, 200], [416, 60]],
    cards: [[224, 300], [312, 110]],
    loot: [[60, 300], [230, 40], [440, 250]],
  },
  {
    name: 'SUBLEVEL 03 — VAULT',
    spawn: [34, 344],
    exit: [478, 26, 30, 44],
    walls: [
      [88, 0, 14, 130], [88, 200, 14, 180],
      [160, 60, 14, 260],
      [232, 0, 14, 190], [232, 260, 14, 120],
      [304, 80, 14, 240],
      [376, 0, 14, 150], [376, 220, 14, 160],
      [102, 130, 60, 14], [246, 190, 60, 14], [318, 80, 60, 14], [318, 300, 60, 14],
    ],
    dark: [[20, 40, 60, 80], [180, 320, 60, 50], [400, 160, 90, 60]],
    guards: [
      { path: [[128, 40], [128, 350]], speed: 54 },
      { path: [[198, 90], [198, 340]], speed: 50 },
      { path: [[270, 40], [270, 240], [340, 240]], speed: 48 },
      { path: [[440, 60], [440, 340]], speed: 56 },
    ],
    cameras: [[210, 24, 0.9, 0.85], [430, 356, -2.1, 0.8]],
    terminals: [[120, 300], [352, 130]],
    cards: [[198, 40], [340, 340]],
    loot: [[60, 180], [270, 340], [468, 300], [140, 40]],
  },
];

export const meta = {
  id: 'stealth',
  title: 'STEALTH AGENT: SHADOW ESCAPE',
  short: 'STEALTH',
  category: 'ACTION',
  desc: 'Slip past raycast vision cones that cast real shadows. Hack terminals '
      + 'for keycards, stay in the dark, and reach the exit before a guard '
      + 'fills your detection meter.',
  accent: PAL.violet,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'WASD / ARROWS — move',
    'HOLD A — sneak (quiet, slow)',
    'HOLD B — hack a terminal',
    'RELEASE ALL — sprint is automatic when you move at full tilt',
  ],
  touch: { stick: true, buttons: [{ id: 'a', label: 'SNEAK' }, { id: 'b', label: 'HACK' }] },
  art(ctx, w, h, accent) {
    ctx.save();
    ctx.fillStyle = '#080c16';
    ctx.fillRect(0, 0, w, h);

    // A guard cone clipped by a wall, which is the game in one image.
    const gx = 44;
    const gy = h - 34;
    const grad = ctx.createRadialGradient(gx, gy, 4, gx, gy, 150);
    grad.addColorStop(0, alpha(PAL.yellow, 0.55));
    grad.addColorStop(1, alpha(PAL.yellow, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.arc(gx, gy, 150, -1.24, -0.44);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#243050';
    ctx.fillRect(96, 40, 14, 78);
    ctx.fillRect(150, 96, 60, 14);

    ctx.shadowColor = PAL.yellow;
    ctx.shadowBlur = 10;
    ctx.fillStyle = PAL.yellow;
    ctx.beginPath();
    ctx.arc(gx, gy, 7, 0, TAU);
    ctx.fill();

    ctx.shadowColor = accent;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(w - 58, 52, 7, 0, TAU);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = alpha(PAL.lime, 0.8);
    ctx.lineWidth = 2;
    ctx.strokeRect(w - 30, 30, 18, 44);
    ctx.restore();
  },
};

export function create(api) {
  let level, levelIndex, walls, segments, guards, cameras, terminals, cards, loot;
  let player, exitRect, darkZones;
  let detection, caught, finished, alarmed;
  let noisePings, levelTime, hackTarget, hackProgress, cameraOffline;
  let bannerTime, bannerText;

  /* ---------------------------------------------------------- geometry */

  /** Flatten every wall rect (plus the arena border) into raycastable edges. */
  function buildSegments() {
    segments = [];
    const push = (x1, y1, x2, y2) => segments.push([x1, y1, x2, y2, Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
    push(0, 0, VIEW_W, 0);
    push(VIEW_W, 0, VIEW_W, VIEW_H);
    push(VIEW_W, VIEW_H, 0, VIEW_H);
    push(0, VIEW_H, 0, 0);
    for (const [x, y, w, h] of walls) {
      push(x, y, x + w, y);
      push(x + w, y, x + w, y + h);
      push(x + w, y + h, x, y + h);
      push(x, y + h, x, y);
    }
  }

  /**
   * Distance along a ray to the nearest wall, capped at `range`.
   * Kept local rather than using the generic segment helper: this runs
   * RAYS x segments x cones times per frame and benefits from the early-outs.
   */
  function castRay(ox, oy, dx, dy, range) {
    let best = range;
    const ex = ox + dx * range;
    const ey = oy + dy * range;
    const rminX = Math.min(ox, ex);
    const rmaxX = Math.max(ox, ex);
    const rminY = Math.min(oy, ey);
    const rmaxY = Math.max(oy, ey);

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      // Bounding-box reject before the arithmetic.
      if (s[4] > rmaxX || s[6] < rminX || s[5] > rmaxY || s[7] < rminY) continue;

      const x3 = s[0], y3 = s[1], x4 = s[2], y4 = s[3];
      const sx = x4 - x3;
      const sy = y4 - y3;
      const den = dx * sy - dy * sx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((x3 - ox) * sy - (y3 - oy) * sx) / den;
      if (t < 0 || t > best) continue;
      const u = ((x3 - ox) * dy - (y3 - oy) * dx) / den;
      if (u < 0 || u > 1) continue;
      best = t;
    }
    return best;
  }

  /** True when nothing blocks the straight line between two points. */
  function hasLineOfSight(ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const d = Math.hypot(dx, dy);
    if (d < 0.001) return true;
    return castRay(ax, ay, dx / d, dy / d, d) >= d - 0.5;
  }

  /** Build the clipped cone polygon for a viewer. */
  function coneShape(x, y, facing, half, range) {
    const pts = [];
    for (let i = 0; i <= RAYS; i++) {
      const a = facing - half + (i / RAYS) * half * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const t = castRay(x, y, dx, dy, range);
      pts.push(x + dx * t, y + dy * t);
    }
    return pts;
  }

  function inCone(x, y, vx, vy, facing, half, range) {
    const dx = x - vx;
    const dy = y - vy;
    const d = Math.hypot(dx, dy);
    if (d > range) return false;
    if (Math.abs(angleDelta(facing, Math.atan2(dy, dx))) > half) return false;
    return hasLineOfSight(vx, vy, x, y);
  }

  function rectHit(px, py, r, [x, y, w, h]) {
    const nx = clamp(px, x, x + w);
    const ny = clamp(py, y, y + h);
    return (px - nx) ** 2 + (py - ny) ** 2 < r * r;
  }

  function blocked(px, py, r) {
    for (const w of walls) if (rectHit(px, py, r, w)) return true;
    return px < r || py < r || px > VIEW_W - r || py > VIEW_H - r;
  }

  function inDark(px, py) {
    for (const [x, y, w, h] of darkZones) {
      if (px > x && px < x + w && py > y && py < y + h) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ level  */

  function loadLevel(i) {
    level = LEVELS[Math.min(i, LEVELS.length - 1)];
    walls = level.walls.map((w) => w.slice());
    darkZones = level.dark.map((d) => d.slice());
    buildSegments();

    player = { x: level.spawn[0], y: level.spawn[1], sneaking: false, speed: 0 };
    exitRect = level.exit.slice();

    guards = level.guards.map((g) => ({
      x: g.path[0][0],
      y: g.path[0][1],
      path: g.path,
      wp: 1 % g.path.length,
      speed: g.speed,
      facing: 0,
      state: 'PATROL',
      timer: 0,
      sweep: 0,
      lastKnown: null,
    }));

    cameras = (level.cameras || []).map(([x, y, base, arc]) => ({
      x, y, base, arc, phase: api.rng.range(0, TAU), facing: base,
    }));

    terminals = level.terminals.map(([x, y]) => ({ x, y, hacked: false }));
    cards = level.cards.map(([x, y]) => ({ x, y, taken: false }));
    loot = level.loot.map(([x, y]) => ({ x, y, taken: false }));

    detection = 0;
    alarmed = false;
    noisePings = [];
    levelTime = 0;
    hackTarget = null;
    hackProgress = 0;
    cameraOffline = 0;
    banner(level.name);
    api.setStatus({ FLOOR: levelIndex + 1, CARDS: `0/${cards.length}`, ALERT: '0%' });
  }

  function banner(str) {
    bannerText = str;
    bannerTime = 2.4;
  }

  function noise(x, y, radius) {
    noisePings.push({ x, y, r: 0, max: radius, life: 0.7 });
    for (const g of guards) {
      if (dist(g.x, g.y, x, y) < radius && g.state !== 'ALERT') {
        g.state = 'SUSPICIOUS';
        g.timer = 4;
        g.lastKnown = { x, y };
      }
    }
  }

  function cardsHeld() {
    return cards.filter((c) => c.taken).length;
  }

  function busted() {
    if (caught || finished) return;
    caught = true;
    api.sfx('alert');
    api.shakeScreen(10, 4);
    api.vibrate(200);
    api.particles.burst(player.x, player.y, 22, {
      speed: 130, life: 0.8, size: 3, color: [PAL.red, PAL.orange], glow: 10, drag: 2,
    });
    api.gameOver({
      message: 'DETECTED — EXTRACTION FAILED',
      stats: {
        FLOOR: levelIndex + 1,
        'FLOORS CLEARED': levelIndex,
        LOOT: loot.filter((l) => l.taken).length,
      },
    });
  }

  function clearLevel() {
    const timeBonus = Math.max(0, Math.round(240 - levelTime) * 4);
    const stealthBonus = alarmed ? 0 : 400;
    api.addScore(600 + timeBonus + stealthBonus);
    api.sfx('victory');
    api.particles.burst(player.x, player.y, 26, {
      speed: 120, life: 0.9, size: 3, color: [PAL.lime, PAL.cyan], glow: 12, drag: 2,
    });

    levelIndex++;
    if (levelIndex >= LEVELS.length) {
      finished = true;
      api.win({
        message: 'EXFILTRATED — ALL FLOORS CLEAR',
        stats: {
          FLOORS: LEVELS.length,
          'TIME BONUS': timeBonus,
          'GHOST BONUS': stealthBonus ? 'YES' : 'NO',
        },
      });
    } else {
      loadLevel(levelIndex);
    }
  }

  /* ------------------------------------------------------------ guards */

  function updateGuard(g, dt) {
    const seesPlayer = inCone(player.x, player.y, g.x, g.y, g.facing, CONE_HALF, CONE_RANGE);

    if (seesPlayer) {
      const exposure = (inDark(player.x, player.y) ? 0.5 : 1) * (player.sneaking ? 0.66 : 1);
      detection = clamp(detection + DETECT_RATE * exposure * dt, 0, 1);
      g.lastKnown = { x: player.x, y: player.y };
      if (detection > ALERT_AT) {
        if (g.state !== 'ALERT') api.sfx('alert');
        g.state = 'ALERT';
        alarmed = true;
        g.timer = 5;
      } else if (detection > SUSPICIOUS_AT && g.state === 'PATROL') {
        g.state = 'SUSPICIOUS';
        g.timer = 4.5;
        api.sfx('blip');
      }
    }

    let tx = null;
    let ty = null;
    let speed = g.speed;

    if (g.state === 'ALERT' && g.lastKnown) {
      tx = g.lastKnown.x;
      ty = g.lastKnown.y;
      speed = g.speed * 1.7;
      g.timer -= dt;
      if (g.timer <= 0 && !seesPlayer) {
        g.state = 'SUSPICIOUS';
        g.timer = 4;
      }
    } else if (g.state === 'SUSPICIOUS' && g.lastKnown) {
      tx = g.lastKnown.x;
      ty = g.lastKnown.y;
      speed = g.speed * 1.15;
      g.timer -= dt;
      // Sweep the cone side to side while investigating.
      g.sweep += dt * 2.4;
      if (g.timer <= 0) {
        g.state = 'PATROL';
        g.lastKnown = null;
        g.sweep = 0;
      }
    } else {
      const wp = g.path[g.wp];
      tx = wp[0];
      ty = wp[1];
      if (dist(g.x, g.y, tx, ty) < 5) g.wp = (g.wp + 1) % g.path.length;
    }

    if (tx != null) {
      const dx = tx - g.x;
      const dy = ty - g.y;
      const d = Math.hypot(dx, dy);
      if (d > 2) {
        const nx = g.x + (dx / d) * speed * dt;
        const ny = g.y + (dy / d) * speed * dt;
        if (!blocked(nx, g.y, 7)) g.x = nx;
        if (!blocked(g.x, ny, 7)) g.y = ny;
        const want = Math.atan2(dy, dx);
        g.facing += angleDelta(g.facing, want) * Math.min(1, dt * 7);
      } else if (g.state === 'SUSPICIOUS') {
        g.facing += Math.sin(g.sweep) * dt * 2.4;
      }
    }

    // Caught red-handed: an alerted guard that reaches you ends the run.
    if (g.state === 'ALERT' && dist(g.x, g.y, player.x, player.y) < 14) {
      detection = 1;
    }
  }

  function updateCamera(cam, dt) {
    if (cameraOffline > 0) return;
    cam.phase += dt * 0.7;
    cam.facing = cam.base + Math.sin(cam.phase) * cam.arc;
    if (inCone(player.x, player.y, cam.x, cam.y, cam.facing, CAM_HALF, CAM_RANGE)) {
      const exposure = inDark(player.x, player.y) ? 0.55 : 1;
      detection = clamp(detection + DETECT_RATE * 0.8 * exposure * dt, 0, 1);
      // A camera hit also tips off nearby guards.
      if (detection > SUSPICIOUS_AT) {
        for (const g of guards) {
          if (g.state === 'PATROL' && dist(g.x, g.y, cam.x, cam.y) < 220) {
            g.state = 'SUSPICIOUS';
            g.timer = 4;
            g.lastKnown = { x: player.x, y: player.y };
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------ render */

  function drawCone(ctx, x, y, facing, half, range, color, strength) {
    const pts = coneShape(x, y, facing, half, range);
    const grad = ctx.createRadialGradient(x, y, 4, x, y, range);
    grad.addColorStop(0, alpha(color, 0.42 * strength));
    grad.addColorStop(0.6, alpha(color, 0.2 * strength));
    grad.addColorStop(1, alpha(color, 0));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  return {
    init() {
      levelIndex = 0;
      caught = false;
      finished = false;
      bannerTime = 0;
      bannerText = '';
      loadLevel(0);
    },

    update(dt) {
      if (caught || finished) return;
      levelTime += dt;
      if (bannerTime > 0) bannerTime -= dt;
      if (cameraOffline > 0) cameraOffline = Math.max(0, cameraOffline - dt);

      /* ---- movement ---- */
      const ax = api.input.stick.x || api.input.axis('left', 'right');
      const ay = api.input.stick.y || api.input.axis('up', 'down');
      const mag = Math.hypot(ax, ay);
      player.sneaking = api.input.isDown('a');

      let speed = 0;
      if (mag > 0.05) {
        // Full stick deflection sprints; a light touch walks.
        const push = Math.min(1, mag);
        speed = player.sneaking ? SPEED_SNEAK : (push > 0.85 ? SPEED_SPRINT : SPEED_WALK * push);
        const nx = player.x + (ax / mag) * speed * dt;
        const ny = player.y + (ay / mag) * speed * dt;
        if (!blocked(nx, player.y, PLAYER_R)) player.x = nx;
        if (!blocked(player.x, ny, PLAYER_R)) player.y = ny;

        // Sprinting is loud; walking is quieter; sneaking is silent.
        if (!player.sneaking) {
          player.speed += speed * dt;
          const threshold = speed >= SPEED_SPRINT ? 26 : 70;
          if (player.speed > threshold) {
            player.speed = 0;
            noise(player.x, player.y, speed >= SPEED_SPRINT ? 128 : 62);
            api.sfx('step', { vol: 0.5 });
          }
        }
      }

      /* ---- hacking ---- */
      hackTarget = null;
      for (const t of terminals) {
        if (!t.hacked && dist(t.x, t.y, player.x, player.y) < HACK_RADIUS) hackTarget = t;
      }
      if (hackTarget && api.input.isDown('b')) {
        hackProgress += dt;
        if (Math.random() < dt * 8) {
          api.particles.emit({
            x: hackTarget.x + api.rng.range(-6, 6), y: hackTarget.y - 6,
            vy: -22, life: 0.4, size: 2, color: PAL.lime, glow: 6,
          });
        }
        if (hackProgress >= HACK_TIME) {
          hackTarget.hacked = true;
          hackProgress = 0;
          cameraOffline = CAMERA_DOWNTIME;
          api.addScore(250);
          api.sfx('powerup');
          api.particles.popText(hackTarget.x, hackTarget.y - 14, 'CAMERAS DOWN', PAL.lime, 1.4);
          banner('TERMINAL BREACHED — CAMERAS OFFLINE');
        }
      } else {
        hackProgress = Math.max(0, hackProgress - dt * 1.6);
      }

      /* ---- pickups ---- */
      for (const c of cards) {
        if (!c.taken && dist(c.x, c.y, player.x, player.y) < 14) {
          c.taken = true;
          api.addScore(150);
          api.sfx('coin');
          api.particles.popText(c.x, c.y - 12, 'KEYCARD', PAL.yellow);
        }
      }
      for (const l of loot) {
        if (!l.taken && dist(l.x, l.y, player.x, player.y) < 13) {
          l.taken = true;
          api.addScore(120);
          api.sfx('pickup');
          api.particles.burst(l.x, l.y, 8, { speed: 60, life: 0.5, size: 2, color: PAL.yellow, glow: 8, drag: 3 });
        }
      }

      /* ---- watchers ---- */
      for (const g of guards) updateGuard(g, dt);
      for (const cam of cameras) updateCamera(cam, dt);

      const anySeen = guards.some((g) => inCone(player.x, player.y, g.x, g.y, g.facing, CONE_HALF, CONE_RANGE));
      if (!anySeen) detection = clamp(detection - DETECT_DECAY * dt, 0, 1);
      if (detection >= 1) { busted(); return; }

      /* ---- noise rings ---- */
      for (let i = noisePings.length - 1; i >= 0; i--) {
        const n = noisePings[i];
        n.life -= dt;
        n.r += (n.max / 0.7) * dt;
        if (n.life <= 0) noisePings.splice(i, 1);
      }

      /* ---- exit ---- */
      const allCards = cardsHeld() === cards.length;
      if (rectHit(player.x, player.y, PLAYER_R, exitRect)) {
        if (allCards) clearLevel();
        else if (bannerTime <= 0) banner(`NEED ${cards.length - cardsHeld()} MORE KEYCARD(S)`);
      }

      api.setStatus({
        FLOOR: levelIndex + 1,
        CARDS: `${cardsHeld()}/${cards.length}`,
        ALERT: `${Math.round(detection * 100)}%`,
      });
    },

    render(ctx) {
      /* ---- floor ---- */
      ctx.fillStyle = '#080b13';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#131c30';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= VIEW_W; x += 26) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, VIEW_H); }
      for (let y = 0; y <= VIEW_H; y += 26) { ctx.moveTo(0, y + 0.5); ctx.lineTo(VIEW_W, y + 0.5); }
      ctx.stroke();
      ctx.restore();

      // Shadow pools read as darker, bluer floor.
      for (const [x, y, w, h] of darkZones) {
        ctx.fillStyle = 'rgba(2,4,10,0.72)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = alpha(PAL.violet, 0.18);
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }

      /* ---- vision cones (additive, below the walls) ---- */
      for (const cam of cameras) {
        if (cameraOffline > 0) continue;
        drawCone(ctx, cam.x, cam.y, cam.facing, CAM_HALF, CAM_RANGE, PAL.cyan, 0.8);
      }
      for (const g of guards) {
        const color = g.state === 'ALERT' ? PAL.red : g.state === 'SUSPICIOUS' ? PAL.orange : PAL.yellow;
        drawCone(ctx, g.x, g.y, g.facing, CONE_HALF, CONE_RANGE, color, 1);
      }

      /* ---- exit ---- */
      const ready = cardsHeld() === cards.length;
      ctx.save();
      ctx.shadowColor = ready ? PAL.lime : PAL.dim;
      ctx.shadowBlur = ready ? 16 : 4;
      ctx.strokeStyle = ready ? PAL.lime : PAL.dim;
      ctx.lineWidth = 2;
      ctx.strokeRect(exitRect[0], exitRect[1], exitRect[2], exitRect[3]);
      ctx.restore();
      text(ctx, 'EXIT', exitRect[0] + exitRect[2] / 2, exitRect[1] + exitRect[3] / 2 - 4,
        { size: 8, color: ready ? PAL.lime : PAL.dim, align: 'center' });

      /* ---- walls ---- */
      for (const [x, y, w, h] of walls) {
        ctx.fillStyle = '#1a2440';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#2b3a63';
        ctx.fillRect(x, y, w, 2);
        ctx.strokeStyle = '#0a1020';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }

      /* ---- objects ---- */
      for (const t of terminals) {
        const c = t.hacked ? PAL.dim : PAL.lime;
        ctx.save();
        ctx.shadowColor = c;
        ctx.shadowBlur = t.hacked ? 3 : 10;
        ctx.fillStyle = c;
        ctx.fillRect(t.x - 5, t.y - 7, 10, 14);
        ctx.fillStyle = '#05070d';
        ctx.fillRect(t.x - 3, t.y - 5, 6, 6);
        ctx.restore();
      }
      for (const c of cards) {
        if (c.taken) continue;
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(Math.sin(api.time * 2) * 0.3);
        ctx.shadowColor = PAL.yellow;
        ctx.shadowBlur = 12;
        ctx.fillStyle = PAL.yellow;
        ctx.fillRect(-6, -4, 12, 8);
        ctx.fillStyle = '#05070d';
        ctx.fillRect(-4, -2, 5, 4);
        ctx.restore();
      }
      for (const l of loot) {
        if (l.taken) continue;
        glowCircle(ctx, l.x, l.y, 3.5 + Math.sin(api.time * 4) * 0.6, PAL.yellow, 10);
      }

      /* ---- noise rings ---- */
      ctx.save();
      for (const n of noisePings) {
        ctx.globalAlpha = clamp(n.life / 0.7, 0, 1) * 0.6;
        ctx.strokeStyle = PAL.cyan;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();

      /* ---- watchers ---- */
      for (const cam of cameras) {
        const off = cameraOffline > 0;
        ctx.save();
        ctx.fillStyle = off ? PAL.dim : PAL.cyan;
        ctx.shadowColor = off ? PAL.dim : PAL.cyan;
        ctx.shadowBlur = off ? 2 : 10;
        ctx.translate(cam.x, cam.y);
        ctx.rotate(cam.facing);
        ctx.fillRect(-5, -4, 10, 8);
        ctx.fillRect(5, -2, 5, 4);
        ctx.restore();
      }

      for (const g of guards) {
        const color = g.state === 'ALERT' ? PAL.red : g.state === 'SUSPICIOUS' ? PAL.orange : PAL.yellow;
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(g.x, g.y, 7, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = '#05070d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(g.x, g.y);
        ctx.lineTo(g.x + Math.cos(g.facing) * 8, g.y + Math.sin(g.facing) * 8);
        ctx.stroke();
        ctx.restore();

        if (g.state !== 'PATROL') {
          text(ctx, g.state === 'ALERT' ? '!' : '?', g.x, g.y - 22,
            { size: 15, color, align: 'center', glow: 10 });
        }
      }

      /* ---- player ---- */
      ctx.save();
      ctx.shadowColor = PAL.violet;
      ctx.shadowBlur = player.sneaking ? 6 : 14;
      ctx.fillStyle = inDark(player.x, player.y) ? alpha(PAL.violet, 0.65) : PAL.violet;
      ctx.beginPath();
      ctx.arc(player.x, player.y, PLAYER_R, 0, TAU);
      ctx.fill();
      ctx.restore();
      if (player.sneaking) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = PAL.violet;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(player.x, player.y, PLAYER_R + 4, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }

      api.particles.render(ctx);

      /* ---- HUD ---- */
      const barW = 150;
      ctx.save();
      ctx.fillStyle = 'rgba(4,6,12,0.75)';
      ctx.fillRect(8, 8, barW + 8, 16);
      ctx.strokeStyle = alpha(detection > ALERT_AT ? PAL.red : PAL.cyan, 0.7);
      ctx.strokeRect(8.5, 8.5, barW + 7, 15);
      ctx.fillStyle = detection > ALERT_AT ? PAL.red : detection > SUSPICIOUS_AT ? PAL.orange : PAL.cyan;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 8;
      ctx.fillRect(12, 12, barW * detection, 8);
      ctx.restore();
      text(ctx, 'DETECTION', 12, 28, { size: 7, color: PAL.dim });

      if (inDark(player.x, player.y)) {
        text(ctx, 'IN SHADOW', VIEW_W - 8, 10, { size: 8, color: PAL.violet, align: 'right', glow: 6 });
      }
      if (cameraOffline > 0) {
        text(ctx, `CAMS OFFLINE ${cameraOffline.toFixed(1)}s`, VIEW_W - 8, 22,
          { size: 8, color: PAL.lime, align: 'right' });
      }

      if (hackTarget) {
        const w = 70;
        const x = hackTarget.x - w / 2;
        const y = hackTarget.y - 20;
        ctx.fillStyle = 'rgba(4,6,12,0.8)';
        ctx.fillRect(x, y, w, 6);
        ctx.fillStyle = PAL.lime;
        ctx.fillRect(x, y, w * (hackProgress / HACK_TIME), 6);
        text(ctx, hackProgress > 0 ? 'HACKING…' : 'HOLD B TO HACK', hackTarget.x, y - 10,
          { size: 7, color: PAL.lime, align: 'center' });
      }

      if (bannerTime > 0) {
        ctx.save();
        ctx.globalAlpha = clamp(bannerTime, 0, 1);
        ctx.fillStyle = 'rgba(4,6,12,0.82)';
        ctx.fillRect(0, VIEW_H / 2 - 18, VIEW_W, 34);
        text(ctx, bannerText, VIEW_W / 2, VIEW_H / 2 - 6,
          { size: 12, color: PAL.cyan, align: 'center', glow: 10 });
        ctx.restore();
      }
    },

    destroy() {
      noisePings = [];
    },
  };
}
