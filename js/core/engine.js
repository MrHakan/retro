/**
 * engine.js — lifecycle framework.
 *
 * Every game is a module exporting `meta` plus `create(api)`, where the created
 * object implements the strict interface:
 *
 *     init()            once, after the view is sized
 *     update(dt)        dt in seconds, clamped
 *     render(ctx)       draw in virtual coordinates
 *     handleInput(e)    discrete input events
 *     destroy()         release timers/audio handles
 *
 * The Engine owns the RAF loop, the shared score/HUD model, and the unified
 * Pause / Game Over / Restart flow so no game has to reimplement any of it.
 */

import { Particles, Shake, RNG } from './fx.js';

export const STATE = {
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
  OVER: 'over',
};

export class Engine {
  constructor({ display, input, audio, storage, hud }) {
    this.display = display;
    this.input = input;
    this.audio = audio;
    this.storage = storage;
    this.hud = hud;

    this.state = STATE.IDLE;
    this.game = null;
    this.meta = null;
    this.score = 0;
    this.status = {};
    this.elapsed = 0;
    this.showFps = false;

    this.particles = new Particles(1000);
    this.shake = new Shake();
    this.rng = new RNG();

    this._raf = null;
    this._last = 0;
    this._acc = 0;
    this._running = false;

    /** Consumer hooks, wired up by the shell (ui.js). */
    this.onGameOver = null;
    this.onPauseChange = null;
    this.onScoreChange = null;
    this.onStatusChange = null;
    this.onExit = null;

    this.input.onEvent = (e) => this._onInput(e);
  }

  /* --------------------------------------------------------------- start */

  /**
   * Mount a game module.
   * @param {{meta:object, create:function}} mod
   * @param {object} [opts] `{seed}`
   */
  load(mod, opts = {}) {
    this.unload();

    const meta = mod.meta;
    this.meta = meta;
    this.score = 0;
    this.status = {};
    this.elapsed = 0;
    this.particles.clear();
    this.shake.reset();
    this.rng.seed(opts.seed ?? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);

    const view = meta.view || { w: 480, h: 360 };
    this.display.setView(view.w, view.h);
    this.input.setTouchLayout(meta.touch || null);
    this.input.releaseAll();
    this.input.clearEdges();

    this.game = mod.create(this._makeApi());
    this.state = STATE.PLAYING;
    if (this.game.init) this.game.init();

    this._emitScore();
    this._emitStatus();
    this.start();
    return this.game;
  }

  _makeApi() {
    const engine = this;
    const view = this.meta.view || { w: 480, h: 360 };
    return {
      /* --- world --- */
      get w() { return view.w; },
      get h() { return view.h; },
      view,
      meta: this.meta,

      /* --- services --- */
      audio: this.audio,
      input: this.input,
      storage: this.storage,
      rng: this.rng,
      particles: this.particles,
      shake: this.shake,
      display: this.display,

      /* --- scoring --- */
      get score() { return engine.score; },
      setScore(v) {
        engine.score = Math.max(0, Math.round(v) || 0);
        engine._emitScore();
      },
      addScore(v) {
        engine.score = Math.max(0, engine.score + (Math.round(v) || 0));
        engine._emitScore();
      },
      /** Extra HUD fields, e.g. `{ LEVEL: 3, LIVES: 2 }`. */
      setStatus(obj) {
        engine.status = { ...engine.status, ...obj };
        engine._emitStatus();
      },
      clearStatus() {
        engine.status = {};
        engine._emitStatus();
      },
      highScore() {
        return engine.storage.getHighScore(engine.meta.id).score;
      },

      /* --- flow --- */
      gameOver(opts = {}) { engine.gameOver(opts); },
      win(opts = {}) { engine.gameOver({ ...opts, win: true }); },
      pause() { engine.pause(); },
      exit() { if (engine.onExit) engine.onExit(); },

      /* --- juice --- */
      shakeScreen(mag, decay) { engine.shake.add(mag, decay); },
      vibrate(ms) {
        if (navigator.vibrate && engine.storage.getSettings().haptics !== false) {
          try { navigator.vibrate(ms); } catch { /* unsupported */ }
        }
      },
      sfx(name, o) { engine.audio.sfx(name, o); },

      /* --- time --- */
      get time() { return engine.elapsed; },
      get isTouch() { return engine.input.hasTouch; },
    };
  }

