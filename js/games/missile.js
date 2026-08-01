/**
 * 16 — MISSILE DEFENSE COMMAND
 *
 * Six cities, three batteries, thirty ammo and an unwinnable war. Tap the sky
 * and the nearest loaded battery lobs a counter-missile there; on arrival it
 * blooms into a forcefield that expands, holds, then collapses.
 *
 * Chain reactions are the whole game: an incoming warhead killed inside a blast
 * detonates its *own* blast, and every extra link in that chain doubles the
 * payout — so the difference between surviving and drowning is patience.
 */

import { PAL, TAU, clamp, alpha, text } from '../core/fx.js';

const VIEW_W = 480;
const VIEW_H = 360;
const GROUND_Y = VIEW_H - 30;

const BAT_XF = [0.08, 0.5, 0.92];
const CITY_XF = [0.19, 0.28, 0.37, 0.63, 0.72, 0.81];
const AMMO_PER_WAVE = 10;

const COUNTER_SPEED = 300;
const BLAST_R = 30;
const BLAST_GROW = 0.26;
const BLAST_HOLD = 0.14;
const BLAST_SHRINK = 0.5;
const BLAST_LIFE = BLAST_GROW + BLAST_HOLD + BLAST_SHRINK;

const CROSS_SPEED = 260;
const BONUS_TIME = 2.8;

/** Chain payouts double per link and cap out — the reward for holding fire. */
const CHAIN_POINTS = [25, 50, 100, 200, 400, 800];

export const meta = {
  id: 'missile',
  title: 'MISSILE DEFENSE COMMAND',
  short: 'MISSILE CMD',
  category: 'SHOOTER',
  desc: 'Trackball-era city defence. Intercept the barrage, farm chain reactions '
      + 'off every kill, and keep six cities breathing through MIRVs and bombers.',
  accent: PAL.orange,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'CLICK / TAP — fire at that point',
    'ARROWS — move crosshair',
    'A / SPACE — fire at crosshair',
  ],
  touch: { buttons: [{ id: 'a', label: 'FIRE' }] },
  art(ctx, w, h, accent) {
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, w, h);
    // Incoming trails.
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = PAL.red;
    ctx.beginPath();
    for (const [sx, ex] of [[20, 80], [120, 70], [210, 150], [90, 130]]) {
      ctx.moveTo(sx, 0);
      ctx.lineTo(ex, 96);
    }
    ctx.stroke();
    // Counter-missile trails from the ground.
    ctx.strokeStyle = PAL.cyan;
    ctx.beginPath();
    ctx.moveTo(30, h - 24); ctx.lineTo(96, 66);
    ctx.moveTo(210, h - 24); ctx.lineTo(150, 84);
    ctx.stroke();
    // Blasts.
    for (const [x, y, r, c] of [[96, 60, 20, PAL.yellow], [150, 82, 12, PAL.orange]]) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.5, c);
      g.addColorStop(1, alpha(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Ground + skyline.
    ctx.fillStyle = '#132038';
    ctx.fillRect(0, h - 24, w, 24);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, h - 24); ctx.lineTo(w, h - 24);
    ctx.stroke();
    ctx.fillStyle = PAL.cyan;
    for (const [cx, ch] of [[52, 12], [66, 8], [112, 14], [126, 9], [172, 11], [186, 13]]) {
      ctx.fillRect(cx, h - 24 - ch, 10, ch);
    }
    // Battery.
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(16, h - 24); ctx.lineTo(34, h - 24); ctx.lineTo(28, h - 36); ctx.lineTo(22, h - 36);
    ctx.closePath();
    ctx.fill();
    // Crosshair.
    ctx.strokeStyle = PAL.lime;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(178, 52, 7, 0, Math.PI * 2);
    ctx.moveTo(166, 52); ctx.lineTo(190, 52);
    ctx.moveTo(178, 40); ctx.lineTo(178, 64);
    ctx.stroke();
  },
};

