/**
 * 08 — TOP-DOWN ZOMBIE SURVIVAL
 *
 * Twin-stick horde defence. The signature trick is the floor layer: a single
 * offscreen canvas is created once in `init()` and *never cleared*, so every
 * blood splatter and every ejected shell stays exactly where it landed. Ten
 * waves in, the arena is a readable map of everything you have done to it —
 * and it costs one `drawImage` per frame.
 *
 * Four weapons with genuinely different jobs, four zombie archetypes, wave
 * pacing with a breather, and a horde that separates so bodies never stack.
 */

import { PAL, TAU, clamp, damp, alpha, dist, mix, text } from '../core/fx.js';

const VIEW = { w: 480, h: 360 };

const PLAYER_R = 8;
const PLAYER_SPEED = 132;
const MAX_HP = 100;
const MAX_ZOMBIES = 34;

/* --------------------------------------------------------------- weapons  */

const WEAPONS = [
  {
    id: 'PISTOL', color: PAL.cyan, dmg: 26, rate: 0.21, mag: 12, reload: 0.8,
    spread: 0.025, speed: 520, pellets: 1, kb: 70, life: 1.1, sfx: 'shoot',
    infinite: true, shake: 1.2, recoil: 26, r: 2,
  },
  {
    id: 'SHOTGUN', color: PAL.orange, dmg: 13, rate: 0.7, mag: 6, reload: 1.45,
    spread: 0.22, speed: 430, pellets: 8, kb: 260, life: 0.3, sfx: 'shotgun',
    shake: 8, recoil: 120, r: 2.2,
  },
  {
    id: 'RIFLE', color: PAL.lime, dmg: 15, rate: 0.085, mag: 30, reload: 1.6,
    spread: 0.03, speed: 640, pellets: 1, kb: 46, life: 1.1, sfx: 'laser',
    shake: 2, recoil: 34, r: 1.8, recoilSpread: 0.055,
  },
  {
    id: 'FLAMER', color: PAL.red, dmg: 5, rate: 0.035, mag: 120, reload: 2.1,
    spread: 0.3, speed: 205, pellets: 1, kb: 12, life: 0.42, sfx: 'thrust',
    shake: 0.6, recoil: 6, r: 4, burn: 2.6, flame: true,
  },
];

/* --------------------------------------------------------------- zombies  */

const ZTYPES = {
  shambler: { hp: 34, speed: 27, r: 8, dmg: 9, score: 10, color: PAL.green, kbTake: 1 },
  runner: { hp: 22, speed: 68, r: 7, dmg: 7, score: 16, color: PAL.lime, kbTake: 1.2 },
  brute: { hp: 135, speed: 25, r: 13, dmg: 22, score: 45, color: PAL.violet, kbTake: 0.22, push: 210 },
  spitter: { hp: 32, speed: 33, r: 8, dmg: 10, score: 28, color: PAL.magenta, kbTake: 1, ranged: true },
};

export const meta = {
  id: 'zombies',
  title: 'TOP-DOWN ZOMBIE SURVIVAL',
  short: 'ZOMBIES',
  category: 'SHOOTER',
  desc: 'Twin-stick horde survival with four weapons and four kinds of dead. '
      + 'Blood and brass never wash off — the floor keeps a permanent record '
      + 'of the whole run.',
  accent: PAL.red,
  view: VIEW,
  controls: [
    'WASD / STICK — move',
    'MOUSE / DRAG — aim',
    'SPACE — fire',
    'B / 1-4 — swap weapon',
    'C — reload',
  ],
  touch: {
    stick: true,
    buttons: [
      { id: 'a', label: 'FIRE' },
      { id: 'b', label: 'SWAP' },
      { id: 'c', label: 'RELOAD' },
    ],
  },
  art(ctx, w, h, accent) {
    ctx.save();
    ctx.fillStyle = '#0c0f14';
    ctx.fillRect(0, 0, w, h);
    // Tiled concrete.
    ctx.strokeStyle = '#161c26';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x += 24) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    for (let y = 0; y < h; y += 24) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
    ctx.stroke();
    // Dried blood.
    for (let i = 0; i < 40; i++) {
      const a = (i * 2.399) % TAU;
      const d = 12 + ((i * 37) % 70);
      const x = 120 + Math.cos(a) * d * 1.5;
      const y = 96 + Math.sin(a) * d;
      ctx.fillStyle = `rgba(${110 + (i % 40)},12,20,${0.25 + (i % 5) * 0.1})`;
      ctx.beginPath();
      ctx.arc(x, y, 3 + (i % 7), 0, TAU);
      ctx.fill();
    }
    // Zombies closing in.
    for (const [zx, zy, s] of [[46, 44, 9], [196, 52, 8], [206, 132, 10], [40, 128, 8]]) {
      ctx.fillStyle = PAL.green;
      ctx.shadowColor = PAL.green;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(zx, zy, s, 0, TAU);
      ctx.fill();
      ctx.fillStyle = PAL.red;
      ctx.fillRect(zx - 3, zy - 3, 2, 2);
      ctx.fillRect(zx + 1, zy - 3, 2, 2);
    }
    // Survivor + muzzle flash.
    ctx.shadowBlur = 14;
    ctx.fillStyle = PAL.white;
    ctx.shadowColor = PAL.white;
    ctx.beginPath();
    ctx.arc(120, 96, 10, 0, TAU);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.beginPath();
    ctx.moveTo(130, 92);
    ctx.lineTo(176, 84);
    ctx.lineTo(176, 104);
    ctx.lineTo(130, 100);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },
};

