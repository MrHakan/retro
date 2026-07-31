import * as breakout from './breakout.js';
import * as chess from './chess.js';
import * as crosser from './crosser.js';
import * as invaders from './invaders.js';
import * as lander from './lander.js';
import * as racer from './racer.js';
import * as runner from './runner.js';
import * as snake from './snake.js';
import * as tetris from './tetris.js';

export const GAMES = [breakout, chess, crosser, invaders, lander, racer, runner, snake, tetris];
export const byId = Object.fromEntries(GAMES.map((g) => [g.meta.id, g]));
export default GAMES;