  unload() {
    this.stop();
    if (this.game && this.game.destroy) {
      try { this.game.destroy(); } catch (err) { console.warn('destroy() failed', err); }
    }
    this.audio.stopTrack();
    this.game = null;
    this.state = STATE.IDLE;
    this.particles.clear();
    this.shake.reset();
    this.input.hideTouch();
  }

  restart() {
    if (!this.meta) return;
    const mod = this._mod;
    if (mod) this.load(mod);
  }

  /** Keep a handle on the module so Restart can re-create cleanly. */
  loadModule(mod, opts) {
    this._mod = mod;
    return this.load(mod, opts);
  }

  /* ---------------------------------------------------------------- loop */

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    const tick = (ts) => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(tick);
      this._frame(ts);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _frame(ts) {
    const raw = (ts - this._last) / 1000;
    this._last = ts;
    // Clamp so an alt-tab or a slow frame can't tunnel physics through walls.
    const dt = Math.min(Math.max(raw, 0), 1 / 30);

    if (this.state === STATE.PLAYING && this.game) {
      this.elapsed += dt;
      try {
        this.game.update(dt);
      } catch (err) {
        console.error('update() crashed', err);
        this.gameOver({ message: 'SYSTEM FAULT', error: true });
      }
      this.particles.update(dt);
      this.shake.update(dt);
    } else if (this.state === STATE.OVER) {
      // Let explosions finish playing out over the game-over overlay.
      this.particles.update(dt);
      this.shake.update(dt);
    }

    const ctx = this.display.begin();
    if (this.game) {
      ctx.save();
      this.shake.apply(ctx);
      try {
        this.game.render(ctx);
      } catch (err) {
        console.error('render() crashed', err);
      }
      ctx.restore();
    }
    this.display.end();

    if (this.display.tickFps(dt) && this.showFps && this.hud?.fps) {
      this.hud.fps.textContent = this.display.fps + ' FPS';
    }
  }

  /* --------------------------------------------------------------- flow  */

  pause() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.PAUSED;
    this.input.releaseAll();
    this.audio.sfx('back');
    this.audio.stopTrack();
    if (this.onPauseChange) this.onPauseChange(true);
  }

  resume() {
    if (this.state !== STATE.PAUSED) return;
    this.state = STATE.PLAYING;
    this._last = performance.now();
    this.input.clearEdges();
    if (this.game.onResume) {
      try { this.game.onResume(); } catch { /* optional hook */ }
    }
    if (this.onPauseChange) this.onPauseChange(false);
  }

  togglePause() {
    if (this.state === STATE.PLAYING) this.pause();
    else if (this.state === STATE.PAUSED) this.resume();
  }

  /**
   * End the run. Records the high score and hands the summary to the shell.
   * @param {object} opts `{score, win, message, stats}`
   */
  gameOver(opts = {}) {
    if (this.state === STATE.OVER) return;
    this.state = STATE.OVER;
    const finalScore = Math.round(opts.score ?? this.score);
    this.score = finalScore;
    const record = this.storage.submitScore(this.meta.id, finalScore);
    this.input.releaseAll();
    this.audio.stopTrack();
    this.audio.sfx(opts.win ? 'victory' : 'gameover');
    if (this.onGameOver) {
      this.onGameOver({
        score: finalScore,
        win: !!opts.win,
        record,
        best: this.storage.getHighScore(this.meta.id).score,
        message: opts.message || (opts.win ? 'MISSION COMPLETE' : 'GAME OVER'),
        stats: opts.stats || null,
      });
    }
  }

  /* -------------------------------------------------------------- input  */

  _onInput(e) {
    if (e.type === 'press') {
      if (e.action === 'pause') {
        this.togglePause();
        return;
      }
      if (e.action === 'back') {
        if (this.state === STATE.PLAYING) this.pause();
        else if (this.onExit) this.onExit();
        return;
      }
    }
    if (this.state !== STATE.PLAYING || !this.game || !this.game.handleInput) return;
    try {
      this.game.handleInput(e);
    } catch (err) {
      console.error('handleInput() crashed', err);
    }
  }

  /* --------------------------------------------------------------- hud   */

  _emitScore() {
    if (this.onScoreChange) this.onScoreChange(this.score);
  }

  _emitStatus() {
    if (this.onStatusChange) this.onStatusChange(this.status);
  }
}

export default Engine;
