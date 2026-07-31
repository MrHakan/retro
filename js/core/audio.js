/**
 * AudioEngine — programmatic 8-bit chiptune synthesizer.
 *
 * Everything is generated at runtime with the Web Audio API: there is not a
 * single MP3/WAV/OGG in this project, which keeps the offline cache tiny and
 * the deployment a pure static drop.
 *
 * Signal path:  voice -> voiceGain -> (sfxBus | musicBus) -> masterGain -> out
 *
 * The AudioContext is created lazily and resumed on the first user gesture,
 * satisfying autoplay policies on iOS/Android/Chrome.
 */

const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A4" / "C#5" / "Eb3" -> Hz */
export function noteToFreq(note) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(note).trim());
  if (!m) return 440;
  let semis = NOTE_INDEX[m[1].toUpperCase()];
  if (m[2] === '#') semis += 1;
  else if (m[2] === 'b') semis -= 1;
  const octave = parseInt(m[3], 10);
  return 440 * Math.pow(2, (semis - 9) / 12 + (octave - 4));
}

/** Build a band-limited pulse wave of the given duty cycle. */
function makePulseWave(ctx, duty, harmonics = 24) {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    // Fourier series of a pulse train with duty cycle `duty`.
    imag[n] = (2 / (n * Math.PI)) * Math.sin(Math.PI * n * duty);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

export class AudioEngine {
  constructor(settings = {}) {
    this.ctx = null;
    this.ready = false;
    this.enabledSfx = settings.sfx !== false;
    this.enabledMusic = settings.music !== false;
    this.masterVolume = typeof settings.master === 'number' ? settings.master : 0.7;
    this._noise = null;
    this._waves = {};
    this._voices = 0;
    this._maxVoices = 28;
    this._track = null;
  }

  /* ------------------------------------------------------------ lifecycle */

  /** Create/resume the context. Safe to call repeatedly; call from a gesture. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try {
        this.ctx = new AC();
      } catch {
        return false;
      }
      const ctx = this.ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this.masterVolume;

      // A gentle limiter keeps dense chip arrangements from clipping.
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.12;

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = this.enabledSfx ? 1 : 0;
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.enabledMusic ? 0.55 : 0;

      this.sfxBus.connect(this.master);
      this.musicBus.connect(this.master);
      this.master.connect(this.limiter);
      this.limiter.connect(ctx.destination);

      // Shared white-noise buffer (2 s, mono) for percussion and explosions.
      const len = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this._noise = buf;

      this._waves = {
        pulse12: makePulseWave(ctx, 0.125),
        pulse25: makePulseWave(ctx, 0.25),
        pulse50: makePulseWave(ctx, 0.5),
      };
      this.ready = true;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return true;
  }

  get time() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  setMaster(v) {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.setTargetAtTime(this.masterVolume, this.time, 0.02);
  }

  setSfxEnabled(on) {
    this.enabledSfx = !!on;
    if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(on ? 1 : 0, this.time, 0.02);
  }

  setMusicEnabled(on) {
    this.enabledMusic = !!on;
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(on ? 0.55 : 0, this.time, 0.05);
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /* --------------------------------------------------------- primitives  */

  _osc(type) {
    const o = this.ctx.createOscillator();
    if (type === 'pulse12' || type === 'pulse25' || type === 'pulse50') {
      o.setPeriodicWave(this._waves[type]);
    } else {
      o.type = type || 'square';
    }
    return o;
  }

  /**
   * One synthesized voice.
   * @param {object} o
   * @param {string} [o.type]      square|triangle|sawtooth|sine|pulse12|pulse25|pulse50|noise
   * @param {number} [o.freq]      start frequency (Hz)
   * @param {number} [o.freqEnd]   glide target; enables a pitch sweep
   * @param {number} [o.dur]       total duration (s)
   * @param {number} [o.vol]       peak gain 0..1
   * @param {number} [o.attack]    attack time (s)
   * @param {number} [o.release]   release time (s)
   * @param {number} [o.when]      absolute start time; defaults to now
   * @param {string} [o.bus]       'sfx' | 'music'
   * @param {number} [o.filter]    lowpass cutoff (Hz)
   * @param {number} [o.filterEnd] lowpass sweep target
   * @param {number} [o.q]         filter resonance
   * @param {number} [o.vibrato]   vibrato depth in Hz
   * @param {number} [o.vibratoHz] vibrato rate
   * @param {number} [o.pan]       -1..1
   * @param {boolean}[o.exp]       exponential (true) vs linear pitch sweep
   */
  voice(o = {}) {
    if (!this.ctx) return null;
    if (this._voices > this._maxVoices) return null;

    const ctx = this.ctx;
    const t0 = Math.max(o.when ?? ctx.currentTime, ctx.currentTime);
    const dur = Math.max(0.01, o.dur ?? 0.15);
    const vol = o.vol ?? 0.3;
    const atk = Math.min(o.attack ?? 0.004, dur * 0.5);
    const rel = Math.min(o.release ?? Math.max(0.02, dur * 0.5), dur);
    const bus = o.bus === 'music' ? this.musicBus : this.sfxBus;

    let src;
    if (o.type === 'noise') {
      src = ctx.createBufferSource();
      src.buffer = this._noise;
      src.loop = true;
      src.playbackRate.value = o.rate ?? 1;
    } else {
      src = this._osc(o.type);
      const f0 = Math.max(1, o.freq ?? 440);
      src.frequency.setValueAtTime(f0, t0);
      if (o.freqEnd != null) {
        const f1 = Math.max(1, o.freqEnd);
        if (o.exp === false) src.frequency.linearRampToValueAtTime(f1, t0 + dur);
        else src.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      }
      if (o.vibrato) {
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = o.vibratoHz ?? 6;
        lfoGain.gain.value = o.vibrato;
        lfo.connect(lfoGain).connect(src.frequency);
        lfo.start(t0);
        lfo.stop(t0 + dur + 0.05);
      }
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + atk);
    if (o.sustain != null) {
      g.gain.setValueAtTime(vol, t0 + Math.max(atk, dur - rel));
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let node = src;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = o.filterType || 'lowpass';
      f.frequency.setValueAtTime(o.filter, t0);
      if (o.filterEnd != null) {
        f.frequency.exponentialRampToValueAtTime(Math.max(20, o.filterEnd), t0 + dur);
      }
      f.Q.value = o.q ?? 1;
      node.connect(f);
      node = f;
    }
    node.connect(g);

    let out = g;
    if (o.pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      g.connect(p);
      out = p;
    }
    out.connect(bus);

    this._voices++;
    src.onended = () => { this._voices--; };
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    return src;
  }

  /** Convenience: a short melodic blip. */
  tone(freq, dur = 0.1, type = 'pulse50', vol = 0.25, when) {
    return this.voice({ freq, dur, type, vol, when });
  }

  /** Play a sequence of [freq|note, duration, vol?] steps starting at `when`. */
  arp(steps, opts = {}) {
    if (!this.ctx) return;
    let t = opts.when ?? this.time;
    for (const s of steps) {
      const f = typeof s[0] === 'string' ? noteToFreq(s[0]) : s[0];
      const d = s[1] ?? 0.08;
      this.voice({
        freq: f,
        dur: d * (opts.legato ?? 1.05),
        type: opts.type || 'pulse25',
        vol: s[2] ?? opts.vol ?? 0.22,
        when: t,
        bus: opts.bus,
      });
      t += d;
    }
    return t;
  }

  /* ------------------------------------------------------------- library */

  /**
   * Fire a named SFX from the chiptune library.
   * @param {string} name
   * @param {object} [opts] `{vol, when, pan, detune}` — detune shifts pitch in semitones.
   */
  sfx(name, opts = {}) {
    if (!this.ready) this.unlock();
    if (!this.ctx || !this.enabledSfx) return;
    const when = opts.when ?? this.time;
    const v = opts.vol ?? 1;
    const pan = opts.pan ?? 0;
    const k = Math.pow(2, (opts.detune ?? 0) / 12);
    const V = (o) => this.voice({ ...o, when: (o.when ?? when), vol: (o.vol ?? 0.3) * v, pan });

    switch (name) {
      case 'laser':
        V({ type: 'sawtooth', freq: 1400 * k, freqEnd: 180 * k, dur: 0.18, vol: 0.22, filter: 3200, filterEnd: 700 });
        V({ type: 'pulse25', freq: 900 * k, freqEnd: 120 * k, dur: 0.12, vol: 0.12 });
        break;

      case 'shoot':
        V({ type: 'pulse12', freq: 780 * k, freqEnd: 260 * k, dur: 0.09, vol: 0.16 });
        break;

      case 'shotgun':
        V({ type: 'noise', dur: 0.28, vol: 0.3, filter: 2600, filterEnd: 220, q: 1.2 });
        V({ type: 'square', freq: 160 * k, freqEnd: 40 * k, dur: 0.2, vol: 0.2 });
        break;

      case 'explosion':
        V({ type: 'noise', dur: 0.55, vol: 0.36, filter: 1800, filterEnd: 90, q: 1.5 });
        V({ type: 'square', freq: 180 * k, freqEnd: 28 * k, dur: 0.42, vol: 0.22 });
        V({ type: 'noise', dur: 0.22, vol: 0.18, filter: 5200, filterEnd: 800, when: when + 0.02 });
        break;

      case 'boom': // smaller, tighter blast
        V({ type: 'noise', dur: 0.3, vol: 0.28, filter: 1400, filterEnd: 120 });
        V({ type: 'triangle', freq: 140 * k, freqEnd: 34 * k, dur: 0.26, vol: 0.2 });
        break;

      case 'jump':
        V({ type: 'pulse50', freq: 300 * k, freqEnd: 900 * k, dur: 0.14, vol: 0.2 });
        break;

      case 'doublejump':
        V({ type: 'pulse25', freq: 480 * k, freqEnd: 1180 * k, dur: 0.13, vol: 0.18 });
        break;

      case 'land':
        V({ type: 'noise', dur: 0.11, vol: 0.16, filter: 900, filterEnd: 180 });
        V({ type: 'triangle', freq: 150 * k, freqEnd: 70 * k, dur: 0.1, vol: 0.14 });
        break;

      case 'coin':
        V({ type: 'pulse25', freq: noteToFreq('B5') * k, dur: 0.07, vol: 0.2 });
        V({ type: 'pulse25', freq: noteToFreq('E6') * k, dur: 0.22, vol: 0.2, when: when + 0.07 });
        break;

      case 'pickup':
        V({ type: 'pulse50', freq: 620 * k, freqEnd: 1240 * k, dur: 0.1, vol: 0.18 });
        break;

      case 'powerup':
        this.arp([['C5', 0.06], ['E5', 0.06], ['G5', 0.06], ['C6', 0.14]],
          { when, type: 'pulse25', vol: 0.2 * v });
        break;

      case 'hit':
        V({ type: 'square', freq: 320 * k, freqEnd: 90 * k, dur: 0.12, vol: 0.24 });
        V({ type: 'noise', dur: 0.08, vol: 0.16, filter: 2200, filterEnd: 400 });
        break;

      case 'hurt':
        V({ type: 'sawtooth', freq: 260 * k, freqEnd: 70 * k, dur: 0.3, vol: 0.24, filter: 1400, filterEnd: 200 });
        break;

      case 'blip':
        V({ type: 'pulse50', freq: 880 * k, dur: 0.045, vol: 0.13 });
        break;

      case 'select':
        V({ type: 'pulse25', freq: 660 * k, dur: 0.05, vol: 0.14 });
        V({ type: 'pulse25', freq: 990 * k, dur: 0.07, vol: 0.13, when: when + 0.05 });
        break;

      case 'back':
        V({ type: 'pulse25', freq: 520 * k, dur: 0.05, vol: 0.13 });
        V({ type: 'pulse25', freq: 330 * k, dur: 0.09, vol: 0.12, when: when + 0.05 });
        break;

      case 'deny':
        V({ type: 'square', freq: 180 * k, dur: 0.09, vol: 0.16 });
        V({ type: 'square', freq: 120 * k, dur: 0.14, vol: 0.16, when: when + 0.08 });
        break;

      case 'motor': // one-shot rev; use `motorHum` for a sustained loop
        V({ type: 'sawtooth', freq: 70 * k, freqEnd: 190 * k, dur: 0.6, vol: 0.14, filter: 800, filterEnd: 1800 });
        break;

      case 'thrust':
        V({ type: 'noise', dur: 0.2, vol: 0.14, filter: 500, filterEnd: 900, q: 3 });
        break;

      case 'bounce':
        V({ type: 'triangle', freq: 520 * k, freqEnd: 240 * k, dur: 0.08, vol: 0.2 });
        break;

      case 'brick':
        V({ type: 'square', freq: 700 * k, freqEnd: 400 * k, dur: 0.06, vol: 0.16 });
        V({ type: 'noise', dur: 0.05, vol: 0.1, filter: 3000 });
        break;

      case 'clear': // line clear / match
        this.arp([['G4', 0.05], ['B4', 0.05], ['D5', 0.05], ['G5', 0.12]],
          { when, type: 'pulse50', vol: 0.2 * v });
        break;

      case 'tetris':
        this.arp([['C5', 0.06], ['G5', 0.06], ['C6', 0.06], ['E6', 0.06], ['G6', 0.2]],
          { when, type: 'pulse25', vol: 0.22 * v });
        break;

      case 'drop':
        V({ type: 'noise', dur: 0.09, vol: 0.16, filter: 1200, filterEnd: 200 });
        V({ type: 'square', freq: 220 * k, freqEnd: 80 * k, dur: 0.09, vol: 0.16 });
        break;

      case 'rotate':
        V({ type: 'pulse12', freq: 720 * k, dur: 0.035, vol: 0.1 });
        break;

      case 'step':
        V({ type: 'noise', dur: 0.05, vol: 0.07, filter: 1100, filterEnd: 500 });
        break;

      case 'splash':
        V({ type: 'noise', dur: 0.35, vol: 0.22, filter: 900, filterEnd: 2800, q: 2 });
        break;

      case 'horn':
        V({ type: 'sawtooth', freq: 240 * k, dur: 0.3, vol: 0.16, filter: 1200 });
        V({ type: 'sawtooth', freq: 302 * k, dur: 0.3, vol: 0.14, filter: 1200 });
        break;

      case 'alert':
        V({ type: 'square', freq: 880 * k, dur: 0.1, vol: 0.16 });
        V({ type: 'square', freq: 1180 * k, dur: 0.14, vol: 0.16, when: when + 0.11 });
        break;

      case 'charge':
        V({ type: 'pulse25', freq: 200 * k, freqEnd: 1200 * k, dur: 0.5, vol: 0.14 });
        break;

      case 'zap':
        V({ type: 'sawtooth', freq: 2200 * k, freqEnd: 260 * k, dur: 0.14, vol: 0.18, filter: 4000, filterEnd: 600 });
        break;

      case 'freeze':
        V({ type: 'triangle', freq: 1600 * k, freqEnd: 520 * k, dur: 0.4, vol: 0.16, vibrato: 30, vibratoHz: 14 });
        break;

      case 'gameover':
        this.arp([['G4', 0.14], ['F#4', 0.14], ['F4', 0.14], ['E4', 0.5]],
          { when, type: 'pulse50', vol: 0.24 * v });
        this.voice({ type: 'triangle', freq: noteToFreq('E3'), dur: 0.7, vol: 0.16 * v, when: when + 0.42 });
        break;

      case 'victory':
        this.arp([['C5', 0.1], ['E5', 0.1], ['G5', 0.1], ['C6', 0.1], ['G5', 0.1], ['C6', 0.42]],
          { when, type: 'pulse25', vol: 0.24 * v });
        this.voice({ type: 'triangle', freq: noteToFreq('C4'), dur: 0.6, vol: 0.16 * v, when: when + 0.5 });
        break;

      case 'levelup':
        this.arp([['E5', 0.07], ['G5', 0.07], ['B5', 0.07], ['E6', 0.22]],
          { when, type: 'pulse50', vol: 0.2 * v });
        break;

      case 'combo':
        V({ type: 'pulse25', freq: 700 * k, freqEnd: 1400 * k, dur: 0.09, vol: 0.14 });
        break;

      case 'perfect':
        V({ type: 'pulse12', freq: 1320 * k, dur: 0.06, vol: 0.14 });
        V({ type: 'pulse12', freq: 1760 * k, dur: 0.1, vol: 0.13, when: when + 0.05 });
        break;

      case 'miss':
        V({ type: 'square', freq: 200 * k, freqEnd: 110 * k, dur: 0.18, vol: 0.16 });
        break;

      case 'kick':
        V({ type: 'sine', freq: 150, freqEnd: 44, dur: 0.18, vol: 0.4 });
        break;

      case 'snare':
        V({ type: 'noise', dur: 0.14, vol: 0.24, filter: 3200, filterEnd: 900, q: 1.4 });
        V({ type: 'triangle', freq: 220, freqEnd: 160, dur: 0.09, vol: 0.12 });
        break;

      case 'hat':
        V({ type: 'noise', dur: 0.045, vol: 0.1, filter: 9000, filterType: 'highpass', q: 1 });
        break;

      default:
        V({ type: 'pulse50', freq: 600 * k, dur: 0.06, vol: 0.12 });
    }
  }

  /**
   * Sustained looping engine hum (racer / lander). Returns a handle with
   * `setRPM(0..1)` and `stop()`. Only one hum per handle.
   */
  motorHum(base = 60) {
    if (!this.ready) this.unlock();
    if (!this.ctx) return { setRPM() {}, stop() {} };
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = base;
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = base * 0.5;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 700;
    filt.Q.value = 4;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    osc.connect(filt);
    sub.connect(filt);
    filt.connect(g).connect(this.sfxBus);
    osc.start();
    sub.start();
    g.gain.setTargetAtTime(0.09, ctx.currentTime, 0.2);

    let stopped = false;
    return {
      setRPM: (r) => {
        if (stopped) return;
        const t = ctx.currentTime;
        const f = base + Math.max(0, Math.min(1, r)) * base * 3.2;
        osc.frequency.setTargetAtTime(f, t, 0.08);
        sub.frequency.setTargetAtTime(f * 0.5, t, 0.08);
        filt.frequency.setTargetAtTime(420 + r * 1900, t, 0.1);
      },
      setVolume: (v) => {
        if (!stopped) g.gain.setTargetAtTime(Math.max(0.0001, v), ctx.currentTime, 0.1);
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        g.gain.setTargetAtTime(0.0001, t, 0.08);
        try { osc.stop(t + 0.4); sub.stop(t + 0.4); } catch { /* already stopped */ }
      },
    };
  }

  /* -------------------------------------------------------------- music  */

  /**
   * Start a looping procedural chiptune track.
   *
   * @param {object} spec
   * @param {number} spec.bpm
   * @param {number} [spec.steps]   steps per loop (16th notes), default 16
   * @param {string[]} [spec.bass]  note or '.' per step
   * @param {string[]} [spec.lead]
   * @param {string} [spec.drums]   per step: k=kick s=snare h=hat .=rest
   * @param {function} [spec.onStep] called (stepIndex, audioTime) as steps fire
   * @returns {{stop:function, position:function, bpm:number, startedAt:number}}
   */
  startTrack(spec) {
    if (!this.ready) this.unlock();
    if (!this.ctx) return { stop() {}, position: () => 0, bpm: spec.bpm || 120, startedAt: 0 };
    this.stopTrack();

    const bpm = spec.bpm || 120;
    const stepDur = 60 / bpm / 4; // 16th notes
    const steps = spec.steps || 16;
    const startedAt = this.ctx.currentTime + 0.12;
    let nextStep = 0;

    const scheduleAhead = 0.25;
    const beatEvents = [];

    const schedule = () => {
      if (!this._track || this._track.token !== token) return;
      const now = this.ctx.currentTime;
      while (startedAt + nextStep * stepDur < now + scheduleAhead) {
        const t = startedAt + nextStep * stepDur;
        const i = nextStep % steps;

        if (spec.drums) {
          const d = spec.drums[i % spec.drums.length];
          if (d === 'k') this.voice({ type: 'sine', freq: 150, freqEnd: 44, dur: 0.18, vol: 0.34, when: t, bus: 'music' });
          else if (d === 's') {
            this.voice({ type: 'noise', dur: 0.13, vol: 0.2, filter: 3000, filterEnd: 900, when: t, bus: 'music' });
            this.voice({ type: 'triangle', freq: 210, freqEnd: 150, dur: 0.08, vol: 0.1, when: t, bus: 'music' });
          } else if (d === 'h') {
            this.voice({ type: 'noise', dur: 0.04, vol: 0.07, filter: 9000, filterType: 'highpass', when: t, bus: 'music' });
          }
        }
        if (spec.bass) {
          const n = spec.bass[i % spec.bass.length];
          if (n && n !== '.') {
            this.voice({ type: 'pulse50', freq: noteToFreq(n), dur: stepDur * 0.9, vol: 0.16, when: t, bus: 'music' });
          }
        }
        if (spec.lead) {
          const n = spec.lead[i % spec.lead.length];
          if (n && n !== '.') {
            this.voice({ type: 'pulse25', freq: noteToFreq(n), dur: stepDur * 1.4, vol: 0.11, when: t, bus: 'music' });
          }
        }
        if (spec.onStep) beatEvents.push({ step: nextStep, time: t });
        nextStep++;
      }

      // Fire onStep callbacks as their audio time arrives.
      if (spec.onStep) {
        while (beatEvents.length && beatEvents[0].time <= now) {
          const e = beatEvents.shift();
          try { spec.onStep(e.step, e.time); } catch { /* game-side error */ }
        }
      }
    };

    const token = Symbol('track');
    const timer = setInterval(schedule, 40);
    schedule();
    this._track = {
      token,
      stop: () => clearInterval(timer),
      startedAt,
      stepDur,
      bpm,
    };

    return {
      bpm,
      startedAt,
      stepDur,
      /** Seconds elapsed since the track's first step (negative before start). */
      position: () => (this.ctx ? this.ctx.currentTime - startedAt : 0),
      stop: () => this.stopTrack(),
    };
  }

  stopTrack() {
    if (this._track) {
      this._track.stop();
      this._track = null;
    }
  }
}

export default AudioEngine;
