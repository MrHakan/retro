/**
 * 09 — RETRO RHYTHM BEAT
 *
 * Four-lane DDR-style chart reader. The important part is the clock: every
 * note position, every judgement window and every receptor pulse is derived
 * from `track.position()` — the Web Audio clock returned by
 * `api.audio.startTrack()` — and never from accumulated `dt`. A dropped frame
 * therefore moves the arrows, not the beat, and the chart stays welded to the
 * drums for the whole song.
 *
 * The chart is generated from the same 16-step grid the synth plays, so an
 * arrow can only ever land on a drum hit that you can actually hear.
 */

import { PAL, clamp, alpha, mix, text } from '../core/fx.js';

const VIEW = { w: 420, h: 480 };

/* ------------------------------------------------------------------ song  */

const BPM = 132;
const STEPS = 16;                       // pattern loop length (16th notes)
const STEP = 60 / BPM / 4;              // seconds per 16th
const BAR = STEPS * STEP;
const LEAD_IN = 32;                     // two silent bars before the first arrow
const SONG_BARS = 24;
const TOTAL_STEPS = SONG_BARS * STEPS;

//                0 1 2 3 4 5 6 7 8 9 A B C D E F
const DRUMS = 'k.h.s.h.k.hks.h.';
const BASS = ['A2', '.', 'A2', '.', '.', 'A2', '.', 'E2', 'G2', '.', 'G2', '.', '.', 'C3', '.', 'E2'];
const LEAD = ['.', '.', 'E5', '.', '.', 'A5', '.', '.', '.', 'G5', '.', '.', 'B5', '.', 'A5', '.'];

/* ------------------------------------------------------------------ lanes */

const LANE_ACTION = ['left', 'down', 'up', 'right'];
const LANE_ROT = [-Math.PI / 2, Math.PI, 0, Math.PI / 2];
const LANE_COLOR = [PAL.magenta, PAL.cyan, PAL.lime, PAL.yellow];

/* ------------------------------------------------------------- judgement  */

const W_PERFECT = 0.045;
const W_GREAT = 0.09;
const W_GOOD = 0.135;
const W_MISS = 0.16;                    // past this, the note is gone

const JUDGE = {
  PERFECT: { score: 300, groove: 3.5, weight: 1, color: PAL.yellow, sfx: 'perfect' },
  GREAT: { score: 200, groove: 2.5, weight: 0.75, color: PAL.cyan, sfx: 'combo' },
  GOOD: { score: 100, groove: 1.2, weight: 0.45, color: PAL.lime, sfx: 'blip' },
  MISS: { score: 0, groove: -9, weight: 0, color: PAL.red, sfx: 'miss' },
};

const SCROLL = 305;                     // px per second of approach
const GROOVE_MAX = 100;

/** Arrow glyph: a chevron pointing "up" before the per-lane rotation. */
function arrowPath(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(-s, 0);
  ctx.lineTo(-s * 0.42, 0);
  ctx.lineTo(-s * 0.42, s * 0.78);
  ctx.lineTo(s * 0.42, s * 0.78);
  ctx.lineTo(s * 0.42, 0);
  ctx.lineTo(s, 0);
  ctx.closePath();
}

