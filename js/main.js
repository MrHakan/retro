/**
 * main.js — bootstrap. Wires the core systems together, registers the
 * service worker for offline play, and hands control to the arcade shell.
 */

import Display from './core/display.js';
import AudioEngine from './core/audio.js';
import InputManager from './core/input.js';
import Storage from './core/storage.js';
import Engine from './core/engine.js';
import ArcadeShell from './core/ui.js';
import { GAMES } from './games/index.js';

const canvas = document.getElementById('screen');
const stage = document.getElementById('stage');
const touchLayer = document.getElementById('touch-layer');

const settings = Storage.getSettings();

const display = new Display(canvas, stage);
display.setEffects({ pixelate: settings.pixelate, glow: settings.glow });

const audio = new AudioEngine(settings);
const input = new InputManager(display, touchLayer, Storage.getKeymap());

const engine = new Engine({
  display,
  input,
  audio,
  storage: Storage,
  hud: { fps: document.getElementById('fps') },
});

const shell = new ArcadeShell({ engine, games: GAMES, audio, storage: Storage, display, input });

// Expose for console tinkering / debugging on a deployed build.
window.ARCADE = { engine, shell, audio, display, input, storage: Storage, games: GAMES };

shell.boot();

/* --------------------------------------------------------- service worker */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Relative registration + relative scope keeps this working under both
    // `user.github.io/` and `user.github.io/repo/`.
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              shell.toast('UPDATE READY — RELOAD TO APPLY');
            }
          });
        });
        navigator.serviceWorker.ready.then(() => shell.setOfflineState());
      })
      .catch((err) => {
        // A failed registration is not fatal: the hub still runs, just online.
        console.warn('Service worker registration failed:', err);
      });
  });
}
