/**
 * perf.mjs — steady-state framerate probe for individual cabinets.
 *
 * Complements smoke.mjs: that one proves the games *run*, this one measures
 * what they cost. Reports the engine's own fps plus whether the display's
 * auto glow governor decided to drop per-sprite `shadowBlur` for that game.
 *
 * Dev-only (needs Playwright):
 *   ln -sfn "$(npm root -g)" node_modules      # once
 *   node tools/perf.mjs vectorwar gravityflip snake
 *   node tools/perf.mjs --all
 *
 * Flags: --all, --glow=full|fast|auto, --settle=<seconds>, --window=<seconds>
 *
 * Note: a headless Chromium without GPU rasterises on the CPU, so absolute
 * numbers here are far below real hardware. Use them comparatively — the
 * ratio between cabinets is what tells you where the cost is.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8431;

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const SETTLE = Number(flag('settle', 6)) * 1000;
const WINDOW = Number(flag('window', 3)) * 1000;
const GLOW = flag('glow', null);
const ALL = argv.includes('--all');
const ids = argv.filter((a) => !a.startsWith('--'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('#boot-start:not([hidden])');
await page.click('#boot-start');
await page.waitForSelector('#launcher:not([hidden])');

if (GLOW) await page.evaluate((q) => window.ARCADE.display.setEffects({ glowQuality: q }), GLOW);

const targets = ALL || !ids.length
  ? await page.evaluate(() => window.ARCADE.games.map((g) => g.meta.id))
  : ids;

console.log(`\n${'cabinet'.padEnd(14)} ${'fps'.padStart(4)}  glow      particles`);
console.log('─'.repeat(46));

for (const id of targets) {
  await page.evaluate((i) => {
    const mod = window.ARCADE.games.find((g) => g.meta.id === i);
    if (mod) window.ARCADE.shell.play(mod);
  }, id);
  await page.waitForTimeout(SETTLE);

  const r = await page.evaluate((ms) => new Promise((res) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else {
        res({
          engineFps: window.ARCADE.display.fps,
          particles: window.ARCADE.engine.particles.count,
          soft: window.ARCADE.display.softGlow,
          quality: window.ARCADE.display.glowQuality,
          state: window.ARCADE.engine.state,
        });
      }
    };
    requestAnimationFrame(tick);
  }), WINDOW);

  const glow = r.quality === 'auto' ? (r.soft ? 'auto→fast' : 'auto→full') : r.quality;
  const warn = r.engineFps < 50 ? '  ⚠' : '';
  console.log(
    `${id.padEnd(14)} ${String(r.engineFps).padStart(4)}  ${glow.padEnd(9)} ` +
    `${String(r.particles).padStart(5)}${warn}`
  );

  await page.evaluate(() => window.ARCADE.shell.quitToHub());
  await page.waitForTimeout(150);
}

await browser.close();
server.close();
console.log('');
