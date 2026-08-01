/**
 * smoke.mjs — headless verification of every cabinet.
 *
 * Serves the repo statically, boots the arcade in Chromium, then launches each
 * of the 22 games in turn: runs it for a few seconds, hammers the inputs,
 * screenshots it, and fails on any console error, page error, failed request
 * or frozen frame.
 *
 * Dev-only. The deployed site has no dependencies; this one needs Playwright
 * (`npm i -D playwright`):
 *   node tools/smoke.mjs [--headed] [--only=snake,tetris] [--seconds=6]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 842;
const SHOT_DIR = process.env.SHOT_DIR || join(ROOT, '.smoke-shots');

const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1]?.split(',').filter(Boolean);
const SECONDS = Number((args.find((a) => a.startsWith('--seconds=')) || '').split('=')[1]) || 3;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

/* Serve from a sub-path to prove the relative-path promise holds under a
   GitHub Pages project site (user.github.io/repository-name/). */
const BASE = '/repository-name/';

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (!urlPath.startsWith(BASE)) {
      res.writeHead(404).end('outside base');
      return;
    }
    urlPath = urlPath.slice(BASE.length - 1);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = join(ROOT, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});

await new Promise((r) => server.listen(PORT, r));
const URL_BASE = `http://127.0.0.1:${PORT}${BASE}`;
console.log(`serving ${ROOT} at ${URL_BASE}\n`);

const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 640 } });

const problems = [];
let current = 'boot';

page.on('console', (m) => {
  if (m.type() === 'error') problems.push({ game: current, kind: 'console', text: m.text() });
  if (m.type() === 'warning' && /precache|failed/i.test(m.text())) {
    problems.push({ game: current, kind: 'warn', text: m.text() });
  }
});
page.on('pageerror', (e) => problems.push({ game: current, kind: 'pageerror', text: String(e) }));
page.on('requestfailed', (r) =>
  problems.push({ game: current, kind: 'request', text: `${r.url()} — ${r.failure()?.errorText}` }));

await page.goto(URL_BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#boot-start:not([hidden])', { timeout: 15000 });
await page.click('#boot-start');
await page.waitForSelector('#launcher:not([hidden])');

await page.waitForTimeout(300);
await page.screenshot({ path: join(SHOT_DIR, '_launcher.png'), fullPage: true });

const games = await page.evaluate(() =>
  window.ARCADE.games.map((g) => ({ id: g.meta.id, title: g.meta.title, view: g.meta.view })));

console.log(`registry: ${games.length} cabinets\n`);
if (games.length !== 22) problems.push({ game: 'registry', kind: 'count', text: `expected 22, got ${games.length}` });

/* Contract audit against the live modules. */
const audit = await page.evaluate(() => {
  const out = [];
  for (const g of window.ARCADE.games) {
    const m = g.meta || {};
    const miss = [];
    for (const k of ['id', 'title', 'short', 'category', 'desc', 'accent', 'view', 'controls']) {
      if (m[k] === undefined) miss.push(k);
    }
    if (typeof g.create !== 'function') miss.push('create()');
    if (typeof m.art !== 'function') miss.push('art()');
    if (m.view && (!m.view.w || !m.view.h)) miss.push('view.w/h');
    if (m.short && m.short.length > 14) miss.push(`short too long (${m.short.length})`);
    out.push({ id: m.id || '???', miss });
  }
  return out;
});
for (const a of audit) {
  if (a.miss.length) problems.push({ game: a.id, kind: 'meta', text: `missing/invalid: ${a.miss.join(', ')}` });
}

const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyJ', 'KeyK', 'KeyL'];
const results = [];

for (const g of games) {
  if (ONLY && !ONLY.includes(g.id)) continue;
  current = g.id;
  const before = problems.length;

  await page.evaluate((id) => {
    const mod = window.ARCADE.games.find((x) => x.meta.id === id);
    window.ARCADE.shell.play(mod);
  }, g.id);

  await page.waitForTimeout(400);

  // Drive it: keyboard, pointer drags and clicks across the play area.
  const box = await page.locator('#screen').boundingBox();
  const t0 = Date.now();
  let k = 0;
  while (Date.now() - t0 < SECONDS * 1000) {
    const key = KEYS[k++ % KEYS.length];
    await page.keyboard.down(key);
    await page.waitForTimeout(70);
    await page.keyboard.up(key);
    if (box && k % 3 === 0) {
      const x = box.x + box.width * (0.25 + Math.random() * 0.5);
      const y = box.y + box.height * (0.25 + Math.random() * 0.5);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 30, y - 20, { steps: 4 });
      await page.mouse.up();
    }
    await page.waitForTimeout(60);
  }

  const state = await page.evaluate(() => ({
    state: window.ARCADE.engine.state,
    score: window.ARCADE.engine.score,
    fps: window.ARCADE.display.fps,
    particles: window.ARCADE.engine.particles.count,
    view: `${window.ARCADE.display.vw}x${window.ARCADE.display.vh}`,
  }));

  // A frozen loop shows up as fps 0 after several seconds of running.
  if (state.fps === 0) problems.push({ game: g.id, kind: 'frozen', text: 'fps reported 0 — loop may be stalled' });

  await page.screenshot({ path: join(SHOT_DIR, `${g.id}.png`) });
  await page.evaluate(() => window.ARCADE.shell.quitToHub());
  await page.waitForTimeout(120);

  const added = problems.length - before;
  results.push({ ...g, ...state, errors: added });
  const flag = added ? '✗' : '✓';
  console.log(
    `${flag} ${g.id.padEnd(14)} ${String(state.fps).padStart(3)}fps  ` +
    `view ${state.view.padEnd(9)} score ${String(state.score).padStart(6)}  ` +
    `state=${state.state}${added ? `  (${added} problem${added > 1 ? 's' : ''})` : ''}`
  );
}

/* Offline check: reload with the network blocked and confirm the SW serves it. */
current = 'offline';
await page.waitForTimeout(600);
const swReady = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  return !!reg;
});
if (swReady) {
  await page.context().setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
    const booted = await page.waitForSelector('#boot-start', { timeout: 8000 }).then(() => true).catch(() => false);
    console.log(`\n${booted ? '✓' : '✗'} offline reload served from cache`);
    if (!booted) problems.push({ game: 'offline', kind: 'offline', text: 'shell did not boot offline' });
  } catch (e) {
    problems.push({ game: 'offline', kind: 'offline', text: String(e) });
    console.log('\n✗ offline reload failed');
  }
  await page.context().setOffline(false);
} else {
  console.log('\n! service worker not ready — skipped offline check');
}

await browser.close();
server.close();

console.log('\n' + '─'.repeat(72));
if (problems.length) {
  console.log(`${problems.length} PROBLEM(S):\n`);
  for (const p of problems) console.log(`  [${p.game}] ${p.kind}: ${p.text}`);
  process.exitCode = 1;
} else {
  console.log(`ALL CLEAR — ${results.length} cabinets ran without errors.`);
}
console.log(`screenshots: ${SHOT_DIR}`);
