/**
 * 19 — GRAVITY FLIP RUNNER
 * An endless neon tunnel with exactly one control: invert gravity. There is no
 * jump. You fall to the ceiling, or you fall to the floor, and the half second
 * in between is the entire game.
 *
 * The course generator is the interesting part: every pattern is tagged with
 * the surface it forces you onto, and no pattern is committed until the lane
 * along that surface has been verified clear. Surface changes are separated by
 * a transition long enough for a full ceiling-to-floor traversal at the current
 * speed, so the tunnel is always survivable no matter how fast it gets.
 */

import { PAL, TAU, alpha, clamp, damp, roundRect, text } from '../core/fx.js';

/* --------------------------------------------------------------- geometry */

const VIEW_W = 480;
const VIEW_H = 270;
const TUN_TOP = 44;           // inner face of the ceiling
const TUN_BOT = 240;          // inner face of the floor
const WALL_TH = 20;           // how far the wall plating extends outwards
const PW = 15;                // player width
const PH = 18;                // player height
const PLAYER_X = 116;         // fixed screen column the runner occupies

const GRAV = 2050;
const V0 = 205;               // starting scroll speed, px/s
const VMAX = 430;
const VRAMP = 0.028;          // speed gained per pixel travelled

/** Time for a full surface-to-surface fall from rest — the unit of level design. */
const FLIP_TIME = Math.sqrt((2 * (TUN_BOT - TUN_TOP - PH)) / GRAV);

const TRAIL_N = 12;           // ghost samples kept behind the runner

export const meta = {
  id: 'gravityflip',
  title: 'GRAVITY FLIP RUNNER',
  short: 'GRAV FLIP',
  category: 'ACTION',
  desc: 'One button, no jump: invert gravity to fall between the floor and the '
      + 'ceiling of an endless neon tunnel that keeps getting faster.',
  accent: PAL.violet,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'SPACE / A — flip gravity',
    'CLICK / TAP — flip gravity',
    'P — pause',
  ],
  touch: { buttons: [{ id: 'a', label: 'FLIP', wide: true }] },
  art(ctx, w, h, accent) {
    ctx.save();
    ctx.fillStyle = '#06070f';
    ctx.fillRect(0, 0, w, h);
    // Perspective tunnel lines.
    ctx.strokeStyle = alpha(accent, 0.28);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      ctx.moveTo(0, 26 + t * 128);
      ctx.lineTo(w, 26 + t * 128);
    }
    for (let i = 0; i <= 8; i++) {
      const x = (i / 8) * w;
      ctx.moveTo(x, 26);
      ctx.lineTo(x, 154);
    }
    ctx.stroke();
    // Ceiling and floor plating.
    ctx.fillStyle = '#141a2e';
    ctx.fillRect(0, 0, w, 26);
    ctx.fillRect(0, 154, w, h - 154);
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 12;
    ctx.fillRect(0, 24, w, 2);
    ctx.fillRect(0, 154, w, 2);
    // Ceiling spikes.
    ctx.fillStyle = PAL.red;
    ctx.shadowColor = PAL.red;
    for (let i = 0; i < 4; i++) {
      const x = 132 + i * 22;
      ctx.beginPath();
      ctx.moveTo(x, 26);
      ctx.lineTo(x + 11, 26);
      ctx.lineTo(x + 5.5, 46);
      ctx.closePath();
      ctx.fill();
    }
    // Ghost trail + runner on the floor.
    for (let i = 0; i < 4; i++) {
      ctx.globalAlpha = 0.12 + i * 0.12;
      ctx.fillStyle = PAL.cyan;
      ctx.shadowColor = PAL.cyan;
      roundRect(ctx, 26 + i * 16, 132, 14, 20, 4);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = PAL.white;
    roundRect(ctx, 90, 132, 15, 21, 4);
    ctx.fill();
    // Energy orbs arcing across.
    ctx.shadowColor = PAL.yellow;
    ctx.fillStyle = PAL.yellow;
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      ctx.beginPath();
      ctx.arc(126 + t * 90, 128 - Math.sin(t * Math.PI) * 62, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  },
};

