/**
 * 13 — PSEUDO-3D HIGHWAY RACER
 *
 * A genuine OutRun-style road engine. The track is a list of segments, each
 * carrying a `curve` (how far the far edge slides sideways) and a world-space
 * `y` (elevation). The camera floats a fixed height above the road surface and
 * every segment endpoint is projected with the classic
 *
 *     scale = cameraDepth / (worldZ - cameraZ)
 *
 * then painted back-to-front as a trapezoid quad with rumble strips, lane
 * markers and grass. Curves are faked exactly the way the 1986 cabinets faked
 * them — by accumulating a sideways offset per segment — which is why the
 * horizon swings and centrifugal force throws you to the outside.
 */

import { PAL, TAU, clamp, lerp, damp, mix, alpha, text } from '../core/fx.js';

/* ----------------------------------------------------------------- tuning */

const VIEW_W = 480;
const VIEW_H = 360;

const SEG_LEN = 200;        // world units per road segment
const RUMBLE_LEN = 5;       // segments per rumble/colour block
const ROAD_WIDTH = 2000;    // half-width of the tarmac in world units
const LANES = 3;
const CAMERA_HEIGHT = 1150; // camera altitude above the road surface
const FOV = 100;            // degrees
const DRAW_DIST = 130;      // segments drawn ahead of the camera
const FOG_DENSITY = 4.2;

const MAX_SPEED = 12000;             // world units / second
const ACCEL = MAX_SPEED / 4.5;
const BRAKING = -MAX_SPEED / 1.3;
const DECEL = -MAX_SPEED / 7;
const OFF_DECEL = -MAX_SPEED / 1.5;  // dirt is *punishing*
const OFF_LIMIT = MAX_SPEED / 3.6;   // speed the dirt drags you down to
const CENTRIFUGAL = 0.34;

const TRACK_SEGS = 1500;             // minimum built length before padding
const CP_SEGS = 260;                 // segments between checkpoint gates
const CP_DIST = CP_SEGS * SEG_LEN;
const CP_BONUS = 9;                  // seconds granted per gate
const START_TIME = 32;

const TRAFFIC = 26;
const CAR_W = 1100;                  // traffic car width in world units
const CAR_OFF = CAR_W / ROAD_WIDTH;  // ...expressed in road-offset units

/* Section shapes used by the procedural track builder. */
const LEN = { SHORT: 26, MEDIUM: 52, LONG: 100 };
const CURVE = { EASY: 2, MEDIUM: 4.5, HARD: 7.5 };
const HILL = { LOW: 18, MEDIUM: 34, HIGH: 56 };

/* --------------------------------------------------------------- palettes */

const FOG_COLOR = '#0a1230';

/** Pre-bake a depth ramp so per-frame fog costs an array lookup, not a mix(). */
function fogRamp(base) {
  const out = new Array(DRAW_DIST);
  for (let i = 0; i < DRAW_DIST; i++) {
    const z = i / DRAW_DIST;
    out[i] = mix(base, FOG_COLOR, 1 - Math.exp(-FOG_DENSITY * z * z));
  }
  return out;
}

const PAL_LIGHT = {
  road: fogRamp('#2c3149'), grass: fogRamp('#0e3a2e'),
  rumble: fogRamp('#ff3ea5'), lane: fogRamp('#e8f4ff'),
};
const PAL_DARK = {
  road: fogRamp('#242940'), grass: fogRamp('#0b3128'),
  rumble: fogRamp('#eaf6ff'), lane: null,
};
const PAL_GATE = {
  road: fogRamp('#4c5170'), grass: fogRamp('#14513c'),
  rumble: fogRamp('#ffd53d'), lane: fogRamp('#ffd53d'),
};

/* ------------------------------------------------------------- projection */

const easeIn = (a, b, p) => a + (b - a) * p * p;
const easeInOut = (a, b, p) => a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5);
const increase = (start, inc, max) => {
  let r = (start + inc) % max;
  while (r < 0) r += max;
  return r;
};

/** Project one road point into screen space. Mutates `p.camera` / `p.screen`. */
function project(p, camX, camY, camZ, camDepth) {
  const c = p.camera;
  const s = p.screen;
  c.x = p.world.x - camX;
  c.y = p.world.y - camY;
  c.z = p.world.z - camZ;
  s.scale = camDepth / (c.z <= 0.001 ? 0.001 : c.z);
  s.x = Math.round(VIEW_W / 2 + (s.scale * c.x * VIEW_W) / 2);
  s.y = Math.round(VIEW_H / 2 - (s.scale * c.y * VIEW_H) / 2);
  s.w = Math.round((s.scale * ROAD_WIDTH * VIEW_W) / 2);
}