export const meta = {
  id: 'rhythm',
  title: 'RETRO RHYTHM BEAT',
  short: 'RHYTHM',
  category: 'ARCADE',
  desc: 'Four-lane arrow chart locked to the Web Audio clock, generated from '
      + 'the same beat grid the chiptune plays. Keep the groove bar alive and '
      + 'chase an S rank.',
  accent: PAL.violet,
  view: VIEW,
  controls: [
    'LEFT / DOWN / UP / RIGHT — lanes',
    'HIT ON THE BEAT — PERFECT',
  ],
  touch: {
    buttons: [
      { id: 'left', label: '◀' },
      { id: 'down', label: '▼' },
      { id: 'up', label: '▲' },
      { id: 'right', label: '▶' },
    ],
  },
  art(ctx, w, h, accent) {
    ctx.save();
    ctx.fillStyle = '#07050f';
    ctx.fillRect(0, 0, w, h);
    const lw = 40;
    const x0 = (w - lw * 4) / 2;
    const cols = [PAL.magenta, PAL.cyan, PAL.lime, PAL.yellow];
    const rots = [-Math.PI / 2, Math.PI, 0, Math.PI / 2];
    for (let i = 0; i < 4; i++) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, alpha(cols[i], 0.02));
      g.addColorStop(1, alpha(cols[i], 0.16));
      ctx.fillStyle = g;
      ctx.fillRect(x0 + i * lw, 0, lw - 2, h);
    }
    // Judgement line.
    ctx.strokeStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0 - 6, h - 40);
    ctx.lineTo(x0 + lw * 4, h - 40);
    ctx.stroke();
    // Receptors + falling arrows.
    const rows = [[h - 40, 1], [96, 0.85], [58, 0.85], [22, 0.85]];
    const which = [[0, 1, 2, 3], [1], [0, 3], [2]];
    for (let r = 0; r < rows.length; r++) {
      for (const i of which[r]) {
        ctx.save();
        ctx.translate(x0 + i * lw + lw / 2 - 1, rows[r][0]);
        ctx.rotate(rots[i]);
        ctx.fillStyle = r === 0 ? alpha(cols[i], 0.25) : cols[i];
        ctx.strokeStyle = cols[i];
        ctx.lineWidth = 2;
        ctx.shadowColor = cols[i];
        ctx.shadowBlur = r === 0 ? 6 : 12;
        arrowPath(ctx, 13);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
    ctx.save();
    ctx.fillStyle = PAL.white;
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PERFECT', w / 2, h - 14);
    ctx.restore();
  },
};