export function create(api) {
  const rng = api.rng;

  let bgTile, bgW;              // pre-rendered tunnel wallpaper
  let obs, orbs;                // live obstacles / collectibles, world coords
  let genX, safeSurface;        // generator cursor + the surface it guarantees
  let dist, speed, py, vy, gsign, grounded;
  let trail, trailT;
  let camY, camRoll, flash, orbCount, flips;
  let dead, deadT, deathMsg, statusT, scoreT, milestone;

  const surfaceY = (s) => (s === 'floor' ? TUN_BOT : TUN_TOP);
  /** Top edge of the body-height lane hugging a surface. */
  const laneTop = (s) => (s === 'floor' ? TUN_BOT - PH : TUN_TOP);
  const other = (s) => (s === 'floor' ? 'ceil' : 'floor');
  /** World x -> screen x. */
  const sx = (wx) => PLAYER_X + (wx - dist);

  /* ------------------------------------------------------------ wallpaper */

  /**
   * The scrolling neon backdrop is a single tileable strip rendered once. Two
   * blits per frame beat re-stroking sixty gradient lines.
   */
  function buildBackdrop() {
    bgW = 240;
    const c = document.createElement('canvas');
    c.width = bgW;
    c.height = VIEW_H;
    const g = c.getContext('2d');

    const bg = g.createLinearGradient(0, 0, 0, VIEW_H);
    bg.addColorStop(0, '#090a18');
    bg.addColorStop(0.5, '#12082a');
    bg.addColorStop(1, '#090a18');
    g.fillStyle = bg;
    g.fillRect(0, 0, bgW, VIEW_H);

    // Horizontal perspective rails, densest toward the tunnel centre line.
    const mid = (TUN_TOP + TUN_BOT) / 2;
    g.lineWidth = 1;
    for (let i = -6; i <= 6; i++) {
      const t = i / 6;
      const y = mid + Math.sign(t) * (t * t) * (TUN_BOT - mid) * 1.05;
      g.strokeStyle = alpha(PAL.violet, 0.06 + (1 - Math.abs(t)) * 0.13);
      g.beginPath();
      g.moveTo(0, y + 0.5);
      g.lineTo(bgW, y + 0.5);
      g.stroke();
    }
    // Vertical pylons, kept clear of the tile seam so it wraps invisibly.
    for (const bx of [24, 84, 144, 204]) {
      const vg = g.createLinearGradient(0, TUN_TOP, 0, TUN_BOT);
      vg.addColorStop(0, alpha(PAL.magenta, 0.02));
      vg.addColorStop(0.5, alpha(PAL.magenta, 0.16));
      vg.addColorStop(1, alpha(PAL.magenta, 0.02));
      g.fillStyle = vg;
      g.fillRect(bx, TUN_TOP - 6, 3, TUN_BOT - TUN_TOP + 12);
      g.fillStyle = alpha(PAL.cyan, 0.1);
      g.fillRect(bx + 5, mid - 22, 1, 44);
    }
    // Faint star dust in the void beyond the plating.
    g.fillStyle = alpha(PAL.white, 0.25);
    for (let i = 0; i < 40; i++) {
      const x = rng.range(0, bgW);
      const y = rng.chance(0.5) ? rng.range(0, TUN_TOP - 14) : rng.range(TUN_BOT + 14, VIEW_H);
      g.fillRect(x, y, 1, 1);
    }
    return c;
  }

  /* ------------------------------------------------------------ generator */

  /**
   * True when the body-height lane hugging `surface` is completely free over
   * [x0, x1] — no spikes, no blocks, no laser sweep reaching into it, and no
   * hole in the plating to fall through. Every pattern is checked against this
   * before it is allowed to stay in the world.
   */
  function laneClear(x0, x1, surface) {
    const top = laneTop(surface);
    const bot = top + PH;
    for (const o of obs) {
      if (o.x + o.w <= x0 || o.x >= x1) continue;
      if (o.type === 'gap') {
        if (o.surface === surface) return false;
        continue;
      }
      if (o.type === 'laser') {
        if (o.yMax + o.h > top && o.yMin < bot) return false;
        continue;
      }
      if (o.y < bot && o.y + o.h > top) return false;
    }
    return true;
  }

  /** Nothing at all may sit in a transition span — you cross the whole tunnel. */
  function columnClear(x0, x1) {
    for (const o of obs) if (o.x + o.w > x0 && o.x < x1) return false;
    return true;
  }

  function addOrb(x, y) {
    orbs.push({ x, y, r: 4.5, got: false, bob: rng.range(0, TAU) });
  }

  /** Orbs strung along a flat run on the safe surface. */
  function orbRun(x0, x1, surface) {
    const y = surface === 'floor' ? TUN_BOT - PH / 2 - 8 : TUN_TOP + PH / 2 + 8;
    for (let x = x0 + 24; x < x1 - 12; x += 34) addOrb(x, y);
  }

  /**
   * Orbs following the actual flip parabola, so the greedy line and the
   * survival line are the same line.
   */
  function orbArc(x0, from, v) {
    const dir = from === 'floor' ? -1 : 1;   // travelling up or down
    const y0 = from === 'floor' ? TUN_BOT - PH / 2 : TUN_TOP + PH / 2;
    for (let i = 1; i <= 5; i++) {
      const t = (i / 6) * FLIP_TIME;
      const y = y0 + dir * 0.5 * GRAV * t * t;
      addOrb(x0 + v * t, clamp(y, TUN_TOP + 8, TUN_BOT - 8));
    }
  }

  /* -- patterns. Each threatens only `danger`, never the safe lane. -------- */

  function patSpikes(x0, len, danger) {
    const h = 22;
    obs.push({
      type: 'spike', surface: danger, x: x0, w: len, h,
      y: danger === 'floor' ? TUN_BOT - h : TUN_TOP,
      teeth: Math.max(2, Math.round(len / 18)),
    });
    return len;
  }

  function patGap(x0, len, danger) {
    obs.push({ type: 'gap', surface: danger, x: x0, w: len, h: 0, y: 0 });
    return len;
  }

  function patBlock(x0, len, danger) {
    const h = Math.round((TUN_BOT - TUN_TOP - PH) * 0.55);
    obs.push({
      type: 'block', surface: danger, x: x0, w: len, h,
      y: danger === 'floor' ? TUN_BOT - h : TUN_TOP,
    });
    return len;
  }

  /**
   * A sweeping bar confined to the dangerous half of the tunnel: it never
   * reaches into the safe lane, so hugging the right surface always works.
   */
  function patLaser(x0, len, danger) {
    const h = 5;
    const margin = 26;              // clearance kept above the safe lane
    // The sweep spans the dangerous half only, stopping well short of the lane
    // the runner is meant to be hugging.
    const yMin = danger === 'floor' ? TUN_TOP + PH + margin : TUN_TOP + 4;
    const yMax = danger === 'floor' ? TUN_BOT - h - 2 : TUN_BOT - PH - margin - h;
    obs.push({
      type: 'laser', surface: danger, x: x0, w: len, h,
      y: yMin, yMin, yMax,
      phase: rng.range(0, TAU),
      rate: rng.range(1.6, 2.8),
    });
    return len;
  }

  /** Emit the next stretch of tunnel just beyond the generator cursor. */
  function generateAhead() {
    const horizon = dist + VIEW_W * 2;
    let guard = 24;
    while (genX < horizon && guard-- > 0) {
      // A surface change costs a clear run long enough to fall across.
      const crossing = speed * FLIP_TIME;
      const wantFlip = rng.chance(0.55);
      if (wantFlip) {
        const run = crossing * 1.3 + 26;
        if (columnClear(genX, genX + run)) {
          orbArc(genX + crossing * 0.15, safeSurface, speed);
          genX += run;
          safeSurface = other(safeSurface);
        }
      } else {
        genX += rng.range(30, 70);
      }

      const danger = other(safeSurface);
      const len = rng.range(80, 150 + Math.min(120, dist * 0.006));
      const start = genX;
      const before = obs.length;

      const roll = rng.next();
      if (roll < 0.34) patSpikes(start, len, danger);
      else if (roll < 0.56) patGap(start, Math.min(len, crossing * 0.9), danger);
      else if (roll < 0.78) patLaser(start, len, danger);
      else patBlock(start, Math.min(len, 90), danger);

      // Verify, and roll the pattern back if it ever threatens the safe lane.
      if (!laneClear(start - 4, start + len + 4, safeSurface)) {
        obs.length = before;
        genX += 60;
        continue;
      }

      if (rng.chance(0.75)) orbRun(start, start + len, safeSurface);
      genX = start + len;
    }
  }

  /* -------------------------------------------------------------- physics */

  /** Is the plating solid under (or over) this world x? */
  function solidAt(wx, surface) {
    for (const o of obs) {
      if (o.type !== 'gap' || o.surface !== surface) continue;
      if (wx > o.x && wx < o.x + o.w) return false;
    }
    return true;
  }

  function flip() {
    if (dead) return;
    gsign = -gsign;
    grounded = false;
    flips++;
    flash = 1;
    api.sfx('thrust', { vol: 0.4, detune: gsign < 0 ? 5 : -3 });
    api.vibrate(12);
    api.particles.burst(PLAYER_X + PW / 2, py + PH / 2, 10, {
      speed: 90, life: 0.4, size: 2.4, color: [PAL.violet, PAL.cyan, PAL.white],
      glow: 10, drag: 3, spread: Math.PI * 0.8, dir: gsign > 0 ? -Math.PI / 2 : Math.PI / 2,
    });
  }

  function die(reason) {
    if (dead) return;
    dead = true;
    deadT = 0;
    deathMsg = reason;
    api.sfx('explosion');
    api.shakeScreen(14, 4);
    api.vibrate(180);
    api.particles.burst(PLAYER_X + PW / 2, py + PH / 2, 30, {
      speed: 190, life: 0.9, size: 3, color: [PAL.violet, PAL.magenta, PAL.white],
      glow: 12, drag: 1.8,
    });
    api.gameOver({
      message: reason,
      stats: {
        DISTANCE: `${Math.floor(dist / 10)} M`,
        ORBS: orbCount,
        FLIPS: flips,
        SPEED: `${Math.round(speed)}`,
      },
    });
  }

  /** Player rect vs every live obstacle, in world coordinates. */
  function checkHits() {
    const x0 = dist;
    const x1 = dist + PW;
    const y0 = py;
    const y1 = py + PH;

    for (const o of obs) {
      if (o.x + o.w < x0 || o.x > x1) continue;
      if (o.type === 'gap') continue;
      let oy = o.y;
      if (o.type === 'laser') oy = laserY(o);
      if (oy < y1 && oy + o.h > y0) {
        die(o.type === 'laser' ? 'CUT DOWN BY A LASER'
          : o.type === 'block' ? 'SLAMMED INTO A BLOCK'
            : 'IMPALED ON SPIKES');
        return;
      }
    }

    for (const orb of orbs) {
      if (orb.got) continue;
      if (orb.x < x0 - 12 || orb.x > x1 + 12) continue;
      if (Math.abs(orb.y - (py + PH / 2)) > 14) continue;
      orb.got = true;
      orbCount++;
      api.sfx('coin', { detune: Math.min(12, orbCount * 0.3) });
      api.particles.burst(sx(orb.x), orb.y, 8, {
        speed: 80, life: 0.4, size: 2, color: [PAL.yellow, PAL.white], glow: 10, drag: 3,
      });
    }
  }

  const laserY = (o) => o.yMin + (o.yMax - o.yMin) * (0.5 + 0.5 * Math.sin(api.time * o.rate + o.phase));

  /* ----------------------------------------------------------------- draw */

  function drawWalls(ctx) {
    // Plating bands.
    ctx.fillStyle = '#141a2e';
    ctx.fillRect(0, TUN_TOP - WALL_TH, VIEW_W, WALL_TH);
    ctx.fillRect(0, TUN_BOT, VIEW_W, WALL_TH);
    ctx.fillStyle = '#1e2647';
    for (let x = -((dist * 1) % 32); x < VIEW_W; x += 32) {
      ctx.fillRect(x, TUN_TOP - WALL_TH, 2, WALL_TH);
      ctx.fillRect(x, TUN_BOT, 2, WALL_TH);
    }

    // Punch the holes out and let the void show through.
    for (const o of obs) {
      if (o.type !== 'gap') continue;
      const x = sx(o.x);
      if (x > VIEW_W || x + o.w < 0) continue;
      const y = o.surface === 'floor' ? TUN_BOT : TUN_TOP - WALL_TH;
      ctx.fillStyle = '#04050c';
      ctx.fillRect(x, y - 1, o.w, WALL_TH + 2);
      ctx.save();
      ctx.strokeStyle = alpha(PAL.red, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath();
      const edge = o.surface === 'floor' ? TUN_BOT : TUN_TOP;
      ctx.moveTo(x, edge);
      ctx.lineTo(x, edge + (o.surface === 'floor' ? 8 : -8));
      ctx.moveTo(x + o.w, edge);
      ctx.lineTo(x + o.w, edge + (o.surface === 'floor' ? 8 : -8));
      ctx.stroke();
      ctx.restore();
    }

    // Neon edge lines, dimmed across the holes.
    ctx.save();
    ctx.shadowColor = PAL.cyan;
    ctx.shadowBlur = 10;
    ctx.fillStyle = PAL.cyan;
    ctx.fillRect(0, TUN_BOT - 2, VIEW_W, 2);
    ctx.fillStyle = PAL.magenta;
    ctx.shadowColor = PAL.magenta;
    ctx.fillRect(0, TUN_TOP, VIEW_W, 2);
    ctx.restore();
    for (const o of obs) {
      if (o.type !== 'gap') continue;
      const x = sx(o.x);
      if (x > VIEW_W || x + o.w < 0) continue;
      ctx.fillStyle = '#04050c';
      ctx.fillRect(x, o.surface === 'floor' ? TUN_BOT - 2 : TUN_TOP, o.w, 2);
    }
  }

  /**
   * Drawn in batches by obstacle type rather than one save/shadow pair per
   * obstacle. A shadowed draw call costs a whole extra blur rasterisation, so
   * collapsing N of them into one path per type is worth several frames a
   * second once the tunnel gets busy.
   */
  function drawObstacles(ctx) {
    const visible = [];
    for (const o of obs) {
      const x = sx(o.x);
      if (x > VIEW_W + 10 || x + o.w < -10) continue;
      visible.push({ o, x });
    }
    if (!visible.length) return;

    /* Spikes — one path, one shadowed fill. */
    ctx.save();
    ctx.shadowColor = PAL.red;
    ctx.shadowBlur = 8;
    ctx.fillStyle = PAL.red;
    ctx.beginPath();
    let anySpike = false;
    for (const { o, x } of visible) {
      if (o.type !== 'spike') continue;
      anySpike = true;
      const up = o.surface === 'floor';
      const base = up ? TUN_BOT : TUN_TOP;
      const tipD = up ? -o.h : o.h;
      const step = o.w / o.teeth;
      for (let i = 0; i < o.teeth; i++) {
        const bx = x + i * step;
        ctx.moveTo(bx, base);
        ctx.lineTo(bx + step, base);
        ctx.lineTo(bx + step / 2, base + tipD);
        ctx.closePath();
      }
    }
    if (anySpike) ctx.fill();
    ctx.restore();

    /* Blocks — unshadowed fills, then one shadowed stroke for every outline. */
    ctx.fillStyle = '#2a3358';
    for (const { o, x } of visible) {
      if (o.type === 'block') ctx.fillRect(x, o.y, o.w, o.h);
    }
    ctx.save();
    ctx.strokeStyle = PAL.orange;
    ctx.lineWidth = 2;
    ctx.shadowColor = PAL.orange;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    let anyBlock = false;
    for (const { o, x } of visible) {
      if (o.type !== 'block') continue;
      anyBlock = true;
      ctx.rect(x + 1, o.y + 1, o.w - 2, o.h - 2);
    }
    if (anyBlock) ctx.stroke();
    ctx.restore();
    ctx.fillStyle = alpha(PAL.orange, 0.22);
    for (const { o, x } of visible) {
      if (o.type !== 'block') continue;
      for (let i = 8; i < o.h - 6; i += 12) ctx.fillRect(x + 4, o.y + i, o.w - 8, 3);
    }

    /* Lasers — one shadowed fill for the beams, then the unshadowed trim. */
    ctx.save();
    ctx.shadowColor = PAL.red;
    ctx.shadowBlur = 14;
    ctx.fillStyle = PAL.red;
    ctx.beginPath();
    let anyLaser = false;
    for (const { o, x } of visible) {
      if (o.type !== 'laser') continue;
      anyLaser = true;
      ctx.rect(x, laserY(o), o.w, o.h);
    }
    if (anyLaser) ctx.fill();
    ctx.restore();

    for (const { o, x } of visible) {
      if (o.type !== 'laser') continue;
      const ly = laserY(o);
      ctx.fillStyle = alpha(PAL.white, 0.8);
      ctx.fillRect(x, ly + o.h / 2 - 0.5, o.w, 1);
      // Emitter posts riding the sweep.
      ctx.fillStyle = '#3a4266';
      ctx.fillRect(x - 3, ly - 3, 4, o.h + 6);
      ctx.fillRect(x + o.w - 1, ly - 3, 4, o.h + 6);
    }
  }

  /** Batched like the obstacles: one shadowed fill for every orb body. */
  function drawOrbs(ctx) {
    const shown = [];
    for (const orb of orbs) {
      if (orb.got) continue;
      const x = sx(orb.x);
      if (x < -10 || x > VIEW_W + 10) continue;
      shown.push({ x, y: orb.y, r: orb.r + Math.sin(api.time * 5 + orb.bob) * 0.8 });
    }
    if (!shown.length) return;

    ctx.save();
    ctx.shadowColor = PAL.yellow;
    ctx.shadowBlur = 10;
    ctx.fillStyle = PAL.yellow;
    ctx.beginPath();
    for (const s of shown) {
      ctx.moveTo(s.x + s.r, s.y);
      ctx.arc(s.x, s.y, s.r, 0, TAU);
    }
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = alpha(PAL.white, 0.85);
    ctx.beginPath();
    for (const s of shown) {
      const hr = s.r * 0.4;
      ctx.moveTo(s.x - 1 + hr, s.y - 1);
      ctx.arc(s.x - 1, s.y - 1, hr, 0, TAU);
    }
    ctx.fill();
  }

  function drawRunner(ctx) {
    // Ghost trail: the last N sampled positions, fading and shrinking.
    ctx.save();
    for (let i = 0; i < trail.length; i++) {
      const t = trail[i];
      const k = (i + 1) / trail.length;
      const gx = PLAYER_X + (t.x - dist);
      if (gx < -20) continue;
      ctx.globalAlpha = 0.05 + k * 0.3;
      ctx.fillStyle = k > 0.7 ? PAL.cyan : PAL.violet;
      const shrink = (1 - k) * 3;
      roundRect(ctx, gx + shrink, t.y + shrink, PW - shrink * 2, PH - shrink * 2, 3);
      ctx.fill();
    }
    ctx.restore();

    // Motion streaks trailing off the runner.
    ctx.save();
    ctx.strokeStyle = alpha(PAL.cyan, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const sy = py + 3 + i * 4;
      const len = 16 + (i % 2) * 12 + speed * 0.05;
      ctx.moveTo(PLAYER_X - 3, sy);
      ctx.lineTo(PLAYER_X - 3 - len, sy);
    }
    ctx.stroke();
    ctx.restore();

    if (dead) return;

    ctx.save();
    ctx.translate(PLAYER_X + PW / 2, py + PH / 2);
    if (gsign < 0) ctx.scale(1, -1);   // upside down while ceiling-bound
    ctx.shadowColor = PAL.cyan;
    ctx.shadowBlur = 14;
    ctx.fillStyle = PAL.white;
    roundRect(ctx, -PW / 2, -PH / 2, PW, PH, 4);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Visor and running legs.
    ctx.fillStyle = PAL.cyan;
    ctx.fillRect(-PW / 2 + 3, -PH / 2 + 4, PW - 6, 4);
    const legPhase = Math.sin(dist * 0.06);
    ctx.fillStyle = grounded ? PAL.cyan : PAL.violet;
    ctx.fillRect(-PW / 2 + 2, PH / 2 - 4, 4, 4 + legPhase * 2);
    ctx.fillRect(PW / 2 - 6, PH / 2 - 4, 4, 4 - legPhase * 2);
    ctx.restore();
  }

  /* ------------------------------------------------------------ lifecycle */

  return {
    init() {
      bgTile = buildBackdrop();
      obs = [];
      orbs = [];
      dist = 0;
      speed = V0;
      py = TUN_BOT - PH;
      vy = 0;
      gsign = 1;
      grounded = true;
      trail = [];
      trailT = 0;
      camY = 0;
      camRoll = 0;
      flash = 0;
      orbCount = 0;
      flips = 0;
      dead = false;
      deadT = 0;
      deathMsg = '';
      statusT = 0;
      scoreT = 0;
      milestone = 0;

      // A clear runway before the first hazard, then generate the tunnel.
      safeSurface = 'floor';
      genX = 340;
      generateAhead();
      api.setStatus({ DIST: '0 M', ORBS: 0, SPEED: Math.round(speed) });
    },

    update(dt) {
      if (dead) {
        deadT += dt;
        return;
      }

      // Scroll and ramp.
      speed = Math.min(VMAX, V0 + dist * VRAMP);
      dist += speed * dt;

      // Gravity. The flip is instant; the fall across the tunnel is not.
      if (!grounded) {
        vy += GRAV * gsign * dt;
        py += vy * dt;
      }

      const centre = dist + PW / 2;
      if (gsign > 0) {
        if (grounded && !solidAt(centre, 'floor')) { grounded = false; vy = 0; }
        if (!grounded && py + PH >= TUN_BOT && solidAt(centre, 'floor')) {
          if (vy > 0) {
            py = TUN_BOT - PH;
            vy = 0;
            grounded = true;
            api.sfx('land', { vol: 0.28 });
            api.particles.burst(PLAYER_X + PW / 2, TUN_BOT - 2, 6, {
              speed: 70, life: 0.3, size: 2, color: PAL.cyan, glow: 8, drag: 3,
              spread: Math.PI * 0.7, dir: -Math.PI / 2,
            });
          }
        }
      } else {
        if (grounded && !solidAt(centre, 'ceil')) { grounded = false; vy = 0; }
        if (!grounded && py <= TUN_TOP && solidAt(centre, 'ceil')) {
          if (vy < 0) {
            py = TUN_TOP;
            vy = 0;
            grounded = true;
            api.sfx('land', { vol: 0.28 });
            api.particles.burst(PLAYER_X + PW / 2, TUN_TOP + 2, 6, {
              speed: 70, life: 0.3, size: 2, color: PAL.magenta, glow: 8, drag: 3,
              spread: Math.PI * 0.7, dir: Math.PI / 2,
            });
          }
        }
      }

      // Out through a hole in the plating and into the void.
      if (py > VIEW_H + 40 || py + PH < -40) {
        die('FELL OUT OF THE TUNNEL');
        return;
      }

      checkHits();
      if (dead) return;

      // Ghost trail sampling.
      trailT += dt;
      if (trailT >= 0.028) {
        trailT = 0;
        trail.push({ x: dist, y: py });
        if (trail.length > TRAIL_N) trail.shift();
      }

      // Camera: a gentle vertical lift and roll toward the active surface.
      camY = damp(camY, gsign > 0 ? 0 : -7, 7, dt);
      camRoll = damp(camRoll, gsign > 0 ? 0 : -0.055, 8, dt);
      if (flash > 0) flash = Math.max(0, flash - dt * 3.2);

      // Speed streak particles.
      if (rng.chance(dt * 26)) {
        api.particles.emit({
          x: VIEW_W + 10,
          y: rng.range(TUN_TOP + 6, TUN_BOT - 6),
          vx: -speed * rng.range(1.3, 2.2),
          vy: 0,
          life: 0.4, size: 1.6, color: rng.chance(0.5) ? PAL.violet : PAL.cyan,
          shape: 'line', glow: 6,
        });
      }

      // Extend the course and retire everything behind us.
      generateAhead();
      const cull = dist - PLAYER_X - 40;
      while (obs.length && obs[0].x + obs[0].w < cull) obs.shift();
      while (orbs.length && orbs[0].x < cull) orbs.shift();

      // Score: distance in metres plus orb bounty, batched so the HUD is not
      // rewritten sixty times a second.
      scoreT += dt;
      if (scoreT >= 0.1) {
        scoreT = 0;
        const target = Math.floor(dist / 10) + orbCount * 25;
        if (target > api.score) api.addScore(target - api.score);
      }
      statusT += dt;
      if (statusT >= 0.2) {
        statusT = 0;
        api.setStatus({
          DIST: `${Math.floor(dist / 10)} M`,
          ORBS: orbCount,
          SPEED: Math.round(speed),
        });
      }

      const m = Math.floor(dist / 10 / 250);
      if (m > milestone) {
        milestone = m;
        api.sfx('levelup', { vol: 0.4 });
        api.particles.popText(VIEW_W / 2, TUN_TOP + 30, `${m * 250} M`, PAL.lime, 1.2);
      }
    },

    handleInput(e) {
      if (e.type === 'press' && (e.action === 'a' || e.action === 'up' || e.action === 'down')) {
        flip();
      } else if (e.type === 'pointerdown') {
        flip();
      }
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;

      ctx.fillStyle = '#04050c';
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      // Camera: subtle lift + roll so a flip reads as the world turning over.
      ctx.translate(W / 2, H / 2);
      ctx.rotate(camRoll);
      ctx.translate(-W / 2, -H / 2 + camY);

      // Parallax wallpaper, overscanned so the camera roll never shows an edge.
      const off = -((dist * 0.35) % bgW);
      for (let x = off - bgW; x < W + bgW; x += bgW) {
        ctx.drawImage(bgTile, x, -14, bgW, VIEW_H + 28);
      }

      drawWalls(ctx);
      drawObstacles(ctx);
      drawOrbs(ctx);
      drawRunner(ctx);

      api.particles.render(ctx);
      ctx.restore();

      // Flip flash.
      if (flash > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = flash * 0.22;
        ctx.fillStyle = gsign > 0 ? PAL.cyan : PAL.magenta;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      // HUD.
      text(ctx, `${Math.floor(dist / 10)} M`, 8, 8, { size: 14, color: PAL.white, glow: 8 });
      text(ctx, `ORBS ${orbCount}`, 8, 24, { size: 9, color: PAL.yellow });
      const sp = (speed - V0) / (VMAX - V0);
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#0d1224';
      ctx.fillRect(W - 78, 10, 70, 5);
      ctx.restore();
      ctx.save();
      ctx.shadowColor = PAL.violet;
      ctx.shadowBlur = 8;
      ctx.fillStyle = sp > 0.85 ? PAL.magenta : PAL.violet;
      ctx.fillRect(W - 78, 10, 70 * clamp(sp, 0.02, 1), 5);
      ctx.restore();
      text(ctx, 'SPEED', W - 78, 18, { size: 8, color: PAL.dim });

      if (dead) {
        ctx.save();
        ctx.globalAlpha = clamp(deadT * 2, 0, 0.7);
        ctx.fillStyle = '#04050c';
        ctx.fillRect(0, H / 2 - 22, W, 44);
        ctx.restore();
        text(ctx, deathMsg, W / 2, H / 2 - 8,
          { size: 13, color: PAL.red, align: 'center', glow: 10 });
      } else if (dist < 300) {
        // Opening prompt — the only instruction the game ever needs.
        const a = clamp(1 - dist / 300, 0, 1);
        ctx.save();
        ctx.globalAlpha = a;
        text(ctx, api.isTouch ? 'TAP FLIP TO INVERT GRAVITY' : 'SPACE TO INVERT GRAVITY',
          W / 2, TUN_TOP + 46, { size: 11, color: PAL.violet, align: 'center', glow: 10 });
        ctx.restore();
      }
    },
  };
}
