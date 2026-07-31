/**
 * InputManager — one unified action model for keyboard, mouse, pen and touch.
 *
 * Actions: up | down | left | right | a | b | c | pause | back
 *
 * Games read continuous state via `isDown(action)` / `stick` / `pointer`, and
 * receive discrete events through the engine's `handleInput(e)` callback.
 * Touch devices get a DOM-based virtual d-pad or analog stick plus action
 * buttons — DOM rather than canvas-drawn, so they stay crisp, accessible and
 * don't cost a redraw.
 */

export const ACTIONS = ['up', 'down', 'left', 'right', 'a', 'b', 'c', 'pause', 'back'];

export class InputManager {
  /**
   * @param {Display} display   for client->virtual coordinate mapping
   * @param {HTMLElement} touchRoot container that hosts the virtual controls
   * @param {object} keymap     action -> array of KeyboardEvent.code
   */
  constructor(display, touchRoot, keymap) {
    this.display = display;
    this.touchRoot = touchRoot;
    this.setKeymap(keymap);

    this.state = Object.create(null);
    this.pressedEdge = Object.create(null);
    for (const a of ACTIONS) {
      this.state[a] = false;
      this.pressedEdge[a] = false;
    }
    // Keyboard and touch are tracked separately so releasing one source does
    // not cancel a hold from the other.
    this._kb = Object.create(null);
    this._touch = Object.create(null);

    this.stick = { x: 0, y: 0, active: false };
    this.pointer = { x: 0, y: 0, down: false, id: null, inside: false };
    this.onEvent = null;
    this.enabled = true;
    this.mode = 'auto';
    this._layout = null;

    this._bindKeyboard();
    this._bindPointer();
    this._buildTouchUI();
    this.hasTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  }

  setKeymap(keymap) {
    this.keymap = keymap;
    this._codeToAction = Object.create(null);
    for (const [action, codes] of Object.entries(keymap || {})) {
      for (const code of codes) this._codeToAction[code] = action;
    }
  }

  /* ------------------------------------------------------------ keyboard */

  _bindKeyboard() {
    const isEditable = (el) =>
      el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

    this._onKeyDown = (e) => {
      if (!this.enabled || isEditable(document.activeElement)) return;
      if (this.captureNextKey) {
        e.preventDefault();
        const cb = this.captureNextKey;
        this.captureNextKey = null;
        cb(e.code);
        return;
      }
      const action = this._codeToAction[e.code];
      if (action) {
        // Arrows/space scroll the page; games need them.
        if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
        if (!this._kb[action]) {
          this._kb[action] = true;
          this._sync(action, true);
        }
      }
      this._emit({ type: 'key', code: e.code, key: e.key, action, repeat: e.repeat });
    };

    this._onKeyUp = (e) => {
      if (!this.enabled) return;
      const action = this._codeToAction[e.code];
      if (action && this._kb[action]) {
        this._kb[action] = false;
        this._sync(action, false);
      }
      this._emit({ type: 'keyup', code: e.code, key: e.key, action });
    };

    // A tab-out must not leave a movement key stuck down.
    this._onBlur = () => this.releaseAll();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  /** Grab the next physical key press (used by the key-rebinding UI). */
  captureKey(cb) {
    this.captureNextKey = cb;
  }

  _sync(action, down) {
    const next = !!(this._kb[action] || this._touch[action]);
    if (next === this.state[action]) return;
    this.state[action] = next;
    if (next) {
      this.pressedEdge[action] = true;
      this._emit({ type: 'press', action });
    } else {
      this._emit({ type: 'release', action });
    }
    this._recomputeStick();
  }

  _recomputeStick() {
    if (this.stick.active) return; // analog stick owns the vector while held
    const x = (this.state.right ? 1 : 0) - (this.state.left ? 1 : 0);
    const y = (this.state.down ? 1 : 0) - (this.state.up ? 1 : 0);
    const len = Math.hypot(x, y) || 1;
    this.stick.x = x / (len > 1 ? len : 1);
    this.stick.y = y / (len > 1 ? len : 1);
  }

  releaseAll() {
    for (const a of ACTIONS) {
      this._kb[a] = false;
      this._touch[a] = false;
      if (this.state[a]) {
        this.state[a] = false;
        this._emit({ type: 'release', action: a });
      }
    }
    this.stick.x = 0;
    this.stick.y = 0;
    this.stick.active = false;
    this.pointer.down = false;
    if (this._stickEl) this._resetStickKnob();
    if (this._touchRootEl) {
      for (const el of this._touchRootEl.querySelectorAll('.tc-btn.is-down')) {
        el.classList.remove('is-down');
      }
    }
  }

  /* ------------------------------------------------------------- pointer */

  _bindPointer() {
    const canvas = this.display.canvas;

    const toV = (e) => this.display.toVirtual(e.clientX, e.clientY);

    this._onPointerDown = (e) => {
      if (!this.enabled) return;
      const p = toV(e);
      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.pointer.down = true;
      this.pointer.id = e.pointerId;
      this.pointer.inside = true;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      this._emit({ type: 'pointerdown', x: p.x, y: p.y, button: e.button, id: e.pointerId, pointerType: e.pointerType });
    };

    this._onPointerMove = (e) => {
      if (!this.enabled) return;
      const p = toV(e);
      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.pointer.inside = p.x >= 0 && p.y >= 0 && p.x <= this.display.vw && p.y <= this.display.vh;
      this._emit({ type: 'pointermove', x: p.x, y: p.y, id: e.pointerId, down: this.pointer.down, pointerType: e.pointerType });
    };

    this._onPointerUp = (e) => {
      if (!this.enabled) return;
      const p = toV(e);
      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.pointer.down = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* fine */ }
      this._emit({ type: 'pointerup', x: p.x, y: p.y, button: e.button, id: e.pointerId, pointerType: e.pointerType });
    };

    this._onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this._emit({ type: 'wheel', dy: e.deltaY, dx: e.deltaX });
    };