export function create(api) {
  /* ---------------------------------------------------------------- state */
  let track = null;
  let pos = 0;                 // song time in seconds (audio clock + offset)
  let timeOffset = 0;          // added after a pause so the chart resumes cleanly
  let lastAp = null;
  let stall = 0;
  let audioDead = false;

  /** @type {{step:number,time:number,lane:number,judged:boolean,skipped:boolean,res:string}[]} */
  let notes;
  let head;                    // first note still worth scanning
  let counts, combo, maxCombo, groove, done, endTime;
  let laneFlash, laneHold, judgeText, judgeT, judgeColor;
  let beatPulse, barPulse, lastBeat;
  let history;                 // rolling judgement ticks for the readout
  let statusT;

  const laneW = () => Math.min(58, (api.w - 40) / 4);
  const laneX0 = () => (api.w - laneW() * 4) / 2;
  const laneCx = (i) => laneX0() + i * laneW() + laneW() / 2;
  const judgeY = () => api.h - 86;

  /* ---------------------------------------------------------------- chart */

  /**
   * Build the chart off the drum string so every arrow coincides with an
   * audible hit. Four sections ramp the density: kicks/snares only, then
   * hats, then most hats, then hats plus two-lane jumps.
   */
  function buildChart() {
    const list = [];
    let lastLane = api.rng.int(0, 3);

    const pickLane = (section, avoid) => {
      let l;
      for (let tries = 0; tries < 8; tries++) {
        // Later sections favour stepping to a neighbouring lane (runs).
        l = section >= 2 && api.rng.chance(0.45)
          ? clamp(lastLane + api.rng.sign(), 0, 3)
          : api.rng.int(0, 3);
        if (l !== avoid) break;
      }
      lastLane = l;
      return l;
    };

    for (let i = 0; i < TOTAL_STEPS; i++) {
      const step = LEAD_IN + i;
      const bar = Math.floor(i / STEPS);
      const section = Math.min(3, Math.floor(bar / (SONG_BARS / 4)));
      const d = DRUMS[step % STEPS];

      let place = false;
      if (d === 'k' || d === 's') place = true;
      else if (d === 'h') place = api.rng.chance([0, 0.5, 0.8, 0.95][section]);
      if (!place) continue;

      const lane = pickLane(section, -1);
      list.push({ step, time: step * STEP, lane, judged: false, skipped: false, res: '' });

      // Jumps: two arrows at once on the heavy beats of the last section.
      if (section === 3 && d === 'k' && api.rng.chance(0.35)) {
        const second = pickLane(section, lane);
        if (second !== lane) {
          list.push({ step, time: step * STEP, lane: second, judged: false, skipped: false, res: '' });
        }
      }
    }

    list.sort((a, b) => a.time - b.time);
    endTime = list.length ? list[list.length - 1].time + 2.2 : 10;
    return list;
  }

  /* ---------------------------------------------------------------- audio */

  function startSong() {
    track = api.audio.startTrack({
      bpm: BPM,
      steps: STEPS,
      bass: BASS,
      lead: LEAD,
      drums: DRUMS,
      // Fired on the audio clock as each 16th arrives — used for the bar flash.
      onStep: (step) => {
        if (step % STEPS === 0) barPulse = 1;
      },
    });
    lastAp = null;
    stall = 0;
    audioDead = false;
  }

  /** Pull the song clock forward. Falls back to `dt` only if audio is absent. */
  function advance(dt) {
    if (audioDead || !track) {
      pos += dt;
      return;
    }
    const ap = track.position();
    if (ap !== lastAp) {
      lastAp = ap;
      stall = 0;
      pos = timeOffset + ap;
    } else {
      stall += dt;
      if (stall > 0.6) audioDead = true;   // no audio context — keep playing
    }
  }

  /* ------------------------------------------------------------ judgement */

  function applyJudge(note, res, exactY) {
    const j = JUDGE[res];
    note.judged = true;
    note.res = res;
    counts[res]++;
    history.push({ res, t: pos });
    if (history.length > 64) history.shift();

    if (res === 'MISS') {
      combo = 0;
      api.sfx('miss', { vol: 0.6 });
      api.vibrate(30);
      api.shakeScreen(3, 8);
    } else {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
      const mult = clamp(1 + Math.floor(combo / 12), 1, 4);
      api.addScore(j.score * mult);
      api.sfx(j.sfx, { vol: res === 'GOOD' ? 0.7 : 1, detune: clamp(combo * 0.1, 0, 8) });
      const x = laneCx(note.lane);
      const y = exactY ?? judgeY();
      laneFlash[note.lane] = 1;
      api.particles.burst(x, y, res === 'PERFECT' ? 16 : 10, {
        speed: res === 'PERFECT' ? 170 : 110, life: 0.45, size: 2.6,
        color: [LANE_COLOR[note.lane], j.color, PAL.white], glow: 10, drag: 2.6,
      });
      if (combo > 0 && combo % 25 === 0) {
        api.particles.popText(api.w / 2, api.h * 0.42, combo + ' COMBO!', PAL.violet, 1.3);
      }
      if (mult > 1 && res === 'PERFECT') {
        api.particles.popText(x, y - 18, 'x' + mult, j.color, 0.6);
      }
    }

    groove = clamp(groove + j.groove, 0, GROOVE_MAX);
    judgeText = res;
    judgeColor = j.color;
    judgeT = 0.55;
  }

  function pressLane(lane) {
    if (done) return;
    laneHold[lane] = 0.12;
    let best = null;
    let bestAd = Infinity;
    for (let i = head; i < notes.length; i++) {
      const n = notes[i];
      const d = n.time - pos;
      if (d > W_GOOD + 0.03) break;
      if (n.judged || n.lane !== lane) continue;
      const ad = Math.abs(d);
      if (ad < bestAd) { bestAd = ad; best = n; }
    }
    if (!best) {
      // Nothing in range — a free tap, no penalty, just a flick of light.
      laneFlash[lane] = 0.45;
      return;
    }
    const res = bestAd <= W_PERFECT ? 'PERFECT' : (bestAd <= W_GREAT ? 'GREAT' : 'GOOD');
    applyJudge(best, res, judgeY());
  }

  /* ---------------------------------------------------------------- flow  */

  function accuracy() {
    let n = 0;
    let w = 0;
    for (const k in counts) {
      n += counts[k];
      w += counts[k] * JUDGE[k].weight;
    }
    return n ? w / n : 1;
  }

  function gradeFor(acc) {
    if (acc >= 0.95) return 'S';
    if (acc >= 0.88) return 'A';
    if (acc >= 0.78) return 'B';
    if (acc >= 0.65) return 'C';
    return 'F';
  }

  function finish(failed) {
    if (done) return;
    done = true;
    const acc = accuracy();
    const grade = failed ? 'F' : gradeFor(acc);
    const stats = {
      GRADE: grade,
      ACCURACY: (acc * 100).toFixed(1) + '%',
      'MAX COMBO': maxCombo,
      PERFECT: counts.PERFECT,
      MISS: counts.MISS,
    };
    if (track) { track.stop(); track = null; }
    if (failed) api.gameOver({ message: 'GROOVE FLATLINED', stats });
    else if (grade === 'F') api.gameOver({ message: 'SONG CLEARED — RANK F', stats });
    else api.win({ message: `SONG CLEARED — RANK ${grade}`, stats });
  }

  /* -------------------------------------------------------------- drawing */

  function drawArrow(ctx, x, y, s, lane, style, a = 1) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(LANE_ROT[lane]);
    ctx.globalAlpha = a;
    const col = LANE_COLOR[lane];
    arrowPath(ctx, s);
    if (style === 'receptor') {
      ctx.strokeStyle = alpha(col, 0.55);
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.shadowColor = col;
      ctx.shadowBlur = 10;
      ctx.fillStyle = col;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = alpha(PAL.white, 0.75);
      arrowPath(ctx, s * 0.55);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ lifecycle */

  return {
    init() {
      notes = buildChart();
      head = 0;
      counts = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
      combo = 0;
      maxCombo = 0;
      groove = 70;
      done = false;
      pos = 0;
      timeOffset = 0;
      laneFlash = [0, 0, 0, 0];
      laneHold = [0, 0, 0, 0];
      judgeText = '';
      judgeT = 0;
      judgeColor = PAL.white;
      beatPulse = 0;
      barPulse = 0;
      lastBeat = -1;
      history = [];
      statusT = 0;
      startSong();
      api.setStatus({ COMBO: 0, GROOVE: '70%', ACC: '100%' });
    },

    update(dt) {
      if (done) return;
      advance(dt);

      /* --- beat-locked visuals, driven by the same clock as the notes --- */
      const beat = Math.floor(pos / (STEP * 4));
      if (beat !== lastBeat) {
        lastBeat = beat;
        beatPulse = 1;
      }
      beatPulse = Math.max(0, beatPulse - dt * 4.5);
      barPulse = Math.max(0, barPulse - dt * 2.4);
      if (judgeT > 0) judgeT -= dt;
      for (let i = 0; i < 4; i++) {
        laneFlash[i] = Math.max(0, laneFlash[i] - dt * 3.4);
        laneHold[i] = Math.max(0, laneHold[i] - dt);
      }

      /* --- notes that sailed past the window are misses --- */
      while (head < notes.length) {
        const n = notes[head];
        if (!n.judged) {
          if (n.time >= pos - W_MISS) break;
          applyJudge(n, 'MISS');
          if (groove <= 0) { finish(true); return; }
        }
        head++;
      }

      /* --- groove bleeds slowly so idling is never a strategy --- */
      if (pos > 0) groove = clamp(groove - dt * 0.55, 0, GROOVE_MAX);
      if (groove <= 0) { finish(true); return; }

      /* --- song over --- */
      if (pos >= endTime) { finish(false); return; }

      /* --- HUD (throttled: each write rebuilds the readout markup) --- */
      statusT -= dt;
      if (statusT <= 0) {
        statusT = 0.2;
        api.setStatus({
          COMBO: combo,
          GROOVE: Math.round(groove) + '%',
          ACC: (accuracy() * 100).toFixed(0) + '%',
        });
      }
    },

    handleInput(e) {
      if (e.type !== 'press') return;
      const lane = LANE_ACTION.indexOf(e.action);
      if (lane >= 0) pressLane(lane);
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;
      const lw = laneW();
      const x0 = laneX0();
      const jy = judgeY();

      /* --- backdrop pulses on the bar --- */
      ctx.fillStyle = '#06040e';
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = 0.1 + barPulse * 0.16;
      const bg = ctx.createRadialGradient(W / 2, H * 0.6, 10, W / 2, H * 0.6, H * 0.9);
      bg.addColorStop(0, PAL.violet);
      bg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // Beat rails running down the sides.
      ctx.save();
      ctx.globalAlpha = 0.25 + beatPulse * 0.5;
      ctx.fillStyle = PAL.violet;
      ctx.fillRect(x0 - 8, 0, 2, H);
      ctx.fillRect(x0 + lw * 4 + 6, 0, 2, H);
      ctx.restore();

      /* --- lanes --- */
      for (let i = 0; i < 4; i++) {
        const lx = x0 + i * lw;
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, alpha(LANE_COLOR[i], 0.02));
        g.addColorStop(0.7, alpha(LANE_COLOR[i], 0.07));
        g.addColorStop(1, alpha(LANE_COLOR[i], 0.02));
        ctx.fillStyle = g;
        ctx.fillRect(lx, 0, lw - 2, H);
        if (laneFlash[i] > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = laneFlash[i] * 0.35;
          const fg = ctx.createLinearGradient(0, jy - 160, 0, jy + 30);
          fg.addColorStop(0, 'rgba(0,0,0,0)');
          fg.addColorStop(1, LANE_COLOR[i]);
          ctx.fillStyle = fg;
          ctx.fillRect(lx, jy - 160, lw - 2, 190);
          ctx.restore();
        }
      }

      /* --- beat gridlines scrolling with the chart --- */
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.strokeStyle = PAL.dim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const firstBeat = Math.floor(pos / (STEP * 4)) - 1;
      for (let b = firstBeat; b < firstBeat + 14; b++) {
        const y = jy - (b * STEP * 4 - pos) * SCROLL;
        if (y < -4 || y > jy) continue;
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + lw * 4 - 2, y);
      }
      ctx.stroke();
      ctx.restore();

      /* --- receptors --- */
      const pulse = 1 + beatPulse * 0.18;
      for (let i = 0; i < 4; i++) {
        const held = laneHold[i] > 0;
        ctx.save();
        if (held) {
          ctx.shadowColor = LANE_COLOR[i];
          ctx.shadowBlur = 18;
        }
        drawArrow(ctx, laneCx(i) - 1, jy, 15 * (held ? 1.12 : pulse), i, 'receptor',
          0.55 + beatPulse * 0.35 + (held ? 0.4 : 0));
        ctx.restore();
      }

      // Judgement line.
      ctx.save();
      ctx.shadowColor = PAL.violet;
      ctx.shadowBlur = 10 + beatPulse * 14;
      ctx.strokeStyle = alpha(PAL.white, 0.5 + beatPulse * 0.4);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0 - 6, jy + 0.5);
      ctx.lineTo(x0 + lw * 4 + 4, jy + 0.5);
      ctx.stroke();
      ctx.restore();

      /* --- notes --- */
      for (let i = head; i < notes.length; i++) {
        const n = notes[i];
        if (n.judged) continue;
        const y = jy - (n.time - pos) * SCROLL;
        if (y < -30) break;
        if (y > jy + 40) continue;
        drawArrow(ctx, laneCx(n.lane) - 1, y, 15, n.lane, 'note', clamp(y / 40 + 0.2, 0.2, 1));
      }

      api.particles.render(ctx);

      /* --- judgement popup + combo --- */
      if (judgeT > 0) {
        const k = clamp(judgeT / 0.55, 0, 1);
        ctx.save();
        ctx.globalAlpha = k;
        text(ctx, judgeText, W / 2, jy - 54, {
          size: 20 + (1 - k) * 6, color: judgeColor, align: 'center', baseline: 'middle', glow: 14,
        });
        ctx.restore();
      }
      if (combo > 2) {
        text(ctx, String(combo), W / 2, jy - 96, {
          size: 30, color: PAL.white, align: 'center', baseline: 'middle', glow: 10,
        });
        text(ctx, 'COMBO', W / 2, jy - 74, {
          size: 9, color: PAL.dim, align: 'center', baseline: 'middle',
        });
      }

      /* --- top panel: notes emerge from behind it, DDR-style --- */
      ctx.fillStyle = alpha('#06040e', 0.88);
      ctx.fillRect(0, 0, W, 56);
      ctx.fillStyle = alpha(PAL.violet, 0.35);
      ctx.fillRect(0, 56, W, 1);

      /* --- groove bar --- */
      const gw = W - 40;
      const gv = groove / GROOVE_MAX;
      ctx.fillStyle = alpha('#000', 0.6);
      ctx.fillRect(20, 12, gw, 10);
      ctx.fillStyle = alpha(PAL.dim, 0.3);
      ctx.fillRect(21, 13, gw - 2, 8);
      ctx.save();
      ctx.shadowColor = mix(PAL.red, PAL.lime, gv);
      ctx.shadowBlur = groove < 25 ? 10 + Math.sin(api.time * 14) * 6 : 6;
      ctx.fillStyle = mix(PAL.red, PAL.lime, gv);
      ctx.fillRect(21, 13, (gw - 2) * gv, 8);
      ctx.restore();
      text(ctx, 'GROOVE', 20, 25, { size: 7, color: PAL.dim });

      /* --- scrolling accuracy readout: one tick per judgement --- */
      const rx = W - 20;
      ctx.save();
      for (const hgt of history) {
        const age = pos - hgt.t;
        if (age > 6) continue;
        const x = rx - age * 26;
        if (x < 24) continue;
        const j = JUDGE[hgt.res];
        ctx.globalAlpha = clamp(1 - age / 6, 0, 1) * 0.9;
        ctx.fillStyle = j.color;
        const hh = hgt.res === 'MISS' ? 3 : 3 + j.weight * 7;
        ctx.fillRect(x, 32 + (10 - hh), 2, hh);
      }
      ctx.restore();
      const acc = accuracy();
      text(ctx, (acc * 100).toFixed(1) + '%', W - 20, 44, {
        size: 10, color: PAL.white, align: 'right',
      });
      text(ctx, 'RANK ' + gradeFor(acc), 20, 44, { size: 10, color: PAL.violet });

      /* --- lead-in countdown --- */
      if (pos < LEAD_IN * STEP - 0.2) {
        const remain = LEAD_IN * STEP - pos;
        ctx.save();
        ctx.globalAlpha = clamp(remain / 1.4, 0, 1);
        text(ctx, Math.ceil(remain / (STEP * 4)).toString(), W / 2, H * 0.4, {
          size: 44, color: PAL.violet, align: 'center', baseline: 'middle', glow: 20,
        });
        text(ctx, api.isTouch ? 'HIT THE ARROWS ON THE LINE' : 'ARROW KEYS = LANES',
          W / 2, H * 0.4 + 42, { size: 10, color: PAL.dim, align: 'center', baseline: 'middle' });
        ctx.restore();
      }
    },

    /**
     * The shell stops the track on pause. Restart on a bar boundary two bars
     * ahead so the loop phase still matches the chart, and write off the notes
     * that went by while the game was frozen.
     */
    onResume() {
      if (done) return;
      const resumeAt = (Math.floor(pos / BAR) + 2) * BAR;
      timeOffset = resumeAt;
      pos = resumeAt;
      for (const n of notes) {
        if (!n.judged && n.time < resumeAt + 0.05) {
          n.judged = true;
          n.skipped = true;
        }
      }
      head = 0;
      lastBeat = -1;
      startSong();
    },

    destroy() {
      if (track) {
        track.stop();
        track = null;
      }
      notes = null;
      history = null;
    },
  };
}