export function create(api) {
  let batteries, cities, stars;
  let incoming, counters, blasts, bombers;
  let spawnQueue, wave, phase, phaseT, over;
  let crossX, crossY, bonusLines, nextBonusCity, statusKey;
  let destroyedCities, shotsFired, intercepts;

  const aliveCities = () => cities.reduce((n, c) => n + (c.hp > 0 ? 1 : 0), 0);

  /* ------------------------------------------------------------- spawning */

  function pickTarget() {
    // Warheads prefer live cities but occasionally go for a battery.
    const live = cities.filter((c) => c.hp > 0);
    if (!live.length || (api.rng.chance(0.22) && batteries.some((b) => b.alive))) {
      const bats = batteries.filter((b) => b.alive);
      if (bats.length) return api.rng.pick(bats).x;
    }
    return live.length ? api.rng.pick(live).x : VIEW_W / 2;
  }

  function launchIncoming(o = {}) {
    const x0 = o.x ?? api.rng.range(10, VIEW_W - 10);
    const y0 = o.y ?? -6;
    const tx = o.tx ?? pickTarget();
    const speed = o.speed ?? (26 + wave * 4.2) * api.rng.range(0.85, 1.2);
    const dx = tx - x0;
    const dy = GROUND_Y - y0;
    const d = Math.hypot(dx, dy) || 1;
    incoming.push({
      x0, y0, x: x0, y: y0,
      vx: (dx / d) * speed, vy: (dy / d) * speed,
      mirv: !!o.mirv,
      splitY: o.mirv ? api.rng.range(VIEW_H * 0.3, VIEW_H * 0.48) : 0,
      smart: !!o.smart,
      r: 3,
    });
  }

  function launchBomber() {
    const dir = api.rng.sign();
    bombers.push({
      x: dir > 0 ? -24 : VIEW_W + 24,
      y: api.rng.range(46, 116),
      vx: dir * api.rng.range(34, 52),
      dropT: api.rng.range(0.6, 1.6),
      r: 10,
    });
  }

  function startWave() {
    wave++;
    phase = 'wave';
    phaseT = 0;
    for (const b of batteries) { b.ammo = AMMO_PER_WAVE; b.alive = true; }

    const count = Math.min(30, 8 + wave * 2);
    const mirvs = wave >= 3 ? Math.min(5, wave - 2) : 0;
    const smarts = wave >= 7 ? Math.min(4, wave - 6) : 0;
    const bomberCount = wave >= 5 ? 1 + Math.floor((wave - 5) / 3) : 0;

    spawnQueue = [];
    let t = 0.6;
    for (let i = 0; i < count; i++) {
      spawnQueue.push({ kind: 'missile', t });
      t += api.rng.range(0.35, 1.5) * Math.max(0.35, 1 - wave * 0.05);
    }
    for (let i = 0; i < mirvs; i++) {
      spawnQueue.push({ kind: 'mirv', t: api.rng.range(2, t * 0.9) });
    }
    for (let i = 0; i < smarts; i++) {
      spawnQueue.push({ kind: 'smart', t: api.rng.range(3, t * 0.95) });
    }
    for (let i = 0; i < bomberCount; i++) {
      spawnQueue.push({ kind: 'bomber', t: api.rng.range(2, t * 0.8) });
    }

    api.sfx('alert');
    api.particles.popText(VIEW_W / 2, VIEW_H * 0.3, 'WAVE ' + wave, PAL.orange, 1.5);
    pushStatus();
  }

  function pushStatus() {
    const ammo = batteries.reduce((n, b) => n + (b.alive ? b.ammo : 0), 0);
    const key = wave + '|' + aliveCities() + '|' + ammo;
    if (key === statusKey) return;
    statusKey = key;
    api.setStatus({ WAVE: wave, CITIES: aliveCities(), AMMO: ammo });
  }

  /* --------------------------------------------------------------- combat */

  function addBlast(x, y, chain, big) {
    blasts.push({
      x, y, t: 0, r: 0,
      maxR: big ? BLAST_R * 1.5 : BLAST_R,
      chain: Math.min(chain, CHAIN_POINTS.length - 1),
    });
    api.sfx(chain > 0 ? 'boom' : 'explosion', { vol: chain > 0 ? 0.5 : 0.7, detune: chain * 2 });
    api.particles.burst(x, y, 10, {
      speed: 90 + chain * 30, life: 0.6, size: 2.6, drag: 2.2, glow: 12,
      color: [PAL.yellow, PAL.orange, PAL.white],
    });
    if (chain === 0) api.shakeScreen(3, 8);
  }

  function fireAt(tx, ty) {
    if (phase !== 'wave' || over) return;
    ty = clamp(ty, 6, GROUND_Y - 14);
    tx = clamp(tx, 4, VIEW_W - 4);

    // Nearest battery that still has shells.
    let best = null;
    let bestD = Infinity;
    for (const b of batteries) {
      if (!b.alive || b.ammo <= 0) continue;
      const d = Math.abs(b.x - tx);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) {
      api.sfx('deny', { vol: 0.6 });
      return;
    }

    best.ammo--;
    shotsFired++;
    const dx = tx - best.x;
    const dy = ty - (GROUND_Y - 10);
    const d = Math.hypot(dx, dy) || 1;
    counters.push({
      x: best.x, y: GROUND_Y - 10, x0: best.x, y0: GROUND_Y - 10,
      vx: (dx / d) * COUNTER_SPEED, vy: (dy / d) * COUNTER_SPEED,
      tx, ty, dist: d, travelled: 0,
    });
    api.sfx('laser', { vol: 0.35, detune: 5 });
    pushStatus();
  }

  function killIncoming(i, m, chain) {
    incoming.splice(i, 1);
    intercepts++;
    const pts = CHAIN_POINTS[Math.min(chain, CHAIN_POINTS.length - 1)];
    api.addScore(pts);
    if (chain > 0) {
      api.particles.popText(m.x, m.y - 8, 'x' + (chain + 1) + ' ' + pts, PAL.yellow, 0.8);
    }
    // Each kill blooms its own forcefield — that is the chain.
    addBlast(m.x, m.y, chain + 1, false);
  }

  function damageStructure(x, y) {
    api.hitStop(0.06);
    api.flash(PAL.orange, 0.4);
    api.particles.burst(x, y, 14, {
      speed: 140, life: 0.7, size: 3, drag: 1.8, gravity: 120, glow: 10,
      color: [PAL.red, PAL.orange, PAL.yellow],
    });
    api.shakeScreen(9, 5);
    api.sfx('explosion');

    let hitSomething = false;
    for (const c of cities) {
      if (c.hp > 0 && Math.abs(c.x - x) < 20) {
        c.hp--;
        hitSomething = true;
        if (c.hp <= 0) {
          destroyedCities++;
          api.particles.burst(c.x, GROUND_Y - 8, 22, {
            speed: 170, life: 1, size: 3, drag: 1.5, gravity: 180, glow: 12,
            color: [PAL.white, PAL.orange, PAL.red],
          });
          api.vibrate(180);
        }
      }
    }
    for (const b of batteries) {
      if (b.alive && Math.abs(b.x - x) < 20) {
        b.alive = false;
        b.ammo = 0;
        hitSomething = true;
      }
    }
    if (hitSomething) pushStatus();

    if (aliveCities() === 0 && !over) {
      over = true;
      phase = 'over';
      api.gameOver({
        message: 'ALL CITIES LOST',
        stats: {
          WAVE: wave,
          INTERCEPTS: intercepts,
          ACCURACY: shotsFired ? Math.round((intercepts / shotsFired) * 100) + '%' : '0%',
        },
      });
    }
  }

  /** Anything caught inside an active forcefield dies. */
  function resolveBlasts() {
    for (const bl of blasts) {
      if (bl.r < 1) continue;
      const r2 = bl.r * bl.r;

      for (let i = incoming.length - 1; i >= 0; i--) {
        const m = incoming[i];
        const dx = m.x - bl.x;
        const dy = m.y - bl.y;
        if (dx * dx + dy * dy <= r2) killIncoming(i, m, bl.chain);
      }
      for (let i = bombers.length - 1; i >= 0; i--) {
        const b = bombers[i];
        const dx = b.x - bl.x;
        const dy = b.y - bl.y;
        if (dx * dx + dy * dy <= r2) {
          bombers.splice(i, 1);
          api.addScore(120);
          api.particles.popText(b.x, b.y - 10, '+120', PAL.lime, 0.9);
          addBlast(b.x, b.y, bl.chain + 1, true);
        }
      }
    }
  }

  function endWave() {
    phase = 'bonus';
    phaseT = 0;
    const ammoLeft = batteries.reduce((n, b) => n + (b.alive ? b.ammo : 0), 0);
    const cityCount = aliveCities();
    const ammoPts = ammoLeft * 5 * wave;
    const cityPts = cityCount * 100 * wave;
    bonusLines = [
      ['UNUSED AMMO ' + ammoLeft, ammoPts],
      ['CITIES ' + cityCount, cityPts],
    ];
    api.addScore(ammoPts + cityPts);
    api.sfx('levelup');

    // A rebuilt city every 10k points — the classic reward for a clean wave.
    if (api.score >= nextBonusCity) {
      nextBonusCity += 10000;
      const hurt = cities.filter((c) => c.hp < 2);
      if (hurt.length) {
        const c = api.rng.pick(hurt);
        c.hp++;
        bonusLines.push(['CITY REBUILT', '']);
        api.sfx('powerup');
        api.particles.burst(c.x, GROUND_Y - 10, 16, {
          speed: 90, life: 0.9, size: 2.4, color: [PAL.lime, PAL.white], glow: 12, drag: 2,
        });
      }
    }
    pushStatus();
  }

  /* ------------------------------------------------------------ lifecycle */

  return {
    init() {
      batteries = BAT_XF.map((f) => ({ x: Math.round(f * VIEW_W), ammo: AMMO_PER_WAVE, alive: true }));
      cities = CITY_XF.map((f) => ({ x: Math.round(f * VIEW_W), hp: 2, seed: api.rng.int(0, 999) }));
      stars = [];
      for (let i = 0; i < 60; i++) {
        stars.push({ x: api.rng.range(0, VIEW_W), y: api.rng.range(0, GROUND_Y - 40), z: api.rng.range(0.3, 1) });
      }
      incoming = [];
      counters = [];
      blasts = [];
      bombers = [];
      spawnQueue = [];
      wave = 0;
      phase = 'bonus';
      phaseT = BONUS_TIME - 0.8;
      bonusLines = null;
      over = false;
      crossX = VIEW_W / 2;
      crossY = VIEW_H * 0.4;
      nextBonusCity = 10000;
      destroyedCities = 0;
      shotsFired = 0;
      intercepts = 0;
      statusKey = '';
      pushStatus();
    },

    update(dt) {
      if (over) return;
      phaseT += dt;

      /* --- crosshair: pointer or d-pad --------------------------------- */
      const ax = api.input.axis('left', 'right');
      const ay = api.input.axis('up', 'down');
      if (ax || ay) {
        crossX = clamp(crossX + ax * CROSS_SPEED * dt, 4, VIEW_W - 4);
        crossY = clamp(crossY + ay * CROSS_SPEED * dt, 6, GROUND_Y - 14);
      }
      const p = api.input.pointer;
      if (p.inside && p.down) { crossX = p.x; crossY = clamp(p.y, 6, GROUND_Y - 14); }

      if (phase === 'bonus') {
        if (phaseT >= BONUS_TIME) { bonusLines = null; startWave(); }
        // Let leftover blasts finish animating during the tally.
      }

      /* --- spawn queue -------------------------------------------------- */
      if (phase === 'wave') {
        for (let i = spawnQueue.length - 1; i >= 0; i--) {
          spawnQueue[i].t -= dt;
          if (spawnQueue[i].t > 0) continue;
          const kind = spawnQueue[i].kind;
          spawnQueue.splice(i, 1);
          if (kind === 'bomber') launchBomber();
          else launchIncoming({ mirv: kind === 'mirv', smart: kind === 'smart' });
        }
      }

      /* --- incoming ------------------------------------------------------ */
      for (let i = incoming.length - 1; i >= 0; i--) {
        const m = incoming[i];

        if (m.smart) {
          // Smart bombs slide out from under a nearby forcefield.
          let sx = 0;
          for (const bl of blasts) {
            const dx = m.x - bl.x;
            const dy = m.y - bl.y;
            const d = Math.hypot(dx, dy);
            if (d < bl.r + 52) sx += (dx / (d || 1)) * (1 - d / (bl.r + 52));
          }
          m.vx = clamp(m.vx + sx * 260 * dt, -70, 70);
        }

        m.x += m.vx * dt;
        m.y += m.vy * dt;

        if (m.mirv && m.y >= m.splitY) {
          // MIRV separation: three fresh warheads on new bearings.
          incoming.splice(i, 1);
          api.sfx('blip', { vol: 0.5, detune: 7 });
          api.particles.burst(m.x, m.y, 8, {
            speed: 80, life: 0.4, size: 2, color: PAL.red, glow: 10, drag: 3,
          });
          for (let k = 0; k < 3; k++) {
            launchIncoming({
              x: m.x, y: m.y,
              tx: clamp(pickTarget() + api.rng.range(-30, 30), 8, VIEW_W - 8),
              speed: Math.hypot(m.vx, m.vy) * 1.15,
            });
          }
          continue;
        }

        if (m.y >= GROUND_Y) {
          incoming.splice(i, 1);
          damageStructure(m.x, GROUND_Y - 4);
          addBlast(m.x, GROUND_Y - 6, 0, false);
          continue;
        }
        if (m.x < -20 || m.x > VIEW_W + 20) incoming.splice(i, 1);
      }

      /* --- bombers -------------------------------------------------------- */
      for (let i = bombers.length - 1; i >= 0; i--) {
        const b = bombers[i];
        b.x += b.vx * dt;
        b.y += Math.sin(api.time * 1.7 + b.x * 0.01) * 8 * dt;
        b.dropT -= dt;
        if (b.dropT <= 0 && b.x > 10 && b.x < VIEW_W - 10) {
          b.dropT = api.rng.range(1.4, 2.6);
          launchIncoming({
            x: b.x, y: b.y + 8,
            smart: wave >= 7 && api.rng.chance(0.4),
            speed: 34 + wave * 2,
          });
          api.sfx('drop', { vol: 0.4 });
        }
        if (b.x < -40 || b.x > VIEW_W + 40) bombers.splice(i, 1);
      }

      /* --- counter-missiles ------------------------------------------------ */
      for (let i = counters.length - 1; i >= 0; i--) {
        const c = counters[i];
        const step = COUNTER_SPEED * dt;
        c.travelled += step;
        if (c.travelled >= c.dist) {
          counters.splice(i, 1);
          addBlast(c.tx, c.ty, 0, false);
          continue;
        }
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        if (api.rng.chance(dt * 40)) {
          api.particles.emit({
            x: c.x, y: c.y, vx: api.rng.range(-12, 12), vy: api.rng.range(-12, 12),
            life: 0.35, size: 1.6, color: PAL.cyan, glow: 8, drag: 2,
          });
        }
      }

      /* --- blasts + chain resolution --------------------------------------- */
      for (let i = blasts.length - 1; i >= 0; i--) {
        const bl = blasts[i];
        bl.t += dt;
        if (bl.t < BLAST_GROW) bl.r = bl.maxR * (bl.t / BLAST_GROW);
        else if (bl.t < BLAST_GROW + BLAST_HOLD) bl.r = bl.maxR;
        else bl.r = bl.maxR * (1 - (bl.t - BLAST_GROW - BLAST_HOLD) / BLAST_SHRINK);
        if (bl.t >= BLAST_LIFE) blasts.splice(i, 1);
      }
      resolveBlasts();

      /* --- wave completion --------------------------------------------------- */
      if (phase === 'wave' && !spawnQueue.length && !incoming.length
          && !bombers.length && !counters.length && !blasts.length) {
        endWave();
      }
    },

    handleInput(e) {
      if (e.type === 'pointerdown') {
        crossX = clamp(e.x, 4, VIEW_W - 4);
        crossY = clamp(e.y, 6, GROUND_Y - 14);
        fireAt(crossX, crossY);
      } else if (e.type === 'press' && e.action === 'a') {
        fireAt(crossX, crossY);
      }
    },

    render(ctx) {
      const W = VIEW_W;
      const H = VIEW_H;

      /* --- sky ---------------------------------------------------------- */
      const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
      g.addColorStop(0, '#05070f');
      g.addColorStop(1, '#141c33');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, GROUND_Y);

      ctx.save();
      for (const s of stars) {
        ctx.globalAlpha = 0.2 + s.z * 0.5;
        ctx.fillStyle = '#9fb6dc';
        ctx.fillRect(s.x | 0, s.y | 0, 1, 1);
      }
      ctx.restore();

      /* --- ground + structures ------------------------------------------- */
      ctx.fillStyle = '#121d33';
      ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
      ctx.save();
      ctx.strokeStyle = PAL.orange;
      ctx.lineWidth = 2;
      ctx.shadowColor = PAL.orange;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y + 0.5);
      ctx.lineTo(W, GROUND_Y + 0.5);
      ctx.stroke();
      ctx.restore();

      for (const c of cities) drawCity(ctx, c);
      for (const b of batteries) drawBattery(ctx, b);

      /* --- trails, additive so overlaps bloom ----------------------------- */
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      ctx.lineWidth = 1.4;
      ctx.strokeStyle = PAL.red;
      ctx.shadowColor = PAL.red;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      for (const m of incoming) {
        ctx.moveTo(m.x0, m.y0);
        ctx.lineTo(m.x, m.y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = PAL.white;
      for (const m of incoming) {
        ctx.fillRect(m.x - 1.5, m.y - 1.5, 3, 3);
        if (m.mirv) {
          ctx.fillStyle = PAL.magenta;
          ctx.fillRect(m.x - 2.5, m.y - 2.5, 5, 5);
          ctx.fillStyle = PAL.white;
        }
      }

      ctx.strokeStyle = PAL.cyan;
      ctx.shadowColor = PAL.cyan;
      ctx.shadowBlur = 6;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (const c of counters) {
        ctx.moveTo(c.x0, c.y0);
        ctx.lineTo(c.x, c.y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = PAL.white;
      for (const c of counters) ctx.fillRect(c.x - 1.5, c.y - 1.5, 3, 3);

      // Target pips where the counter-missiles are heading.
      ctx.strokeStyle = alpha(PAL.cyan, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const c of counters) {
        ctx.moveTo(c.tx - 3, c.ty);
        ctx.lineTo(c.tx + 3, c.ty);
        ctx.moveTo(c.tx, c.ty - 3);
        ctx.lineTo(c.tx, c.ty + 3);
      }
      ctx.stroke();

      /* --- forcefields ----------------------------------------------------- */
      for (const bl of blasts) {
        if (bl.r < 0.5) continue;
        const rg = ctx.createRadialGradient(bl.x, bl.y, 0, bl.x, bl.y, bl.r);
        const hot = bl.chain > 0 ? PAL.magenta : PAL.yellow;
        rg.addColorStop(0, alpha(PAL.white, 0.95));
        rg.addColorStop(0.45, alpha(hot, 0.75));
        rg.addColorStop(0.8, alpha(PAL.orange, 0.35));
        rg.addColorStop(1, alpha(PAL.orange, 0));
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(bl.x, bl.y, bl.r, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = alpha(PAL.white, 0.6);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(bl.x, bl.y, bl.r * 0.72, 0, TAU);
        ctx.stroke();
        ctx.strokeStyle = alpha(hot, 0.5);
        ctx.beginPath();
        ctx.arc(bl.x, bl.y, bl.r * 0.95, 0, TAU);
        ctx.stroke();
      }

      /* --- bombers --------------------------------------------------------- */
      for (const b of bombers) {
        ctx.strokeStyle = PAL.violet;
        ctx.shadowColor = PAL.violet;
        ctx.shadowBlur = 10;
        ctx.lineWidth = 2;
        const d = Math.sign(b.vx) || 1;
        ctx.beginPath();
        ctx.moveTo(b.x - 12 * d, b.y);
        ctx.lineTo(b.x + 4 * d, b.y - 4);
        ctx.lineTo(b.x + 13 * d, b.y);
        ctx.lineTo(b.x + 4 * d, b.y + 4);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(b.x - 2 * d, b.y - 3);
        ctx.lineTo(b.x - 6 * d, b.y - 9);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      api.particles.render(ctx);
      ctx.restore();

      /* --- crosshair -------------------------------------------------------- */
      const ready = batteries.some((b) => b.alive && b.ammo > 0);
      ctx.save();
      ctx.strokeStyle = ready ? PAL.lime : PAL.red;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(crossX, crossY, 7, 0, TAU);
      ctx.moveTo(crossX - 13, crossY);
      ctx.lineTo(crossX - 3, crossY);
      ctx.moveTo(crossX + 3, crossY);
      ctx.lineTo(crossX + 13, crossY);
      ctx.moveTo(crossX, crossY - 13);
      ctx.lineTo(crossX, crossY - 3);
      ctx.moveTo(crossX, crossY + 3);
      ctx.lineTo(crossX, crossY + 13);
      ctx.stroke();
      ctx.restore();

      /* --- HUD -------------------------------------------------------------- */
      text(ctx, 'WAVE ' + Math.max(1, wave), 8, 8, { size: 10, color: PAL.orange });
      const totalAmmo = batteries.reduce((n, b) => n + (b.alive ? b.ammo : 0), 0);
      text(ctx, 'AMMO ' + totalAmmo, W - 8, 8, {
        size: 10, align: 'right', color: totalAmmo > 6 ? PAL.cyan : PAL.red,
      });

      if (phase === 'bonus' && bonusLines) {
        const y0 = H * 0.32;
        text(ctx, 'WAVE ' + wave + ' CLEARED', W / 2, y0, {
          size: 15, color: PAL.lime, align: 'center', glow: 12,
        });
        let ly = y0 + 24;
        for (const [label, val] of bonusLines) {
          text(ctx, label, W / 2 - 80, ly, { size: 10, color: PAL.dim });
          if (val !== '') {
            text(ctx, '+' + val, W / 2 + 80, ly, { size: 10, color: PAL.yellow, align: 'right' });
          }
          ly += 14;
        }
      } else if (phase === 'bonus') {
        text(ctx, 'DEFEND THE CITIES', W / 2, H * 0.36, {
          size: 14, color: PAL.orange, align: 'center', glow: 10,
        });
      }
    },

    destroy() {},
  };

  /* -------------------------------------------------------------- drawing */

  function drawCity(ctx, c) {
    const base = GROUND_Y;
    if (c.hp <= 0) {
      // Rubble: a low jagged mound with a couple of embers.
      ctx.fillStyle = '#2a3145';
      ctx.beginPath();
      ctx.moveTo(c.x - 14, base);
      ctx.lineTo(c.x - 9, base - 5);
      ctx.lineTo(c.x - 3, base - 2);
      ctx.lineTo(c.x + 3, base - 6);
      ctx.lineTo(c.x + 9, base - 3);
      ctx.lineTo(c.x + 14, base);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = alpha(PAL.orange, 0.35 + 0.25 * Math.sin(api.time * 4 + c.seed));
      ctx.fillRect(c.x - 6, base - 3, 2, 2);
      ctx.fillRect(c.x + 5, base - 4, 2, 2);
      return;
    }

    const damaged = c.hp === 1;
    const color = damaged ? '#5c7fa8' : PAL.cyan;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = damaged ? 3 : 7;
    ctx.fillStyle = color;
    const towers = damaged
      ? [[-11, 7], [-2, 5], [6, 9]]
      : [[-12, 11], [-5, 16], [2, 9], [8, 13]];
    for (const [ox, hgt] of towers) {
      ctx.fillRect(c.x + ox, base - hgt, 6, hgt);
    }
    ctx.restore();

    // Lit windows flicker on healthy cities only.
    if (!damaged) {
      ctx.fillStyle = alpha(PAL.yellow, 0.55 + 0.35 * Math.sin(api.time * 2 + c.seed));
      ctx.fillRect(c.x - 10, base - 8, 2, 2);
      ctx.fillRect(c.x - 3, base - 12, 2, 2);
      ctx.fillRect(c.x + 10, base - 9, 2, 2);
    } else {
      ctx.fillStyle = alpha(PAL.red, 0.4);
      ctx.fillRect(c.x - 9, base - 4, 2, 2);
    }
  }

  function drawBattery(ctx, b) {
    const base = GROUND_Y;
    if (!b.alive) {
      ctx.fillStyle = '#2a3145';
      ctx.fillRect(b.x - 11, base - 4, 22, 4);
      ctx.fillStyle = alpha(PAL.red, 0.4);
      ctx.fillRect(b.x - 3, base - 6, 3, 2);
      return;
    }
    ctx.save();
    ctx.fillStyle = PAL.orange;
    ctx.shadowColor = PAL.orange;
    ctx.shadowBlur = 7;
    ctx.beginPath();
    ctx.moveTo(b.x - 13, base);
    ctx.lineTo(b.x + 13, base);
    ctx.lineTo(b.x + 7, base - 11);
    ctx.lineTo(b.x - 7, base - 11);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Shell stack, three rows of up to four.
    const n = b.ammo;
    ctx.fillStyle = n > 3 ? PAL.cyan : n > 0 ? PAL.yellow : PAL.red;
    for (let i = 0; i < Math.min(n, 10); i++) {
      const row = Math.floor(i / 4);
      const col = i % 4;
      ctx.fillRect(b.x - 8 + col * 4.5 + row * 2.2, base - 15 - row * 4, 3, 3);
    }
    text(ctx, String(n), b.x, base + 6, {
      size: 9, align: 'center', color: n > 0 ? PAL.white : PAL.red,
    });
  }
}
