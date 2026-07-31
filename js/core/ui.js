/**
 * ui.js — the arcade shell: boot sequence, cabinet launcher, category and
 * search filtering, detail cards, settings (audio / CRT / keybindings / data),
 * the unified pause + game-over overlays, and PWA install plumbing.
 *
 * The shell owns all DOM; games only ever see a 2D context.
 */

import { PAL, alpha } from './fx.js';
import { STATE } from './engine.js';

const $ = (id) => document.getElementById(id);

const KEY_LABELS = {
  up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT',
  a: 'ACTION A', b: 'ACTION B', c: 'ACTION C', pause: 'PAUSE', back: 'BACK',
};

/** Human-readable name for a KeyboardEvent.code. */
function keyLabel(code) {
  if (!code) return '—';
  return code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Arrow/, '')
    .replace(/^Numpad/, 'NUM ')
    .replace('Left', ' L')
    .replace('Right', ' R')
    .toUpperCase();
}

export class ArcadeShell {
  constructor({ engine, games, audio, storage, display, input }) {
    this.engine = engine;
    this.games = games;
    this.audio = audio;
    this.storage = storage;
    this.display = display;
    this.input = input;

    this.settings = storage.getSettings();
    this.activeCategory = 'ALL';
    this.query = '';
    this.currentMod = null;
    this.deferredInstall = null;

    this.el = {
      boot: $('boot'), bootLog: $('boot-log'), bootStart: $('boot-start'),
      launcher: $('launcher'), arcade: $('arcade'), stage: $('stage'),
      grid: $('game-grid'), cats: $('categories'), search: $('search'),
      stats: $('hub-stats'), offline: $('offline-state'),
      hudTitle: $('hud-title'), readout: $('hud-readout'), fps: $('fps'),
      overPause: $('overlay-pause'), overOver: $('overlay-over'),
      overSettings: $('overlay-settings'), overDetail: $('overlay-detail'),
      toast: $('toast'),
    };

    this._wireShell();
    this._wireEngine();
    this._wireSettings();
    this._applySettings();
  }

  /* ---------------------------------------------------------------- boot */