export function create(api) {
  /* ---------------------------------------------------------------- state */
  let floor = null;              // the persistent gore layer (offscreen canvas)
  let fctx = null;

  let player;
  let zombies, bullets, spits, drops, casings;
  let weapons;                   // per-weapon runtime ammo state
  let wIndex, reloadT, fireCd, muzzle, recoilSpread;
  let wave, waveState, waveTimer, spawnQueue, spawnTimer;
  let kills, shotsFired, shotsHit, over, statusT, hurtFlash;

  const W = () => api.w;
  const H = () => api.h;
  const gun = () => WEAPONS[wIndex];

  /* ------------------------------------------------------------ the floor */

  /** Bake the arena surface once; blood is painted on top of it forever. */
  function buildFloor() {
    const c = document.createElement('canvas');
    c.width = api.w;
    c.height = api.h;
    const g = c.getContext('2d');
    g.fillStyle = '#0b0e14';
    g.fillRect(0, 0, c.width, c.height);
    // Concrete slabs.
    for (let y = 0; y < c.height; y += 30) {
      for (let x = 0; x < c.width; x += 30) {
        g.fillStyle = api.rng.chance(0.5) ? '#0d111a' : '#0a0d15';
        g.fillRect(x, y, 29, 29);
      }
    }
    g.strokeStyle = '#141c2b';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= c.width; x += 30) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, c.height); }
    for (let y = 0; y <= c.height; y += 30) { g.moveTo(0, y + 0.5); g.lineTo(c.width, y + 0.5); }
    g.stroke();
    // Old stains and cracks so the arena never looks sterile.
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = alpha('#1b2536', api.rng.range(0.3, 0.8));
      g.lineWidth = api.rng.range(0.5, 1.6);
      const x = api.rng.range(0, c.width);
      const y = api.rng.range(0, c.height);
      g.beginPath();
      g.moveTo(x, y);
      let a = api.rng.angle();
      let cx = x;
      let cy = y;
      for (let s = 0; s < 4; s++) {
        a += api.rng.range(-0.9, 0.9);
        cx += Math.cos(a) * api.rng.range(6, 22);
        cy += Math.sin(a) * api.rng.range(6, 22);
        g.lineTo(cx, cy);
      }
      g.stroke();
    }
    // A faint hazard chevron border.
    g.fillStyle = alpha(PAL.yellow, 0.06);
    for (let x = -20; x < c.width; x += 20) {
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x + 10, 0); g.lineTo(x + 2, 8); g.lineTo(x - 8, 8);
      g.closePath(); g.fill();
      g.beginPath();
      g.moveTo(x, c.height - 8); g.lineTo(x + 10, c.height - 8);
      g.lineTo(x + 2, c.height); g.lineTo(x - 8, c.height);
      g.closePath(); g.fill();
    }
    return c;
  }

  /** Permanent blood. `dark` scales opacity — a kill leaves a much wider pool. */
  function splat(x, y, radius, n, dark) {
    if (!fctx) return;
    for (let i = 0; i < n; i++) {
      const a = api.rng.angle();
      const d = api.rng.range(0, radius);
      const r = api.rng.range(radius * 0.14, radius * 0.42);
      const red = 96 + api.rng.int(0, 70);
      fctx.fillStyle = `rgba(${red},${9 + api.rng.int(0, 16)},${14 + api.rng.int(0, 20)},${dark})`;
      fctx.beginPath();
      fctx.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d, r, r * api.rng.range(0.55, 1.3), a, 0, TAU);
      fctx.fill();
    }
  }

  function paintCasing(c) {
    if (!fctx) return;
    fctx.save();
    fctx.translate(c.x, c.y);
    fctx.rotate(c.rot);
    fctx.fillStyle = alpha('#d8b23c', 0.85);
    fctx.fillRect(-2.4, -0.9, 4.8, 1.8);
    fctx.fillStyle = alpha('#7d6520', 0.7);
    fctx.fillRect(1.4, -0.9, 1, 1.8);
    fctx.restore();
  }

  /* -------------------------------------------------------------- weapons */

  function resetWeapons() {
    weapons = WEAPONS.map((w, i) => ({
      ammo: i === 0 ? w.mag : 0,
      reserve: i === 0 ? Infinity : 0,
      owned: i === 0,
    }));
  }

  function ownedCount() {
    let n = 0;
    for (const w of weapons) if (w.owned) n++;
    return n;
  }

  function swapWeapon(dir = 1) {
    if (ownedCount() < 2) {
      api.sfx('deny', { vol: 0.6 });
      return;
    }
    let i = wIndex;
    for (let k = 0; k < WEAPONS.length; k++) {
      i = (i + dir + WEAPONS.length) % WEAPONS.length;
      if (weapons[i].owned) break;
    }
    if (i === wIndex) return;
    wIndex = i;
    reloadT = 0;
    fireCd = 0.12;
    recoilSpread = 0;
    api.sfx('select');
    pushStatus();
  }

  function selectWeapon(i) {
    if (i < 0 || i >= WEAPONS.length || !weapons[i].owned || i === wIndex) return;
    wIndex = i;
    reloadT = 0;
    fireCd = 0.12;
    recoilSpread = 0;
    api.sfx('select');
    pushStatus();
  }

  function startReload() {
    const w = gun();
    const st = weapons[wIndex];
    if (reloadT > 0 || st.ammo >= w.mag) return;
    if (!w.infinite && st.reserve <= 0) {
      api.sfx('deny', { vol: 0.6 });
      return;
    }
    reloadT = w.reload;
    api.sfx('rotate', { vol: 0.7 });
  }

  function finishReload() {
    const w = gun();
    const st = weapons[wIndex];
    const need = w.mag - st.ammo;
    if (w.infinite) {
      st.ammo = w.mag;
    } else {
      const take = Math.min(need, st.reserve);
      st.ammo += take;
      st.reserve -= take;
    }
    api.sfx('pickup', { vol: 0.6 });
    pushStatus();
  }

  function shoot() {
    const w = gun();
    const st = weapons[wIndex];
    if (reloadT > 0 || fireCd > 0) return;
    if (st.ammo <= 0) {
      startReload();
      if (reloadT <= 0) api.sfx('deny', { vol: 0.5 });
      return;
    }
    st.ammo--;
    fireCd = w.rate;
    // Accuracy is measured per projectile, and the flamer opts out entirely.
    if (!w.flame) shotsFired += w.pellets;

    const spread = w.spread + recoilSpread;
    for (let i = 0; i < w.pellets; i++) {
      const a = player.aim + api.rng.range(-spread, spread);
      const sp = w.speed * api.rng.range(0.86, 1.14);
      bullets.push({
        x: player.x + Math.cos(player.aim) * 12,
        y: player.y + Math.sin(player.aim) * 12,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: w.life * api.rng.range(0.85, 1.15),
        dmg: w.dmg,
        kb: w.kb,
        r: w.r,
        color: w.color,
        burn: w.burn || 0,
        flame: !!w.flame,
      });
    }

    // Recoil pushes the player and, for the rifle, opens the cone up.
    player.vx -= Math.cos(player.aim) * w.recoil;
    player.vy -= Math.sin(player.aim) * w.recoil;
    if (w.recoilSpread) recoilSpread = Math.min(0.2, recoilSpread + w.recoilSpread);

    muzzle.t = 0.06;
    muzzle.len = w.flame ? 6 : 10 + w.recoil * 0.08;
    api.shakeScreen(w.shake, 9);
    api.sfx(w.sfx, { vol: w.flame ? 0.35 : 1, detune: w.flame ? api.rng.range(-2, 2) : 0 });
    if (!w.flame) ejectCasing();
    if (st.ammo <= 0) startReload();
    pushStatus();
  }

  function ejectCasing() {
    if (casings.length > 46) casings.shift();
    const a = player.aim + Math.PI / 2 + api.rng.range(-0.4, 0.4);
    casings.push({
      x: player.x + Math.cos(player.aim) * 6,
      y: player.y + Math.sin(player.aim) * 6,
      vx: Math.cos(a) * api.rng.range(50, 110),
      vy: Math.sin(a) * api.rng.range(50, 110),
      z: 6,
      vz: api.rng.range(30, 70),
      rot: api.rng.angle(),
      vr: api.rng.range(-14, 14),
    });
  }

  /* -------------------------------------------------------------- horde   */

  function spawnZombie(kind) {
    if (zombies.length >= MAX_ZOMBIES) return;
    const t = ZTYPES[kind];
    const edge = api.rng.int(0, 3);
    let x;
    let y;
    if (edge === 0) { x = api.rng.range(0, W()); y = -18; }
    else if (edge === 1) { x = api.rng.range(0, W()); y = H() + 18; }
    else if (edge === 2) { x = -18; y = api.rng.range(0, H()); }
    else { x = W() + 18; y = api.rng.range(0, H()); }
    zombies.push({
      x, y, kind, hp: t.hp, max: t.hp, r: t.r,
      kx: 0, ky: 0, burn: 0, hitT: 0, atkCd: api.rng.range(0, 0.6),
      anim: api.rng.range(0, TAU), spitCd: api.rng.range(1, 2.5),
    });
  }

  /** Wave composition: new archetypes phase in, counts climb. */
  function buildWave(n) {
    const q = [];
    const total = Math.min(46, 6 + n * 3);
    const brutes = n >= 4 ? Math.min(6, 1 + Math.floor((n - 4) / 2)) : 0;
    const spitters = n >= 3 ? Math.min(7, 1 + Math.floor((n - 3) / 2)) : 0;
    const runners = n >= 2 ? Math.round(total * clamp(0.16 + n * 0.03, 0, 0.45)) : 0;
    for (let i = 0; i < brutes; i++) q.push('brute');
    for (let i = 0; i < spitters; i++) q.push('spitter');
    for (let i = 0; i < runners; i++) q.push('runner');
    while (q.length < total) q.push('shambler');
    return api.rng.shuffle(q);
  }

  function killZombie(z, i) {
    const t = ZTYPES[z.kind];
    kills++;
    api.addScore(t.score);
    splat(z.x, z.y, t.r * 2.6, 14, 0.5);
    splat(z.x, z.y, t.r * 5, 8, 0.22);
    api.particles.burst(z.x, z.y, 14, {
      speed: 150, life: 0.5, size: 2.6, color: ['#b7121f', '#7a0d16', t.color],
      glow: 4, drag: 2.4, additive: false,
    });
    api.sfx(z.kind === 'brute' ? 'boom' : 'hit', { detune: z.kind === 'runner' ? 5 : -3 });
    if (z.kind === 'brute') api.shakeScreen(6, 6);
    zombies.splice(i, 1);
    maybeDrop(z.x, z.y, z.kind);
  }

  function maybeDrop(x, y, kind) {
    const roll = api.rng.next();
    const bonus = kind === 'brute' ? 0.28 : 0;
    if (roll < 0.09 + bonus) {
      drops.push({ x, y, kind: 'health', t: 16, ph: 0 });
    } else if (roll < 0.24 + bonus) {
      // Ammo for a weapon you already carry.
      const own = [];
      for (let i = 0; i < weapons.length; i++) if (weapons[i].owned && !WEAPONS[i].infinite) own.push(i);
      if (own.length) drops.push({ x, y, kind: 'ammo', w: api.rng.pick(own), t: 18, ph: 0 });
    } else if (roll < 0.31 + bonus) {
      const locked = [];
      for (let i = 0; i < weapons.length; i++) if (!weapons[i].owned) locked.push(i);
      if (locked.length) drops.push({ x, y, kind: 'gun', w: api.rng.pick(locked), t: 22, ph: 0 });
    }
  }

  function takeDrop(d) {
    if (d.kind === 'health') {
      player.hp = Math.min(MAX_HP, player.hp + 32);
      api.sfx('powerup');
      api.particles.popText(d.x, d.y - 10, '+32 HP', PAL.green);
    } else if (d.kind === 'ammo') {
      const w = WEAPONS[d.w];
      weapons[d.w].reserve += w.mag * 3;
      api.sfx('pickup');
      api.particles.popText(d.x, d.y - 10, w.id + ' AMMO', w.color);
    } else {
      const w = WEAPONS[d.w];
      weapons[d.w].owned = true;
      weapons[d.w].ammo = w.mag;
      weapons[d.w].reserve += w.mag * 3;
      wIndex = d.w;
      reloadT = 0;
      api.sfx('powerup');
      api.particles.popText(d.x, d.y - 12, w.id + '!', w.color, 1.3);
    }
    api.addScore(15);
    pushStatus();
  }

  /* --------------------------------------------------------------- player */

  function hurtPlayer(amount, ax, ay) {
    if (over || player.inv > 0) return;
    player.hp -= amount;
    player.inv = 0.32;
    hurtFlash = 1;
    api.sfx('hurt');
    api.shakeScreen(7, 6);
    api.vibrate(60);
    const a = Math.atan2(player.y - ay, player.x - ax);
    player.vx += Math.cos(a) * 130;
    player.vy += Math.sin(a) * 130;
    splat(player.x, player.y, 12, 6, 0.35);
    api.particles.burst(player.x, player.y, 8, {
      speed: 120, life: 0.4, size: 2.4, color: ['#d81b2c', PAL.white], glow: 6, drag: 2.6, additive: false,
    });
    if (player.hp <= 0) {
      player.hp = 0;
      over = true;
      splat(player.x, player.y, 26, 26, 0.5);
      api.shakeScreen(16, 4);
      api.gameOver({
        message: 'DEVOURED ON WAVE ' + wave,
        stats: {
          WAVE: wave,
          KILLS: kills,
          ACCURACY: shotsFired ? Math.round((shotsHit / shotsFired) * 100) + '%' : '—',
        },
      });
    }
    pushStatus();
  }

  function pushStatus() {
    const st = weapons[wIndex];
    const w = gun();
    api.setStatus({
      WAVE: wave,
      HP: Math.max(0, Math.round(player.hp)),
      AMMO: `${st.ammo}/${w.infinite ? '∞' : st.reserve}`,
    });
  }

  /* -------------------------------------------------------------- drawing */

  function drawZombie(ctx, z) {
    const t = ZTYPES[z.kind];
    const bob = Math.sin(z.anim) * 1.6;
    const col = z.hitT > 0 ? PAL.white : (z.burn > 0 ? mix(t.color, PAL.orange, 0.6) : t.color);

    // Body.
    ctx.save();
    ctx.translate(z.x, z.y + bob);
    ctx.fillStyle = alpha('#000', 0.35);
    ctx.beginPath();
    ctx.ellipse(0, t.r * 0.7, t.r * 0.9, t.r * 0.4, 0, 0, TAU);
    ctx.fill();
    ctx.shadowColor = col;
    ctx.shadowBlur = z.hitT > 0 ? 14 : 6;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(0, 0, t.r, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Shambling arms.
    const sway = Math.sin(z.anim * 1.6) * 0.5;
    const a = Math.atan2(player.y - z.y, player.x - z.x);
    ctx.strokeStyle = mix(col, '#000000', 0.35);
    ctx.lineWidth = Math.max(2, t.r * 0.32);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a - 0.4 + sway) * t.r * 1.7, Math.sin(a - 0.4 + sway) * t.r * 1.7);
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a + 0.4 - sway) * t.r * 1.7, Math.sin(a + 0.4 - sway) * t.r * 1.7);
    ctx.stroke();
    // Eyes.
    ctx.fillStyle = z.kind === 'spitter' ? PAL.yellow : PAL.red;
    ctx.fillRect(Math.cos(a) * t.r * 0.5 - 2.5, Math.sin(a) * t.r * 0.5 - 2, 2, 2);
    ctx.fillRect(Math.cos(a) * t.r * 0.5 + 0.5, Math.sin(a) * t.r * 0.5 - 2, 2, 2);
    ctx.restore();

    // Health pip for anything tougher than a shambler.
    if (z.hp < z.max && t.hp > 34) {
      const w = t.r * 2.2;
      ctx.fillStyle = alpha('#000', 0.6);
      ctx.fillRect(z.x - w / 2, z.y - t.r - 7, w, 3);
      ctx.fillStyle = PAL.red;
      ctx.fillRect(z.x - w / 2, z.y - t.r - 7, w * (z.hp / z.max), 3);
    }
  }

  function drawPlayer(ctx) {
    const p = player;
    ctx.save();
    ctx.translate(p.x, p.y);
    // Shadow + body.
    ctx.fillStyle = alpha('#000', 0.4);
    ctx.beginPath();
    ctx.ellipse(0, 5, PLAYER_R, PLAYER_R * 0.5, 0, 0, TAU);
    ctx.fill();
    ctx.rotate(p.aim);
    const w = gun();
    // Weapon.
    ctx.fillStyle = w.color;
    ctx.shadowColor = w.color;
    ctx.shadowBlur = 8;
    ctx.fillRect(2, -2, 14, 4);
    if (w.id === 'SHOTGUN') ctx.fillRect(2, 1, 12, 2);
    ctx.shadowBlur = 0;
    // Torso.
    ctx.fillStyle = p.inv > 0 && Math.floor(p.inv * 30) % 2 ? PAL.red : PAL.white;
    ctx.shadowColor = PAL.cyan;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_R, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#0a1018';
    ctx.fillRect(-2, -PLAYER_R + 1, 3, PLAYER_R * 2 - 2);
    ctx.restore();

    // Muzzle flash.
    if (muzzle.t > 0) {
      const k = muzzle.t / 0.06;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.aim);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = k;
      ctx.fillStyle = w.color;
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(14 + muzzle.len, -muzzle.len * 0.5);
      ctx.lineTo(14 + muzzle.len * 1.5, 0);
      ctx.lineTo(14 + muzzle.len, muzzle.len * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawHud(ctx) {
    const w = gun();
    const st = weapons[wIndex];
    const hh = H();

    // Health bar.
    const bw = 108;
    ctx.fillStyle = alpha('#000', 0.55);
    ctx.fillRect(8, hh - 20, bw + 4, 12);
    ctx.fillStyle = alpha(PAL.red, 0.3);
    ctx.fillRect(10, hh - 18, bw, 8);
    const hp = clamp(player.hp / MAX_HP, 0, 1);
    ctx.fillStyle = hp > 0.5 ? PAL.green : (hp > 0.25 ? PAL.yellow : PAL.red);
    ctx.fillRect(10, hh - 18, bw * hp, 8);
    text(ctx, 'HP', 12, hh - 30, { size: 8, color: PAL.dim });

    // Weapon block.
    text(ctx, w.id, W() - 10, hh - 32, { size: 11, color: w.color, align: 'right', glow: 8 });
    const ammoStr = reloadT > 0
      ? 'RELOADING'
      : `${st.ammo} / ${w.infinite ? '∞' : st.reserve}`;
    text(ctx, ammoStr, W() - 10, hh - 19, {
      size: 10, color: st.ammo === 0 && reloadT <= 0 ? PAL.red : PAL.white, align: 'right',
    });
    if (reloadT > 0) {
      const p = 1 - reloadT / w.reload;
      ctx.fillStyle = alpha(w.color, 0.3);
      ctx.fillRect(W() - 88, hh - 8, 78, 4);
      ctx.fillStyle = w.color;
      ctx.fillRect(W() - 88, hh - 8, 78 * p, 4);
    }

    // Weapon slots.
    const sx = W() - 10 - WEAPONS.length * 16;
    for (let i = 0; i < WEAPONS.length; i++) {
      const owned = weapons[i].owned;
      ctx.fillStyle = i === wIndex ? WEAPONS[i].color : alpha(owned ? WEAPONS[i].color : PAL.dim, 0.3);
      ctx.fillRect(sx + i * 16, 10, 12, 4);
    }

    // Wave banner / breather countdown.
    if (waveState === 'breather') {
      const secs = Math.max(0, waveTimer);
      text(ctx, `WAVE ${wave + 1}`, W() / 2, H() * 0.36, {
        size: 22, color: PAL.red, align: 'center', baseline: 'middle', glow: 14,
      });
      text(ctx, secs.toFixed(1), W() / 2, H() * 0.36 + 22, {
        size: 14, color: PAL.white, align: 'center', baseline: 'middle',
      });
    } else {
      const left = spawnQueue.length + zombies.length;
      text(ctx, `WAVE ${wave}`, 10, 10, { size: 11, color: PAL.red, glow: 6 });
      text(ctx, `${left} LEFT`, 10, 24, { size: 9, color: PAL.dim });
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  return {
    init() {
      floor = buildFloor();
      fctx = floor.getContext('2d');

      player = {
        x: api.w / 2, y: api.h / 2, vx: 0, vy: 0,
        hp: MAX_HP, aim: -Math.PI / 2, inv: 0,
      };
      zombies = [];
      bullets = [];
      spits = [];
      drops = [];
      casings = [];
      resetWeapons();
      wIndex = 0;
      reloadT = 0;
      fireCd = 0;
      recoilSpread = 0;
      muzzle = { t: 0, len: 10 };
      wave = 0;
      waveState = 'breather';
      waveTimer = 3.5;
      spawnQueue = [];
      spawnTimer = 0;
      kills = 0;
      shotsFired = 0;
      shotsHit = 0;
      over = false;
      statusT = 0;
      hurtFlash = 0;
      pushStatus();
    },

    update(dt) {
      if (over) return;

      /* ---------------------------------------------------------- timers */
      if (fireCd > 0) fireCd -= dt;
      if (muzzle.t > 0) muzzle.t -= dt;
      if (player.inv > 0) player.inv -= dt;
      if (hurtFlash > 0) hurtFlash -= dt * 3;
      recoilSpread = Math.max(0, recoilSpread - dt * 0.28);
      if (reloadT > 0) {
        reloadT -= dt;
        if (reloadT <= 0) {
          reloadT = 0;
          finishReload();
        }
      }

      /* ----------------------------------------------------- player move */
      const st = api.input.stick;
      let mx = st.x;
      let my = st.y;
      const mm = Math.hypot(mx, my);
      if (mm > 1) { mx /= mm; my /= mm; }
      player.vx = damp(player.vx, mx * PLAYER_SPEED, 12, dt);
      player.vy = damp(player.vy, my * PLAYER_SPEED, 12, dt);
      player.x = clamp(player.x + player.vx * dt, PLAYER_R + 2, api.w - PLAYER_R - 2);
      player.y = clamp(player.y + player.vy * dt, PLAYER_R + 2, api.h - PLAYER_R - 2);

      /* ----------------------------------------------------------- aim   */
      const p = api.input.pointer;
      if (api.isTouch) {
        // Stick steers the gun; the last touched point takes over when idle.
        if (mm > 0.25) player.aim = Math.atan2(my, mx);
        else if (p.inside) player.aim = Math.atan2(p.y - player.y, p.x - player.x);
      } else if (p.inside || p.down) {
        player.aim = Math.atan2(p.y - player.y, p.x - player.x);
      } else if (mm > 0.25) {
        player.aim = Math.atan2(my, mx);
      }

      /* ---------------------------------------------------------- firing */
      if (api.input.isDown('a') || p.down) shoot();

      /* --------------------------------------------------------- casings */
      for (let i = casings.length - 1; i >= 0; i--) {
        const c = casings[i];
        c.vz -= 420 * dt;
        c.z += c.vz * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.rot += c.vr * dt;
        c.vx *= Math.exp(-3 * dt);
        c.vy *= Math.exp(-3 * dt);
        if (c.z <= 0) {
          // Landed: burn it into the floor layer forever.
          paintCasing(c);
          casings.splice(i, 1);
        }
      }

      /* --------------------------------------------------------- bullets */
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.life -= dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        if (b.flame) {
          b.r += 26 * dt;
          b.vx *= Math.exp(-1.6 * dt);
          b.vy *= Math.exp(-1.6 * dt);
          if (api.rng.chance(0.5)) {
            api.particles.emit({
              x: b.x, y: b.y, vx: b.vx * 0.3, vy: b.vy * 0.3,
              life: 0.28, size: b.r * 0.9, color: api.rng.pick([PAL.orange, PAL.yellow, PAL.red]),
              glow: 8, drag: 2, shrink: 8, shape: 'circle',
            });
          }
        }
        let dead = b.life <= 0 || b.x < -10 || b.y < -10 || b.x > api.w + 10 || b.y > api.h + 10;

        // `spent` stops a flame puff from re-damaging every frame it lingers.
        if (!dead && !b.spent) {
          for (let j = zombies.length - 1; j >= 0; j--) {
            const z = zombies[j];
            if (dist(b.x, b.y, z.x, z.y) > z.r + b.r) continue;
            const t = ZTYPES[z.kind];
            z.hp -= b.dmg;
            z.hitT = 0.08;
            if (b.burn) z.burn = Math.max(z.burn, b.burn);
            const a = Math.atan2(b.vy, b.vx);
            z.kx += Math.cos(a) * b.kb * t.kbTake;
            z.ky += Math.sin(a) * b.kb * t.kbTake;
            if (b.flame) {
              b.spent = true;
              api.particles.burst(b.x, b.y, 4, {
                speed: 70, life: 0.3, size: 2.4, color: [PAL.orange, PAL.yellow],
                glow: 8, drag: 2.5, shape: 'circle',
              });
            } else {
              shotsHit++;
              splat(b.x, b.y, 5 + b.dmg * 0.2, 4, 0.3);
              api.particles.burst(b.x, b.y, 4, {
                speed: 90, life: 0.28, size: 2, dir: a, spread: 2,
                color: ['#c4111f', '#ff5566'], glow: 4, drag: 3, additive: false,
              });
            }
            if (z.hp <= 0) killZombie(z, j);
            if (!b.flame) { dead = true; break; }
            break;
          }
        }
        if (dead) bullets.splice(i, 1);
      }

      /* ------------------------------------------------------------ spit */
      for (let i = spits.length - 1; i >= 0; i--) {
        const s = spits[i];
        s.life -= dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (dist(s.x, s.y, player.x, player.y) < PLAYER_R + 4) {
          hurtPlayer(ZTYPES.spitter.dmg, s.x, s.y);
          splat(s.x, s.y, 9, 5, 0.28);
          spits.splice(i, 1);
          if (over) return;
        } else if (s.life <= 0) {
          splat(s.x, s.y, 8, 4, 0.2);
          spits.splice(i, 1);
        }
      }

      /* --------------------------------------------------------- zombies */
      for (let i = zombies.length - 1; i >= 0; i--) {
        const z = zombies[i];
        const t = ZTYPES[z.kind];
        z.anim += dt * (2 + t.speed * 0.06);
        if (z.hitT > 0) z.hitT -= dt;
        if (z.burn > 0) {
          z.burn -= dt;
          z.hp -= 16 * dt;
          if (api.rng.chance(dt * 12)) {
            api.particles.emit({
              x: z.x + api.rng.range(-4, 4), y: z.y + api.rng.range(-4, 4),
              vy: -30, life: 0.3, size: 2.5, color: PAL.orange, glow: 8, drag: 1.5, shape: 'circle',
            });
          }
          if (z.hp <= 0) { killZombie(z, i); continue; }
        }

        const a = Math.atan2(player.y - z.y, player.x - z.x);
        const d = dist(z.x, z.y, player.x, player.y);

        // Spitters hold their range and lob acid.
        let move = 1;
        if (t.ranged) {
          if (d < 110) move = -0.7;
          else if (d < 185) move = 0.12;
          z.spitCd -= dt;
          if (z.spitCd <= 0 && d < 230) {
            z.spitCd = api.rng.range(1.8, 3);
            const sp = 190;
            spits.push({
              x: z.x + Math.cos(a) * z.r, y: z.y + Math.sin(a) * z.r,
              vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1.6,
            });
            api.sfx('splash', { vol: 0.4 });
          }
        }

        z.x += (Math.cos(a) * t.speed * move + z.kx) * dt;
        z.y += (Math.sin(a) * t.speed * move + z.ky) * dt;
        const kd = Math.exp(-7 * dt);
        z.kx *= kd;
        z.ky *= kd;

        // Separation so the horde spreads instead of stacking into one dot.
        for (let j = i - 1; j >= 0; j--) {
          const o = zombies[j];
          const dx = z.x - o.x;
          const dy = z.y - o.y;
          const need = z.r + o.r;
          const d2 = dx * dx + dy * dy;
          if (d2 > need * need || d2 < 0.0001) continue;
          const dd = Math.sqrt(d2);
          const push = (need - dd) * 0.5;
          const ux = dx / dd;
          const uy = dy / dd;
          z.x += ux * push;
          z.y += uy * push;
          o.x -= ux * push;
          o.y -= uy * push;
        }

        // Contact damage.
        z.atkCd -= dt;
        if (!t.ranged && d < z.r + PLAYER_R && z.atkCd <= 0) {
          z.atkCd = 0.85;
          hurtPlayer(t.dmg, z.x, z.y);
          if (t.push) {
            const pa = Math.atan2(player.y - z.y, player.x - z.x);
            player.vx += Math.cos(pa) * t.push;
            player.vy += Math.sin(pa) * t.push;
          }
          if (over) return;
        }
      }

      /* ----------------------------------------------------------- drops */
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        d.t -= dt;
        d.ph += dt * 4;
        if (dist(d.x, d.y, player.x, player.y) < PLAYER_R + 9) {
          takeDrop(d);
          drops.splice(i, 1);
        } else if (d.t <= 0) {
          drops.splice(i, 1);
        }
      }

      /* ------------------------------------------------------------ wave */
      if (waveState === 'breather') {
        waveTimer -= dt;
        if (waveTimer <= 0) {
          wave++;
          spawnQueue = buildWave(wave);
          spawnTimer = 0;
          waveState = 'active';
          api.sfx('alert');
          pushStatus();
        }
      } else {
        spawnTimer -= dt;
        if (spawnQueue.length && spawnTimer <= 0 && zombies.length < MAX_ZOMBIES) {
          spawnZombie(spawnQueue.pop());
          spawnTimer = clamp(0.85 - wave * 0.045, 0.2, 0.9) * api.rng.range(0.6, 1.4);
        }
        if (!spawnQueue.length && !zombies.length) {
          waveState = 'breather';
          waveTimer = 5;
          api.addScore(120 + wave * 40);
          api.sfx('levelup');
          api.particles.popText(api.w / 2, api.h * 0.5, 'WAVE ' + wave + ' CLEARED', PAL.yellow, 1.6);
          // A guaranteed medkit between waves keeps long runs survivable.
          drops.push({ x: api.rng.range(60, api.w - 60), y: api.rng.range(60, api.h - 60), kind: 'health', t: 24, ph: 0 });
        }
      }

      /* ---------------------------------------------------------- status */
      statusT -= dt;
      if (statusT <= 0) {
        statusT = 0.25;
        pushStatus();
      }
    },

    handleInput(e) {
      if (e.type === 'press') {
        if (e.action === 'b') swapWeapon(1);
        else if (e.action === 'c') startReload();
        else if (e.action === 'a') shoot();
      } else if (e.type === 'key' && !e.repeat) {
        if (e.code === 'KeyR') startReload();
        else if (e.code === 'KeyQ') swapWeapon(-1);
        else if (e.code.startsWith('Digit')) selectWeapon(parseInt(e.code.slice(5), 10) - 1);
      } else if (e.type === 'pointerdown') {
        // Tapping the arena both aims and fires.
        player.aim = Math.atan2(e.y - player.y, e.x - player.x);
        shoot();
      }
    },

    render(ctx) {
      const w = api.w;
      const h = api.h;

      // The permanent floor: arena surface + every splatter and casing so far.
      if (floor) ctx.drawImage(floor, 0, 0);
      else { ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, w, h); }

      // Drops.
      for (const d of drops) {
        const blink = d.t < 4 && Math.floor(d.t * 8) % 2 === 0;
        if (blink) continue;
        const bob = Math.sin(d.ph) * 2;
        if (d.kind === 'health') {
          ctx.save();
          ctx.shadowColor = PAL.green;
          ctx.shadowBlur = 12;
          ctx.fillStyle = PAL.white;
          ctx.fillRect(d.x - 7, d.y - 5 + bob, 14, 10);
          ctx.fillStyle = PAL.green;
          ctx.fillRect(d.x - 1.5, d.y - 3.5 + bob, 3, 7);
          ctx.fillRect(d.x - 5, d.y - 1.5 + bob, 10, 3);
          ctx.restore();
        } else {
          const wc = WEAPONS[d.w].color;
          ctx.save();
          ctx.shadowColor = wc;
          ctx.shadowBlur = 12;
          ctx.fillStyle = alpha('#101722', 0.95);
          ctx.fillRect(d.x - 9, d.y - 6 + bob, 18, 12);
          ctx.strokeStyle = wc;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(d.x - 9, d.y - 6 + bob, 18, 12);
          ctx.restore();
          text(ctx, d.kind === 'gun' ? WEAPONS[d.w].id[0] : 'A', d.x, d.y + bob,
            { size: 9, color: wc, align: 'center', baseline: 'middle' });
        }
      }

      // Casings still in the air.
      ctx.save();
      for (const c of casings) {
        ctx.save();
        ctx.translate(c.x, c.y - c.z);
        ctx.rotate(c.rot);
        ctx.fillStyle = '#f0cf62';
        ctx.fillRect(-2.4, -0.9, 4.8, 1.8);
        ctx.restore();
      }
      ctx.restore();

      for (const z of zombies) drawZombie(ctx, z);

      // Acid.
      ctx.save();
      ctx.shadowColor = PAL.magenta;
      ctx.shadowBlur = 8;
      ctx.fillStyle = PAL.magenta;
      for (const s of spits) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 3.5, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      if (!over) drawPlayer(ctx);

      // Bullets (flames are handled by the particle system).
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const b of bullets) {
        if (b.flame) continue;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = b.r;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - b.vx * 0.014, b.y - b.vy * 0.014);
        ctx.stroke();
      }
      ctx.restore();

      api.particles.render(ctx);

      // Damage vignette.
      if (hurtFlash > 0) {
        ctx.save();
        ctx.globalAlpha = clamp(hurtFlash, 0, 1) * 0.4;
        ctx.fillStyle = PAL.red;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }

      drawHud(ctx);
    },

    destroy() {
      floor = null;
      fctx = null;
      zombies = bullets = spits = drops = casings = null;
    },
  };
}