function quad(ctx, x1, y1, x2, y2, x3, y3, x4, y4, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.lineTo(x4, y4);
  ctx.closePath();
  ctx.fill();
}

/** Do two road-space spans overlap? Offsets and widths are in road units. */
function overlap(x1, w1, x2, w2, pct = 0.85) {
  const h = pct / 2;
  return !(x1 + w1 * h < x2 - w2 * h || x1 - w1 * h > x2 + w2 * h);
}

/* ------------------------------------------------------------------- meta */

export const meta = {
  id: 'racer',
  title: 'PSEUDO-3D HIGHWAY RACER',
  short: 'HIGHWAY',
  category: 'SPORTS',
  desc: 'A scanline-era pseudo-3D road engine: real projected segments, swinging '
      + 'curves, hills, dips and traffic to weave through before the clock dies.',
  accent: PAL.magenta,
  view: { w: VIEW_W, h: VIEW_H },
  controls: [
    'LEFT / RIGHT — steer',
    'UP or A — accelerate',
    'DOWN or B — brake',
    'CHECKPOINTS — add time',
  ],
  touch: {
    buttons: [
      { id: 'left', label: '◀' },
      { id: 'right', label: '▶' },
      { id: 'a', label: 'GAS' },
      { id: 'b', label: 'BRAKE' },
    ],
  },
  art(ctx, w, h, accent) {
    const hz = h * 0.42;
    // Dusk sky.
    const g = ctx.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, '#160b33');
    g.addColorStop(1, '#5a1f5e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, hz);
    // Sun.
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(w * 0.62, hz - 14, 22, 0, Math.PI * 2);
    ctx.fill();
    // Hills.
    ctx.fillStyle = '#132a3f';
    ctx.beginPath();
    ctx.moveTo(0, hz);
    for (let x = 0; x <= w; x += 10) ctx.lineTo(x, hz - 10 - Math.sin(x * 0.045) * 9);
    ctx.lineTo(w, hz);
    ctx.closePath();
    ctx.fill();
    // Grass + road trapezoid.
    ctx.fillStyle = '#0d3a2c';
    ctx.fillRect(0, hz, w, h - hz);
    const vx = w * 0.5;
    ctx.fillStyle = '#2c3149';
    ctx.beginPath();
    ctx.moveTo(vx - 8, hz);
    ctx.lineTo(vx + 8, hz);
    ctx.lineTo(w * 1.05, h);
    ctx.lineTo(-w * 0.05, h);
    ctx.closePath();
    ctx.fill();
    // Rumble strips.
    for (let i = 0; i < 5; i++) {
      const t0 = i / 5;
      const t1 = (i + 0.5) / 5;
      const yy0 = hz + (h - hz) * t0 * t0;
      const yy1 = hz + (h - hz) * t1 * t1;
      const hw0 = 8 + (w * 0.55 - 8) * t0 * t0;
      const hw1 = 8 + (w * 0.55 - 8) * t1 * t1;
      ctx.fillStyle = i % 2 ? '#eaf6ff' : accent;
      ctx.fillRect(vx - hw0 - 5, yy0, 6, yy1 - yy0 + 2);
      ctx.fillRect(vx + hw0 - 1, yy0, 6, yy1 - yy0 + 2);
      ctx.fillStyle = '#e8f4ff';
      ctx.fillRect(vx - 2, yy0, 4, (yy1 - yy0) * 0.7);
    }
    // Player car.
    ctx.fillStyle = '#ffd53d';
    ctx.fillRect(vx - 26, h - 34, 52, 18);
    ctx.fillStyle = '#0a0f1c';
    ctx.fillRect(vx - 18, h - 30, 36, 8);
    ctx.fillStyle = PAL.red;
    ctx.fillRect(vx - 24, h - 22, 9, 5);
    ctx.fillRect(vx + 15, h - 22, 9, 5);
  },
};

/* ------------------------------------------------------------------ game  */

