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

    // Quarter-resolution bloom texture. Blurring the full composite is a
    // fill-rate disaster at retina sizes — downsample first, blur the small
    // copy, then let the upscale do most of the spreading for free.
    this.bloom = document.createElement('canvas');
    this.blctx = this.bloom.getContext('2d', { alpha: false });

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

    /**
     * Glow governor.
     *
     * Per-draw `shadowBlur` is by far the most expensive thing a 2D canvas
     * game can do — measured across these cabinets at 2-4x the whole frame
     * (vector warfare 30 -> 60 fps with it off, gravity flip 19 -> 51).
     *
     * A middle tier that merely clamped the radius was tried and dropped: it
     * bought nothing measurable (30 -> 30 fps), because the cost is entering
     * the shadow compositing path per draw, not the size of the blur. So the
     * switch is binary — but turning shadows off raises the frame-level bloom
     * to compensate, which keeps the neon look instead of going flat.
     *
     *   full  shadows drawn as the game asked   bloom 0.32
     *   fast  shadows off, bloom carries it     bloom 0.58
     */
    this.glowQuality = 'auto';   // auto | full | fast
    this.glowTier = 'full';      // the tier actually in force
    this._autoSamples = [];
    this.onGlowDowngrade = null;
    this._installGlowGovernor();

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

  /**
   * Intercept `shadowBlur` writes on the game buffer only. Games keep asking
   * for glow exactly as they always did; the engine decides whether to pay
   * for it. Scoped to this context instance, never the prototype, so nothing
   * else on the page is affected.
   */
  _installGlowGovernor() {
    const proto = Object.getPrototypeOf(this.bctx);
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'shadowBlur');
    if (!desc || !desc.set || !desc.get) return;
    const display = this;
    Object.defineProperty(this.bctx, 'shadowBlur', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, display.glowTier === 'fast' ? 0 : v); },
    });
  }

  /** Bloom strength for the tier in force — weaker tiers lean on it harder. */
  get bloomAlpha() {
    return this.glowTier === 'fast' ? 0.58 : 0.32;
  }

  /** True when the auto governor has stepped below full quality. */
  get isDowngraded() {
    return this.glowQuality === 'auto' && this.glowTier !== 'full';
  }

  /** Set the virtual resolution the active game draws in. */
  setView(w, h) {
    this.vw = Math.max(16, Math.round(w));
    this.vh = Math.max(16, Math.round(h));
    // Each cabinet gets a fresh assessment — a light puzzle game shouldn't
    // inherit a downgrade earned by a particle-heavy shooter.
    this._autoSamples.length = 0;
    if (this.glowQuality === 'auto') this.glowTier = 'full';
    this.resize();
  }

  setEffects({ pixelate, glow, glowQuality } = {}) {
    if (pixelate != null) this.pixelate = !!pixelate;
    if (glow != null) this.glow = !!glow;
    if (glowQuality != null) {
      this.glowQuality = glowQuality;
      this._autoSamples.length = 0;
      // 'auto' begins optimistic and earns its way down.
      this.glowTier = glowQuality === 'auto' ? 'full' : glowQuality;
    }
    this.resize();
  }

  resize() {
    const rect = this.stage.getBoundingClientRect();
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    // Cap DPR on very dense phone screens: 3x of a full-screen canvas is a lot
    // of fill rate for a 60 fps particle-heavy game.
    let dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    // Hard ceiling on total backing pixels. A 2x tablet in landscape asks for
    // ~3.3M pixels, which costs more than the visual difference is worth.
    const BUDGET = 2_600_000;
    if (cssW * cssH * dpr * dpr > BUDGET) {
      dpr = Math.max(1, Math.sqrt(BUDGET / (cssW * cssH)));
    }

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

    const glw = Math.max(1, Math.round(bw / 4));
    const glh = Math.max(1, Math.round(bh / 4));
    if (this.bloom.width !== glw || this.bloom.height !== glh) {
      this.bloom.width = glw;
      this.bloom.height = glh;
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
    // Bloom is applied to the *buffer*, not the screen. Blending a full-screen
    // additive pass at retina size costs ~4x more fill than doing it here, and
    // the result is indistinguishable once it's upscaled.
    if (this.glow) {
      const b = this.blctx;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.globalCompositeOperation = 'source-over';
      b.globalAlpha = 1;
      b.filter = 'none';
      b.imageSmoothingEnabled = true;
      b.drawImage(this.buffer, 0, 0, this.bloom.width, this.bloom.height);
      if (this._bloomSupported) {
        b.filter = 'blur(1.5px)';
        b.drawImage(this.bloom, 0, 0);
        b.filter = 'none';
      }

      const c = this.bctx;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = this.bloomAlpha;
      c.imageSmoothingEnabled = true;
      c.drawImage(this.bloom, 0, 0, this.buffer.width, this.buffer.height);
      c.restore();
    }

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
  }

  tickFps(dt) {
    this._frames++;
    this._fpsAccum += dt;
    if (this._fpsAccum >= 0.5) {
      this._fps = Math.round(this._frames / this._fpsAccum);
      this._frames = 0;
      this._fpsAccum = 0;
      this._sampleGlowBudget();
      return true;
    }
    return false;
  }

  /**
   * Auto glow: a rolling median over the last ~2.5 s. Sampled continuously
   * rather than judged once, because a cabinet can start light and only get
   * heavy when the screen fills with enemies — the median smooths out both
   * the startup hitch and a single unlucky frame.
   */
  _sampleGlowBudget() {
    if (this.glowQuality !== 'auto' || this.glowTier === 'fast') return;
    const s = this._autoSamples;
    s.push(this._fps);
    if (s.length > 5) s.shift();
    if (s.length < 4) return;
    const sorted = s.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (median >= 50) return;
    this.glowTier = 'fast';
    s.length = 0;
    if (this.onGlowDowngrade) this.onGlowDowngrade(median, this.glowTier);
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
