/**
 * 06 — CYBER PARKOUR RUNNER
 *
 * One-button endless rooftop runner. The city scrolls under you at an
 * ever-rising speed while the generator lays down platforms, gaps, ducts and
 * low neon signage. Every gap is provably clearable: the generator solves the
 * projectile equation for the *current* run speed before it picks a width, so
 * a run can never become impossible — only tight.
 *
 * Feel notes: coyote time, jump buffering and a variable-height jump (release
 * early to clip the arc) are all in here. They are what makes a runner feel
 * fair rather than twitchy.
 */

import { PAL, TAU, clamp, alpha, aabb, mix, text } from '../core/fx.js';

const VIEW = { w: 480, h: 270 };

/* ----------------------------------------------------------------- physics */

const GRAV = 1400;          // px/s^2
const JUMP_V = 400;         // initial upward speed of a jump
const CUT_V = 150;          // velocity kept when the button is released early
const COYOTE = 0.11;        // grace after walking off a ledge
const BUFFER = 0.14;        // grace for pressing jump before landing
const RUN_X = 108;          // player's fixed screen column
const P_W = 15;
const P_H = 30;
const SLIDE_H = 15;
const SLIDE_TIME = 0.5;
const SPEED_MIN = 168;
const SPEED_MAX = 352;
const SPEED_RAMP = 5.4;     // px/s gained per second of survival

/** Deck heights the generator is allowed to use. */
const DECK_HI = 132;
const DECK_LO = 214;

/**
 * Air time of a jump that must finish `rise` pixels higher than it started
 * (negative `rise` = landing lower, which buys extra hang time). Returns 0 if
 * the height is simply out of reach.
 */
function airTime(rise) {
  const disc = JUMP_V * JUMP_V - 2 * GRAV * rise;
  if (disc <= 0) return 0;
  return (JUMP_V + Math.sqrt(disc)) / GRAV;
}

/** The tallest single jump — used to clamp how far the decks may step up. */
const MAX_RISE = (JUMP_V * JUMP_V) / (2 * GRAV) * 0.72;

