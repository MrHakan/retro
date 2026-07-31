/**
 * 22 — STEALTH AGENT: SHADOW ESCAPE
 *
 * Top-down infiltration. Guards and cameras project true field-of-view cones:
 * each cone is built by casting rays against the level's wall edges, so walls
 * cast real shadows and a corner genuinely hides you. Detection additionally
 * requires an unobstructed line of sight, so standing in the lit wedge behind
 * a crate is safe.
 *
 * The raycast is the expensive part, so walls are culled to the guard's
 * sight radius before any ray is tested.
 */

import {
  PAL, TAU, clamp, alpha, dist, segIntersect, text, glowCircle, roundRect,
} from '../core/fx.js';

const VIEW_W = 480;
const VIEW_H = 360;

const RAYS = 44;            // rays per cone — cheap enough for 5 viewers
const PLAYER_R = 5.5;
const RUN_SPEED = 82;
const SNEAK_SPEED = 38;
const RUN_NOISE = 54;       // radius at which running is audible
const SNEAK_NOISE = 0;
const DETECT_RATE = 1.55;   // meter fill per second, fully lit
const DETECT_DECAY = 0.5;
const HACK_TIME = 2.2;

/* ---------------------------------------------------------------- levels */

/**
 * Hand-authored layouts — a stealth level lives or dies on its sightlines, and
 * procedural generation tends to produce either trivial or impossible ones.
 * Each is a compact spec expanded in `buildLevel`.
 */
const LEVELS = [
  {
    name: 'SERVER FARM',
    walls: [
      [0, 0, 480, 8], [0, 352, 480, 8], [0, 0, 8, 360], [472, 0, 8, 360],
      [90, 60, 16, 130], [160, 60, 16, 130],
      [90, 240, 130, 16], [300, 60, 16, 110],
      [300, 230, 16, 90], [370, 150, 90, 16],
    ],
    player: [40, 300],
    exit: [438, 30, 30, 40],
    keycards: [[196, 300]],
    terminals: [[130, 210]],
    loot: [[126, 100], [340, 300], [420, 240]],
    lights: [[200, 160, 78], [390, 90, 70]],
    guards: [
      { path: [[60, 60], [60, 320], [250, 320]], speed: 40 },
      { path: [[350, 40], [440, 40], [440, 300], [350, 300]], speed: 46 },
    ],
    cameras: [],
  },
  {
    name: 'ATRIUM',
    walls: [
      [0, 0, 480, 8], [0, 352, 480, 8], [0, 0, 8, 360], [472, 0, 8, 360],
      [70, 70, 140, 14], [70, 70, 14, 90],
      [270, 70, 140, 14], [396, 70, 14, 90],
      [70, 270, 140, 14], [196, 200, 14, 84],
      [270, 270, 140, 14], [270, 200, 14, 84],
      [220, 150, 40, 60],
    ],
    player: [30, 180],
    exit: [438, 160, 30, 40],
    keycards: [[240, 40], [120, 320]],
    terminals: [[100, 180], [380, 180]],
    loot: [[150, 120], [330, 120], [240, 330], [440, 40]],
    lights: [[240, 180, 92], [110, 40, 60], [380, 320, 60]],
    guards: [
      { path: [[240, 110], [140, 180], [240, 250], [340, 180]], speed: 44 },
      { path: [[40, 40], [40, 320]], speed: 52 },
      { path: [[440, 320], [440, 60]], speed: 50 },
    ],
    cameras: [{ x: 240, y: 20, angle: Math.PI / 2, sweep: 1.1 }],
  },
  {
    name: 'VAULT',
    walls: [
      [0, 0, 480, 8], [0, 352, 480, 8], [0, 0, 8, 360], [472, 0, 8, 360],
      [60, 60, 14, 100], [60, 60, 120, 14],
      [60, 220, 120, 14], [166, 234, 14, 90],
      [230, 40, 14, 120], [230, 210, 14, 120],
      [300, 100, 110, 14], [300, 100, 14, 90],
      [300, 250, 110, 14], [396, 170, 14, 94],
    ],
    player: [30, 330],
    exit: [438, 24, 30, 40],
    keycards: [[110, 130], [350, 180]],
    terminals: [[210, 320], [330, 60]],
    loot: [[100, 30], [270, 180], [440, 200], [40, 180], [200, 60]],
    lights: [[120, 300, 66], [350, 180, 74], [260, 60, 62]],
    guards: [
      { path: [[110, 300], [420, 300], [420, 200]], speed: 50 },
      { path: [[200, 180], [200, 40], [420, 40]], speed: 48 },
      { path: [[40, 40], [40, 300], [120, 300]], speed: 54 },
    ],
    cameras: [
      { x: 460, y: 120, angle: Math.PI, sweep: 0.9 },
      { x: 20, y: 200, angle: 0, sweep: 0.8 },
    ],
  },
];

