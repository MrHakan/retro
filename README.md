# RETRO-CANVAS-ARCADE

A 22-cabinet retro arcade that runs entirely in the browser — **no server, no
build step, no dependencies, no network**. Pure HTML5, CSS3 and vanilla ES2022
modules, rendered with the Canvas 2D API, with every sound effect synthesized
on the fly by the Web Audio API.

Drop the repository on GitHub Pages and it works. Load it once and it works
forever, offline, including on a ship in the middle of the ocean.

```
                    ██████╗ ███████╗████████╗██████╗  ██████╗
                    ██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗
                    ██████╔╝█████╗     ██║   ██████╔╝██║   ██║
                    ██╔══██╗██╔══╝     ██║   ██╔══██╗██║   ██║
                    ██║  ██║███████╗   ██║   ██║  ██║╚██████╔╝
                    ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝
                      C A N V A S   A R C A D E
```

---

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   The included [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
   syntax-checks every module, validates the manifest, fails the build if any
   absolute asset path sneaks in, and then publishes the repo as-is.

   *(Prefer no Actions? Set Source to "Deploy from a branch" and pick the
   branch root. There is nothing to build.)*
3. Open the published URL. Press **INSERT COIN**.

That's the whole deployment. No `npm install`, no bundler, no transpiler.

### Why it works in a subdirectory

A project site is served from `https://user.github.io/repository-name/`, which
breaks any project that hardcodes root-anchored paths. Everything here is
strictly relative:

| Concern | How it's handled |
| --- | --- |
| Scripts, styles, icons | `./css/…`, `./js/…`, `./icons/…` in `index.html` |
| ES module imports | `./core/fx.js`, `../core/fx.js` — never `/js/…` |
| Manifest | `"start_url": "./"`, `"scope": "./"`, relative icon `src` |
| Service worker | Registered as `./sw.js` with `{ scope: './' }`; precache URLs resolved against `self.registration.scope` |
| localStorage | Keys namespaced from `location.pathname`, so a root deploy and a project deploy keep separate save data in the same browser |

`.nojekyll` is present so GitHub Pages serves every file verbatim.

## Running locally

ES modules need a real HTTP origin — `file://` will not work.

```bash
npx serve .          # or: python3 -m http.server 8000
```

Then open the printed URL.

---

## The 22 cabinets

| # | Game | Category | What it is |
| --- | --- | --- | --- |
| 01 | **Neon Cyber-Snake** | Arcade | Grid serpent with a directional buffer, wrap-around portals, destructible datawalls, and Speed / Ghost / Breaker / Multiplier power-ups. |
| 02 | **Tetris DX & Block Stacker** | Puzzle | 7-bag randomizer, full SRS rotation with wall kicks, hold piece, ghost preview, lock delay, T-spin detection and Back-to-Back scoring. |
| 03 | **Space Invaders: Bullet Hell** | Shooter | Procedurally moving alien formations that escalate into radial and spiral bullet patterns. Spread cannon, plasma shield, beam laser, smart bomb. |
| 04 | **16-Bit Roguelike Dungeon** | Strategy | Turn-based, BSP-generated floors, fog of war, A\*/Dijkstra enemy pathfinding, permadeath, chests, keys and descending staircases. |
| 05 | **Pixel Tower Defense** | Strategy | Gatling, Freezer, Laser and Artillery towers with three upgrade tiers and sell-back, against scouts, armored tanks and flying waves. |
| 06 | **Cyber Parkour Runner** | Action | One-button endless runner with double jump, slide, coyote time, and a 3-layer parallax city that speeds up as you survive. |
| 07 | **Arkanoid / Breakout Rebound** | Arcade | Position-based paddle deflection, multi-hit and explosive bricks, multi-ball, wide paddle, lasers and a sticky magnet paddle. |
| 08 | **Top-Down Zombie Survival** | Shooter | Twin-stick waves with pistol, shotgun, rifle and flamethrower — and blood splatter that permanently accumulates on the floor layer. |
| 09 | **Retro Rhythm Beat** | Arcade | Four-lane note charts generated from, and locked to, the Web Audio clock of a procedural drum-and-bass chiptune. Graded S through F. |
| 10 | **Micro Chess & Checkers** | Strategy | 6×6 boards, full legal-move generation with check/checkmate/stalemate, and a minimax + alpha-beta AI at three difficulties. |
| 11 | **Asteroid Miner & Drift** | Shooter | Newtonian momentum flight, splitting asteroids, and an oxygen-versus-cargo push-your-luck mining loop around a docking beacon. |
| 12 | **Pixel Mini-Golf** | Sports | Nine procedural holes with drag-to-putt aiming, reflection prediction, sand, ice, slopes and windmills. |
| 13 | **Pseudo-3D Highway Racer** | Sports | A real OutRun-style segment projection engine — curves, hills, centrifugal drift, AI traffic and checkpoint timers. |
| 14 | **Lunar Rescue Lander** | Simulation | Gravity, angular momentum on the RCS jets, finite fuel, and pads that only accept a genuinely gentle, upright touchdown. |
| 15 | **Geometry Vector Warfare** | Shooter | Additive-blended neon twin-stick arena with black hole bombs, ricochet lasers and EMP shockwaves. |
| 16 | **Missile Defense Command** | Shooter | Ballistic rain on six cities, three limited-ammo batteries, MIRV splits, and chain-explosion scoring. |
| 17 | **Cyber Crosser** | Arcade | Frogger-style hopping across truck lanes and a river of logs, turtles, sinking lily pads and crocodiles. |
| 18 | **Boulder Mine Digger** | Puzzle | Full Boulder Dash grid physics — falling, rolling and crushing — with pushable boulders and wall-following tunnel monsters. |
| 19 | **Gravity Flip Runner** | Action | No jump button. Flip gravity between floor and ceiling through spikes, gaps and sweeping lasers, with a trailing ghost runner. |
| 20 | **Match-3 Block Collapse** | Puzzle | Lumines-style 2×2 pairs cleared by a sweeping timeline beam, with chain reactions formed ahead of the sweep. |
| 21 | **Retro Canvas Pinball** | Arcade | Substepped circle-vs-segment physics, rotating flippers that impart angular impulse, drop targets, multiball lock and tilt. |
| 22 | **Stealth Agent: Shadow Escape** | Action | Raycast field-of-view cones that cast real shadows off walls, guard alert states, noise pings, terminals and keycards. |

---

## Architecture

```
index.html               shell markup: boot, launcher, HUD, overlays
manifest.webmanifest     PWA metadata (relative start_url + scope)
sw.js                    offline service worker (precache + cache-first)
css/arcade.css           CRT styling, responsive layout, touch controls
js/
  main.js                bootstrap + service worker registration
  core/
    display.js           high-DPI canvas, letterboxing, bloom, glow governor
    audio.js             8-bit Web Audio synthesizer + chiptune sequencer
    input.js             unified keyboard / pointer / virtual-touch action model
    storage.js           namespaced localStorage: scores, plays, achievements, keys
    engine.js            RAF loop, lifecycle, pause / game-over, hit-stop + flash
    fx.js                RNG, math, collision, particles, shake, palette, drawing
    ui.js                launcher, filtering, settings, modals, PWA install
  games/
    index.js             the registry (import order = launcher order)
    *.js                 one module per cabinet
icons/                   PWA icons (generated by tools/make-icons.mjs)
docs/GAME_API.md         the game module contract
tools/                   dev-only: icon generator, headless smoke test
```

### Display: virtual resolution, real pixels

Games never think about screen size. Each declares a virtual resolution
(`meta.view`), draws in those units, and `Display` does the rest: it renders
into an offscreen buffer sized to the actual device pixels
(`devicePixelRatio`, capped at 2.5), then composites that buffer onto the
visible canvas — centred and letterboxed to any viewport. Pointer coordinates
are mapped back through the same transform, so a tap lands where it looks like
it lands on every device.

CRT effects layer on top: scanlines and vignette as CSS overlays (free),
phosphor bloom as an additive blurred re-composite of the buffer, and
pixelation by dropping the buffer to 1:1 with image smoothing off.

The bloom is taken from a **quarter-scale copy** of the frame and composited
back into the buffer rather than onto the screen. Blur cost scales with area,
and `ctx.filter` on a full-size destination is a slow path in every engine
tested — confining it to a sixteenth of the pixels cut the effect's cost by
roughly 4x. It also degrades gracefully: where `ctx.filter` is unsupported the
downsample-and-upscale alone still yields a soft glow.

### The glow governor

Per-draw `shadowBlur` is the single most expensive thing a 2D canvas game can
do. Measured across this catalogue it costs **2–4x the entire frame**:

| Cabinet | shadowBlur on | forced off |
| --- | --- | --- |
| Geometry Vector Warfare | 25 fps | 60 fps |
| Gravity Flip Runner | 19 fps | 51 fps |
| Neon Cyber-Snake | 49 fps | 60 fps |

Since the frame-level bloom is now nearly free and produces a very similar
look, `Display` installs a governor that intercepts `shadowBlur` writes **on
the game buffer's context only** (an instance property, never the prototype).
Games keep asking for glow exactly as they always did; the engine decides
whether to pay for it.

`Settings → Glow quality` exposes this as Auto / Full / Fast. Auto keeps a
rolling median of the last ~2.5 s and drops to bloom-only if a cabinet cannot
hold ~50 fps, re-assessing per game so a light puzzler never inherits a
downgrade earned by a particle-heavy shooter. When it engages, it says so in a
toast rather than silently changing the look.

Net effect in headless software rasterisation (no GPU — a deliberately harsh
floor): most cabinets hold 55–60 fps, and the heaviest sit in the 30s rather
than at 9–19.

### The CRT layer

The tube treatment is entirely CSS, composited by the GPU, so it costs nothing
per frame and covers the menus as well as the games:

- Horizontal scanlines **plus a vertical RGB aperture-grille mask**. The
  grille is the part that matters — without it scanlines read as grey stripes
  over a flat image rather than as light through a shadow mask.
- The slow vertical refresh band a real CRT shows on camera, at very low
  contrast: readable as motion, never as a distraction.
- Tube geometry faked with rounded stage corners and an inner shadow, which
  reads as curvature far more cheaply than warping the canvas would, plus a
  saturation lift so the palette has phosphor punch instead of flat sRGB.
- CRT power-on and power-off wipes when entering and leaving a cabinet.

All of it is disabled under `prefers-reduced-motion`.

### Impact feedback

Screen shake alone was carrying every impact, which reads as noise rather than
weight. The engine owns two more primitives, so no cabinet reimplements them:

| Call | What it does |
| --- | --- |
| `api.hitStop(seconds)` | Freezes the simulation for a beat while rendering continues, so the held frame is what the player sees. The game is handed **no `dt` at all** during the freeze — physics must not creep — and particles run at quarter speed so the picture isn't completely dead. |
| `api.flash(color, alpha, decay)` | Full-screen additive flash that decays on its own. |

Both respect the "Reduce flashing" accessibility setting.

All 22 cabinets mark their defining moment with them. Placement is the fiddly
part: most death handlers open with an early-return guard (`if (!alive)
return`), and injecting above it re-fires the freeze every time the handler is
re-entered after death — so every call sits *below* the guard, and the one
handler that had no guard got one.

### Audio: nothing is downloaded

`audio.js` is a small chiptune synthesizer. Band-limited pulse waves at 12.5%,
25% and 50% duty are built with `createPeriodicWave`; a shared white-noise
buffer drives percussion and explosions; every SFX in the library is a recipe
of oscillators, envelopes and filter sweeps. There is also a look-ahead
sequencer (`startTrack`) that schedules bass, lead and drums against the
`AudioContext` clock — which is what lets the rhythm game stay sample-accurate
where a `dt` accumulator would drift.

The context is created lazily and resumed on the INSERT COIN click, satisfying
every browser's autoplay policy.

### Input: one action model

Keyboard, mouse, pen and touch all collapse into nine actions — `up`, `down`,
`left`, `right`, `a`, `b`, `c`, `pause`, `back`. Keyboard bindings are
remappable and persisted. On touch devices each game declares the on-screen
controls it needs (analog stick, d-pad, and labelled buttons); those are real
DOM elements layered over the canvas, so they stay crisp and accessible and
cost nothing to redraw. The analog stick also drives the digital directions,
so grid-based games work with it too.

### Storage

`localStorage`, namespaced by deployment path, holding per-game high scores,
play counts, achievements, custom keybindings and CRT settings. It degrades to
an in-memory map when storage is unavailable (Safari private mode), so nothing
throws. Nothing ever leaves the device.

---

## Offline / PWA

The service worker precaches the shell **and all 22 game modules** on install
— the registry imports them statically for exactly this reason, so there is no
per-game download step to get caught out by later. Navigations are
network-first (so a redeploy lands promptly) with the cached shell as
fallback; everything else is cache-first with a quiet background revalidate.

Install it from the browser's install prompt or **Add to Home Screen**. It
launches fullscreen, supports orientation locking, and the manifest ships
shortcuts that deep-link straight into a cabinet (`./?game=pinball`).

---

## Development

The dev tools need Playwright; the site itself needs nothing.

```bash
node tools/make-icons.mjs        # regenerate the PWA icons — needs nothing installed

npm i -D playwright              # the test tools are the only thing with a dependency
node tools/smoke.mjs             # headless run of all 22 cabinets
node tools/perf.mjs --all        # steady-state framerate per cabinet
```

`smoke.mjs` serves the repo from a `/repository-name/` sub-path — proving the
relative-path guarantee — boots the arcade in Chromium, launches every
cabinet, drives its inputs, screenshots it, audits each module against the
contract, and fails on any console error, failed request or stalled loop. It
finishes by reloading with the network disabled to confirm the offline cache
actually serves the site.

Useful flags: `--headed`, `--only=snake,pinball`, `--seconds=6`.

`perf.mjs` reports each cabinet's steady-state fps and whether the glow
governor engaged for it. Flags: `--all`, `--glow=full|fast|auto`,
`--settle=<s>`, `--window=<s>`. Absolute numbers are pessimistic (headless
Chromium rasterises on the CPU); read them comparatively.

### Adding a cabinet

Read [`docs/GAME_API.md`](docs/GAME_API.md) — it is the full contract. In
short: create `js/games/yourgame.js` exporting `meta` and `create(api)`,
implementing `init / update(dt) / render(ctx) / handleInput(e) / destroy()`;
import only from `../core/fx.js`; add it to `js/games/index.js` and to the
`PRECACHE` list in `sw.js`.

---

## Browser support

Chrome/Edge 90+, Firefox 90+, Safari 15.4+, and the mobile equivalents.
Requires ES modules, Canvas 2D, Web Audio and Pointer Events. The phosphor
bloom needs `ctx.filter` and is skipped where unsupported; the service worker
is optional — without it the arcade simply requires a connection to load.

## License

MIT.