/** Cheap deterministic noise so the parallax clutter is stable while scrolling. */
function h01(i) {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const OBSTACLES = {
  crate: { w: 22, h: 26, color: PAL.orange },
  duct: { w: 38, h: 19, color: PAL.blue },
  sign: { w: 30, h: 130, color: PAL.magenta }, // hangs; bottom edge sits 26px up
};

export const meta = {
  id: 'runner',
  title: 'CYBER PARKOUR RUNNER',
  short: 'PARKOUR',
  category: 'ACTION',
  desc: 'Auto-run the neon rooftops. Tap to jump, tap again to double jump, '
      + 'hold to fly higher and slide under the signage. Every gap is solvable — '
      + 'the generator does the maths before it opens one.',
  accent: PAL.cyan,
  view: VIEW,
  controls: [
    'SPACE / UP — jump (again in air = double)',
    'HOLD — jump higher',
    'DOWN — slide',
  ],
  touch: { buttons: [{ id: 'a', label: 'JUMP', wide: true }, { id: 'down', label: 'SLIDE' }] },
  art(ctx, w, h, accent) {
    ctx.save();
    // Night sky.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0a0f22');
    g.addColorStop(1, '#2a1038');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Skyline.
    ctx.fillStyle = '#141f3d';
    for (let i = 0; i < 11; i++) {
      const bw = 14 + h01(i) * 22;
      const bh = 26 + h01(i + 90) * 70;
      ctx.fillRect(i * 23, h - 46 - bh, bw, bh + 46);
    }
    ctx.fillStyle = alpha(PAL.cyan, 0.5);
    for (let i = 0; i < 26; i++) {
      ctx.fillRect(8 + h01(i + 7) * (w - 16), h - 60 - h01(i + 31) * 60, 2, 3);
    }
    // Two rooftops with a gap.
    ctx.fillStyle = '#1c2b46';
    ctx.fillRect(0, h - 46, 96, 46);
    ctx.fillRect(146, h - 60, w - 146, 60);
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;
    ctx.fillRect(0, h - 48, 96, 3);
    ctx.fillRect(146, h - 62, w - 146, 3);
    // Runner mid-leap.
    ctx.fillStyle = PAL.white;
    ctx.shadowColor = PAL.white;
    ctx.fillRect(104, h - 96, 12, 20);
    ctx.fillRect(106, h - 106, 9, 8);
    ctx.fillStyle = PAL.magenta;
    ctx.shadowColor = PAL.magenta;
    ctx.fillRect(100, h - 78, 8, 4);
    ctx.fillRect(114, h - 74, 8, 4);
    // Data shard.
    ctx.fillStyle = PAL.yellow;
    ctx.shadowColor = PAL.yellow;
    ctx.beginPath();
    ctx.moveTo(190, h - 104);
    ctx.lineTo(198, h - 94);
    ctx.lineTo(190, h - 84);
    ctx.lineTo(182, h - 94);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },
};

export function create(api) {
  /* ------------------------------------------------------------- state */
  let camX;                 // world x of the left screen edge
  let speed, distance, shards, meters;
  let alive;

  let py, pvy;              // feet y, vertical velocity
  let onGround, coyote, buffer, jumpsLeft, holding;
  let sliding, slideT, runPhase, landFlash;

  /** @type {{x:number,w:number,y:number}[]} left-to-right, never overlapping */
  let plats;
  /** @type {{x:number,y:number,w:number,h:number,kind:string}[]} */
  let obstacles;
  /** @type {{x:number,y:number,taken:boolean,ph:number}[]} */
  let items;

  let trail;                // short ribbon behind the runner
  let statusTimer;
  let bgTile = null;        // offscreen: far skyline (top) + mid block (bottom)

  const px = () => camX + RUN_X;

  /* -------------------------------------------------------- backdrop */

  /**
   * Pre-render the two slowest parallax layers once. They never change, so
   * baking them into a single offscreen canvas turns ~300 rects per frame
   * into two `drawImage` calls.
   */
  function buildBackdrop() {
    const W = api.w;
    const H = api.h;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H * 2;
    const g = c.getContext('2d');

    // --- far skyline (region y: 0..H) ---
    let x = -20;
    while (x < W + 20) {
      const bw = 16 + api.rng.range(0, 26);
      const bh = 22 + api.rng.range(0, 74);
      const top = H * 0.72 - bh;
      g.fillStyle = mix('#0b1226', '#12203c', api.rng.next());
      g.fillRect(Math.round(x), Math.round(top), Math.round(bw), H);
      // A few lit windows.
      for (let wy = top + 6; wy < H * 0.72 - 4; wy += 7) {
        for (let wx = x + 3; wx < x + bw - 3; wx += 6) {
          if (api.rng.chance(0.16)) {
            g.fillStyle = alpha(api.rng.chance(0.5) ? PAL.cyan : PAL.violet, 0.45);
            g.fillRect(Math.round(wx), Math.round(wy), 2, 3);
          }
        }
      }
      x += bw + api.rng.range(2, 16);
    }

    // --- mid block (region y: H..2H) ---
    x = -26;
    while (x < W + 26) {
      const bw = 30 + api.rng.range(0, 46);
      const bh = 52 + api.rng.range(0, 120);
      const top = H + H * 0.92 - bh;
      g.fillStyle = mix('#131d38', '#1b2450', api.rng.next());
      g.fillRect(Math.round(x), Math.round(top), Math.round(bw), H);
      // Roof edge highlight + a neon sign stripe.
      g.fillStyle = alpha(PAL.violet, 0.5);
      g.fillRect(Math.round(x), Math.round(top), Math.round(bw), 1);
      if (api.rng.chance(0.45)) {
        g.fillStyle = alpha(api.rng.pick([PAL.magenta, PAL.cyan, PAL.orange]), 0.55);
        g.fillRect(Math.round(x + 4), Math.round(top + 14 + api.rng.range(0, 40)), Math.round(bw - 8), 3);
      }
      for (let wy = top + 8; wy < H * 2 - 10; wy += 9) {
        for (let wx = x + 4; wx < x + bw - 4; wx += 8) {
          if (api.rng.chance(0.22)) {
            g.fillStyle = alpha(api.rng.chance(0.6) ? PAL.cyan : PAL.yellow, 0.3);
            g.fillRect(Math.round(wx), Math.round(wy), 3, 4);
          }
        }
      }
      x += bw + api.rng.range(6, 26);
    }
    return c;
  }

  /* ------------------------------------------------------ generation */

  /** Widest gap the runner can actually clear right now, with a safety margin. */
  function reachable(rise, spd) {
    return spd * airTime(clamp(rise, -180, MAX_RISE));
  }

  function addPlatform() {
    const prev = plats[plats.length - 1];
    // Difficulty 0..1 drives gap width, deck variety and obstacle density.
    const diff = clamp((speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN), 0, 1);
    const spd = Math.min(SPEED_MAX, speed + 18); // the gap is crossed slightly later

    let y = prev.y + api.rng.range(-MAX_RISE, 46);
    y = clamp(y, DECK_HI, DECK_LO);
    const rise = prev.y - y;

    const lo = 0.30 + diff * 0.10;
    const hi = 0.46 + diff * 0.16;
    const gap = clamp(reachable(rise, spd) * api.rng.range(lo, hi), 30, 210);

    const w = api.rng.range(210 - diff * 80, 320 - diff * 110);
    const p = { x: prev.x + prev.w + gap, w, y };
    plats.push(p);

    dressPlatform(p, diff);
    scatterShards(p, prev, gap);
  }

  /**
   * Populate a freshly minted deck with hazards.
   *
   * Two solvability rules are enforced here, not left to luck:
   *   1. The first 70px of a deck stays clear (and 110px before any sign) so
   *      there is always room to land and read what is coming.
   *   2. A slide-under sign may never sit inside the arc of the jump you just
   *      made over a crate — that combination is unavoidable, so the spacing
   *      after a jump-over hazard is at least one full jump long.
   */
  function dressPlatform(p, diff) {
    const EXIT = 48;                        // room to set up the jump-out
    const jumpArc = SPEED_MAX * airTime(0); // worst-case airborne distance
    const slideArc = SPEED_MAX * SLIDE_TIME * 0.65; // shortest committed slide
    let cursor = p.x + 70;
    let lastKind = null;
    let lastEnd = -Infinity;
    const density = 0.42 + diff * 0.42;

    while (cursor < p.x + p.w - EXIT) {
      if (!api.rng.chance(density)) {
        cursor += api.rng.range(60, 130);
        continue;
      }
      let kind = api.rng.chance(0.24 + diff * 0.16)
        ? 'sign'
        : (api.rng.chance(0.55) ? 'crate' : 'duct');

      // A sign inside the arc of the jump you just made is unavoidable, and a
      // crate inside a committed slide is equally unfair — demote or skip.
      if (kind === 'sign' && (cursor < p.x + 110 || (lastKind && lastKind !== 'sign' && cursor < lastEnd + jumpArc))) {
        kind = 'crate';
      }
      if (kind !== 'sign' && lastKind === 'sign' && cursor < lastEnd + slideArc) {
        cursor = lastEnd + slideArc;
        continue;
      }
      const o = OBSTACLES[kind];
      if (cursor + o.w > p.x + p.w - EXIT) break;

      obstacles.push({
        x: cursor,
        y: kind === 'sign' ? p.y - 26 - o.h : p.y - o.h,
        w: o.w,
        h: o.h,
        kind,
        deck: p.y,
        seed: api.rng.int(0, 999),
      });
      lastKind = kind;
      lastEnd = cursor + o.w;
      // Never chain two hazards closer than a comfortable stride.
      cursor += o.w + api.rng.range(86 - diff * 22, 170 - diff * 50);
    }
  }

  /** Shards ride the natural jump arc across a gap, or float above the deck. */
  function scatterShards(p, prev, gap) {
    if (gap > 60 && api.rng.chance(0.8)) {
      const n = 3 + api.rng.int(0, 2);
      const x0 = prev.x + prev.w;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const arc = Math.sin(t * Math.PI) * 46;
        items.push({
          x: x0 + gap * t,
          y: (prev.y + (p.y - prev.y) * t) - 26 - arc,
          taken: false,
          ph: api.rng.range(0, TAU),
        });
      }
    }
    if (api.rng.chance(0.55)) {
      const n = 2 + api.rng.int(0, 3);
      const x0 = p.x + api.rng.range(60, Math.max(70, p.w - 120));
      for (let i = 0; i < n; i++) {
        items.push({ x: x0 + i * 22, y: p.y - 30 - api.rng.range(0, 34), taken: false, ph: api.rng.range(0, TAU) });
      }
    }
  }

  /** Keep ~1.5 screens of world in front of the camera and drop what's behind. */
  function extendWorld() {
    while (plats[plats.length - 1].x + plats[plats.length - 1].w < camX + api.w + 320) addPlatform();
    const cut = camX - 120;
    while (plats.length > 2 && plats[0].x + plats[0].w < cut) plats.shift();
    while (obstacles.length && obstacles[0].x + obstacles[0].w < cut) obstacles.shift();
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].x < cut) items.splice(i, 1);
    }
  }

  /* ----------------------------------------------------------- player */

  function deckUnder(x) {
    for (const p of plats) {
      if (x >= p.x && x <= p.x + p.w) return p;
    }
    return null;
  }

  function playerRect() {
    const hgt = sliding ? SLIDE_H : P_H;
    const wid = sliding ? P_W + 9 : P_W;
    return { x: px() - wid / 2, y: py - hgt, w: wid, h: hgt };
  }

  function doJump() {
    if (jumpsLeft <= 0) return;
    const dbl = !onGround && coyote <= 0;
    jumpsLeft--;
    pvy = -JUMP_V * (dbl ? 0.92 : 1);
    onGround = false;
    coyote = 0;
    buffer = 0;
    holding = true;
    if (sliding) endSlide();
    api.sfx(dbl ? 'doublejump' : 'jump');
    api.particles.burst(px(), py, dbl ? 10 : 6, {
      speed: dbl ? 110 : 70, life: 0.32, size: 2.2, shape: 'spark',
      color: dbl ? [PAL.magenta, PAL.white] : [PAL.cyan, PAL.white], glow: 8, drag: 3,
    });
  }

  function startSlide() {
    if (sliding) return;
    sliding = true;
    slideT = SLIDE_TIME;
    api.sfx('thrust', { vol: 0.7 });
    if (onGround) {
      api.particles.burst(px() - 6, py - 2, 8, {
        speed: 90, life: 0.4, size: 2.4, dir: Math.PI, spread: 1.1,
        color: [PAL.cyan, PAL.dim], glow: 6, drag: 2.6,
      });
    }
  }

  function endSlide() {
    sliding = false;
    slideT = 0;
  }

  function land(surface) {
    const impact = pvy;
    py = surface;
    pvy = 0;
    onGround = true;
    jumpsLeft = 2;
    coyote = COYOTE;
    if (impact > 120) {
      landFlash = 0.18;
      api.sfx('land', { vol: clamp(impact / 700, 0.3, 1) });
      api.particles.burst(px(), py, Math.min(12, 4 + (impact / 90) | 0), {
        speed: 90, life: 0.42, size: 2.6, dir: -Math.PI / 2, spread: 2.6,
        color: [PAL.dim, PAL.white, PAL.cyan], glow: 5, drag: 3.4, gravity: 220,
      });
    }
  }

  function die(cause) {
    if (!alive) return;
    api.hitStop(0.08);
    api.flash(PAL.red, 0.4);
    alive = false;
    api.shakeScreen(13, 5);
    api.sfx('explosion');
    api.vibrate(140);
    api.particles.burst(px(), py - P_H / 2, 26, {
      speed: 210, life: 0.8, size: 3, color: [PAL.cyan, PAL.white, PAL.magenta],
      glow: 10, drag: 1.9, gravity: 240,
    });
    api.gameOver({
      message: cause,
      stats: {
        DISTANCE: meters + 'M',
        SHARDS: shards,
        'TOP SPEED': Math.round(speed) + ' PX/S',
      },
    });
  }

  /* ----------------------------------------------------------- render */

  function drawParallax(ctx) {
    const W = api.w;
    const H = api.h;

    // Sky + a low horizon smog band.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#070a18');
    g.addColorStop(0.55, '#131033');
    g.addColorStop(1, '#2c1140');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // A fat moon that barely creeps along.
    const mx = W * 0.74 - ((camX * 0.02) % (W * 2));
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = alpha(PAL.pink, 0.5);
    ctx.beginPath();
    ctx.arc(mx, H * 0.24, 26, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (bgTile) {
      // far + mid layers, each wrapped twice so the seam is always covered
      const layer = (rate, sy) => {
        let off = -(((camX * rate) % W) + W) % W;
        ctx.drawImage(bgTile, 0, sy, W, H, off, 0, W, H);
        ctx.drawImage(bgTile, 0, sy, W, H, off + W, 0, W, H);
      };
      layer(0.12, 0);
      layer(0.34, H);
    }

    // Near clutter: chunky roof boxes + antennas, still behind the play field.
    const step = 74;
    const rate = 0.62;
    const first = Math.floor((camX * rate) / step) - 1;
    ctx.save();
    ctx.fillStyle = '#0d1526';
    for (let i = first; i < first + Math.ceil(W / step) + 3; i++) {
      const sx = i * step - camX * rate;
      const bw = 40 + h01(i) * 34;
      const bh = 40 + h01(i + 501) * 62;
      ctx.fillRect(sx, H - bh, bw, bh);
      ctx.fillStyle = alpha(PAL.blue, 0.22);
      ctx.fillRect(sx, H - bh, bw, 1);
      if (h01(i + 88) > 0.6) ctx.fillRect(sx + bw * 0.5, H - bh - 18, 1, 18);
      ctx.fillStyle = '#0d1526';
    }
    ctx.restore();
  }

  function drawSpeedLines(ctx) {
    const t = clamp((speed - 230) / (SPEED_MAX - 230), 0, 1);
    if (t <= 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = alpha(PAL.cyan, 0.06 + t * 0.22);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 14; i++) {
      const y = (h01(i + 3) * api.h + api.time * (60 + h01(i) * 260)) % api.h;
      const len = 30 + h01(i + 40) * (70 + t * 120);
      const x = (api.w + 40) - ((api.time * (420 + h01(i + 11) * 620) + i * 137) % (api.w + 160));
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawPlatform(ctx, p) {
    const x = p.x - camX;
    const H = api.h;
    // Deck body.
    ctx.fillStyle = '#101b30';
    ctx.fillRect(x, p.y, p.w, H - p.y);
    // Concrete striping so motion is readable at speed.
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#0a1220';
    for (let sx = Math.ceil((p.x) / 26) * 26; sx < p.x + p.w; sx += 26) {
      ctx.fillRect(sx - camX, p.y + 6, 2, H - p.y);
    }
    ctx.restore();
    // Glowing lip.
    ctx.save();
    ctx.shadowColor = PAL.cyan;
    ctx.shadowBlur = 10;
    ctx.fillStyle = PAL.cyan;
    ctx.fillRect(x, p.y - 2, p.w, 3);
    ctx.restore();
    // Edge markers make the gap boundaries unmistakable.
    ctx.fillStyle = alpha(PAL.magenta, 0.85);
    ctx.fillRect(x, p.y, 2, 10);
    ctx.fillRect(x + p.w - 2, p.y, 2, 10);
  }

  function drawObstacle(ctx, o) {
    const x = o.x - camX;
    if (o.kind === 'sign') {
      // Support strut running up out of frame, then the sign box itself.
      ctx.fillStyle = '#1b2540';
      ctx.fillRect(x + o.w / 2 - 2, -10, 4, o.h - 30);
      const sy = o.y + o.h - 34;
      ctx.fillStyle = '#12172b';
      ctx.fillRect(x, sy, o.w, 34);
      ctx.save();
      ctx.shadowColor = PAL.magenta;
      ctx.shadowBlur = 12;
      ctx.strokeStyle = PAL.magenta;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, sy + 1, o.w - 2, 32);
      ctx.fillStyle = alpha(PAL.magenta, 0.55 + 0.35 * Math.sin(api.time * 9 + o.seed));
      ctx.fillRect(x + 5, sy + 8, o.w - 10, 4);
      ctx.fillRect(x + 5, sy + 18, o.w - 14, 4);
      ctx.restore();
      // "duck here" hint bar along the clearance line.
      ctx.fillStyle = alpha(PAL.yellow, 0.35);
      ctx.fillRect(x - 2, o.y + o.h, o.w + 4, 1);
    } else if (o.kind === 'duct') {
      ctx.fillStyle = '#16243f';
      ctx.fillRect(x, o.y, o.w, o.h);
      ctx.save();
      ctx.shadowColor = PAL.blue;
      ctx.shadowBlur = 8;
      ctx.strokeStyle = PAL.blue;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, o.y + 0.5, o.w - 1, o.h - 1);
      ctx.restore();
      ctx.fillStyle = alpha(PAL.blue, 0.4);
      for (let i = 4; i < o.w - 3; i += 7) ctx.fillRect(x + i, o.y + 3, 2, o.h - 6);
    } else {
      ctx.fillStyle = '#20180f';
      ctx.fillRect(x, o.y, o.w, o.h);
      ctx.save();
      ctx.shadowColor = PAL.orange;
      ctx.shadowBlur = 9;
      ctx.strokeStyle = PAL.orange;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 1, o.y + 1, o.w - 2, o.h - 2);
      ctx.beginPath();
      ctx.moveTo(x + 2, o.y + 2);
      ctx.lineTo(x + o.w - 2, o.y + o.h - 2);
      ctx.moveTo(x + o.w - 2, o.y + 2);
      ctx.lineTo(x + 2, o.y + o.h - 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawRunner(ctx) {
    const x = RUN_X;
    ctx.save();
    ctx.shadowColor = PAL.cyan;
    ctx.shadowBlur = 14;

    if (sliding) {
      ctx.fillStyle = PAL.white;
      ctx.fillRect(x - 13, py - SLIDE_H, 24, SLIDE_H - 2);
      ctx.fillStyle = PAL.cyan;
      ctx.fillRect(x + 7, py - SLIDE_H - 1, 8, 7);
      ctx.fillStyle = alpha(PAL.magenta, 0.8);
      ctx.fillRect(x - 20, py - 5, 9, 3);
    } else {
      // Torso + head.
      ctx.fillStyle = PAL.white;
      ctx.fillRect(x - P_W / 2, py - P_H + 8, P_W, P_H - 14);
      ctx.fillStyle = PAL.cyan;
      ctx.fillRect(x - 5, py - P_H, 11, 9);
      // Legs: run cycle on the ground, tucked in the air.
      ctx.fillStyle = PAL.magenta;
      if (onGround) {
        const a = Math.sin(runPhase) * 7;
        const b = Math.sin(runPhase + Math.PI) * 7;
        ctx.fillRect(x - 6 + a, py - 7, 5, 7);
        ctx.fillRect(x + 1 + b, py - 7, 5, 7);
        ctx.fillStyle = alpha(PAL.cyan, 0.7);
        ctx.fillRect(x - 10 - Math.abs(a), py - P_H + 12, 5, 3);
      } else {
        const tuck = pvy < 0 ? 4 : 0;
        ctx.fillRect(x - 7, py - 8 + tuck, 6, 6);
        ctx.fillRect(x + 2, py - 10 + tuck, 6, 6);
      }
    }
    ctx.restore();
  }

  /* --------------------------------------------------------- lifecycle */

  return {
    init() {
      camX = 0;
      speed = SPEED_MIN;
      distance = 0;
      meters = 0;
      shards = 0;
      alive = true;

      plats = [{ x: -60, w: 460, y: 186 }];
      obstacles = [];
      items = [];
      trail = [];
      statusTimer = 0;

      py = plats[0].y;
      pvy = 0;
      onGround = true;
      coyote = COYOTE;
      buffer = 0;
      jumpsLeft = 2;
      holding = false;
      sliding = false;
      slideT = 0;
      runPhase = 0;
      landFlash = 0;

      bgTile = buildBackdrop();

      // Two gentle warm-up decks before the generator gets opinionated.
      for (let i = 0; i < 2; i++) {
        const prev = plats[plats.length - 1];
        plats.push({ x: prev.x + prev.w + 70, w: 300, y: prev.y - 8 });
      }
      extendWorld();
      api.setStatus({ DIST: '0M', SHARDS: 0, SPEED: Math.round(speed) });
    },

    update(dt) {
      if (!alive) return;

      /* --- speed curve: fast early gains, asymptotic later --- */
      speed = Math.min(SPEED_MAX, speed + SPEED_RAMP * dt * (1.6 - speed / SPEED_MAX));
      camX += speed * dt;
      distance += speed * dt;
      runPhase += dt * speed * 0.075;
      if (landFlash > 0) landFlash -= dt;

      /* --- timers --- */
      if (buffer > 0) buffer -= dt;
      if (coyote > 0) {
        coyote -= dt;
        // Stepping off a ledge without jumping burns the ground jump once the
        // grace window closes — you keep the air jump, not both.
        if (coyote <= 0 && !onGround && jumpsLeft > 1) jumpsLeft = 1;
      }

      /* --- held-button reads (keyboard hold + touch button hold) --- */
      const jumpHeld = api.input.isDown('a') || api.input.isDown('up');
      const downHeld = api.input.isDown('down');
      if (!jumpHeld) holding = false;
      if (downHeld && !sliding && onGround) startSlide();

      if (sliding) {
        slideT -= dt;
        // Let go early to stand back up, but never below the committed minimum.
        if (slideT <= 0 && (!downHeld || !onGround)) endSlide();
        else if (slideT <= SLIDE_TIME * 0.35 && !downHeld) endSlide();
      }

      /* --- buffered jump fires the moment it becomes legal --- */
      if (buffer > 0 && (onGround || coyote > 0 || jumpsLeft > 0)) doJump();

      /* --- gravity, with a shorter arc when the button is released --- */
      if (!holding && pvy < -CUT_V) pvy = -CUT_V;
      const g = GRAV * (pvy > 0 ? 1.22 : 1); // snappier fall
      pvy += g * dt;
      const prevFeet = py;
      py += pvy * dt;

      /* --- landing --- */
      const deck = deckUnder(px());
      const wasGrounded = onGround;
      onGround = false;
      if (deck && pvy >= 0 && prevFeet <= deck.y + 1 && py >= deck.y) {
        land(deck.y);
      } else if (deck && Math.abs(py - deck.y) < 0.5 && pvy >= 0) {
        land(deck.y);
      } else if (wasGrounded && !deck) {
        coyote = COYOTE; // walked off a ledge — grace window opens
      }

      /* --- gap fall --- */
      if (py > api.h + 40) {
        die('FELL INTO THE VOID');
        return;
      }

      /* --- obstacles --- */
      const rect = playerRect();
      for (const o of obstacles) {
        if (o.x - camX > api.w) break;
        if (o.x + o.w < camX + RUN_X - 40) continue;
        if (aabb(rect, o)) {
          die(o.kind === 'sign' ? 'CLOTHESLINED BY NEON' : 'SLAMMED INTO A ' + o.kind.toUpperCase());
          return;
        }
      }

      /* --- shards --- */
      const cx = px();
      const cy = py - (sliding ? SLIDE_H : P_H) / 2;
      for (const s of items) {
        if (s.taken) continue;
        s.ph += dt * 3;
        if (Math.abs(s.x - cx) < 14 && Math.abs(s.y - cy) < 20) {
          s.taken = true;
          shards++;
          api.addScore(25);
          api.sfx('coin', { detune: clamp(shards * 0.25, 0, 12) });
          api.particles.burst(s.x - camX, s.y, 8, {
            speed: 90, life: 0.4, size: 2.2, color: [PAL.yellow, PAL.white], glow: 10, drag: 3,
          });
        }
      }

      /* --- world streaming + distance score --- */
      extendWorld();
      const m = Math.floor(distance / 12);
      if (m > meters) {
        api.addScore(m - meters);
        meters = m;
      }

      /* --- motion ribbon --- */
      trail.push({ x: RUN_X, y: py - (sliding ? SLIDE_H : P_H) * 0.5, t: 0.26 });
      if (trail.length > 10) trail.shift();
      for (let i = trail.length - 1; i >= 0; i--) {
        trail[i].t -= dt;
        trail[i].x -= speed * dt;
        if (trail[i].t <= 0) trail.splice(i, 1);
      }

      /* --- HUD (throttled: every write touches the DOM) --- */
      statusTimer -= dt;
      if (statusTimer <= 0) {
        statusTimer = 0.25;
        api.setStatus({ DIST: meters + 'M', SHARDS: shards, SPEED: Math.round(speed) });
      }
    },

    handleInput(e) {
      if (e.type === 'press') {
        if (e.action === 'a' || e.action === 'up') {
          buffer = BUFFER;
          holding = true;
          if (onGround || coyote > 0 || jumpsLeft > 0) doJump();
        } else if (e.action === 'down') {
          startSlide();
        }
      } else if (e.type === 'release') {
        if (e.action === 'a' || e.action === 'up') holding = false;
      } else if (e.type === 'pointerdown') {
        // Bare pointer taps jump too, so a mouse-only player is covered.
        buffer = BUFFER;
        holding = true;
        if (onGround || coyote > 0 || jumpsLeft > 0) doJump();
      } else if (e.type === 'pointerup') {
        holding = false;
      }
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;

      drawParallax(ctx);
      drawSpeedLines(ctx);

      for (const p of plats) {
        if (p.x - camX > W || p.x + p.w - camX < 0) continue;
        drawPlatform(ctx, p);
      }
      for (const o of obstacles) {
        if (o.x - camX > W || o.x + o.w - camX < 0) continue;
        drawObstacle(ctx, o);
      }

      // Data shards.
      ctx.save();
      ctx.shadowColor = PAL.yellow;
      ctx.shadowBlur = 10;
      ctx.fillStyle = PAL.yellow;
      for (const s of items) {
        if (s.taken) continue;
        const x = s.x - camX;
        if (x < -20 || x > W + 20) continue;
        const r = 5 + Math.sin(s.ph) * 1.4;
        ctx.beginPath();
        ctx.moveTo(x, s.y - r);
        ctx.lineTo(x + r * 0.7, s.y);
        ctx.lineTo(x, s.y + r);
        ctx.lineTo(x - r * 0.7, s.y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      // Motion ribbon behind the runner.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const t of trail) {
        ctx.globalAlpha = clamp(t.t / 0.26, 0, 1) * 0.35;
        ctx.fillStyle = PAL.cyan;
        ctx.fillRect(t.x - 5, t.y - 4, 10, 8);
      }
      ctx.restore();

      if (alive) drawRunner(ctx);

      // Landing shockwave ring.
      if (landFlash > 0) {
        const k = 1 - landFlash / 0.18;
        ctx.save();
        ctx.globalAlpha = (1 - k) * 0.7;
        ctx.strokeStyle = PAL.cyan;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(RUN_X, py, 8 + k * 30, 3 + k * 8, 0, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }

      api.particles.render(ctx);

      // Vignette + scanlines tie it back to the cabinet look.
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#000';
      for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
      ctx.restore();

      // On-screen speedometer bar.
      const t = clamp((speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN), 0, 1);
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = alpha(PAL.dim, 0.5);
      ctx.fillRect(W - 92, 10, 82, 5);
      ctx.fillStyle = mix(PAL.cyan, PAL.magenta, t);
      ctx.shadowColor = mix(PAL.cyan, PAL.magenta, t);
      ctx.shadowBlur = 8;
      ctx.fillRect(W - 92, 10, 82 * t, 5);
      ctx.restore();
      text(ctx, 'VELOCITY', W - 92, 18, { size: 7, color: PAL.dim });
      text(ctx, meters + 'M', 10, 10, { size: 12, color: PAL.cyan, glow: 8 });
      text(ctx, '◆ ' + shards, 10, 24, { size: 9, color: PAL.yellow });

      if (jumpsLeft === 2 && onGround) {
        text(ctx, api.isTouch ? 'TAP JUMP · HOLD SLIDE' : 'SPACE = JUMP  ·  DOWN = SLIDE',
          W / 2, H - 16, { size: 8, color: alpha(PAL.dim, 0.8), align: 'center' });
      }
    },

    destroy() {
      bgTile = null;
      trail = null;
    },
  };
}