  async boot() {
    const lines = [
      'RETRO-CANVAS-ARCADE  v1.0',
      'CPU ......... VANILLA ES2022  OK',
      'VIDEO ....... CANVAS 2D / HIGH-DPI  OK',
      'AUDIO ....... WEB AUDIO SYNTH  OK',
      `CABINETS .... ${this.games.length} LOADED`,
      'STORAGE ..... LOCAL  OK',
      'NETWORK ..... NOT REQUIRED',
    ];
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      this.el.bootLog.appendChild(div);
      await new Promise((r) => setTimeout(r, 130));
    }
    this.el.bootStart.hidden = false;
    this.el.bootStart.focus();
  }

  startShell() {
    // The click that dismisses the boot screen is our audio unlock gesture.
    this.audio.unlock();
    this.audio.sfx('powerup');
    this.el.boot.hidden = true;
    this.el.launcher.hidden = false;
    this.renderGrid();
    this.renderStats();

    // Manifest shortcuts and shared links land on `./?game=<id>`.
    const wanted = new URLSearchParams(location.search).get('game');
    if (wanted) {
      const mod = this.games.find((g) => g.meta.id === wanted);
      if (mod) this.play(mod);
      else this.toast(`UNKNOWN CABINET: ${wanted.toUpperCase()}`);
    }
  }

  _wireShell() {
    this.el.bootStart.addEventListener('click', () => this.startShell());

    $('btn-settings').addEventListener('click', () => this.openSettings());
    $('settings-close').addEventListener('click', () => this.closeSettings());
    $('btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    $('btn-back').addEventListener('click', () => this.quitToHub());
    $('btn-pause').addEventListener('click', () => this.engine.togglePause());
    $('btn-restart').addEventListener('click', () => this.restart());

    $('pause-resume').addEventListener('click', () => this.engine.resume());
    $('pause-restart').addEventListener('click', () => this.restart());
    $('pause-settings').addEventListener('click', () => this.openSettings());
    $('pause-quit').addEventListener('click', () => this.quitToHub());

    $('over-again').addEventListener('click', () => this.restart());
    $('over-quit').addEventListener('click', () => this.quitToHub());

    $('detail-close').addEventListener('click', () => { this.el.overDetail.hidden = true; });
    $('detail-play').addEventListener('click', () => {
      this.el.overDetail.hidden = true;
      if (this._detailGame) this.play(this._detailGame);
    });

    this.el.search.addEventListener('input', (e) => {
      this.query = e.target.value.trim().toLowerCase();
      this.filterGrid();
    });

    // Close the top-most modal with Escape when no game owns the keyboard.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this.el.overDetail.hidden) { this.el.overDetail.hidden = true; e.preventDefault(); }
      else if (!this.el.overSettings.hidden) { this.closeSettings(); e.preventDefault(); }
    });

    // Click-outside dismissal for the floating modals.
    for (const ov of [this.el.overSettings, this.el.overDetail]) {
      ov.addEventListener('pointerdown', (e) => {
        if (e.target === ov) ov.hidden = true;
      });
    }

    // Pause automatically when the tab is backgrounded — nobody wants to come
    // back to a dead run because the browser throttled the loop.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.engine.state === STATE.PLAYING) this.engine.pause();
        this.audio.suspend();
      } else {
        this.audio.resume();
      }
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstall = e;
      $('btn-install').hidden = false;
    });
    $('btn-install').addEventListener('click', async () => {
      if (!this.deferredInstall) return;
      this.deferredInstall.prompt();
      const { outcome } = await this.deferredInstall.userChoice;
      if (outcome === 'accepted') $('btn-install').hidden = true;
      this.deferredInstall = null;
    });

    window.addEventListener('online', () => this.setOfflineState());
    window.addEventListener('offline', () => this.setOfflineState());
    this.setOfflineState();
  }

  setOfflineState() {
    const cached = 'serviceWorker' in navigator && navigator.serviceWorker.controller;
    this.el.offline.textContent = navigator.onLine
      ? (cached ? '● CACHED FOR OFFLINE PLAY' : '● CACHING FOR OFFLINE PLAY…')
      : '● OFFLINE MODE — RUNNING FROM CACHE';
  }

  /* -------------------------------------------------------------- grid  */

  renderGrid() {
    const grid = this.el.grid;
    grid.innerHTML = '';

    const cats = ['ALL', ...new Set(this.games.map((g) => g.meta.category))];
    this.el.cats.innerHTML = '';
    for (const c of cats) {
      const b = document.createElement('button');
      b.className = 'chip' + (c === this.activeCategory ? ' is-active' : '');
      b.textContent = c;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => {
        this.activeCategory = c;
        this.audio.sfx('blip');
        for (const chip of this.el.cats.children) chip.classList.toggle('is-active', chip.textContent === c);
        this.filterGrid();
      });
      this.el.cats.appendChild(b);
    }

    this.games.forEach((mod, i) => {
      const m = mod.meta;
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.id = m.id;
      card.dataset.search = `${m.title} ${m.category} ${m.desc}`.toLowerCase();
      card.dataset.cat = m.category;

      const best = this.storage.getHighScore(m.id).score;
      card.innerHTML = `
        <span class="card-num">${String(i + 1).padStart(2, '0')}</span>
        ${best ? `<span class="card-best">★${best.toLocaleString()}</span>` : ''}
        <div class="card-body">
          <div class="card-title">${m.title}</div>
          <div class="card-cat">${m.category}</div>
        </div>`;

      const cv = document.createElement('canvas');
      cv.width = 240;
      cv.height = 180;
      card.insertBefore(cv, card.firstChild);
      this._paintThumb(cv, m);

      card.addEventListener('click', () => this.openDetail(mod));
      grid.appendChild(card);
    });

    this.filterGrid();
  }

  /** Paint a card thumbnail using the game's own `meta.art` painter. */
  _paintThumb(canvas, meta) {
    const c = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const accent = meta.accent || PAL.cyan;

    c.fillStyle = '#06080f';
    c.fillRect(0, 0, w, h);

    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, alpha(accent, 0.16));
    g.addColorStop(1, 'rgba(6,8,15,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    c.save();
    c.globalAlpha = 0.22;
    c.strokeStyle = accent;
    c.lineWidth = 1;
    c.beginPath();
    for (let x = 0; x <= w; x += 20) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); }
    for (let y = 0; y <= h; y += 20) { c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); }
    c.stroke();
    c.restore();

    if (typeof meta.art === 'function') {
      c.save();
      try { meta.art(c, w, h, accent); } catch (err) { console.warn('thumb art failed', meta.id, err); }
      c.restore();
    } else {
      c.save();
      c.shadowColor = accent;
      c.shadowBlur = 18;
      c.fillStyle = accent;
      c.font = 'bold 46px "Courier New", monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(meta.short || meta.title.slice(0, 3), w / 2, h / 2);
      c.restore();
    }

    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(0, h - 4, w, 4);
  }

  filterGrid() {
    let visible = 0;
    for (const card of this.el.grid.children) {
      const okCat = this.activeCategory === 'ALL' || card.dataset.cat === this.activeCategory;
      const okQ = !this.query || card.dataset.search.includes(this.query);
      const show = okCat && okQ;
      card.classList.toggle('is-hidden', !show);
      if (show) visible++;
    }
    let empty = this.el.grid.querySelector('.empty-state');
    if (!visible) {
      if (!empty) {
        empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = 'NO CABINETS MATCH THAT SEARCH.';
        this.el.grid.appendChild(empty);
      }
    } else if (empty) {
      empty.remove();
    }
  }

  renderStats() {
    const scores = this.storage.allScores();
    const played = Object.keys(this.storage.allPlays()).length;
    const total = this.storage.totalPlays();
    const best = Object.values(scores).reduce((a, s) => a + (s.score || 0), 0);
    this.el.stats.innerHTML = `
      <div class="stat"><b>${this.games.length}</b><span>CABINETS</span></div>
      <div class="stat"><b>${played}</b><span>PLAYED</span></div>
      <div class="stat"><b>${total}</b><span>TOTAL RUNS</span></div>
      <div class="stat"><b>${best.toLocaleString()}</b><span>SCORE SUM</span></div>`;
  }

  /* ------------------------------------------------------------- detail */

  openDetail(mod) {
    const m = mod.meta;
    this._detailGame = mod;
    this.audio.sfx('select');
    $('detail-title').textContent = m.title;
    $('detail-cat').textContent = m.category;
    $('detail-desc').textContent = m.desc;
    $('detail-best').textContent = this.storage.getHighScore(m.id).score.toLocaleString();
    $('detail-plays').textContent = this.storage.getPlays(m.id);
    const list = $('detail-controls');
    list.innerHTML = '';
    for (const line of m.controls || []) {
      const li = document.createElement('li');
      li.innerHTML = line.replace(/^([^—]+)—/, '<b>$1</b>—');
      list.appendChild(li);
    }
    this.el.overDetail.hidden = false;
  }

  /* --------------------------------------------------------------- play */

  play(mod) {
    this.currentMod = mod;
    this.audio.unlock();
    this.storage.bumpPlays(mod.meta.id);

    this.el.launcher.hidden = true;
    this.el.arcade.hidden = false;
    this.el.overPause.hidden = true;
    this.el.overOver.hidden = true;
    $('hud-title').textContent = mod.meta.short || mod.meta.title;

    // The stage must have its final size before the display measures it.
    requestAnimationFrame(() => {
      this.display.resize();
      this.engine.loadModule(mod);
      this.renderPauseControls(mod.meta);
    });
  }

  restart() {
    if (!this.currentMod) return;
    this.el.overPause.hidden = true;
    this.el.overOver.hidden = true;
    this.audio.sfx('select');
    this.engine.loadModule(this.currentMod);
  }

  quitToHub() {
    this.engine.unload();
    this.audio.sfx('back');
    this.el.overPause.hidden = true;
    this.el.overOver.hidden = true;
    this.el.arcade.hidden = true;
    this.el.launcher.hidden = false;
    this.renderGrid();
    this.renderStats();
    this.setOfflineState();
  }

  renderPauseControls(meta) {
    const box = $('pause-controls');
    box.innerHTML = (meta.controls || [])
      .map((c) => `<div>${c.replace(/^([^—]+)—/, '<kbd>$1</kbd> —')}</div>`)
      .join('');
  }

  _wireEngine() {
    this.engine.onScoreChange = () => this.renderReadout();
    this.engine.onStatusChange = () => this.renderReadout();
    this.engine.onExit = () => this.quitToHub();

    this.engine.onPauseChange = (paused) => {
      this.el.overPause.hidden = !paused;
      $('btn-pause').textContent = paused ? '▶' : '❚❚';
    };

    this.engine.onGameOver = (r) => {
      $('over-title').textContent = r.message;
      $('over-title').style.color = r.win ? PAL.lime : PAL.magenta;
      $('over-score').textContent = r.score.toLocaleString();
      $('over-best').textContent = r.best.toLocaleString();
      $('over-record').hidden = !r.record;
      const stats = $('over-stats');
      stats.innerHTML = r.stats
        ? Object.entries(r.stats).map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')
        : '';
      this.el.overOver.hidden = false;
      if (r.record) this.storage.unlock(`record.${this.engine.meta.id}`, `High score in ${this.engine.meta.title}`);
    };
  }

  renderReadout() {
    const e = this.engine;
    const best = this.storage.getHighScore(e.meta?.id || '').score;
    const parts = [
      `<div class="readout"><span>${e.meta?.scoreLabel || 'SCORE'}</span><b>${e.score.toLocaleString()}</b></div>`,
      `<div class="readout"><span>BEST</span><b>${best.toLocaleString()}</b></div>`,
    ];
    for (const [k, v] of Object.entries(e.status)) {
      parts.push(`<div class="readout"><span>${k}</span><b>${v}</b></div>`);
    }
    this.el.readout.innerHTML = parts.join('');
  }

  /* ----------------------------------------------------------- settings */

  openSettings() {
    if (this.engine.state === STATE.PLAYING) this.engine.pause();
    this.settings = this.storage.getSettings();
    this._syncSettingsUI();
    this._renderKeymap();
    this._renderDataSummary();
    this.el.overSettings.hidden = false;
  }

  closeSettings() {
    this.el.overSettings.hidden = true;
    this.audio.sfx('back');
  }

  _wireSettings() {
    const bind = (id, event, fn) => $(id).addEventListener(event, fn);

    bind('set-master', 'input', (e) => this._set({ master: parseFloat(e.target.value) }));
    bind('set-sfx', 'change', (e) => this._set({ sfx: e.target.checked }));
    bind('set-music', 'change', (e) => this._set({ music: e.target.checked }));
    bind('set-scanlines', 'change', (e) => this._set({ scanlines: e.target.checked }));
    bind('set-glow', 'change', (e) => this._set({ glow: e.target.checked }));
    bind('set-pixelate', 'change', (e) => this._set({ pixelate: e.target.checked }));
    bind('set-fps', 'change', (e) => this._set({ showFps: e.target.checked }));
    bind('set-reduced', 'change', (e) => this._set({ reducedFlash: e.target.checked }));
    bind('set-touch', 'change', (e) => this._set({ touchControls: e.target.value }));

    bind('keymap-reset', 'click', () => {
      this.storage.resetKeymap();
      this.input.setKeymap(this.storage.getKeymap());
      this._renderKeymap();
      this.toast('KEYBINDINGS RESET');
    });

    bind('btn-wipe', 'click', () => {
      if (!confirm('Erase all high scores, play counts, achievements and settings?')) return;
      this.storage.wipe();
      this.settings = this.storage.getSettings();
      this.input.setKeymap(this.storage.getKeymap());
      this._syncSettingsUI();
      this._renderKeymap();
      this._renderDataSummary();
      this._applySettings();
      this.renderGrid();
      this.renderStats();
      this.toast('SAVE DATA ERASED');
    });
  }

  _set(patch) {
    this.settings = this.storage.setSettings(patch);
    this._applySettings();
  }

  _applySettings() {
    const s = this.settings;
    document.body.classList.toggle('crt-scanlines', !!s.scanlines);
    document.body.classList.toggle('crt-glow', !!s.glow);
    this.display.setEffects({ pixelate: s.pixelate, glow: s.glow });
    this.audio.setMaster(s.master);
    this.audio.setSfxEnabled(s.sfx);
    this.audio.setMusicEnabled(s.music);
    this.input.setTouchMode(s.touchControls);
    this.engine.showFps = !!s.showFps;
    this.el.fps.hidden = !s.showFps;
  }

  _syncSettingsUI() {
    const s = this.settings;
    $('set-master').value = s.master;
    $('set-sfx').checked = !!s.sfx;
    $('set-music').checked = !!s.music;
    $('set-scanlines').checked = !!s.scanlines;
    $('set-glow').checked = !!s.glow;
    $('set-pixelate').checked = !!s.pixelate;
    $('set-fps').checked = !!s.showFps;
    $('set-reduced').checked = !!s.reducedFlash;
    $('set-touch').value = s.touchControls;
  }

  _renderKeymap() {
    const map = this.storage.getKeymap();
    const box = $('keymap');
    box.innerHTML = '';
    for (const [action, label] of Object.entries(KEY_LABELS)) {
      const row = document.createElement('div');
      row.className = 'keymap-row';
      const name = document.createElement('span');
      name.textContent = label;
      const btn = document.createElement('button');
      btn.className = 'key-btn';
      btn.textContent = (map[action] || []).map(keyLabel).join(' / ') || '—';
      btn.addEventListener('click', () => {
        btn.classList.add('is-listening');
        btn.textContent = 'PRESS KEY…';
        this.input.captureKey((code) => {
          btn.classList.remove('is-listening');
          const next = this.storage.getKeymap();
          // A code may only be bound to one action at a time.
          for (const k of Object.keys(next)) next[k] = next[k].filter((c) => c !== code);
          next[action] = [code];
          this.storage.setKeymap(next);
          this.input.setKeymap(next);
          this._renderKeymap();
          this.audio.sfx('select');
        });
      });
      row.append(name, btn);
      box.appendChild(row);
    }
  }

  _renderDataSummary() {
    const scores = Object.keys(this.storage.allScores()).length;
    const ach = Object.keys(this.storage.getAchievements()).length;
    $('data-summary').textContent =
      `${scores} high score${scores === 1 ? '' : 's'} · ${this.storage.totalPlays()} runs · ` +
      `${ach} achievement${ach === 1 ? '' : 's'} stored locally in this browser. Nothing leaves your device.`;
  }

  /* -------------------------------------------------------------- misc  */

  async toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        // Landscape suits every cabinet here; ignore failures on desktop.
        if (screen.orientation?.lock) {
          screen.orientation.lock('landscape').catch(() => {});
        }
      } else {
        await document.exitFullscreen();
      }
    } catch {
      this.toast('FULLSCREEN UNAVAILABLE');
    }
  }

  toast(msg, ms = 2200) {
    const t = this.el.toast;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
}

export default ArcadeShell;
