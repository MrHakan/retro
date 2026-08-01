/**
 * 03 — SPACE INVADERS: BULLET HELL
 * The classic silhouette with a modern danmaku engine underneath: formations
 * that march, weave, split and dive-bomb, tiered invaders, aimed / radial /
 * spiral emitters, four power-ups and a spiral-casting boss every fifth wave.
 */

import {
  PAL, TAU, alpha, mix, clamp, dist2, Starfield, text, glowCircle, polygon, vgrad,
} from '../core/fx.js';

const VIEW_W = 400;
const VIEW_H = 560;

/* --------------------------------------------------------------- tuning */

const PLAYER_SPEED = 210;
const PLAYER_R = 2.6;          // the real hitbox — tiny, and drawn as a dot
const FIRE_BASE = 0.135;
const FIRE_HELD = 0.085;
const BULLET_DMG = 2;
const BEAM_DPS = 60;
const MAX_EB = 150;            // hard ceiling on enemy bullets, for fairness
const MAX_PB = 70;
const INVULN = 2.4;
const FLOOR_Y = VIEW_H - 34;   // invaders that cross this line breach the base

/* Formation grid spacing. */
const SPX = 38;
const SPY = 30;

const TIERS = {
  grunt: { hp: 4, pts: 25, color: PAL.cyan, r: 9, cd: [1.6, 3.2], shape: 'crab' },
  drone: { hp: 7, pts: 45, color: PAL.lime, r: 9, cd: [1.9, 3.6], shape: 'squid' },
  gunner: { hp: 12, pts: 80, color: PAL.yellow, r: 10, cd: [2.4, 4.2], shape: 'ufo' },
  elite: { hp: 20, pts: 140, color: PAL.magenta, r: 11, cd: [2.8, 5.0], shape: 'eye' },
};

const POWERS = {
  spread: { color: PAL.lime, label: 'TRIPLE SPREAD', letter: 'T', dur: 12 },
  shield: { color: PAL.cyan, label: 'PLASMA SHIELD', letter: 'S', hits: 3 },
  beam: { color: PAL.violet, label: 'BEAM LASER', letter: 'L', dur: 7 },
  bomb: { color: PAL.orange, label: 'SMART BOMB', letter: 'X' },
};
const POWER_KEYS = ['spread', 'shield', 'beam', 'bomb'];

/** Formation choreography, cycled as the waves climb. */
const MODES = ['march', 'weave', 'split', 'dive'];

export const meta = {
  id: 'invaders',
  title: 'SPACE INVADERS: BULLET HELL',
  short: 'BULLET HELL',
  category: 'SHOOTER',
  desc: 'Invader formations that march, weave, split and dive while spraying '
      + 'radial, aimed and spiral danmaku. Four power-ups, a boss every five waves.',
  accent: PAL.magenta,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'ARROWS / WASD — fly',
    'SPACE — fire (auto-fire is always on)',
    'K — smart bomb',
  ],
  touch: { stick: true, buttons: [{ id: 'a', label: 'FIRE' }, { id: 'b', label: 'BOMB' }] },
  art(ctx, w, h, accent) {
    ctx.save();
    ctx.fillStyle = '#06070f';
    ctx.fillRect(0, 0, w, h);
    // Stars.
    ctx.fillStyle = alpha('#ffffff', 0.55);
    for (let i = 0; i < 40; i++) {
      const x = (i * 97) % w;
      const y = (i * 53) % h;
      ctx.fillRect(x, y, 1 + (i % 3 === 0 ? 1 : 0), 1);
    }
    // Invader rows.
    const cols = [PAL.magenta, PAL.yellow, PAL.cyan];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        const x = 34 + c * 30;
        const y = 22 + r * 22;
        ctx.fillStyle = cols[r];
        ctx.fillRect(x - 7, y - 4, 14, 8);
        ctx.fillRect(x - 10, y - 1, 3, 6);
        ctx.fillRect(x + 7, y - 1, 3, 6);
      }
    }
    // Danmaku curtain.
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 8;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU;
      const rr = 26 + (i % 4) * 9;
      ctx.beginPath();
      ctx.arc(w / 2 + Math.cos(a) * rr, 96 + Math.sin(a) * rr * 0.6, 2.4, 0, TAU);
      ctx.fill();
    }
    // Player ship + its twin lasers.
    ctx.shadowColor = PAL.cyan;
    ctx.fillStyle = PAL.cyan;
    ctx.beginPath();
    ctx.moveTo(w / 2, h - 34);
    ctx.lineTo(w / 2 - 13, h - 12);
    ctx.lineTo(w / 2, h - 18);
    ctx.lineTo(w / 2 + 13, h - 12);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = PAL.white;
    ctx.fillRect(w / 2 - 8, h - 62, 2, 16);
    ctx.fillRect(w / 2 + 6, h - 62, 2, 16);
    ctx.restore();
  },
};

