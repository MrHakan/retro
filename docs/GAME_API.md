# RETRO-CANVAS-ARCADE — Game Module Contract

Every cabinet is one ES module in `js/games/`. It exports exactly two things:
`meta` (static description) and `create(api)` (factory returning the lifecycle
object). Nothing else is imported by the shell.

```js
import { PAL, clamp, RNG, /* … */ } from '../core/fx.js';

export const meta = { /* see below */ };

export function create(api) {
  return { init, update, render, handleInput, destroy };
}
```

## `meta`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Stable, kebab-case. Used as the localStorage high-score key — **never change it**. |
| `title` | `string` | Full name, uppercase, shown on the card and detail modal. |
| `short` | `string` | ≤ 14 chars, shown in the HUD. |
| `category` | `string` | One of: `ARCADE`, `PUZZLE`, `SHOOTER`, `ACTION`, `STRATEGY`, `SPORTS`, `SIMULATION`. |
| `desc` | `string` | One or two sentences for the detail modal. |
| `accent` | `string` | Hex colour driving the card's tint and glow. |
| `view` | `{w, h}` | **Virtual resolution.** All drawing happens in these units; the engine letterboxes and scales to any screen. Pick something in the 320–640 range. |
| `controls` | `string[]` | Lines like `'ARROWS / WASD — steer'`. The part before the em dash is rendered as a key cap. |
| `touch` | `object \| null` | On-screen controls: `{ stick?: bool, dpad?: bool, buttons?: [{id, label, wide?}] }`. `id` must be one of `a`, `b`, `c`, `up`, `down`, `left`, `right`, `pause`. |
| `scoreLabel` | `string?` | HUD label for the score, default `SCORE`. |
| `art` | `(ctx, w, h, accent) => void` | Paints the 240×180 launcher thumbnail. Pure canvas, no state. |

## Lifecycle

| Method | When | Contract |
| --- | --- | --- |
| `init()` | Once, after the view is sized. | Build all state here, not in `create()`. |
| `update(dt)` | Every frame while playing. | `dt` is seconds, **already clamped to ≤ 1/30**. Never assume 60 Hz. |
| `render(ctx)` | Every frame, including while paused / game-over. | Draw in virtual coordinates. Leave the context state as you found it (`save`/`restore`). |
| `handleInput(e)` | Discrete events, only while playing. | Optional. |
| `destroy()` | On quit / restart. | Stop audio handles (`motorHum`), clear intervals. Optional. |
| `onResume()` | After unpause. | Optional; re-sync timers. |

### Input events

```
{ type: 'press',       action }                 // action pressed (edge)
{ type: 'release',     action }
{ type: 'key',         code, key, action, repeat }
{ type: 'keyup',       code, key, action }
{ type: 'pointerdown', x, y, button, id, pointerType }
{ type: 'pointermove', x, y, id, down, pointerType }
{ type: 'pointerup',   x, y, button, id, pointerType }
{ type: 'wheel',       dx, dy }
```

`x`/`y` are already converted into **virtual game coordinates**. They can fall
outside `[0, view.w] × [0, view.h]` when the pointer is over the letterbox bars.

Actions: `up`, `down`, `left`, `right`, `a`, `b`, `c`, `pause`, `back`.
`pause` and `back` are consumed by the shell — do not rely on them.

## The `api` object

```
api.w, api.h            virtual view size (numbers)
api.meta                this module's meta

api.audio               AudioEngine — api.audio.sfx(name), .motorHum(), .startTrack()
api.sfx(name, opts)     shorthand for api.audio.sfx
api.input               InputManager — .isDown(action), .axis('left','right'),
                        .consume(action)  (true once per press),
                        .stick {x,y}  (-1..1, analog on touch, digital on keys),
                        .pointer {x, y, down, inside}
api.rng                 seeded RNG — .next() .range(a,b) .int(a,b) .pick(arr)
                        .chance(p) .shuffle(arr) .sign() .angle()
api.particles           pooled Particles — .emit(o) .burst(x,y,n,o) .popText(...)
                        Updated and rendered BY THE GAME (see below).
api.shake               Shake — but prefer api.shakeScreen(mag, decay)
api.storage             Storage wrapper

api.score               current score (number)
api.setScore(v)         set
api.addScore(v)         add
api.setStatus({K: v})   extra HUD fields, e.g. { LEVEL: 3, LIVES: 2 }
api.highScore()         best recorded score for this game

api.gameOver({score?, message?, stats?})   end the run
api.win({score?, message?, stats?})        end the run as a victory
api.shakeScreen(mag, decay?)
api.vibrate(ms)
api.time                seconds since the run started
api.isTouch             boolean
```