    this._onContext = (e) => e.preventDefault();

    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this._onContext);
  }

  /* -------------------------------------------------------- touch UI DOM */

  _buildTouchUI() {
    const root = document.createElement('div');
    root.className = 'touch-controls';
    root.hidden = true;
    root.innerHTML = `
      <div class="tc-left">
        <div class="tc-stick" hidden>
          <div class="tc-stick-base"><div class="tc-stick-knob"></div></div>
        </div>
        <div class="tc-dpad" hidden>
          <button class="tc-btn tc-dir" data-action="up" aria-label="Up"></button>
          <button class="tc-btn tc-dir" data-action="left" aria-label="Left"></button>
          <button class="tc-btn tc-dir" data-action="right" aria-label="Right"></button>
          <button class="tc-btn tc-dir" data-action="down" aria-label="Down"></button>
        </div>
      </div>
      <div class="tc-right"></div>`;
    this.touchRoot.appendChild(root);

    this._touchRootEl = root;
    this._stickEl = root.querySelector('.tc-stick');
    this._stickBase = root.querySelector('.tc-stick-base');
    this._knob = root.querySelector('.tc-stick-knob');
    this._dpadEl = root.querySelector('.tc-dpad');
    this._btnRow = root.querySelector('.tc-right');

    // Delegated press handling for every button-shaped control.
    const press = (el, down) => {
      const action = el.dataset.action;
      if (!action) return;
      el.classList.toggle('is-down', down);
      if (!!this._touch[action] === down) return;
      this._touch[action] = down;
      this._sync(action, down);
    };

    root.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('.tc-btn');
      if (!btn) return;
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      press(btn, true);
    });
    const up = (e) => {
      const btn = e.target.closest?.('.tc-btn');
      if (btn) press(btn, false);
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('lostpointercapture', up);
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    this._bindStick();
  }

  _bindStick() {
    const base = this._stickBase;
    let pid = null;
    const radius = () => base.getBoundingClientRect().width / 2;

    const update = (e) => {
      const r = base.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const max = radius() * 0.72;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const d = Math.hypot(dx, dy);
      if (d > max) {
        dx = (dx / d) * max;
        dy = (dy / d) * max;
      }
      this._knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const nx = dx / max;
      const ny = dy / max;
      this.stick.x = nx;
      this.stick.y = ny;
      this.stick.active = true;
      // Mirror the analog vector onto the digital actions so grid-based games
      // (snake, roguelike, crosser) work with the stick too.
      const dead = 0.42;
      this._setTouchDir('left', nx < -dead);
      this._setTouchDir('right', nx > dead);
      this._setTouchDir('up', ny < -dead);
      this._setTouchDir('down', ny > dead);
    };

    base.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pid = e.pointerId;
      try { base.setPointerCapture(pid); } catch { /* ignore */ }
      update(e);
    });
    base.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      e.preventDefault();
      update(e);
    });
    const release = (e) => {
      if (pid !== null && e.pointerId !== pid) return;
      pid = null;
      this._resetStickKnob();
    };
    base.addEventListener('pointerup', release);
    base.addEventListener('pointercancel', release);
    base.addEventListener('lostpointercapture', release);
  }

  _resetStickKnob() {
    if (this._knob) this._knob.style.transform = 'translate(0px, 0px)';
    this.stick.active = false;
    this.stick.x = 0;
    this.stick.y = 0;
    for (const d of ['up', 'down', 'left', 'right']) this._setTouchDir(d, false);
    this._recomputeStick();
  }

  _setTouchDir(action, down) {
    if (!!this._touch[action] === down) return;
    this._touch[action] = down;
    this._sync(action, down);
  }

  /**
   * Configure the on-screen controls for a game.
   * @param {object|null} layout `{stick?:boolean, dpad?:boolean, buttons?:[{id,label}]}`
   */
  setTouchLayout(layout) {
    this._layout = layout;
    const show = this._shouldShowTouch(layout);
    this._touchRootEl.hidden = !show;
    if (!show) return;

    this._stickEl.hidden = !layout?.stick;
    this._dpadEl.hidden = !layout?.dpad;

    const buttons = layout?.buttons || [];
    this._btnRow.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'tc-btn tc-action';
      el.dataset.action = b.id;
      el.textContent = b.label || b.id.toUpperCase();
      el.setAttribute('aria-label', b.label || b.id);
      if (b.wide) el.classList.add('is-wide');
      this._btnRow.appendChild(el);
    }
  }

  _shouldShowTouch(layout) {
    if (!layout) return false;
    if (this.mode === 'never') return false;
    if (this.mode === 'always') return true;
    return this.hasTouch;
  }

  setTouchMode(mode) {
    this.mode = mode || 'auto';
    this.setTouchLayout(this._layout);
  }

  hideTouch() {
    this._touchRootEl.hidden = true;
    this.releaseAll();
  }

  /* --------------------------------------------------------------- query */

  isDown(action) {
    return !!this.state[action];
  }

  /** True once per press; clears the edge flag. */
  consume(action) {
    if (this.pressedEdge[action]) {
      this.pressedEdge[action] = false;
      return true;
    }
    return false;
  }

  clearEdges() {
    for (const a of ACTIONS) this.pressedEdge[a] = false;
  }

  /** Digital axis helper: -1, 0 or 1. */
  axis(neg, pos) {
    return (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0);
  }

  _emit(e) {
    if (this.onEvent) this.onEvent(e);
  }

  destroy() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('pointerup', this._onPointerUp);
  }
}

export default InputManager;