export function create(api) {
  let stars;
  let px, py, pvx, pvy;
  let lives, invuln, alive, playing;
  let fireTimer, muzzle;
  let pb, eb, aliens, drops;
  let boss;
  let wave, waveState, waveTimer, mode;
  let anchor;                // { x, y, dir, vx, drop, sway }
  let power;                 // { spread, beam, shield, bombs }
  let bombFlash, hitFlash;
  let kills, shotsFired, shotsHit, bestCombo, chain, chainTimer;
  let banner;

  /* ----------------------------------------------------------- spawning */

  function eBullet(x, y, ang, spd, o = {}) {
    if (eb.length >= MAX_EB) return;
    eb.push({
      x,
      y,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      r: o.r ?? 3.2,
      color: o.color || PAL.magenta,
      acc: o.acc || 0,
      life: o.life ?? 14,
    });
  }

  function pBullet(x, y, ang, dmg, pierce = 0) {
    if (pb.length >= MAX_PB) return;
    pb.push({
      x,
      y,
      vx: Math.cos(ang) * 470,
      vy: Math.sin(ang) * 470,
      dmg,
      pierce,
      life: 2,
    });
  }

  /** Slot position for an invader still flying in formation. */
  function slotPos(a, t) {
    const half = (a.cols - 1) / 2;
    let x = anchor.x + (a.col - half) * SPX;
    let y = anchor.y + a.row * SPY;
    if (mode === 'weave') {
      x += Math.sin(t * 1.7 + a.col * 0.55) * 26;
      y += Math.cos(t * 1.3 + a.row * 0.7) * 8;
    } else if (mode === 'split') {
      const side = a.col < a.cols / 2 ? -1 : 1;
      x += side * Math.sin(t * 1.25) * 46;
      y += Math.sin(t * 2.1 + a.col) * 6;
    } else if (mode === 'dive') {
      x += Math.sin(t * 1.1 + a.col * 0.4) * 12;
    }
    return { x, y };
  }

  function makeAlien(tier, col, row, cols, hpMul) {
    const T = TIERS[tier];
    return {
      tier,
      col,
      row,
      cols,
      hp: Math.round(T.hp * hpMul),
      maxHp: Math.round(T.hp * hpMul),
      x: 0,
      y: -40 - row * 24,
      r: T.r,
      hurt: 0,
      state: 'enter',
      enter: 0,
      cd: api.rng.range(T.cd[0], T.cd[1]),
      dive: 0,
      diveX: 0,
      wobble: api.rng.range(0, TAU),
    };
  }

  function buildWave(n) {
    aliens = [];
    boss = null;
    const bossWave = n % 5 === 0;
    mode = bossWave ? 'weave' : MODES[Math.floor((n - 1) / 2) % MODES.length];
    const hpMul = 1 + (n - 1) * 0.14;

    anchor = { x: VIEW_W / 2, y: 96, dir: 1, vx: 26 + n * 3.5, drop: 0, sway: 0 };

    if (bossWave) {
      anchor.y = 118;
      boss = {
        x: VIEW_W / 2,
        y: -70,
        r: 34,
        hp: 260 + n * 45,
        maxHp: 260 + n * 45,
        phase: 0,
        t: 0,
        spin: 0,
        cd: 2.4,
        pattern: 0,
        hurt: 0,
        entering: true,
      };
      // A thin escort so the arena is never just the boss.
      const cols = 5;
      for (let c = 0; c < cols; c++) aliens.push(makeAlien(c % 2 ? 'drone' : 'grunt', c, 0, cols, hpMul));
      api.sfx('alert');
      banner = { text: 'WARNING — DREADNOUGHT', color: PAL.red, life: 2.4 };
    } else {
      const cols = 6 + Math.min(3, Math.floor(n / 3));
      const rows = 3 + Math.min(2, Math.floor((n - 1) / 4));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // Tougher tiers ride the top rows, exactly like the arcade original.
          let tier = 'grunt';
          if (r === 0) tier = n >= 8 ? 'elite' : n >= 4 ? 'gunner' : 'drone';
          else if (r === 1) tier = n >= 6 ? 'gunner' : 'drone';
          aliens.push(makeAlien(tier, c, r, cols, hpMul));
        }
      }
      banner = { text: 'WAVE ' + n, color: PAL.cyan, life: 1.8 };
    }
    for (const a of aliens) {
      const s = slotPos(a, 0);
      a.x = s.x;
    }
  }

  /* ----------------------------------------------------------- combat   */

  function shoot(held) {
    if (power.beam > 0) return;
    muzzle = 0.07;
    if (power.spread > 0) {
      shotsFired += 3;
      for (const off of [-0.24, 0, 0.24]) pBullet(px, py - 12, -Math.PI / 2 + off, BULLET_DMG);
    } else {
      shotsFired += 2;
      pBullet(px - 6, py - 10, -Math.PI / 2, BULLET_DMG);
      pBullet(px + 6, py - 10, -Math.PI / 2, BULLET_DMG);
    }
    api.sfx('laser', { vol: held ? 0.16 : 0.2, detune: power.spread > 0 ? 3 : 0 });
    api.particles.emit({
      x: px, y: py - 12, vy: 60, life: 0.12, size: 5,
      color: power.spread > 0 ? PAL.lime : PAL.cyan, glow: 10, shape: 'circle', shrink: 26,
    });
  }

  function damageAlien(a, dmg) {
    a.hp -= dmg;
    a.hurt = 0.12;
    if (a.hp > 0) return false;
    killAlien(a);
    return true;
  }

  function killAlien(a) {
    const T = TIERS[a.tier];
    chain++;
    chainTimer = 1.6;
    if (chain > bestCombo) bestCombo = chain;
    kills++;
    const mult = 1 + Math.min(9, Math.floor(chain / 5)) * 0.1;
    api.addScore(Math.round(T.pts * mult));
    api.sfx('boom', { vol: 0.4, detune: clamp(a.r - 9, -4, 6) });
    api.particles.burst(a.x, a.y, 12, {
      speed: 150, life: 0.5, size: 2.6, color: [T.color, PAL.white], glow: 9, drag: 2.4, shape: 'spark',
    });
    api.particles.burst(a.x, a.y, 5, {
      speed: 60, life: 0.7, size: 6, color: alpha(T.color, 0.8), glow: 12, drag: 3, shape: 'circle', shrink: 9,
    });
    if (chain > 0 && chain % 10 === 0) {
      api.particles.popText(a.x, a.y - 12, 'x' + chain, PAL.yellow);
      api.sfx('combo', { vol: 0.5 });
    }
    if (api.rng.chance(0.13)) dropPower(a.x, a.y);
    const i = aliens.indexOf(a);
    if (i >= 0) aliens.splice(i, 1);
  }

  function dropPower(x, y, kind) {
    drops.push({
      x,
      y,
      vy: 64,
      kind: kind || api.rng.pick(POWER_KEYS),
      t: 0,
      life: 11,
    });
  }

  function takePower(d) {
    const p = POWERS[d.kind];
    if (d.kind === 'shield') power.shield = Math.max(power.shield, p.hits);
    else if (d.kind === 'bomb') power.bombs = Math.min(4, power.bombs + 1);
    else power[d.kind] = p.dur;
    api.sfx('powerup');
    api.addScore(60);
    api.particles.burst(d.x, d.y, 16, {
      speed: 130, life: 0.6, size: 3, color: [p.color, PAL.white], glow: 12, drag: 2.6,
    });
    api.particles.popText(d.x, d.y - 10, p.label, p.color, 1.1);
    syncStatus();
  }

  function smartBomb() {
    if (power.bombs <= 0) {
      api.sfx('deny', { vol: 0.5 });
      return;
    }
    power.bombs--;
    bombFlash = 1;
    api.shakeScreen(11, 4);
    api.vibrate(90);
    api.sfx('explosion');
    // Every bullet on screen becomes score confetti.
    for (const b of eb) {
      api.particles.emit({
        x: b.x, y: b.y, vx: b.vx * 0.2, vy: b.vy * 0.2 - 40,
        life: 0.45, size: 2.5, color: PAL.yellow, glow: 8, drag: 3,
      });
    }
    api.addScore(eb.length * 4);
    eb.length = 0;
    for (let i = aliens.length - 1; i >= 0; i--) damageAlien(aliens[i], 26);
    if (boss && !boss.entering) {
      boss.hp -= 55;
      boss.hurt = 0.2;
      api.particles.burst(boss.x, boss.y, 20, {
        speed: 190, life: 0.6, size: 3, color: [PAL.orange, PAL.white], glow: 10, drag: 2.5, shape: 'spark',
      });
    }
    syncStatus();
  }

  function hitPlayer() {
    if (invuln > 0 || !alive) return;
    if (power.shield > 0) {
      power.shield--;
      hitFlash = 0.35;
      invuln = 0.7;
      api.sfx('zap', { vol: 0.7 });
      api.shakeScreen(5, 8);
      api.particles.burst(px, py, 18, {
        speed: 190, life: 0.4, size: 2.4, color: [PAL.cyan, PAL.white], glow: 10, drag: 3, shape: 'spark',
      });
      syncStatus();
      return;
    }
    lives--;
    invuln = INVULN;
    hitFlash = 0.6;
    chain = 0;
    power.spread = 0;
    power.beam = 0;
    api.shakeScreen(14, 4);
    api.vibrate(140);
    api.sfx('explosion');
    api.particles.burst(px, py, 26, {
      speed: 220, life: 0.8, size: 3, color: [PAL.cyan, PAL.white, PAL.orange], glow: 12, drag: 1.8, shape: 'spark',
    });
    // Clearing the curtain stops a death from cascading into three more.
    eb.length = 0;
    px = VIEW_W / 2;
    py = VIEW_H - 56;
    syncStatus();
    if (lives <= 0) end();
  }

  function breach() {
    // An invader crossed the defence line: costs a life and shoves the
    // formation back up so the wave stays winnable.
    if (!alive) return;
    anchor.y -= SPY * 4;
    for (const a of aliens) if (a.state === 'dive') { a.state = 'formation'; a.dive = 0; }
    api.sfx('alert');
    banner = { text: 'DEFENCE LINE BREACHED', color: PAL.red, life: 1.6 };
    hitPlayer();
  }

  function end() {
    if (!alive) return;
    alive = false;
    playing = false;
    api.gameOver({
      message: 'FLEET OVERWHELMED',
      stats: {
        WAVE: wave,
        KILLS: kills,
        'BEST CHAIN': bestCombo,
        ACCURACY: shotsFired ? Math.round((shotsHit / shotsFired) * 100) + '%' : '—',
      },
    });
  }

  function syncStatus() {
    api.setStatus({ WAVE: wave, LIVES: Math.max(0, lives), BOMBS: power.bombs });
  }

  /* ------------------------------------------------------ enemy patterns */

  /** Each tier casts a different shape; density scales gently with the wave. */
  function alienFire(a, diff) {
    const T = TIERS[a.tier];
    const aim = Math.atan2(py - a.y, px - a.x);
    const spd = 96 + diff * 12;
    switch (a.tier) {
      case 'grunt':
        eBullet(a.x, a.y + 8, aim, spd, { color: PAL.cyan, r: 3 });
        break;
      case 'drone':
        for (const o of [-0.2, 0, 0.2]) eBullet(a.x, a.y + 8, aim + o, spd * 0.92, { color: PAL.lime, r: 3 });
        break;
      case 'gunner': {
        // Downward fan, always leaving gaps you can slide through.
        const n = 5;
        for (let i = 0; i < n; i++) {
          const ang = Math.PI / 2 - 0.5 + (i / (n - 1)) * 1.0;
          eBullet(a.x, a.y + 8, ang, spd * 0.85, { color: PAL.yellow, r: 3.4 });
        }
        break;
      }
      case 'elite': {
        const n = 8;
        const off = a.wobble;
        for (let i = 0; i < n; i++) eBullet(a.x, a.y, off + (i / n) * TAU, spd * 0.68, { color: PAL.magenta, r: 3.2 });
        a.wobble += 0.42;
        break;
      }
      default: break;
    }
    api.sfx('shoot', { vol: 0.12, detune: T.r - 9 });
  }

  function bossFire(dt, diff) {
    boss.t += dt;
    boss.spin += dt * (boss.phase ? 2.6 : 1.7);
    boss.cd -= dt;

    // Continuous spiral emitter — the signature of the fight.
    boss.emit = (boss.emit || 0) - dt;
    if (boss.emit <= 0) {
      boss.emit = boss.phase ? 0.085 : 0.13;
      const arms = boss.phase ? 3 : 2;
      for (let i = 0; i < arms; i++) {
        const ang = boss.spin + (i / arms) * TAU;
        eBullet(boss.x, boss.y + 10, ang, 84 + diff * 6, { color: PAL.violet, r: 3.2 });
      }
    }

    if (boss.cd > 0) return;
    boss.pattern = (boss.pattern + 1) % 3;
    const aim = Math.atan2(py - boss.y, px - boss.x);
    if (boss.pattern === 0) {
      // Aimed shotgun.
      for (let i = -3; i <= 3; i++) {
        eBullet(boss.x, boss.y + 14, aim + i * 0.12, 150 + diff * 8, { color: PAL.red, r: 3.6 });
      }
      boss.cd = boss.phase ? 1.5 : 2.1;
      api.sfx('shotgun', { vol: 0.35 });
    } else if (boss.pattern === 1) {
      // Radial ring with a deliberate safe gap opposite the player.
      const n = boss.phase ? 22 : 16;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * TAU + boss.spin * 0.3;
        if (Math.abs(((ang - aim + Math.PI * 3) % TAU) - Math.PI) < 0.28) continue;
        eBullet(boss.x, boss.y, ang, 108 + diff * 5, { color: PAL.magenta, r: 3.2 });
      }
      boss.cd = boss.phase ? 1.7 : 2.4;
      api.sfx('charge', { vol: 0.35 });
    } else {
      // Rain of slow, accelerating drops.
      for (let i = 0; i < 9; i++) {
        eBullet(api.rng.range(20, VIEW_W - 20), boss.y - 10, Math.PI / 2, 40, {
          color: PAL.orange, r: 3.4, acc: 105,
        });
      }
      boss.cd = boss.phase ? 1.4 : 2.0;
      api.sfx('alert', { vol: 0.3 });
    }
  }

  function killBoss() {
    api.addScore(800 + wave * 80);
    api.shakeScreen(18, 3);
    api.vibrate(200);
    api.sfx('explosion');
    for (let i = 0; i < 5; i++) {
      api.particles.burst(boss.x + api.rng.range(-26, 26), boss.y + api.rng.range(-18, 18), 8, {
        speed: 230, life: 0.9, size: 3.4, color: [PAL.violet, PAL.white, PAL.orange],
        glow: 12, drag: 1.6, shape: 'spark',
      });
    }
    for (let i = 0; i < 3; i++) dropPower(boss.x + (i - 1) * 26, boss.y, POWER_KEYS[i]);
    eb.length = 0;
    boss = null;
    banner = { text: 'DREADNOUGHT DOWN', color: PAL.yellow, life: 2 };
  }

  /* -------------------------------------------------------------- draw   */

  function drawInvader(ctx, a) {
    const T = TIERS[a.tier];
    const col = a.hurt > 0 ? mix(T.color, '#ffffff', 0.75) : T.color;
    const r = a.r;
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.strokeStyle = col;
    ctx.fillStyle = alpha(col, 0.22);
    ctx.lineWidth = 1.6;
    switch (T.shape) {
      case 'crab':
        ctx.beginPath();
        ctx.moveTo(-r, -r * 0.3);
        ctx.lineTo(-r * 0.5, -r * 0.75);
        ctx.lineTo(r * 0.5, -r * 0.75);
        ctx.lineTo(r, -r * 0.3);
        ctx.lineTo(r * 0.6, r * 0.45);
        ctx.lineTo(r * 0.85, r * 0.9);
        ctx.lineTo(r * 0.2, r * 0.5);
        ctx.lineTo(-r * 0.2, r * 0.5);
        ctx.lineTo(-r * 0.85, r * 0.9);
        ctx.lineTo(-r * 0.6, r * 0.45);
        ctx.closePath();
        break;
      case 'squid':
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.8, -r * 0.1);
        ctx.lineTo(r * 0.45, r * 0.9);
        ctx.lineTo(0, r * 0.35);
        ctx.lineTo(-r * 0.45, r * 0.9);
        ctx.lineTo(-r * 0.8, -r * 0.1);
        ctx.closePath();
        break;
      case 'ufo':
        ctx.beginPath();
        ctx.ellipse(0, r * 0.15, r, r * 0.45, 0, 0, TAU);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, -r * 0.2, r * 0.5, Math.PI, 0);
        ctx.closePath();
        break;
      default:
        polygon(ctx, 0, 0, r, 6, api.time * 0.6, r * 0.5);
    }
    ctx.fill();
    ctx.stroke();
    // Eye dots make the tiers readable at a glance.
    ctx.fillStyle = a.hurt > 0 ? PAL.white : alpha(col, 0.95);
    ctx.fillRect(-r * 0.42, -r * 0.15, 2, 2);
    ctx.fillRect(r * 0.22, -r * 0.15, 2, 2);
    ctx.restore();

    if (a.maxHp > 8 && a.hp < a.maxHp) {
      const w = r * 2;
      ctx.fillStyle = alpha('#000000', 0.6);
      ctx.fillRect(a.x - w / 2, a.y + r + 3, w, 2);
      ctx.fillStyle = T.color;
      ctx.fillRect(a.x - w / 2, a.y + r + 3, w * (a.hp / a.maxHp), 2);
    }
  }

  function drawBoss(ctx) {
    const b = boss;
    const col = b.hurt > 0 ? PAL.white : PAL.violet;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.shadowColor = col;
    ctx.shadowBlur = 16;
    // Hull.
    ctx.strokeStyle = col;
    ctx.fillStyle = alpha(PAL.violet, 0.2);
    ctx.lineWidth = 2.4;
    polygon(ctx, 0, 0, b.r, 6, Math.PI / 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Rotating turret ring.
    ctx.rotate(b.spin);
    ctx.strokeStyle = alpha(b.phase ? PAL.red : PAL.magenta, 0.9);
    ctx.lineWidth = 2;
    polygon(ctx, 0, 0, b.r * 0.62, 3);
    ctx.stroke();
    ctx.restore();
    // Core.
    glowCircle(ctx, b.x, b.y, 7 + Math.sin(api.time * 7) * 1.6, b.phase ? PAL.red : PAL.cyan, 16);
  }

  function drawShip(ctx) {
    const blink = invuln > 0 && Math.floor(invuln * 18) % 2 === 0;
    ctx.save();
    if (blink) ctx.globalAlpha = 0.3;
    // Engine plume.
    const flame = 8 + Math.sin(api.time * 40) * 3;
    ctx.fillStyle = alpha(PAL.orange, 0.8);
    ctx.beginPath();
    ctx.moveTo(px - 4, py + 8);
    ctx.lineTo(px, py + 8 + flame);
    ctx.lineTo(px + 4, py + 8);
    ctx.closePath();
    ctx.fill();
    // Hull.
    ctx.shadowColor = PAL.cyan;
    ctx.shadowBlur = 12;
    ctx.fillStyle = PAL.cyan;
    ctx.beginPath();
    ctx.moveTo(px, py - 14);
    ctx.lineTo(px - 14, py + 9);
    ctx.lineTo(px - 5, py + 4);
    ctx.lineTo(px, py + 9);
    ctx.lineTo(px + 5, py + 4);
    ctx.lineTo(px + 14, py + 9);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = alpha(PAL.white, 0.85);
    ctx.fillRect(px - 1.5, py - 10, 3, 12);
    ctx.restore();

    if (muzzle > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = alpha(power.spread > 0 ? PAL.lime : PAL.cyan, muzzle * 8);
      ctx.beginPath();
      ctx.ellipse(px, py - 14, 7, 12, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Plasma shield ring.
    if (power.shield > 0) {
      ctx.save();
      ctx.strokeStyle = alpha(PAL.cyan, 0.35 + 0.25 * power.shield + (hitFlash > 0 ? 0.4 : 0));
      ctx.lineWidth = 2;
      ctx.shadowColor = PAL.cyan;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(px, py - 1, 22 + Math.sin(api.time * 4) * 1.5, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // The actual hitbox — the only pixel that can kill you.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = invuln > 0 ? PAL.yellow : PAL.white;
    ctx.beginPath();
    ctx.arc(px, py, PLAYER_R + 1.4, 0, TAU);
    ctx.fill();
    ctx.fillStyle = alpha(PAL.red, 0.9);
    ctx.beginPath();
    ctx.arc(px, py, PLAYER_R, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Small labelled meter used for the power-up readouts. */
  function powerBar(ctx, x, y, label, frac, color) {
    const w = 74;
    ctx.fillStyle = alpha('#000000', 0.5);
    ctx.fillRect(x, y - 5, w, 4);
    ctx.fillStyle = color;
    ctx.fillRect(x, y - 5, w * clamp(frac, 0, 1), 4);
    text(ctx, label, x, y - 14, { size: 7, color });
  }

  /* --------------------------------------------------------- lifecycle  */

  return {
    init() {
      stars = new Starfield(VIEW_W, VIEW_H, 120, api.rng);
      px = VIEW_W / 2;
      py = VIEW_H - 56;
      pvx = 0;
      pvy = 0;
      lives = 3;
      invuln = 1.2;
      alive = true;
      playing = true;
      fireTimer = 0;
      muzzle = 0;
      pb = [];
      eb = [];
      aliens = [];
      drops = [];
      boss = null;
      wave = 1;
      waveState = 'fight';
      waveTimer = 0;
      power = { spread: 0, beam: 0, shield: 0, bombs: 1 };
      bombFlash = 0;
      hitFlash = 0;
      kills = 0;
      shotsFired = 0;
      shotsHit = 0;
      chain = 0;
      chainTimer = 0;
      bestCombo = 0;
      banner = null;
      buildWave(1);
      syncStatus();
    },

    update(dt) {
      if (!playing) return;
      const t = api.time;
      const diff = wave;

      stars.update(dt, 26, 0, 1);
      if (bombFlash > 0) bombFlash = Math.max(0, bombFlash - dt * 2.4);
      if (hitFlash > 0) hitFlash = Math.max(0, hitFlash - dt * 2);
      if (muzzle > 0) muzzle -= dt;
      if (invuln > 0) invuln -= dt;
      if (banner) {
        banner.life -= dt;
        if (banner.life <= 0) banner = null;
      }
      if (chainTimer > 0) {
        chainTimer -= dt;
        if (chainTimer <= 0) chain = 0;
      }
      for (const k of ['spread', 'beam']) {
        if (power[k] > 0) {
          power[k] = Math.max(0, power[k] - dt);
          if (power[k] === 0) api.sfx('back', { vol: 0.4 });
        }
      }

      /* ---------------------------------------------------- player ---- */
      // The stick vector mirrors the arrow keys too, so one read serves both.
      const stick = api.input.stick;
      const ax = clamp(stick.x, -1, 1);
      const ay = clamp(stick.y, -1, 1);
      pvx = ax * PLAYER_SPEED;
      pvy = ay * PLAYER_SPEED * 0.85;
      px = clamp(px + pvx * dt, 16, VIEW_W - 16);
      py = clamp(py + pvy * dt, VIEW_H * 0.55, VIEW_H - 22);

      // Auto-fire is always live; holding FIRE simply cycles faster.
      const held = api.input.isDown('a');
      fireTimer -= dt;
      if (fireTimer <= 0) {
        shoot(held);
        fireTimer = held ? FIRE_HELD : FIRE_BASE;
      }

      /* ------------------------------------------------ player bullets - */
      for (let i = pb.length - 1; i >= 0; i--) {
        const b = pb[i];
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        if (b.y < -12 || b.life <= 0) { pb.splice(i, 1); continue; }
        let consumed = false;
        for (let j = aliens.length - 1; j >= 0; j--) {
          const a = aliens[j];
          if (dist2(b.x, b.y, a.x, a.y) > (a.r + 3) ** 2) continue;
          shotsHit++;
          damageAlien(a, b.dmg);
          api.particles.emit({
            x: b.x, y: b.y, vy: -30, life: 0.16, size: 2.5, color: PAL.white, glow: 8, drag: 3,
          });
          if (b.pierce > 0) b.pierce--;
          else consumed = true;
          break;
        }
        if (!consumed && boss && !boss.entering && dist2(b.x, b.y, boss.x, boss.y) < (boss.r + 3) ** 2) {
          shotsHit++;
          boss.hp -= b.dmg;
          boss.hurt = 0.1;
          api.particles.emit({
            x: b.x, y: b.y, vy: -40, life: 0.2, size: 3, color: PAL.violet, glow: 9, drag: 3,
          });
          consumed = true;
        }
        if (consumed) pb.splice(i, 1);
      }

      /* -------------------------------------------------------- beam --- */
      if (power.beam > 0) {
        for (let j = aliens.length - 1; j >= 0; j--) {
          const a = aliens[j];
          if (a.y > py || Math.abs(a.x - px) > a.r + 5) continue;
          damageAlien(a, BEAM_DPS * dt);
        }
        if (boss && !boss.entering && boss.y < py && Math.abs(boss.x - px) < boss.r + 5) {
          boss.hp -= BEAM_DPS * dt;
          boss.hurt = 0.06;
        }
        // The beam also burns through the bullet curtain in its lane.
        for (let i = eb.length - 1; i >= 0; i--) {
          const b = eb[i];
          if (b.y < py && Math.abs(b.x - px) < 6) {
            api.particles.emit({ x: b.x, y: b.y, life: 0.2, size: 3, color: PAL.violet, glow: 8 });
            eb.splice(i, 1);
          }
        }
      }

      /* ------------------------------------------------------ formation  */
      if (mode === 'march') {
        anchor.x += anchor.dir * anchor.vx * dt;
        let lo = Infinity;
        let hi = -Infinity;
        for (const a of aliens) {
          if (a.state !== 'formation') continue;
          const s = slotPos(a, t);
          if (s.x < lo) lo = s.x;
          if (s.x > hi) hi = s.x;
        }
        if (hi > VIEW_W - 26 && anchor.dir > 0) { anchor.dir = -1; anchor.y += 14; api.sfx('step', { vol: 0.3 }); }
        else if (lo < 26 && anchor.dir < 0) { anchor.dir = 1; anchor.y += 14; api.sfx('step', { vol: 0.3 }); }
      } else {
        anchor.x = VIEW_W / 2 + Math.sin(t * 0.55) * 42;
        anchor.y += 3.2 * dt;
      }

      /* --------------------------------------------------------- aliens  */
      let breached = false;
      for (let i = aliens.length - 1; i >= 0; i--) {
        const a = aliens[i];
        if (a.hurt > 0) a.hurt -= dt;

        if (a.state === 'enter') {
          a.enter += dt;
          const s = slotPos(a, t);
          const k = clamp(a.enter / 0.9, 0, 1);
          a.x = s.x;
          a.y = s.y - (1 - k * k) * 190;
          if (k >= 1) a.state = 'formation';
        } else if (a.state === 'formation') {
          const s = slotPos(a, t);
          a.x = s.x;
          a.y = s.y;
          // Dive-bombers peel off the formation and come at you directly.
          if (mode === 'dive' && a.dive <= 0 && api.rng.chance(dt * 0.09) && a.y < VIEW_H * 0.5) {
            a.state = 'dive';
            a.dive = 0;
            a.diveX = px;
            api.sfx('thrust', { vol: 0.28 });
          }
        } else {
          a.dive += dt;
          const speed = 150 + diff * 6;
          a.y += speed * dt;
          a.x += Math.sin(a.dive * 5) * 62 * dt + clamp(a.diveX - a.x, -1, 1) * 55 * dt;
          api.particles.emit({
            x: a.x, y: a.y - 6, life: 0.22, size: 2, color: TIERS[a.tier].color, glow: 6, drag: 2,
          });
          if (a.y > VIEW_H + 24) {
            // Loop back around to the top and rejoin the formation.
            a.state = 'formation';
            a.dive = 0;
            a.y = -30;
          }
        }

        if (a.y > FLOOR_Y && a.state !== 'dive') breached = true;
        // Ramming an invader hurts just as much as eating a bullet.
        if (alive && invuln <= 0 && dist2(a.x, a.y, px, py) < (a.r + PLAYER_R + 3) ** 2) {
          killAlien(a);
          hitPlayer();
          continue;
        }

        a.cd -= dt * (1 + diff * 0.05);
        if (a.cd <= 0 && a.y > 0 && a.y < py - 30 && eb.length < MAX_EB - 12) {
          const T = TIERS[a.tier];
          // Cooldowns stretch with the squadron size so a fat formation does
          // not multiply the curtain — density stays dodgeable at every wave.
          a.cd = api.rng.range(T.cd[0], T.cd[1])
            * clamp(aliens.length / 5, 1, 4) / (1 + diff * 0.06);
          alienFire(a, diff);
        }
      }
      if (breached) breach();
      if (!playing) return;

      /* ---------------------------------------------------------- boss   */
      if (boss) {
        if (boss.hurt > 0) boss.hurt -= dt;
        if (boss.entering) {
          boss.y += 70 * dt;
          if (boss.y >= 92) { boss.y = 92; boss.entering = false; }
        } else {
          boss.x = VIEW_W / 2 + Math.sin(api.time * (boss.phase ? 0.95 : 0.6)) * (VIEW_W / 2 - 60);
          boss.y = 92 + Math.sin(api.time * 0.8) * 14;
          if (!boss.phase && boss.hp < boss.maxHp * 0.5) {
            boss.phase = 1;
            api.sfx('alert');
            api.shakeScreen(8, 5);
            banner = { text: 'DREADNOUGHT ENRAGED', color: PAL.red, life: 1.6 };
          }
          bossFire(dt, diff);
          if (boss.hp <= 0) killBoss();
        }
      }

      /* -------------------------------------------------- enemy bullets  */
      for (let i = eb.length - 1; i >= 0; i--) {
        const b = eb[i];
        if (b.acc) {
          const sp = Math.hypot(b.vx, b.vy) || 1;
          b.vx += (b.vx / sp) * b.acc * dt;
          b.vy += (b.vy / sp) * b.acc * dt;
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        if (b.life <= 0 || b.y > VIEW_H + 16 || b.y < -40 || b.x < -20 || b.x > VIEW_W + 20) {
          eb.splice(i, 1);
          continue;
        }
        if (alive && invuln <= 0 && dist2(b.x, b.y, px, py) < (b.r + PLAYER_R) ** 2) {
          eb.splice(i, 1);
          hitPlayer();
          break;      // hitPlayer may wipe the curtain; restart next frame
        }
      }

      /* --------------------------------------------------------- drops   */
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        d.t += dt;
        d.life -= dt;
        d.y += d.vy * dt;
        d.x += Math.sin(d.t * 3) * 22 * dt;
        if (d.life <= 0 || d.y > VIEW_H + 12) { drops.splice(i, 1); continue; }
        if (dist2(d.x, d.y, px, py) < 18 * 18) {
          takePower(d);
          drops.splice(i, 1);
        }
      }

      /* ---------------------------------------------------- wave flow    */
      if (!playing) return;
      if (waveState === 'fight' && !boss && aliens.length === 0) {
        waveState = 'clear';
        waveTimer = 1.7;
        const bonus = 100 * wave;
        api.addScore(bonus);
        api.sfx('victory', { vol: 0.5 });
        banner = { text: 'WAVE CLEAR  +' + bonus, color: PAL.lime, life: 1.7 };
      } else if (waveState === 'clear') {
        waveTimer -= dt;
        if (waveTimer <= 0) {
          wave++;
          waveState = 'fight';
          buildWave(wave);
          if (wave % 5 === 1 && wave > 1) power.bombs = Math.min(4, power.bombs + 1);
          syncStatus();
        }
      }
    },

    handleInput(e) {
      if (e.type !== 'press' || !playing) return;
      if (e.action === 'b') smartBomb();
      if (e.action === 'a' && fireTimer > FIRE_HELD) fireTimer = 0; // snappy manual tap
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;

      /* ---- deep space ---- */
      vgrad(ctx, 0, 0, W, H, '#080413', '#03040a');
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = PAL.violet;
      ctx.beginPath();
      ctx.ellipse(W * 0.3, H * 0.22, W * 0.5, H * 0.2, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = PAL.blue;
      ctx.beginPath();
      ctx.ellipse(W * 0.75, H * 0.68, W * 0.42, H * 0.16, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
      stars.render(ctx, '#dff3ff');

      /* ---- drops ---- */
      for (const d of drops) {
        const p = POWERS[d.kind];
        const blink = d.life < 3 && Math.floor(d.life * 8) % 2 === 0;
        if (blink) continue;
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.rotate(d.t * 2.2);
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 14;
        ctx.strokeStyle = p.color;
        ctx.fillStyle = alpha(p.color, 0.25);
        ctx.lineWidth = 2;
        polygon(ctx, 0, 0, 8, 4);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        text(ctx, p.letter, d.x, d.y, {
          size: 8, color: PAL.white, align: 'center', baseline: 'middle',
        });
      }

      /* ---- invaders ---- */
      for (const a of aliens) drawInvader(ctx, a);
      if (boss) drawBoss(ctx);

      /* ---- beam ---- */
      if (power.beam > 0) {
        const flick = 0.7 + Math.random() * 0.3;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = alpha(PAL.violet, 0.32 * flick);
        ctx.fillRect(px - 7, 0, 14, py - 10);
        ctx.fillStyle = alpha(PAL.white, 0.85 * flick);
        ctx.fillRect(px - 2, 0, 4, py - 10);
        ctx.restore();
      }

      /* ---- player bullets ---- */
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const b of pb) {
        ctx.fillStyle = alpha(power.spread > 0 ? PAL.lime : PAL.cyan, 0.85);
        ctx.fillRect(b.x - 1.6, b.y - 7, 3.2, 12);
        ctx.fillStyle = PAL.white;
        ctx.fillRect(b.x - 0.7, b.y - 5, 1.4, 8);
      }
      ctx.restore();

      /* ---- enemy bullets: cheap two-pass draw, no per-bullet shadow ---- */
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const b of eb) {
        ctx.fillStyle = alpha(b.color, 0.4);
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 1.9, 0, TAU);
        ctx.fill();
      }
      for (const b of eb) {
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = alpha('#ffffff', 0.9);
      for (const b of eb) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 0.42, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      if (alive) drawShip(ctx);

      api.particles.render(ctx);

      /* ---- boss health bar ---- */
      if (boss && !boss.entering) {
        const bw = W - 60;
        ctx.fillStyle = alpha('#000000', 0.6);
        ctx.fillRect(30, 26, bw, 7);
        ctx.fillStyle = boss.phase ? PAL.red : PAL.violet;
        ctx.fillRect(30, 26, bw * clamp(boss.hp / boss.maxHp, 0, 1), 7);
        ctx.strokeStyle = alpha(PAL.white, 0.5);
        ctx.lineWidth = 1;
        ctx.strokeRect(30.5, 26.5, bw - 1, 6);
        text(ctx, 'DREADNOUGHT MK' + Math.ceil(wave / 5), W / 2, 15,
          { size: 8, color: boss.phase ? PAL.red : PAL.violet, align: 'center' });
      }

      /* ---- HUD ---- */
      text(ctx, 'WAVE ' + wave, 8, 8, { size: 10, color: PAL.cyan, glow: 6 });
      for (let i = 0; i < lives; i++) {
        const lx = W - 12 - i * 14;
        ctx.save();
        ctx.fillStyle = PAL.cyan;
        ctx.beginPath();
        ctx.moveTo(lx, 8);
        ctx.lineTo(lx - 5, 18);
        ctx.lineTo(lx + 5, 18);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // Active power-up state, bottom-left.
      let by = H - 12;
      if (power.beam > 0) {
        powerBar(ctx, 8, by, 'BEAM', power.beam / POWERS.beam.dur, PAL.violet);
        by -= 13;
      }
      if (power.spread > 0) {
        powerBar(ctx, 8, by, 'SPREAD', power.spread / POWERS.spread.dur, PAL.lime);
        by -= 13;
      }
      if (power.shield > 0) {
        powerBar(ctx, 8, by, 'SHIELD x' + power.shield, power.shield / POWERS.shield.hits, PAL.cyan);
        by -= 13;
      }
      text(ctx, 'BOMB x' + power.bombs, W - 8, H - 14,
        { size: 9, color: power.bombs > 0 ? PAL.orange : PAL.dim, align: 'right' });
      if (chain >= 5) {
        text(ctx, 'CHAIN x' + chain, W - 8, H - 26, { size: 9, color: PAL.yellow, align: 'right' });
      }

      /* ---- banner ---- */
      if (banner) {
        const a = clamp(banner.life / 0.6, 0, 1);
        ctx.save();
        ctx.globalAlpha = a;
        text(ctx, banner.text, W / 2, H * 0.34, {
          size: 15, color: banner.color, align: 'center', glow: 14,
        });
        ctx.restore();
      }

      /* ---- full-screen flashes ---- */
      if (bombFlash > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = alpha(PAL.white, bombFlash * 0.55);
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
        ctx.save();
        ctx.strokeStyle = alpha(PAL.orange, bombFlash);
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(px, py, (1 - bombFlash) * W * 1.2, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
      if (hitFlash > 0) {
        ctx.save();
        ctx.fillStyle = alpha(PAL.red, hitFlash * 0.3);
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    },

    destroy() {
      pb = eb = aliens = drops = null;
      boss = null;
    },
  };
}
