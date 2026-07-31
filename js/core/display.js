/**
 * Display — high-DPI canvas manager with letterboxed virtual resolution
 * and CRT post-processing.
 *
 * Games always draw in *virtual* coordinates (their declared `view.w/h`).
 * The Display renders them into an offscreen buffer at a resolution matched
 * to the physical device pixels, then composites that buffer onto the screen
 * canvas — centred and letterboxed — applying optional bloom and pixelation.
 * Scanlines, vignette and screen curvature are CSS overlays, which are free
 * compared to per-pixel canvas work.
 */

export class Display {
  /**
   * @param {HTMLCanvasElement} canvas visible canvas
   * @param {HTMLElement} stage element that defines the available area
   */
  constructor(canvas, stage) {
    this.canvas = canvas;
    this.stage = stage;
    this.screen = canvas.getContext('2d', { alpha: false, desynchronized: true });

    this.buffer = document.createElement('canvas');
    this.bctx = this.buffer.getContext('2d', { alpha: false });

    this.vw = 480;
    this.vh = 360;
    this.dpr = 1;
    this.quality = 1;      // buffer pixels per virtual unit
    this.fit = 1;          // CSS px per virtual unit
    this.offsetX = 0;      // letterbox offset, CSS px
    this.offsetY = 0;
    this.cssW = 0;
    this.cssH = 0;

    this.pixelate = false;
    this.glow = true;
    this.maxQuality = 2;

    this._fps = 0;
    this._frames = 0;
    this._fpsAccum = 0;
    this._bloomSupported = typeof this.screen.filter === 'string';

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onResize, { passive: true });
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(stage);
    }
  }

  /** Set the virtual resolution the active game draws in. */
  setView(w, h) {
    this.vw = Math.max(16, Math.round(w));
    this.vh = Math.max(16, Math.round(h));
    this.resize();
  }

  setEffects({ pixelate, glow } = {}) {
    if (pixelate != null) this.pixelate = !!pixelate;
    if (glow != null) this.glow = !!glow;
    this.resize();
  }

  resize() {
    const rect = this.stage.getBoundingClientRect();
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    // Cap DPR on very dense phone screens: 3x of a full-screen canvas is a lot
    // of fill rate for a 60 fps particle-heavy game.
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;

    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    // Contain the virtual view inside the stage, preserving aspect ratio.
    this.fit = Math.min(cssW / this.vw, cssH / this.vh);
    const drawW = this.vw * this.fit;
    const drawH = this.vh * this.fit;
    this.offsetX = (cssW - drawW) / 2;
    this.offsetY = (cssH - drawH) / 2;

    const q = this.pixelate
      ? 1
      : Math.max(0.75, Math.min(this.maxQuality, this.fit * dpr));
    this.quality = q;

    const bw = Math.max(1, Math.round(this.vw * q));
    const bh = Math.max(1, Math.round(this.vh * q));
    if (this.buffer.width !== bw || this.buffer.height !== bh) {
      this.buffer.width = bw;
      this.buffer.height = bh;
    }

    this.screen.imageSmoothingEnabled = !this.pixelate;
  }

  /** Begin a frame: returns the 2D context games should draw into. */
  begin() {
    const ctx = this.bctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = !this.pixelate;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.buffer.width, this.buffer.height);
    ctx.scale(this.quality, this.quality);
    return ctx;
  }

  /** Composite the buffer to the visible canvas with CRT post-effects. */
  end() {
    const s = this.screen;
    const dpr = this.dpr;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.imageSmoothingEnabled = !this.pixelate;
    s.fillStyle = '#05060a';
    s.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const dx = Math.round(this.offsetX * dpr);
    const dy = Math.round(this.offsetY * dpr);
    const dw = Math.round(this.vw * this.fit * dpr);
    const dh = Math.round(this.vh * this.fit * dpr);

    s.drawImage(this.buffer, 0, 0, this.buffer.width, this.buffer.height, dx, dy, dw, dh);

    if (this.glow && this._bloomSupported) {
      s.save();
      s.globalCompositeOperation = 'lighter';
      s.globalAlpha = 0.28;
      s.filter = `blur(${Math.max(2, Math.round(3 * dpr))}px)`;
      s.drawImage(this.buffer, 0, 0, this.buffer.width, this.buffer.height, dx, dy, dw, dh);
      s.filter = 'none';
      s.restore();
    }
  }

  tickFps(dt) {
    this._frames++;
    this._fpsAccum += dt;
    if (this._fpsAccum >= 0.5) {
      this._fps = Math.round(this._frames / this._fpsAccum);
      this._frames = 0;
      this._fpsAccum = 0;
      return true;
    }
    return false;
  }

  get fps() {
    return this._fps;
  }

  /** Convert a client (viewport) point into virtual game coordinates. */
  toVirtual(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left - this.offsetX) / this.fit;
    const y = (clientY - rect.top - this.offsetY) / this.fit;
    return { x, y };
  }

  /** True when the client point falls inside the letterboxed play area. */
  inView(clientX, clientY) {
    const p = this.toVirtual(clientX, clientY);
    return p.x >= 0 && p.y >= 0 && p.x <= this.vw && p.y <= this.vh;
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    if (this._ro) this._ro.disconnect();
  }
}

export default Display;
