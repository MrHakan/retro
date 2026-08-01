/**
 * Storage — localStorage wrapper for RETRO-CANVAS-ARCADE.
 *
 * Keys are namespaced by deployment path so that the same browser can host
 * `username.github.io/` and `username.github.io/repo/` without the two builds
 * fighting over each other's high scores. The namespace is derived from
 * `location.pathname` (directory portion only), which keeps everything
 * relative — no absolute host assumptions anywhere.
 */

const DIR = (() => {
  try {
    const p = location.pathname || '/';
    return p.slice(0, p.lastIndexOf('/') + 1) || '/';
  } catch {
    return '/';
  }
})();

const PREFIX = `rca${DIR === '/' ? '' : DIR.replace(/\/+$/, '').replace(/\//g, '.')}:`;

/** Feature-detect localStorage; Safari private mode throws on setItem. */
const backing = (() => {
  try {
    const probe = '__rca_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
})();

const DEFAULTS = {
  settings: {
    master: 0.7,
    sfx: true,
    music: true,
    scanlines: true,
    glow: true,
    glowQuality: 'auto', // auto | full | fast
    pixelate: false,
    showFps: false,
    touchControls: 'auto', // auto | always | never
    reducedFlash: false,
  },
  keymap: {
    up: ['ArrowUp', 'KeyW'],
    down: ['ArrowDown', 'KeyS'],
    left: ['ArrowLeft', 'KeyA'],
    right: ['ArrowRight', 'KeyD'],
    a: ['Space', 'KeyJ', 'Enter'],
    b: ['KeyK', 'ShiftLeft'],
    c: ['KeyL'],
    pause: ['KeyP'],
    back: ['Escape'],
  },
};

function read(key, fallback) {
  try {
    const raw = backing.getItem(PREFIX + key);
    if (raw == null) return structuredCloneSafe(fallback);
    const val = JSON.parse(raw);
    return val == null ? structuredCloneSafe(fallback) : val;
  } catch {
    return structuredCloneSafe(fallback);
  }
}

function write(key, value) {
  try {
    backing.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function structuredCloneSafe(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

export const Storage = {
  prefix: PREFIX,

  /* ---------------------------------------------------------- settings -- */
  getSettings() {
    return { ...DEFAULTS.settings, ...read('settings', {}) };
  },
  setSettings(patch) {
    const next = { ...this.getSettings(), ...patch };
    write('settings', next);
    return next;
  },

  /* ------------------------------------------------------------ keymap -- */
  getKeymap() {
    const stored = read('keymap', {});
    const out = {};
    for (const action of Object.keys(DEFAULTS.keymap)) {
      out[action] = Array.isArray(stored[action]) && stored[action].length
        ? stored[action].slice()
        : DEFAULTS.keymap[action].slice();
    }
    return out;
  },
  setKeymap(map) {
    write('keymap', map);
    return map;
  },
  resetKeymap() {
    write('keymap', structuredCloneSafe(DEFAULTS.keymap));
    return this.getKeymap();
  },

  /* ------------------------------------------------------- high scores -- */
  /** @returns {{score:number, at:number}} */
  getHighScore(gameId) {
    const all = read('scores', {});
    return all[gameId] || { score: 0, at: 0 };
  },
  /** @returns {boolean} true when a new record was set */
  submitScore(gameId, score) {
    if (!Number.isFinite(score)) return false;
    const all = read('scores', {});
    const prev = all[gameId]?.score ?? 0;
    if (score <= prev) return false;
    all[gameId] = { score: Math.round(score), at: Date.now() };
    write('scores', all);
    return true;
  },
  allScores() {
    return read('scores', {});
  },

  /* -------------------------------------------------------- play stats -- */
  getPlays(gameId) {
    return read('plays', {})[gameId] || 0;
  },
  bumpPlays(gameId) {
    const all = read('plays', {});
    all[gameId] = (all[gameId] || 0) + 1;
    write('plays', all);
    return all[gameId];
  },
  allPlays() {
    return read('plays', {});
  },
  totalPlays() {
    return Object.values(read('plays', {})).reduce((a, b) => a + b, 0);
  },

  /* ------------------------------------------------------ achievements -- */
  getAchievements() {
    return read('achievements', {});
  },
  unlock(id, label) {
    const all = this.getAchievements();
    if (all[id]) return false;
    all[id] = { label, at: Date.now() };
    write('achievements', all);
    return true;
  },
  hasAchievement(id) {
    return !!this.getAchievements()[id];
  },

  /* ------------------------------------------------------------- misc  -- */
  get(key, fallback = null) {
    return read('kv.' + key, fallback);
  },
  set(key, value) {
    return write('kv.' + key, value);
  },
  wipe() {
    for (const k of ['settings', 'keymap', 'scores', 'plays', 'achievements']) {
      try { backing.removeItem(PREFIX + k); } catch { /* ignore */ }
    }
  },
};

export default Storage;
