/**
 * Game registry.
 *
 * Modules are imported statically rather than lazily on purpose: the whole
 * catalogue is a few hundred KB of plain JS, and pulling it in up front means
 * the service worker caches every cabinet on the very first visit. After that
 * the hub is fully playable with the network switched off — which is the
 * entire point of this build.
 *
 * Order here is the order shown in the launcher.
 */

import * as snake from './snake.js';
import * as tetris from './tetris.js';
import * as invaders from './invaders.js';
import * as roguelike from './roguelike.js';
import * as towerdefense from './towerdefense.js';
import * as runner from './runner.js';
import * as breakout from './breakout.js';
import * as zombies from './zombies.js';
import * as rhythm from './rhythm.js';
import * as chess from './chess.js';
import * as asteroids from './asteroids.js';
import * as minigolf from './minigolf.js';
import * as racer from './racer.js';
import * as lander from './lander.js';
import * as vectorwar from './vectorwar.js';
import * as missile from './missile.js';
import * as crosser from './crosser.js';
import * as boulder from './boulder.js';
import * as gravityflip from './gravityflip.js';
import * as collapse from './collapse.js';
import * as pinball from './pinball.js';
import * as stealth from './stealth.js';

export const GAMES = [
  snake,        //  1  NEON CYBER-SNAKE
  tetris,       //  2  TETRIS DX & BLOCK STACKER
  invaders,     //  3  SPACE INVADERS: BULLET HELL
  roguelike,    //  4  16-BIT ROGUELIKE DUNGEON
  towerdefense, //  5  PIXEL TOWER DEFENSE
  runner,       //  6  CYBER PARKOUR RUNNER
  breakout,     //  7  ARKANOID / BREAKOUT REBOUND
  zombies,      //  8  TOP-DOWN ZOMBIE SURVIVAL
  rhythm,       //  9  RETRO RHYTHM BEAT
  chess,        // 10  MICRO CHESS & CHECKERS
  asteroids,    // 11  ASTEROID MINER & DRIFT
  minigolf,     // 12  PIXEL MINI-GOLF
  racer,        // 13  PSEUDO-3D HIGHWAY RACER
  lander,       // 14  LUNAR RESCUE LANDER
  vectorwar,    // 15  GEOMETRY VECTOR WARFARE
  missile,      // 16  MISSILE DEFENSE COMMAND
  crosser,      // 17  CYBER CROSSER
  boulder,      // 18  BOULDER MINE DIGGER
  gravityflip,  // 19  GRAVITY FLIP RUNNER
  collapse,     // 20  MATCH-3 BLOCK COLLAPSE
  pinball,      // 21  RETRO CANVAS PINBALL
  stealth,      // 22  STEALTH AGENT: SHADOW ESCAPE
];

export const byId = Object.fromEntries(GAMES.map((g) => [g.meta.id, g]));

export default GAMES;