export function create(api) {
  const cameraDepth = 1 / Math.tan(((FOV / 2) * Math.PI) / 180);
  const PLAYER_Z = CAMERA_HEIGHT * cameraDepth;

  let segments;         // the whole track
  let trackLength;
  let cars;             // AI traffic, flat list (also indexed into segment.cars)
  let position;         // camera Z along the track (wraps)
  let traveled;         // total distance this run (never wraps)
  let speed, playerX;   // playerX in road units: -1..1 is tarmac
  let playerY;          // road surface height under the camera
  let timer, checkpoint, overtakes, offRoad, over;
  let hum, hillShift, steerVis, bump, cpFlash, hitFlash, scoreAcc, statusT;
  let skyGrad;

  const findSegment = (z) => segments[Math.floor(z / SEG_LEN) % segments.length];

  /* ------------------------------------------------------------- building */

  const lastY = () => (segments.length ? segments[segments.length - 1].p2.world.y : 0);

  function addSegment(curve, y) {
    const n = segments.length;
    segments.push({
      index: n,
      p1: { world: { x: 0, y: lastY(), z: n * SEG_LEN }, camera: {}, screen: {} },
      p2: { world: { x: 0, y, z: (n + 1) * SEG_LEN }, camera: {}, screen: {} },
      curve,
      cars: [],
      gate: false,
      pylon: n % 12 === 0,
      pal: Math.floor(n / RUMBLE_LEN) % 2 ? PAL_DARK : PAL_LIGHT,
      clip: 0,
      fog: 0,
      looped: false,
    });
  }

  /** Ease into a curve/hill, hold it, ease back out — the OutRun section shape. */
  function addRoad(enter, hold, leave, curve, y) {
    const startY = lastY();
    const endY = startY + y * SEG_LEN;
    const total = enter + hold + leave;
    for (let n = 0; n < enter; n++) {
      addSegment(easeIn(0, curve, n / enter), easeInOut(startY, endY, n / total));
    }
    for (let n = 0; n < hold; n++) {
      addSegment(curve, easeInOut(startY, endY, (enter + n) / total));
    }
    for (let n = 0; n < leave; n++) {
      addSegment(easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n) / total));
    }
  }

  function buildTrack() {
    segments = [];
    addRoad(24, LEN.MEDIUM, 24, 0, 0); // clean launch straight

    while (segments.length < TRACK_SEGS) {
      const roll = api.rng.next();
      const dir = api.rng.sign();
      const hill = api.rng.chance(0.45)
        ? api.rng.sign() * api.rng.pick([HILL.LOW, HILL.MEDIUM, HILL.HIGH])
        : 0;
      if (roll < 0.24) {
        // Straight, possibly rolling over a crest or dropping into a dip.
        addRoad(20, api.rng.pick([LEN.SHORT, LEN.MEDIUM, LEN.LONG]), 20, 0, hill);
      } else if (roll < 0.52) {
        addRoad(28, LEN.MEDIUM, 28, dir * CURVE.EASY, hill * 0.6);
      } else if (roll < 0.8) {
        addRoad(24, LEN.MEDIUM, 24, dir * CURVE.MEDIUM, hill * 0.4);
      } else {
        // Sharp switchback — the ones that need a lift off the gas.
        addRoad(18, LEN.SHORT, 18, dir * CURVE.HARD, 0);
        addRoad(18, LEN.SHORT, 18, -dir * CURVE.HARD, 0);
      }
    }

    // Bring the elevation home so the loop seam is invisible, then pad the
    // length out to a whole number of checkpoint blocks.
    addRoad(24, 32, 24, 0, -lastY() / SEG_LEN);
    while (segments.length % CP_SEGS !== 0) addSegment(0, lastY());

    trackLength = segments.length * SEG_LEN;

    // Checkpoint gates land on exact multiples of CP_SEGS, which is why the
    // padding above matters: `traveled / CP_DIST` then always agrees with the
    // gate you just drove through, lap after lap.
    for (let i = 0; i < segments.length; i += CP_SEGS) {
      for (let k = 0; k < 3; k++) {
        const s = segments[i + k];
        if (s) { s.pal = PAL_GATE; s.gate = k === 0; }
      }
    }
  }

  function resetTraffic() {
    cars = [];
    for (let i = 0; i < TRAFFIC; i++) {
      const lane = api.rng.int(0, LANES - 1);
      const car = {
        offset: (lane / (LANES - 1)) * 1.4 - 0.7,
        z: Math.floor(api.rng.next() * segments.length) * SEG_LEN,
        speed: MAX_SPEED * api.rng.range(0.26, 0.58),
        color: api.rng.pick([PAL.cyan, PAL.lime, PAL.violet, PAL.orange, PAL.blue, PAL.pink]),
        seg: null,
        passed: true,
        swerve: 0,
      };
      car.seg = findSegment(car.z);
      car.seg.cars.push(car);
      cars.push(car);
    }
  }

  /* ---------------------------------------------------------------- logic */

  function finish(reason) {
    if (over) return;
    over = true;
    if (hum) { hum.stop(); hum = null; }
    api.shakeScreen(10, 5);
    const km = traveled / 1000;
    const speedBonus = Math.round((traveled / Math.max(1, api.time) / MAX_SPEED) * 900);
    api.addScore(speedBonus);
    api.gameOver({
      message: reason,
      stats: {
        DISTANCE: km.toFixed(2) + ' km',
        CHECKPOINTS: checkpoint,
        OVERTAKES: overtakes,
        'SPEED BONUS': speedBonus,
      },
    });
  }

  function hitCar(car) {
    hitFlash = 0.4;
    speed = Math.max(MAX_SPEED * 0.12, Math.min(speed, car.speed) * 0.4);
    position = increase(car.z, -PLAYER_Z * 1.15, trackLength);
    api.sfx('hit');
    api.shakeScreen(11, 6);
    api.vibrate(90);
    api.particles.burst(VIEW_W / 2 + playerX * 60, VIEW_H - 60, 16, {
      speed: 200, life: 0.5, size: 3, color: [PAL.orange, PAL.yellow, PAL.white],
      glow: 10, drag: 2.5, gravity: 220,
    });
  }

  /** Traffic drifts along its lane and flinches away from a car on its tail. */
  function updateTraffic(dt) {
    const playerZ = position + PLAYER_Z;
    for (const car of cars) {
      const oldSeg = car.seg;

      // Look a little way ahead; nudge sideways if something is in the way.
      let steer = 0;
      const ahead = findSegment(car.z + SEG_LEN * 6);
      for (const other of ahead.cars) {
        if (other !== car && overlap(car.offset, CAR_OFF, other.offset, CAR_OFF, 1.3)) {
          steer = other.offset > car.offset ? -1 : 1;
        }
      }
      // Player pressure: if we are close behind and lined up, it gets out of the way.
      let rel = car.z - playerZ;
      if (rel > trackLength / 2) rel -= trackLength;
      if (rel < -trackLength / 2) rel += trackLength;
      if (rel > 0 && rel < SEG_LEN * 12 && overlap(car.offset, CAR_OFF, playerX, CAR_OFF, 1.6)) {
        steer = playerX > car.offset ? -1 : 1;
      }
      car.swerve = damp(car.swerve, steer, 3, dt);
      car.offset = clamp(car.offset + car.swerve * dt * 0.55, -0.82, 0.82);

      car.z = increase(car.z, dt * car.speed, trackLength);

      // Overtake bookkeeping: `passed` flips once we get a full segment past it.
      if (!car.passed && rel < -SEG_LEN * 0.6) {
        car.passed = true;
        overtakes++;
        api.addScore(30);
        api.sfx('blip', { vol: 0.5 });
        api.particles.popText(VIEW_W / 2, VIEW_H - 110, '+30', PAL.lime, 0.7);
      } else if (car.passed && rel > SEG_LEN * 4) {
        car.passed = false;
      }

      const newSeg = findSegment(car.z);
      if (newSeg !== oldSeg) {
        const i = oldSeg.cars.indexOf(car);
        if (i >= 0) oldSeg.cars.splice(i, 1);
        newSeg.cars.push(car);
        car.seg = newSeg;
      }
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  return {
    init() {
      buildTrack();
      resetTraffic();
      position = 0;
      traveled = 0;
      speed = 0;
      playerX = 0;
      playerY = 0;
      timer = START_TIME;
      checkpoint = 0;
      overtakes = 0;
      offRoad = false;
      over = false;
      hillShift = 0;
      steerVis = 0;
      bump = 0;
      cpFlash = 0;
      hitFlash = 0;
      scoreAcc = 0;
      statusT = -1;
      skyGrad = null;
      hum = api.audio.motorHum(46);
      api.setStatus({ TIME: Math.ceil(timer), KM: '0.00', PASSED: 0 });
    },

    update(dt) {
      if (over) return;

      const playerSeg = findSegment(position + PLAYER_Z);
      const speedPct = speed / MAX_SPEED;
      const dx = dt * 2.6 * speedPct;

      /* --- driving ------------------------------------------------------ */
      const steer = api.input.axis('left', 'right');
      const gas = api.input.isDown('a') || api.input.isDown('up');
      const brake = api.input.isDown('b') || api.input.isDown('down');

      position = increase(position, dt * speed, trackLength);
      traveled += dt * speed;

      playerX += steer * dx;
      steerVis = damp(steerVis, steer, 9, dt);

      // Centrifugal force: the faster you take a curve, the harder it throws
      // you at the outside rumble strip.
      playerX -= dx * speedPct * playerSeg.curve * CENTRIFUGAL;

      if (gas) speed += ACCEL * dt;
      else if (brake) speed += BRAKING * dt;
      else speed += DECEL * dt;

      /* --- off-road ----------------------------------------------------- */
      offRoad = Math.abs(playerX) > 1;
      if (offRoad) {
        if (speed > OFF_LIMIT) speed += OFF_DECEL * dt;
        api.shakeScreen(1.6 + speedPct * 5, 16);
        bump = Math.sin(api.time * 42) * (2 + speedPct * 5);
        if (speed > MAX_SPEED * 0.1 && api.rng.chance(dt * 26)) {
          api.particles.emit({
            x: VIEW_W / 2 + Math.sign(playerX) * api.rng.range(40, 130),
            y: VIEW_H - api.rng.range(10, 40),
            vx: -Math.sign(playerX) * api.rng.range(20, 90),
            vy: -api.rng.range(20, 90),
            life: 0.5, size: api.rng.range(2, 4),
            color: api.rng.chance(0.5) ? '#7a6a3a' : '#4b6b45',
            drag: 1.6, gravity: 140, additive: false,
          });
        }
      } else {
        bump = damp(bump, 0, 12, dt);
      }

      playerX = clamp(playerX, -2.4, 2.4);
      speed = clamp(speed, 0, MAX_SPEED);

      /* --- traffic ------------------------------------------------------ */
      updateTraffic(dt);
      if (speed > 0) {
        const pSeg = findSegment(position + PLAYER_Z);
        for (const car of pSeg.cars) {
          if (overlap(playerX, CAR_OFF, car.offset, CAR_OFF, 0.85) && speed > car.speed) {
            hitCar(car);
            break;
          }
        }
      }

      /* --- checkpoints & clock ------------------------------------------ */
      const cpIdx = Math.floor(traveled / CP_DIST);
      if (cpIdx > checkpoint) {
        checkpoint = cpIdx;
        timer += CP_BONUS;
        cpFlash = 1;
        api.addScore(250);
        api.sfx('levelup');
        api.particles.popText(VIEW_W / 2, VIEW_H * 0.34, '+' + CP_BONUS + 's', PAL.yellow, 1.3);
      }

      timer -= dt;
      if (timer <= 0) {
        timer = 0;
        finish('OUT OF TIME');
        return;
      }

      /* --- scoring & juice ---------------------------------------------- */
      scoreAcc += dt * speed * 0.004;
      if (scoreAcc >= 1) {
        const n = Math.floor(scoreAcc);
        scoreAcc -= n;
        api.addScore(n);
      }

      hillShift -= playerSeg.curve * speedPct * dt * 26;
      if (cpFlash > 0) cpFlash -= dt * 1.6;
      if (hitFlash > 0) hitFlash -= dt * 2.4;
      if (hum) hum.setRPM(clamp(speedPct * (offRoad ? 0.55 : 1) + (gas ? 0.08 : 0), 0, 1));

      // The DOM HUD only needs a nudge when a displayed value actually changes.
      const t = Math.ceil(timer);
      if (t !== statusT) {
        statusT = t;
        api.setStatus({ TIME: t, KM: (traveled / 1000).toFixed(2), PASSED: overtakes });
      }
    },

    render(ctx) {
      const W = VIEW_W;
      const H = VIEW_H;
      const speedPct = speed / MAX_SPEED;

      const baseSeg = findSegment(position);
      const basePct = (position % SEG_LEN) / SEG_LEN;
      const playerSeg = findSegment(position + PLAYER_Z);
      const playerPct = ((position + PLAYER_Z) % SEG_LEN) / SEG_LEN;
      playerY = lerp(playerSeg.p1.world.y, playerSeg.p2.world.y, playerPct);

      /* --- sky ---------------------------------------------------------- */
      if (!skyGrad) {
        skyGrad = ctx.createLinearGradient(0, 0, 0, H * 0.62);
        skyGrad.addColorStop(0, '#0a0722');
        skyGrad.addColorStop(0.45, '#2a1152');
        skyGrad.addColorStop(0.8, '#7a2260');
        skyGrad.addColorStop(1, '#ff7a3d');
      }
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, H * 0.62);

      const horizon = H / 2 + clamp(playerY * 0.0016, -26, 26);

      // Low sun, sliced by scanline bars — the obligatory synthwave sun.
      const sunX = W / 2 + Math.sin(hillShift * 0.004) * 40;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, horizon);
      ctx.clip();
      ctx.fillStyle = '#ffb03a';
      ctx.beginPath();
      ctx.arc(sunX, horizon - 6, 46, 0, TAU);
      ctx.fill();
      ctx.fillStyle = alpha('#2a1152', 0.85);
      for (let i = 0; i < 7; i++) {
        ctx.fillRect(sunX - 50, horizon - 46 + i * 12 + (i * i) * 0.4, 100, 3 + i * 0.7);
      }
      ctx.restore();

      /* --- parallax hills ------------------------------------------------ */
      for (let layer = 0; layer < 2; layer++) {
        const k = layer === 0 ? 0.45 : 1;
        const amp = layer === 0 ? 26 : 16;
        const off = hillShift * k;
        ctx.fillStyle = layer === 0 ? '#1a1038' : '#241a4d';
        ctx.beginPath();
        ctx.moveTo(0, horizon + 2);
        for (let x = 0; x <= W; x += 16) {
          const p = (x + off) * 0.012 + layer * 2.1;
          const y = horizon - 6 - amp * (0.5 + 0.5 * Math.sin(p) * Math.cos(p * 0.37));
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, horizon + 2);
        ctx.closePath();
        ctx.fill();
      }

      /* --- road --------------------------------------------------------- */
      let maxy = H;
      let x = 0;
      let dx = -(baseSeg.curve * basePct);

      for (let n = 0; n < DRAW_DIST; n++) {
        const seg = segments[(baseSeg.index + n) % segments.length];
        seg.looped = seg.index < baseSeg.index;
        seg.fog = n;
        seg.clip = maxy;

        const camZ = position - (seg.looped ? trackLength : 0);
        project(seg.p1, playerX * ROAD_WIDTH - x, playerY + CAMERA_HEIGHT, camZ, cameraDepth);
        project(seg.p2, playerX * ROAD_WIDTH - x - dx, playerY + CAMERA_HEIGHT, camZ, cameraDepth);

        x += dx;
        dx += seg.curve;

        if (seg.p1.camera.z <= cameraDepth) continue;
        if (seg.p2.screen.y >= seg.p1.screen.y || seg.p2.screen.y >= maxy) continue;

        const s1 = seg.p1.screen;
        const s2 = seg.p2.screen;
        const pal = seg.pal;
        const f = n;

        // Grass band behind the tarmac.
        ctx.fillStyle = pal.grass[f];
        ctx.fillRect(0, s2.y, W, s1.y - s2.y + 1);

        const r1 = s1.w / 6;
        const r2 = s2.w / 6;
        quad(ctx, s1.x - s1.w - r1, s1.y, s1.x - s1.w, s1.y,
          s2.x - s2.w, s2.y, s2.x - s2.w - r2, s2.y, pal.rumble[f]);
        quad(ctx, s1.x + s1.w + r1, s1.y, s1.x + s1.w, s1.y,
          s2.x + s2.w, s2.y, s2.x + s2.w + r2, s2.y, pal.rumble[f]);
        quad(ctx, s1.x - s1.w, s1.y, s1.x + s1.w, s1.y,
          s2.x + s2.w, s2.y, s2.x - s2.w, s2.y, pal.road[f]);

        if (pal.lane) {
          const l1 = s1.w / 26;
          const l2 = s2.w / 26;
          const lw1 = (s1.w * 2) / LANES;
          const lw2 = (s2.w * 2) / LANES;
          let lx1 = s1.x - s1.w + lw1;
          let lx2 = s2.x - s2.w + lw2;
          for (let lane = 1; lane < LANES; lane++) {
            quad(ctx, lx1 - l1, s1.y, lx1 + l1, s1.y,
              lx2 + l2, s2.y, lx2 - l2, s2.y, pal.lane[f]);
            lx1 += lw1;
            lx2 += lw2;
          }
        }

        maxy = s2.y;
      }

      /* --- props & traffic, front-to-back so near hides far -------------- */
      for (let n = DRAW_DIST - 1; n > 0; n--) {
        const seg = segments[(baseSeg.index + n) % segments.length];
        const s1 = seg.p1.screen;
        if (!s1.scale || seg.p1.camera.z <= cameraDepth) continue;

        if (seg.gate) drawGate(ctx, seg);
        if (seg.pylon) {
          drawPylon(ctx, seg, -1.25);
          drawPylon(ctx, seg, 1.25);
        }

        for (const car of seg.cars) {
          const pct = (car.z % SEG_LEN) / SEG_LEN;
          const sc = lerp(seg.p1.screen.scale, seg.p2.screen.scale, pct);
          const sx = lerp(seg.p1.screen.x, seg.p2.screen.x, pct)
                   + (sc * car.offset * ROAD_WIDTH * W) / 2;
          const sy = lerp(seg.p1.screen.y, seg.p2.screen.y, pct);
          const cw = (sc * CAR_W * W) / 2;
          if (cw < 1.5 || cw > W * 3) continue;
          drawSprite(ctx, seg.clip, () => drawTraffic(ctx, sx, sy, cw, car.color));
        }
      }

      /* --- speed streaks ------------------------------------------------- */
      if (speedPct > 0.55) {
        const a = (speedPct - 0.55) / 0.45;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = alpha(PAL.white, 0.06 + a * 0.16);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < 16; i++) {
          const ang = (i / 16) * TAU + api.time * 0.7;
          const r0 = 60 + ((i * 37) % 90);
          const r1 = r0 + 40 + a * 110;
          const cx = W / 2;
          const cy = horizon + 20;
          ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0 * 0.7);
          ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1 * 0.7);
        }
        ctx.stroke();
        ctx.restore();
      }

      /* --- player car ---------------------------------------------------- */
      drawPlayer(ctx, speedPct);

      api.particles.render(ctx);

      /* --- HUD ----------------------------------------------------------- */
      drawHud(ctx, speedPct);
    },

    destroy() {
      if (hum) { hum.stop(); hum = null; }
    },
  };

  /* --------------------------------------------------------------- sprites */

  /** Draw `fn` clipped to the road already painted in front of this segment. */
  function drawSprite(ctx, clipY, fn) {
    if (clipY >= VIEW_H) { fn(); return; }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, clipY);
    ctx.clip();
    fn();
    ctx.restore();
  }

  function drawTraffic(ctx, cx, baseY, w, color) {
    const h = w * 0.62;
    const y = baseY - h;
    ctx.fillStyle = alpha('#000000', 0.4);
    ctx.beginPath();
    ctx.ellipse(cx, baseY, w * 0.55, h * 0.12, 0, 0, TAU);
    ctx.fill();
    // Body.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.5, baseY);
    ctx.lineTo(cx - w * 0.42, y + h * 0.34);
    ctx.lineTo(cx - w * 0.3, y + h * 0.06);
    ctx.lineTo(cx + w * 0.3, y + h * 0.06);
    ctx.lineTo(cx + w * 0.42, y + h * 0.34);
    ctx.lineTo(cx + w * 0.5, baseY);
    ctx.closePath();
    ctx.fill();
    if (w > 14) {
      ctx.fillStyle = '#0a0f1c';
      ctx.fillRect(cx - w * 0.24, y + h * 0.12, w * 0.48, h * 0.2);
      ctx.fillStyle = PAL.red;
      ctx.fillRect(cx - w * 0.46, baseY - h * 0.3, w * 0.14, h * 0.16);
      ctx.fillRect(cx + w * 0.32, baseY - h * 0.3, w * 0.14, h * 0.16);
    }
  }

  function drawGate(ctx, seg) {
    const s = seg.p1.screen;
    const postH = s.scale * 2600 * VIEW_H * 0.5;
    const postW = Math.max(1.5, s.w * 0.09);
    const lx = s.x - s.w * 1.18;
    const rx = s.x + s.w * 1.18;
    if (postH < 2 || postH > VIEW_H * 4) return;
    drawSprite(ctx, seg.clip, () => {
      ctx.save();
      ctx.fillStyle = PAL.yellow;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(lx - postW / 2, s.y - postH, postW, postH);
      ctx.fillRect(rx - postW / 2, s.y - postH, postW, postH);
      ctx.fillStyle = alpha(PAL.yellow, 0.75);
      ctx.fillRect(lx, s.y - postH, rx - lx, Math.max(1.5, postH * 0.14));
      ctx.restore();
    });
  }

  function drawPylon(ctx, seg, offset) {
    const s = seg.p1.screen;
    const h = s.scale * 900 * VIEW_H * 0.5;
    if (h < 1 || h > VIEW_H) return;
    const px = s.x + (s.scale * offset * ROAD_WIDTH * VIEW_W) / 2;
    const w = Math.max(1, h * 0.28);
    drawSprite(ctx, seg.clip, () => {
      ctx.fillStyle = seg.pal === PAL_DARK ? PAL.cyan : '#8f9fc0';
      ctx.fillRect(px - w / 2, s.y - h, w, h);
    });
  }

  /** The player's car: fixed on screen, leaning into the steering. */
  function drawPlayer(ctx, speedPct) {
    const cw = 124;
    const ch = 60;
    const cx = VIEW_W / 2 + steerVis * 9;
    const baseY = VIEW_H - 26 + bump;
    const lean = steerVis * 0.09;

    ctx.save();
    ctx.translate(cx, baseY);
    ctx.rotate(lean);

    // Shadow / contact patch.
    ctx.fillStyle = alpha('#000000', 0.45);
    ctx.beginPath();
    ctx.ellipse(0, 2, cw * 0.52, 8, 0, 0, TAU);
    ctx.fill();

    // Wheels.
    ctx.fillStyle = '#12161f';
    ctx.fillRect(-cw * 0.54, -ch * 0.42, cw * 0.16, ch * 0.44);
    ctx.fillRect(cw * 0.38, -ch * 0.42, cw * 0.16, ch * 0.44);

    // Body.
    ctx.fillStyle = '#ffd53d';
    ctx.beginPath();
    ctx.moveTo(-cw * 0.5, 0);
    ctx.lineTo(-cw * 0.44, -ch * 0.42);
    ctx.lineTo(-cw * 0.3, -ch * 0.78);
    ctx.lineTo(cw * 0.3, -ch * 0.78);
    ctx.lineTo(cw * 0.44, -ch * 0.42);
    ctx.lineTo(cw * 0.5, 0);
    ctx.closePath();
    ctx.fill();

    // Rear window + spoiler.
    ctx.fillStyle = '#0a1226';
    ctx.beginPath();
    ctx.moveTo(-cw * 0.26, -ch * 0.74);
    ctx.lineTo(cw * 0.26, -ch * 0.74);
    ctx.lineTo(cw * 0.2, -ch * 0.48);
    ctx.lineTo(-cw * 0.2, -ch * 0.48);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e0a92c';
    ctx.fillRect(-cw * 0.36, -ch * 0.86, cw * 0.72, ch * 0.1);

    // Brake lights burn when you are on the brake.
    const braking = api.input.isDown('b') || api.input.isDown('down');
    ctx.save();
    ctx.shadowColor = PAL.red;
    ctx.shadowBlur = braking ? 16 : 5;
    ctx.fillStyle = braking ? '#ff5566' : '#a3213a';
    ctx.fillRect(-cw * 0.42, -ch * 0.36, cw * 0.16, ch * 0.16);
    ctx.fillRect(cw * 0.26, -ch * 0.36, cw * 0.16, ch * 0.16);
    ctx.restore();

    // Exhaust flare at speed.
    if (speedPct > 0.7) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = alpha(PAL.cyan, (speedPct - 0.7) * 1.6);
      ctx.fillRect(-cw * 0.14, -ch * 0.08, cw * 0.1, 5);
      ctx.fillRect(cw * 0.04, -ch * 0.08, cw * 0.1, 5);
      ctx.restore();
    }

    ctx.restore();
  }

  /* ------------------------------------------------------------------ hud  */

  function drawHud(ctx, speedPct) {
    const W = VIEW_W;
    const H = VIEW_H;

    // Checkpoint flash across the whole screen.
    if (cpFlash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = alpha(PAL.yellow, cpFlash * 0.22);
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    if (hitFlash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = alpha(PAL.red, hitFlash * 0.3);
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    /* Timer — the whole game is a fight with this number. */
    const low = timer < 6;
    const blink = low && Math.floor(api.time * 6) % 2 === 0;
    text(ctx, 'TIME', W / 2, 8, { size: 9, color: PAL.dim, align: 'center' });
    text(ctx, Math.ceil(timer).toString(), W / 2, 18, {
      size: 30, align: 'center',
      color: blink ? PAL.white : low ? PAL.red : PAL.yellow,
      glow: low ? 18 : 8,
    });

    /* Speedometer: a swept arc plus the digits. */
    const gx = W - 54;
    const gy = H - 40;
    const r = 30;
    ctx.save();
    ctx.lineWidth = 5;
    ctx.strokeStyle = alpha(PAL.dim, 0.5);
    ctx.beginPath();
    ctx.arc(gx, gy, r, Math.PI * 0.78, Math.PI * 2.22);
    ctx.stroke();
    ctx.strokeStyle = speedPct > 0.85 ? PAL.magenta : PAL.cyan;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(gx, gy, r, Math.PI * 0.78, Math.PI * (0.78 + 1.44 * speedPct));
    ctx.stroke();
    // Needle.
    const na = Math.PI * (0.78 + 1.44 * speedPct);
    ctx.strokeStyle = PAL.white;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + Math.cos(na) * (r - 5), gy + Math.sin(na) * (r - 5));
    ctx.stroke();
    ctx.restore();

    const kmh = Math.round(speedPct * 340);
    text(ctx, String(kmh), gx, gy + 6, { size: 17, color: PAL.white, align: 'center', glow: 6 });
    text(ctx, 'KM/H', gx, gy + 22, { size: 8, color: PAL.dim, align: 'center' });

    /* Distance, overtakes and the off-road warning. */
    text(ctx, (traveled / 1000).toFixed(2) + ' KM', 8, H - 34, { size: 10, color: PAL.cyan });
    text(ctx, 'PASSED ' + overtakes, 8, H - 21, { size: 10, color: PAL.lime });
    text(ctx, 'CP ' + checkpoint, 8, H - 8, { size: 9, color: PAL.dim });

    if (offRoad && speed > MAX_SPEED * 0.05) {
      text(ctx, 'OFF ROAD', W / 2, H * 0.62, {
        size: 14, color: Math.floor(api.time * 8) % 2 ? PAL.red : PAL.orange,
        align: 'center', glow: 12,
      });
    }
  }
}