### Particles

The engine updates and renders `api.particles` **for you** — it calls
`particles.update(dt)` after your `update(dt)`, and the shake transform is
applied around your `render()`. You only need to call `api.particles.render(ctx)`
at the point in your draw order where you want them to appear. If you never
call it, they will not be drawn.

## House rules

1. **No imports besides `../core/fx.js`.** No CDNs, no other game modules.
2. **No DOM.** No `document.createElement`, no listeners. Canvas only.
   (The one exception: an offscreen canvas for a pre-rendered background is
   fine, created once in `init`.)
3. **Resolution independence.** Never hardcode 800×600. Use `api.w` / `api.h`
   or `meta.view`, and lay out relative to them.
4. **`dt`-based motion.** `x += vx * dt`, never `x += vx`.
5. **Touch parity.** Every game must be completable with the declared `touch`
   layout alone. Aim-with-mouse games get a stick + fire button, or aim toward
   the last pointer position.
6. **Call `api.gameOver()` exactly once** per run; the engine ignores repeats
   but your `update` should stop mutating afterwards.
7. **Clean up.** Anything from `api.audio.motorHum()` or `startTrack()` must be
   stopped in `destroy()`.
8. **Score before game over.** Use `api.addScore()` as points are earned so the
   HUD stays live; `gameOver()` records whatever the score is at that moment.
9. **Draw your own background.** The buffer is cleared to black each frame.
10. **Performance budget.** Target 60 fps on a mid-range phone: keep particle
    bursts under ~40 at a time, avoid per-frame allocations in hot loops, and
    avoid `shadowBlur` on more than a few dozen draws per frame.

## Skeleton

```js
import { PAL, clamp, grid, text, glowRect } from '../core/fx.js';

export const meta = {
  id: 'example',
  title: 'EXAMPLE CABINET',
  short: 'EXAMPLE',
  category: 'ARCADE',
  desc: 'One or two sentences.',
  accent: PAL.cyan,
  view: { w: 480, h: 360 },
  controls: ['ARROWS / WASD — move', 'SPACE — action'],
  touch: { dpad: true, buttons: [{ id: 'a', label: 'FIRE' }] },
  art(ctx, w, h, accent) {
    ctx.fillStyle = accent;
    ctx.fillRect(w / 2 - 20, h / 2 - 20, 40, 40);
  },
};

export function create(api) {
  let x, y;

  return {
    init() {
      x = api.w / 2;
      y = api.h / 2;
      api.setStatus({ LIVES: 3 });
    },

    update(dt) {
      x = clamp(x + api.input.axis('left', 'right') * 160 * dt, 0, api.w);
    },

    render(ctx) {
      ctx.fillStyle = PAL.bg;
      ctx.fillRect(0, 0, api.w, api.h);
      grid(ctx, api.w, api.h, 24);
      glowRect(ctx, x - 8, y - 8, 16, 16, PAL.cyan);
      api.particles.render(ctx);
      text(ctx, 'HELLO', 8, 8, { size: 10, color: PAL.dim });
    },

    handleInput(e) {
      if (e.type === 'press' && e.action === 'a') api.sfx('laser');
    },

    destroy() {},
  };
}
```

## SFX names available

`laser shoot shotgun explosion boom jump doublejump land coin pickup powerup
hit hurt blip select back deny motor thrust bounce brick clear tetris drop
rotate step splash horn alert charge zap freeze gameover victory levelup combo
perfect miss kick snare hat`

`api.sfx(name, { vol, detune, pan, when })` — `detune` is in semitones.

## `fx.js` exports

Math: `TAU clamp lerp invLerp dist dist2 sign angleDelta damp aabb circleRect
segIntersect reflect`
RNG: `RNG hashString`
Colour: `PAL NEON alpha mix hsl`
Systems: `Particles Shake Starfield`
Drawing: `glow glowRect glowCircle glowLine roundRect polygon text pixelText
measure grid vgrad`