export const meta = {
  id: 'stealth',
  title: 'STEALTH AGENT: SHADOW ESCAPE',
  short: 'STEALTH',
  category: 'ACTION',
  desc: 'Slip past raycast vision cones that cast real shadows. Hack terminals, '
      + 'lift keycards and reach the exit before a guard finishes deciding what '
      + 'that noise was.',
  accent: PAL.violet,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'WASD / ARROWS — move',
    'HOLD J — sneak (slow and silent)',
    'HOLD K — hack a terminal',
    'P — pause',
  ],
  touch: { stick: true, buttons: [{ id: 'a', label: 'SNEAK' }, { id: 'b', label: 'HACK' }] },

  art(ctx, w, h, accent) {
    ctx.save();
    ctx.fillStyle = '#080b14';
    ctx.fillRect(0, 0, w, h);

    // A guard's cone clipped by a wall — the game in one image.
    const gx = 58;
    const gy = 132;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(gx, gy, 4, gx, gy, 140);
    grad.addColorStop(0, alpha(PAL.yellow, 0.55));
    grad.addColorStop(1, alpha(PAL.yellow, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.arc(gx, gy, 140, -1.05, -0.1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Wall casting the shadow.
    ctx.fillStyle = '#1d2a45';
    ctx.fillRect(120, 60, 16, 58);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(120.5, 60.5, 15, 57);

    // Shadow wedge behind it.
    ctx.fillStyle = 'rgba(6,8,15,0.92)';
    ctx.beginPath();
    ctx.moveTo(136, 60);
    ctx.lineTo(240, 34);
    ctx.lineTo(240, 96);
    ctx.lineTo(136, 118);
    ctx.closePath();
    ctx.fill();

    // Guard.
    ctx.shadowColor = PAL.yellow;
    ctx.shadowBlur = 10;
    ctx.fillStyle = PAL.yellow;
    ctx.beginPath();
    ctx.arc(gx, gy, 7, 0, TAU);
    ctx.fill();

    // Agent hiding in the shadow.
    ctx.shadowColor = accent;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(186, 74, 7, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = PAL.red;
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.fillText('?', gx - 4, gy - 14);
    ctx.restore();
  },
};

export function create(api) {
  let levelIndex, level, player, guards, cameras, pickups, terminals;
  let exitZone, keysHeld, keysNeeded, lootTaken, lootTotal;
  let alarm, noises, over, levelTime, totalTime, hacking, hackTarget;
  let camerasDown, flashTimer, levelBanner;

  /* --------------------------------------------------------- level setup */

  function buildLevel(i) {
    const spec = LEVELS[i % LEVELS.length];
    // Deeper loops through the level list get faster, sharper-eyed guards.
    const loop = Math.floor(i / LEVELS.length);
    const boost = 1 + loop * 0.22;

    level = {
      name: spec.name,
      walls: spec.walls.map(([x, y, w, h]) => ({ x, y, w, h })),
      lights: spec.lights.map(([x, y, r]) => ({ x, y, r })),
    };
    // Flatten every wall into edges once — the raycaster reuses this list.
    level.edges = [];
    for (const w of level.walls) {
      level.edges.push(
        { x1: w.x, y1: w.y, x2: w.x + w.w, y2: w.y, cx: w.x + w.w / 2, cy: w.y, r: w.w / 2 },
        { x1: w.x + w.w, y1: w.y, x2: w.x + w.w, y2: w.y + w.h, cx: w.x + w.w, cy: w.y + w.h / 2, r: w.h / 2 },
        { x1: w.x + w.w, y1: w.y + w.h, x2: w.x, y2: w.y + w.h, cx: w.x + w.w / 2, cy: w.y + w.h, r: w.w / 2 },
        { x1: w.x, y1: w.y + w.h, x2: w.x, y2: w.y, cx: w.x, cy: w.y + w.h / 2, r: w.h / 2 },
      );
    }

    player = { x: spec.player[0], y: spec.player[1], detect: 0, sneak: false, moving: false };

    guards = spec.guards.map((g) => ({
      path: g.path.map(([x, y]) => ({ x, y })),
      node: 1,
      x: g.path[0][0],
      y: g.path[0][1],
      speed: g.speed * boost,
      angle: 0,
      state: 'patrol',
      alertTimer: 0,
      target: null,
      scan: 0,
      range: 118 + loop * 10,
      fov: 1.05,
      cone: [],
    }));

    cameras = spec.cameras.map((c) => ({
      x: c.x, y: c.y, base: c.angle, sweep: c.sweep,
      angle: c.angle, t: api.rng.next() * TAU,
      range: 108, fov: 0.62, cone: [], state: 'patrol',
    }));

    pickups = [
      ...spec.keycards.map(([x, y]) => ({ x, y, kind: 'key', taken: false })),
      ...spec.loot.map(([x, y]) => ({ x, y, kind: 'loot', taken: false })),
    ];
    terminals = spec.terminals.map(([x, y]) => ({ x, y, done: false, progress: 0 }));
    exitZone = { x: spec.exit[0], y: spec.exit[1], w: spec.exit[2], h: spec.exit[3] };

    keysHeld = 0;
    keysNeeded = spec.keycards.length;
    lootTotal = spec.loot.length;
    lootTaken = 0;
    alarm = 0;
    camerasDown = 0;
    noises = [];
    hacking = 0;
    hackTarget = null;
    levelTime = 0;
    flashTimer = 0;
    levelBanner = 2.2;

    api.setStatus({
      LEVEL: i + 1,
      KEYS: `${keysHeld}/${keysNeeded}`,
      LOOT: `${lootTaken}/${lootTotal}`,
    });
  }

  /* ------------------------------------------------------------ geometry */

  const blocked = (x, y, r) => {
    for (const w of level.walls) {
      if (x + r > w.x && x - r < w.x + w.w && y + r > w.y && y - r < w.y + w.h) return true;
    }
    return false;
  };

  /** True when nothing solid sits between the two points. */
  function lineOfSight(x1, y1, x2, y2) {
    for (const e of level.edges) {
      if (segIntersect(x1, y1, x2, y2, e.x1, e.y1, e.x2, e.y2)) return false;
    }
    return true;
  }

  /**
   * Build the visible polygon for a cone by casting `RAYS` rays across its arc
   * and stopping each at the nearest wall edge. Only edges within range are
   * considered, which is what keeps five simultaneous cones affordable.
   */
  function castCone(ox, oy, facing, fov, range, out) {
    const near = [];
    const reach = range + 40;
    for (const e of level.edges) {
      if (dist(ox, oy, e.cx, e.cy) - e.r < reach) near.push(e);
    }

    out.length = 0;
    for (let i = 0; i < RAYS; i++) {
      const a = facing - fov + (i / (RAYS - 1)) * fov * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let best = range;
      const ex = ox + dx * range;
      const ey = oy + dy * range;
      for (const e of near) {
        const hit = segIntersect(ox, oy, ex, ey, e.x1, e.y1, e.x2, e.y2);
        if (hit && hit.t * range < best) best = hit.t * range;
      }
      out.push(ox + dx * best, oy + dy * best);
    }
    return out;
  }

  /** Is the player inside this viewer's cone, with line of sight? */
  function sees(v) {
    const d = dist(v.x, v.y, player.x, player.y);
    if (d > v.range) return false;
    const a = Math.atan2(player.y - v.y, player.x - v.x);
    let diff = Math.abs(((a - v.angle + Math.PI * 3) % TAU) - Math.PI);
    if (diff > v.fov) return false;
    return lineOfSight(v.x, v.y, player.x, player.y);
  }

  /** How brightly lit the player currently is: 0.35 in shadow, 1 under a lamp. */
  function lightLevel() {
    let lit = 0.35;
    for (const l of level.lights) {
      const d = dist(l.x, l.y, player.x, player.y);
      if (d < l.r) lit = Math.max(lit, 0.45 + 0.55 * (1 - d / l.r));
    }
    return lit;
  }

  function makeNoise(x, y, radius) {
    if (radius <= 0) return;
    noises.push({ x, y, r: 0, max: radius, life: 0.5 });
    for (const g of guards) {
      if (g.state === 'alert') continue;
      if (dist(g.x, g.y, x, y) < radius && lineOfSight(g.x, g.y, x, y)) {
        g.state = 'suspicious';
        g.alertTimer = 3.2;
        g.target = { x, y };
      }
    }
  }

  /* --------------------------------------------------------------- flow  */

  function caught(by) {
    if (over) return;
    over = true;
    api.sfx('alert');
    api.shakeScreen(10, 4);
    api.vibrate(200);
    api.particles.burst(player.x, player.y, 22, {
      speed: 130, life: 0.8, size: 3, color: [PAL.red, PAL.orange], glow: 10, drag: 2,
    });
    api.gameOver({
      message: by === 'camera' ? 'SPOTTED BY A CAMERA' : 'GUARD CAUGHT YOU',
      stats: {
        FLOORS: levelIndex,
        LOOT: `${lootTaken}/${lootTotal}`,
        TIME: `${totalTime.toFixed(1)}s`,
      },
    });
  }

  function completeLevel() {
    const speedBonus = Math.max(0, Math.round(400 - levelTime * 6));
    const silent = alarm < 0.05 ? 500 : 0;
    api.addScore(1000 + speedBonus + silent);
    api.particles.popText(player.x, player.y - 14, `+${1000 + speedBonus + silent}`, PAL.lime, 1.4);
    api.sfx('victory');

    levelIndex++;
    if (levelIndex >= 6) {
      over = true;
      api.win({
        message: 'EXFILTRATED',
        stats: {
          FLOORS: levelIndex,
          TIME: `${totalTime.toFixed(1)}s`,
          SCORE: api.score,
        },
      });
      return;
    }
    buildLevel(levelIndex);
  }

  /* -------------------------------------------------------------- update */

  function updatePlayer(dt) {
    const ix = api.input.stick.x || api.input.axis('left', 'right');
    const iy = api.input.stick.y || api.input.axis('up', 'down');
    const len = Math.hypot(ix, iy);
    player.sneak = api.input.isDown('a');
    player.moving = len > 0.12;

    if (player.moving && !hacking) {
      const speed = player.sneak ? SNEAK_SPEED : RUN_SPEED;
      const nx = (ix / len) * speed * dt;
      const ny = (iy / len) * speed * dt;
      // Axis-separated so sliding along a wall feels smooth.
      if (!blocked(player.x + nx, player.y, PLAYER_R)) player.x += nx;
      if (!blocked(player.x, player.y + ny, PLAYER_R)) player.y += ny;
      player.x = clamp(player.x, PLAYER_R, VIEW_W - PLAYER_R);
      player.y = clamp(player.y, PLAYER_R, VIEW_H - PLAYER_R);

      if (!player.sneak) {
        player.noiseTimer = (player.noiseTimer || 0) - dt;
        if (player.noiseTimer <= 0) {
          player.noiseTimer = 0.55;
          makeNoise(player.x, player.y, RUN_NOISE);
          api.sfx('step', { vol: 0.5 });
        }
      }
    }
  }

  function updateHacking(dt) {
    const holding = api.input.isDown('b');
    hackTarget = null;
    for (const t of terminals) {
      if (!t.done && dist(t.x, t.y, player.x, player.y) < 22) hackTarget = t;
    }

    if (holding && hackTarget && !player.moving) {
      hacking += dt;
      hackTarget.progress = hacking / HACK_TIME;
      if (Math.random() < dt * 8) {
        api.particles.emit({
          x: hackTarget.x + (Math.random() - 0.5) * 14,
          y: hackTarget.y - 6,
          vy: -22, life: 0.4, size: 2, color: PAL.cyan, glow: 6,
        });
      }
      if (hacking >= HACK_TIME) {
        hackTarget.done = true;
        hackTarget.progress = 1;
        hacking = 0;
        camerasDown = 12;
        api.addScore(250);
        api.sfx('powerup');
        api.particles.popText(hackTarget.x, hackTarget.y - 16, 'CAMERAS DOWN', PAL.cyan, 1.4);
      }
    } else {
      hacking = 0;
      if (hackTarget) hackTarget.progress = 0;
    }
  }

  function updateGuard(g, dt) {
    if (g.state === 'alert') {
      // Beeline for the last known position; give up if it goes cold.
      const t = g.target || player;
      const a = Math.atan2(t.y - g.y, t.x - g.x);
      const sp = g.speed * 1.7;
      const nx = g.x + Math.cos(a) * sp * dt;
      const ny = g.y + Math.sin(a) * sp * dt;
      if (!blocked(nx, g.y, 7)) g.x = nx;
      if (!blocked(g.x, ny, 7)) g.y = ny;
      g.angle = a;
      g.alertTimer -= dt;
      if (g.alertTimer <= 0) {
        g.state = 'suspicious';
        g.alertTimer = 3;
      }
    } else if (g.state === 'suspicious') {
      g.alertTimer -= dt;
      if (g.target && dist(g.x, g.y, g.target.x, g.target.y) > 10) {
        const a = Math.atan2(g.target.y - g.y, g.target.x - g.x);
        const nx = g.x + Math.cos(a) * g.speed * 0.85 * dt;
        const ny = g.y + Math.sin(a) * g.speed * 0.85 * dt;
        if (!blocked(nx, g.y, 7)) g.x = nx;
        if (!blocked(g.x, ny, 7)) g.y = ny;
        g.angle = a;
      } else {
        // Arrived: sweep the cone around looking for whatever made the noise.
        g.scan += dt * 2.4;
        g.angle += Math.sin(g.scan) * dt * 2.6;
      }
      if (g.alertTimer <= 0) {
        g.state = 'patrol';
        g.target = null;
      }
    } else {
      const node = g.path[g.node];
      const d = dist(g.x, g.y, node.x, node.y);
      if (d < 4) {
        g.node = (g.node + 1) % g.path.length;
      } else {
        const a = Math.atan2(node.y - g.y, node.x - g.x);
        g.x += Math.cos(a) * g.speed * dt;
        g.y += Math.sin(a) * g.speed * dt;
        // Ease the facing so the cone swings rather than snapping.
        const diff = ((a - g.angle + Math.PI * 3) % TAU) - Math.PI;
        g.angle += diff * Math.min(1, dt * 6);
      }
    }
    castCone(g.x, g.y, g.angle, g.fov, g.range, g.cone);
  }

  function updateCamera(c, dt) {
    if (camerasDown > 0) {
      c.state = 'down';
      c.cone.length = 0;
      return;
    }
    c.state = 'patrol';
    c.t += dt * 0.7;
    c.angle = c.base + Math.sin(c.t) * c.sweep;
    castCone(c.x, c.y, c.angle, c.fov, c.range, c.cone);
  }

  function updateDetection(dt) {
    let seenBy = null;
    for (const g of guards) if (sees(g)) { seenBy = g; break; }
    let cam = null;
    if (!seenBy && camerasDown <= 0) {
      for (const c of cameras) if (sees(c)) { cam = c; break; }
    }

    if (seenBy || cam) {
      const lit = lightLevel();
      const sneakMod = player.sneak ? 0.62 : 1;
      player.detect += DETECT_RATE * lit * sneakMod * dt;
      alarm = Math.max(alarm, 0.35);
      if (seenBy && seenBy.state !== 'alert' && player.detect > 0.42) {
        seenBy.state = 'suspicious';
        seenBy.alertTimer = 3.5;
        seenBy.target = { x: player.x, y: player.y };
        api.sfx('blip');
      }
      if (player.detect >= 1) {
        if (seenBy) {
          seenBy.state = 'alert';
          seenBy.alertTimer = 5;
          seenBy.target = { x: player.x, y: player.y };
        }
        caught(cam ? 'camera' : 'guard');
        return;
      }
      // Alert guards keep a fix on you while they can see you.
      if (seenBy && seenBy.state === 'alert') seenBy.target = { x: player.x, y: player.y };
    } else {
      player.detect = Math.max(0, player.detect - DETECT_DECAY * dt);
      alarm = Math.max(0, alarm - dt * 0.4);
    }
  }

  /* --------------------------------------------------------------- draw  */

  function drawCone(ctx, v, color, strength) {
    if (!v.cone.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(v.x, v.y, 6, v.x, v.y, v.range);
    g.addColorStop(0, alpha(color, 0.5 * strength));
    g.addColorStop(0.6, alpha(color, 0.2 * strength));
    g.addColorStop(1, alpha(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(v.x, v.y);
    for (let i = 0; i < v.cone.length; i += 2) ctx.lineTo(v.cone[i], v.cone[i + 1]);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  return {
    init() {
      levelIndex = 0;
      totalTime = 0;
      over = false;
      buildLevel(0);
    },

    update(dt) {
      if (over) return;
      levelTime += dt;
      totalTime += dt;
      if (levelBanner > 0) levelBanner -= dt;
      if (camerasDown > 0) camerasDown -= dt;
      if (flashTimer > 0) flashTimer -= dt;

      updatePlayer(dt);
      updateHacking(dt);
      for (const g of guards) updateGuard(g, dt);
      for (const c of cameras) updateCamera(c, dt);
      updateDetection(dt);
      if (over) return;

      for (let i = noises.length - 1; i >= 0; i--) {
        const n = noises[i];
        n.life -= dt;
        n.r = n.max * (1 - n.life / 0.5);
        if (n.life <= 0) noises.splice(i, 1);
      }

      for (const p of pickups) {
        if (p.taken || dist(p.x, p.y, player.x, player.y) > 12) continue;
        p.taken = true;
        if (p.kind === 'key') {
          keysHeld++;
          api.sfx('coin');
          api.particles.popText(p.x, p.y - 12, 'KEYCARD', PAL.yellow);
        } else {
          lootTaken++;
          api.addScore(150);
          api.sfx('pickup');
          api.particles.popText(p.x, p.y - 12, '+150', PAL.cyan);
        }
        api.particles.burst(p.x, p.y, 10, {
          speed: 70, life: 0.5, size: 2, color: p.kind === 'key' ? PAL.yellow : PAL.cyan,
          glow: 8, drag: 3,
        });
        api.setStatus({ KEYS: `${keysHeld}/${keysNeeded}`, LOOT: `${lootTaken}/${lootTotal}` });
      }

      const atExit = player.x > exitZone.x - PLAYER_R && player.x < exitZone.x + exitZone.w + PLAYER_R
        && player.y > exitZone.y - PLAYER_R && player.y < exitZone.y + exitZone.h + PLAYER_R;
      if (atExit) {
        if (keysHeld >= keysNeeded) completeLevel();
        else if (flashTimer <= 0) {
          flashTimer = 1;
          api.sfx('deny');
          api.particles.popText(player.x, player.y - 16, 'NEED KEYCARD', PAL.red, 1);
        }
      }
    },

    render(ctx) {
      /* Floor */
      ctx.fillStyle = '#080b14';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#111a2c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= VIEW_W; x += 24) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, VIEW_H); }
      for (let y = 0; y <= VIEW_H; y += 24) { ctx.moveTo(0, y + 0.5); ctx.lineTo(VIEW_W, y + 0.5); }
      ctx.stroke();
      ctx.restore();

      /* Lit floor zones */
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const l of level.lights) {
        const g = ctx.createRadialGradient(l.x, l.y, 2, l.x, l.y, l.r);
        g.addColorStop(0, 'rgba(120,150,200,0.16)');
        g.addColorStop(1, 'rgba(120,150,200,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(l.x, l.y, l.r, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      /* Exit */
      const open = keysHeld >= keysNeeded;
      ctx.save();
      ctx.shadowColor = open ? PAL.lime : PAL.red;
      ctx.shadowBlur = 14 + (open ? Math.sin(api.time * 6) * 6 : 0);
      ctx.fillStyle = alpha(open ? PAL.lime : PAL.red, 0.28);
      ctx.fillRect(exitZone.x, exitZone.y, exitZone.w, exitZone.h);
      ctx.strokeStyle = open ? PAL.lime : PAL.red;
      ctx.lineWidth = 2;
      ctx.strokeRect(exitZone.x + 1, exitZone.y + 1, exitZone.w - 2, exitZone.h - 2);
      ctx.restore();
      text(ctx, 'EXIT', exitZone.x + exitZone.w / 2, exitZone.y + exitZone.h / 2,
        { size: 8, color: open ? PAL.lime : PAL.red, align: 'center', baseline: 'middle' });

      /* Vision cones — drawn under the walls so shadows read correctly */
      for (const c of cameras) drawCone(ctx, c, PAL.cyan, 0.8);
      for (const g of guards) {
        const col = g.state === 'alert' ? PAL.red : g.state === 'suspicious' ? PAL.orange : PAL.yellow;
        drawCone(ctx, g, col, g.state === 'alert' ? 1.2 : 1);
      }

      /* Walls */
      for (const w of level.walls) {
        ctx.fillStyle = '#161f36';
        ctx.fillRect(w.x, w.y, w.w, w.h);
        ctx.strokeStyle = '#2b3d63';
        ctx.lineWidth = 1;
        ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
      }

      /* Noise rings */
      ctx.save();
      for (const n of noises) {
        ctx.globalAlpha = (n.life / 0.5) * 0.5;
        ctx.strokeStyle = PAL.white;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();

      /* Terminals */
      for (const t of terminals) {
        const col = t.done ? PAL.lime : PAL.cyan;
        ctx.save();
        ctx.shadowColor = col;
        ctx.shadowBlur = 8;
        ctx.fillStyle = alpha(col, 0.3);
        roundRect(ctx, t.x - 7, t.y - 9, 14, 18, 2);
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
        if (t.progress > 0 && t.progress < 1) {
          ctx.fillStyle = '#05060a';
          ctx.fillRect(t.x - 12, t.y - 18, 24, 4);
          ctx.fillStyle = PAL.cyan;
          ctx.fillRect(t.x - 12, t.y - 18, 24 * t.progress, 4);
        }
      }

      /* Pickups */
      for (const p of pickups) {
        if (p.taken) continue;
        const bob = Math.sin(api.time * 4 + p.x) * 1.5;
        if (p.kind === 'key') {
          ctx.save();
          ctx.shadowColor = PAL.yellow;
          ctx.shadowBlur = 12;
          ctx.fillStyle = PAL.yellow;
          ctx.fillRect(p.x - 5, p.y - 3 + bob, 10, 6);
          ctx.fillRect(p.x + 2, p.y + 3 + bob, 3, 3);
          ctx.restore();
        } else {
          glowCircle(ctx, p.x, p.y + bob, 3.5, PAL.cyan, 10);
        }
      }

      /* Cameras */
      for (const c of cameras) {
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(c.angle);
        ctx.fillStyle = camerasDown > 0 ? PAL.dim : PAL.cyan;
        ctx.fillRect(-4, -4, 10, 8);
        ctx.restore();
      }

      /* Guards */
      for (const g of guards) {
        const col = g.state === 'alert' ? PAL.red : g.state === 'suspicious' ? PAL.orange : PAL.yellow;
        ctx.save();
        ctx.shadowColor = col;
        ctx.shadowBlur = 10;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(g.x, g.y, 6, 0, TAU);
        ctx.fill();
        ctx.restore();
        // Facing nub.
        ctx.fillStyle = '#05060a';
        ctx.fillRect(g.x + Math.cos(g.angle) * 4 - 1.5, g.y + Math.sin(g.angle) * 4 - 1.5, 3, 3);
        if (g.state !== 'patrol') {
          text(ctx, g.state === 'alert' ? '!' : '?', g.x, g.y - 18,
            { size: 14, color: col, align: 'center', glow: 8 });
        }
      }

      /* Player */
      const lit = lightLevel();
      ctx.save();
      ctx.shadowColor = PAL.violet;
      ctx.shadowBlur = player.sneak ? 6 : 14;
      ctx.globalAlpha = player.sneak ? 0.72 : 1;
      ctx.fillStyle = PAL.violet;
      ctx.beginPath();
      ctx.arc(player.x, player.y, PLAYER_R, 0, TAU);
      ctx.fill();
      ctx.restore();

      api.particles.render(ctx);

      /* Darkness: everything outside the agent's own small vision radius dims */
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      const dark = ctx.createRadialGradient(player.x, player.y, 20, player.x, player.y, 190);
      dark.addColorStop(0, 'rgba(255,255,255,1)');
      dark.addColorStop(1, 'rgba(96,104,130,1)');
      ctx.fillStyle = dark;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.restore();

      /* HUD */
      if (player.detect > 0.02) {
        const w = 90;
        const x = player.x - w / 2;
        const y = player.y - 20;
        ctx.fillStyle = 'rgba(5,6,10,0.7)';
        ctx.fillRect(x, y, w, 5);
        ctx.fillStyle = player.detect > 0.7 ? PAL.red : player.detect > 0.4 ? PAL.orange : PAL.yellow;
        ctx.fillRect(x, y, w * clamp(player.detect, 0, 1), 5);
      }

      text(ctx, level.name, 10, 8, { size: 9, color: PAL.dim, letterSpacing: '2px' });
      text(ctx, player.sneak ? 'SNEAKING' : 'RUNNING', 10, VIEW_H - 18,
        { size: 9, color: player.sneak ? PAL.violet : PAL.orange });
      text(ctx, `LIGHT ${Math.round(lit * 100)}%`, 10, VIEW_H - 30, { size: 8, color: PAL.dim });
      if (camerasDown > 0) {
        text(ctx, `CAMERAS OFFLINE ${camerasDown.toFixed(1)}`, VIEW_W - 10, 8,
          { size: 9, color: PAL.cyan, align: 'right' });
      }
      if (hackTarget && !hacking) {
        text(ctx, 'HOLD HACK', hackTarget.x, hackTarget.y - 26,
          { size: 8, color: PAL.cyan, align: 'center' });
      }

      if (levelBanner > 0) {
        ctx.save();
        ctx.globalAlpha = clamp(levelBanner / 0.6, 0, 1);
        text(ctx, `FLOOR ${levelIndex + 1}`, VIEW_W / 2, VIEW_H / 2 - 18,
          { size: 20, color: PAL.violet, align: 'center', glow: 14 });
        text(ctx, level.name, VIEW_W / 2, VIEW_H / 2 + 6,
          { size: 11, color: PAL.dim, align: 'center' });
        ctx.restore();
      }

      /* Alert vignette */
      if (alarm > 0.01) {
        ctx.save();
        ctx.globalAlpha = alarm * 0.5;
        ctx.strokeStyle = PAL.red;
        ctx.lineWidth = 6;
        ctx.strokeRect(3, 3, VIEW_W - 6, VIEW_H - 6);
        ctx.restore();
      }
    },
  };
}
