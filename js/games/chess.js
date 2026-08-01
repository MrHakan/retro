/**
 * 10 — MICRO CHESS & CHECKERS
 * Two compact 6x6 board games sharing one alpha-beta engine. The rules are
 * plugged in as a table of pure functions (generate / make / unmake / evaluate)
 * so the same iterative-deepening search drives both. The search runs in
 * time-sliced bursts inside update() — never more than ~45ms of any one frame —
 * so the board keeps animating while the AI thinks.
 */

import { PAL, TAU, alpha, text, roundRect } from '../core/fx.js';

/* ----------------------------------------------------------------- layout */

const N = 6;                    // board is 6x6 in both modes
const CELL = 48;
const BOARD = N * CELL;         // 288
const BX = 16;
const BY = 34;
const PX = BX + BOARD + 8;      // right-hand info panel
const PY = BY;
const PW = 160;
const VIEW = { w: PX + PW + 8, h: 360 };

/* ------------------------------------------------------------ piece codes */

const EMPTY = 0;
// chess types
const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
// checkers types (share the low bits — the active mode decides how to read them)
const CMAN = 1, CKING = 2;
const WHITE = 8, BLACK = 16;
const CMASK = 24, TMASK = 7;

const PVAL = [0, 100, 305, 320, 480, 900, 20000];
const MATE = 900000;
const INF = 9999999;

const colorOf = (p) => p & CMASK;
const typeOf = (p) => p & TMASK;
const other = (c) => (c === WHITE ? BLACK : WHITE);

const KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const ROOK_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISH_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALL8 = ROOK_D.concat(BISH_D);
const FILES = 'abcdef';

const now = () => performance.now();

/* ------------------------------------------------------------ shared state */

/**
 * A position. `undo` is a reusable stack of records so the search never
 * allocates while walking the tree.
 */
function makeState() {
  return { b: new Int8Array(N * N), side: WHITE, ep: -1, half: 0, undo: [], ut: 0 };
}

function pushUndo(st) {
  let u = st.undo[st.ut];
  if (!u) {
    u = { cap: 0, capSq: -1, ep: -1, half: 0, moved: 0, caps: [] };
    st.undo[st.ut] = u;
  }
  st.ut++;
  return u;
}

function posKey(st) {
  let h = 2166136261;
  for (let i = 0; i < N * N; i++) {
    h ^= st.b[i] + 1;
    h = Math.imul(h, 16777619);
  }
  h ^= st.side;
  return Math.imul(h, 16777619) >>> 0;
}

const inB = (x, y) => x >= 0 && x < N && y >= 0 && y < N;

/* ================================================================== CHESS */

/**
 * Standard movement adapted to 6x6: back rank is R N B Q K R, pawns get the
 * usual double first step plus en passant, and promotion (always to a queen)
 * happens on the far rank. There is no room to castle on a six-file board, so
 * castling is dropped.
 */
function chessSetup(st) {
  st.b.fill(EMPTY);
  const back = [ROOK, KNIGHT, BISHOP, QUEEN, KING, ROOK];
  for (let x = 0; x < N; x++) {
    st.b[0 * N + x] = back[x] | BLACK;
    st.b[1 * N + x] = PAWN | BLACK;
    st.b[4 * N + x] = PAWN | WHITE;
    st.b[5 * N + x] = back[x] | WHITE;
  }
  st.side = WHITE;
  st.ep = -1;
  st.half = 0;
}

function chessAttacked(st, sq, by) {
  const tx = sq % N;
  const ty = (sq / N) | 0;

  // Pawns: a white pawn pushes toward y-1, so it attacks from y+1.
  const pd = by === WHITE ? 1 : -1;
  for (let i = -1; i <= 1; i += 2) {
    const x = tx + i;
    const y = ty + pd;
    if (inB(x, y)) {
      const p = st.b[y * N + x];
      if (p && colorOf(p) === by && typeOf(p) === PAWN) return true;
    }
  }
  for (const [dx, dy] of KNIGHT_D) {
    const x = tx + dx;
    const y = ty + dy;
    if (!inB(x, y)) continue;
    const p = st.b[y * N + x];
    if (p && colorOf(p) === by && typeOf(p) === KNIGHT) return true;
  }
  for (const [dx, dy] of ALL8) {
    const x = tx + dx;
    const y = ty + dy;
    if (!inB(x, y)) continue;
    const p = st.b[y * N + x];
    if (p && colorOf(p) === by && typeOf(p) === KING) return true;
  }
  for (let s = 0; s < 8; s++) {
    const [dx, dy] = s < 4 ? ROOK_D[s] : BISH_D[s - 4];
    let x = tx + dx;
    let y = ty + dy;
    while (inB(x, y)) {
      const p = st.b[y * N + x];
      if (p) {
        if (colorOf(p) === by) {
          const t = typeOf(p);
          if (t === QUEEN || (s < 4 ? t === ROOK : t === BISHOP)) return true;
        }
        break;
      }
      x += dx;
      y += dy;
    }
  }
  return false;
}

function kingSquare(st, col) {
  for (let i = 0; i < N * N; i++) {
    const p = st.b[i];
    if (p && colorOf(p) === col && typeOf(p) === KING) return i;
  }
  return -1;
}

function chessInCheck(st, col) {
  const k = kingSquare(st, col);
  return k >= 0 && chessAttacked(st, k, other(col));
}

/** MVV-LVA ordering score baked in at generation time. */
function addMove(out, from, to, cap, mover, extra) {
  const mv = { from, to, cap, promo: false, dbl: false, epCap: false, caps: null, score: 0 };
  if (extra) Object.assign(mv, extra);
  mv.score = cap ? 1000 + PVAL[typeOf(cap)] * 8 - PVAL[typeOf(mover)] : 0;
  out.push(mv);
  return mv;
}

/** Pseudo-legal generation; the legality filter runs in chessGen. */
function chessPseudo(st, col, out) {
  for (let sq = 0; sq < N * N; sq++) {
    const p = st.b[sq];
    if (!p || colorOf(p) !== col) continue;
    const x = sq % N;
    const y = (sq / N) | 0;
    const t = typeOf(p);

    if (t === PAWN) {
      const dy = col === WHITE ? -1 : 1;
      const startY = col === WHITE ? N - 2 : 1;
      const lastY = col === WHITE ? 0 : N - 1;
      const y1 = y + dy;
      if (inB(x, y1) && !st.b[y1 * N + x]) {
        const m = addMove(out, sq, y1 * N + x, EMPTY, p);
        if (y1 === lastY) { m.promo = true; m.score += 800; }
        const y2 = y + dy * 2;
        if (y === startY && !st.b[y2 * N + x]) {
          addMove(out, sq, y2 * N + x, EMPTY, p, { dbl: true });
        }
      }
      for (let i = -1; i <= 1; i += 2) {
        const cx = x + i;
        if (!inB(cx, y1)) continue;
        const dst = y1 * N + cx;
        const tgt = st.b[dst];
        if (tgt && colorOf(tgt) !== col) {
          const m = addMove(out, sq, dst, tgt, p);
          if (y1 === lastY) { m.promo = true; m.score += 800; }
        } else if (!tgt && dst === st.ep) {
          addMove(out, sq, dst, PAWN | other(col), p, { epCap: true });
        }
      }
      continue;
    }

    if (t === KNIGHT || t === KING) {
      const dirs = t === KNIGHT ? KNIGHT_D : ALL8;
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inB(nx, ny)) continue;
        const dst = ny * N + nx;
        const tgt = st.b[dst];
        if (tgt && colorOf(tgt) === col) continue;
        addMove(out, sq, dst, tgt, p);
      }
      continue;
    }

    const dirs = t === ROOK ? ROOK_D : t === BISHOP ? BISH_D : ALL8;
    for (const [dx, dy] of dirs) {
      let nx = x + dx;
      let ny = y + dy;
      while (inB(nx, ny)) {
        const dst = ny * N + nx;
        const tgt = st.b[dst];
        if (tgt && colorOf(tgt) === col) break;
        addMove(out, sq, dst, tgt, p);
        if (tgt) break;
        nx += dx;
        ny += dy;
      }
    }
  }
}

function chessGen(st, col) {
  const pseudo = [];
  chessPseudo(st, col, pseudo);
  const legal = [];
  for (const mv of pseudo) {
    chessMake(st, mv);
    const bad = chessInCheck(st, col);
    chessUnmake(st, mv);
    if (!bad) legal.push(mv);
  }
  return legal;
}

function chessMake(st, mv) {
  const u = pushUndo(st);
  const p = st.b[mv.from];
  const col = colorOf(p);
  const capSq = mv.epCap ? mv.to + (col === WHITE ? N : -N) : mv.to;
  u.ep = st.ep;
  u.half = st.half;
  u.cap = st.b[capSq];
  u.capSq = capSq;
  u.moved = p;
  st.b[capSq] = EMPTY;
  st.b[mv.from] = EMPTY;
  st.b[mv.to] = mv.promo ? (QUEEN | col) : p;
  st.ep = mv.dbl ? (mv.from + mv.to) >> 1 : -1;
  st.half = typeOf(p) === PAWN || u.cap ? 0 : st.half + 1;
  st.side = other(col);
  return u;
}

function chessUnmake(st, mv) {
  const u = st.undo[--st.ut];
  st.b[mv.to] = EMPTY;
  st.b[mv.from] = u.moved;
  st.b[u.capSq] = u.cap;
  st.ep = u.ep;
  st.half = u.half;
  st.side = colorOf(u.moved);
}

/* Piece-square tables, written from White's point of view (row 0 = far rank). */
const PST = {
  [PAWN]: [
    0, 0, 0, 0, 0, 0,
    62, 62, 62, 62, 62, 62,
    26, 32, 42, 42, 32, 26,
    10, 16, 26, 26, 16, 10,
    4, 6, 10, 10, 6, 4,
    0, 0, 0, 0, 0, 0,
  ],
  [KNIGHT]: [
    -24, -12, -6, -6, -12, -24,
    -10, 6, 12, 12, 6, -10,
    -4, 12, 22, 22, 12, -4,
    -4, 12, 22, 22, 12, -4,
    -10, 6, 12, 12, 6, -10,
    -24, -12, -6, -6, -12, -24,
  ],
  [BISHOP]: [
    -12, -6, -4, -4, -6, -12,
    -4, 10, 8, 8, 10, -4,
    -2, 8, 14, 14, 8, -2,
    -2, 8, 14, 14, 8, -2,
    -4, 10, 8, 8, 10, -4,
    -12, -6, -4, -4, -6, -12,
  ],
  [ROOK]: [
    6, 8, 10, 10, 8, 6,
    16, 18, 20, 20, 18, 16,
    0, 2, 4, 4, 2, 0,
    0, 2, 4, 4, 2, 0,
    -4, 0, 2, 2, 0, -4,
    0, 2, 6, 6, 2, 0,
  ],
  [QUEEN]: [
    -8, -4, 0, 0, -4, -8,
    -4, 4, 6, 6, 4, -4,
    0, 6, 10, 10, 6, 0,
    0, 6, 10, 10, 6, 0,
    -4, 4, 6, 6, 4, -4,
    -8, -4, -2, -2, -4, -8,
  ],
  [KING]: [
    -34, -34, -34, -34, -34, -34,
    -26, -26, -26, -26, -26, -26,
    -18, -18, -18, -18, -18, -18,
    -8, -8, -8, -8, -8, -8,
    2, 6, -4, -4, 6, 2,
    12, 20, 6, 6, 20, 12,
  ],
};

/** Material + piece-square score, always from White's point of view. */
function chessEval(st) {
  let s = 0;
  for (let i = 0; i < N * N; i++) {
    const p = st.b[i];
    if (!p) continue;
    const t = typeOf(p);
    const tab = PST[t];
    if (colorOf(p) === WHITE) s += PVAL[t] + tab[i];
    else s -= PVAL[t] + tab[(N - 1 - ((i / N) | 0)) * N + (i % N)];
  }
  return s;
}

/* ============================================================== CHECKERS */

/**
 * 6x6 draughts on the dark squares: men step diagonally forward, captures are
 * compulsory, jump chains are one single move, and a man crowned on the far
 * rank ends its turn as a king.
 */
const playable = (x, y) => ((x + y) & 1) === 1;

function checkersSetup(st) {
  st.b.fill(EMPTY);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!playable(x, y)) continue;
      if (y < 2) st.b[y * N + x] = CMAN | BLACK;
      else if (y > N - 3) st.b[y * N + x] = CMAN | WHITE;
    }
  }
  st.side = WHITE;
  st.ep = -1;
  st.half = 0;
}

function manDirs(p) {
  if (typeOf(p) === CKING) return BISH_D;
  return colorOf(p) === WHITE ? [[-1, -1], [1, -1]] : [[-1, 1], [1, 1]];
}

/** Recursive jump-chain walker; `caps`/`path` are shared scratch arrays. */
function jumpsFrom(st, sq, p, caps, path, out) {
  const x = sq % N;
  const y = (sq / N) | 0;
  const col = colorOf(p);
  const lastY = col === WHITE ? 0 : N - 1;
  let extended = false;

  for (const [dx, dy] of manDirs(p)) {
    const mx = x + dx;
    const my = y + dy;
    const lx = x + dx * 2;
    const ly = y + dy * 2;
    if (!inB(lx, ly)) continue;
    const mid = my * N + mx;
    const land = ly * N + lx;
    const midP = st.b[mid];
    if (!midP || colorOf(midP) === col || st.b[land]) continue;

    extended = true;
    st.b[mid] = EMPTY;
    st.b[sq] = EMPTY;
    const crown = typeOf(p) === CMAN && ly === lastY;
    const np = crown ? CKING | col : p;
    st.b[land] = np;
    caps.push(mid);
    path.push(land);

    // Crowning stops the chain, otherwise keep jumping if we can.
    let more = false;
    if (!crown) more = jumpsFrom(st, land, np, caps, path, out);
    if (!more) {
      out.push({
        from: path[0], to: land, caps: caps.slice(), path: path.slice(1),
        promo: crown, score: 1000 + caps.length * 400,
      });
    }

    st.b[land] = EMPTY;
    st.b[sq] = p;
    st.b[mid] = midP;
    caps.pop();
    path.pop();
  }
  return extended;
}

function checkersGen(st, col) {
  const caps = [];
  const quiet = [];
  for (let sq = 0; sq < N * N; sq++) {
    const p = st.b[sq];
    if (!p || colorOf(p) !== col) continue;
    const scratchC = [];
    const scratchP = [sq];
    jumpsFrom(st, sq, p, scratchC, scratchP, caps);
  }
  if (caps.length) return caps;      // captures are forced

  for (let sq = 0; sq < N * N; sq++) {
    const p = st.b[sq];
    if (!p || colorOf(p) !== col) continue;
    const x = sq % N;
    const y = (sq / N) | 0;
    const lastY = col === WHITE ? 0 : N - 1;
    for (const [dx, dy] of manDirs(p)) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inB(nx, ny) || st.b[ny * N + nx]) continue;
      const crown = typeOf(p) === CMAN && ny === lastY;
      quiet.push({
        from: sq, to: ny * N + nx, caps: null, path: null,
        promo: crown, score: crown ? 300 : 0,
      });
    }
  }
  return quiet;
}

function checkersMake(st, mv) {
  const u = pushUndo(st);
  const p = st.b[mv.from];
  const col = colorOf(p);
  u.moved = p;
  u.half = st.half;
  u.caps.length = 0;
  if (mv.caps) {
    for (const c of mv.caps) {
      u.caps.push(st.b[c]);
      st.b[c] = EMPTY;
    }
  }
  st.b[mv.from] = EMPTY;
  st.b[mv.to] = mv.promo ? CKING | col : p;
  st.half = mv.caps || mv.promo ? 0 : st.half + 1;
  st.side = other(col);
  return u;
}

function checkersUnmake(st, mv) {
  const u = st.undo[--st.ut];
  st.b[mv.to] = EMPTY;
  st.b[mv.from] = u.moved;
  if (mv.caps) {
    for (let i = 0; i < mv.caps.length; i++) st.b[mv.caps[i]] = u.caps[i];
  }
  st.half = u.half;
  st.side = colorOf(u.moved);
}

function checkersEval(st) {
  let s = 0;
  for (let i = 0; i < N * N; i++) {
    const p = st.b[i];
    if (!p) continue;
    const x = i % N;
    const y = (i / N) | 0;
    const centre = 6 - Math.abs(x - 2.5) * 2 - Math.abs(y - 2.5) * 2;
    if (colorOf(p) === WHITE) {
      s += typeOf(p) === CKING ? 185 + centre * 2 : 100 + (N - 1 - y) * 9 + centre;
    } else {
      s -= typeOf(p) === CKING ? 185 + centre * 2 : 100 + y * 9 + centre;
    }
  }
  return s;
}

/* -------------------------------------------------------- rule interfaces */

const RULES = {
  chess: {
    label: 'MICRO CHESS',
    setup: chessSetup,
    gen: chessGen,
    make: chessMake,
    unmake: chessUnmake,
    evaluate: chessEval,
    /** Score for a side with no legal moves: mate loses, stalemate draws. */
    terminal(st, col, ply) {
      return chessInCheck(st, col) ? -(MATE - ply) : 0;
    },
    inCheck: chessInCheck,
  },
  checkers: {
    label: 'CHECKERS',
    setup: checkersSetup,
    gen: checkersGen,
    make: checkersMake,
    unmake: checkersUnmake,
    evaluate: checkersEval,
    terminal(st, col, ply) {
      return -(MATE - ply);        // blocked or wiped out — you simply lose
    },
    inCheck: () => false,
  },
};

/* ==================================================== alpha-beta search */

/**
 * Negamax with alpha-beta pruning. The search aborts the moment the slice
 * deadline passes; the caller then keeps the last fully completed depth.
 */
function makeSearcher() {
  const s = {
    nodes: 0, deadline: 0, aborted: false, rules: null, st: null,
  };

  function negamax(depth, alphaV, betaV, ply) {
    if ((++s.nodes & 255) === 0 && now() > s.deadline) s.aborted = true;
    if (s.aborted) return 0;

    const st = s.st;
    const col = st.side;
    if (depth <= 0) return s.rules.evaluate(st) * (col === WHITE ? 1 : -1);

    const moves = s.rules.gen(st, col);
    if (!moves.length) return s.rules.terminal(st, col, ply);

    moves.sort(byScore);
    let best = -INF;
    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      s.rules.make(st, mv);
      const v = -negamax(depth - 1, -betaV, -alphaV, ply + 1);
      s.rules.unmake(st, mv);
      if (s.aborted) return 0;
      if (v > best) best = v;
      if (best > alphaV) alphaV = best;
      if (alphaV >= betaV) break;
    }
    return best;
  }

  /** One full-width root iteration. Returns null if the slice ran out. */
  s.root = function root(st, rules, depth, first, ms) {
    s.st = st;
    s.rules = rules;
    s.aborted = false;
    s.nodes = 0;
    s.deadline = now() + ms;

    const col = st.side;
    const moves = rules.gen(st, col);
    if (!moves.length) return { move: null, score: rules.terminal(st, col, 0) };
    moves.sort(byScore);
    if (first) {
      const idx = moves.findIndex((m) => m.from === first.from && m.to === first.to);
      if (idx > 0) moves.unshift(moves.splice(idx, 1)[0]);
    }

    let alphaV = -INF;
    let best = moves[0];
    let bestScore = -INF;
    for (const mv of moves) {
      rules.make(st, mv);
      const v = -negamax(depth - 1, -INF, -alphaV, 1);
      rules.unmake(st, mv);
      if (s.aborted) return null;
      if (v > bestScore) {
        bestScore = v;
        best = mv;
      }
      if (v > alphaV) alphaV = v;
    }
    return { move: best, score: bestScore };
  };

  return s;
}

const byScore = (a, b) => b.score - a.score;

/* ------------------------------------------------------- vector piece art */

/**
 * All pieces are drawn from canvas paths in a unit box (-0.5..0.5) then scaled,
 * so they stay crisp at any board size and need no font.
 */
function piecePath(ctx, type, checkers, king) {
  ctx.beginPath();
  if (checkers) {
    ctx.arc(0, 0, 0.4, 0, TAU);
    return;
  }
  switch (type) {
    case PAWN:
      ctx.moveTo(-0.28, 0.46);
      ctx.lineTo(0.28, 0.46);
      ctx.lineTo(0.2, 0.34);
      ctx.lineTo(0.11, 0.08);
      ctx.lineTo(0.17, 0.02);
      ctx.lineTo(0.09, -0.04);
      ctx.arc(0, -0.17, 0.155, 0.5, Math.PI - 0.5, true);
      ctx.lineTo(-0.09, -0.04);
      ctx.lineTo(-0.17, 0.02);
      ctx.lineTo(-0.11, 0.08);
      ctx.lineTo(-0.2, 0.34);
      ctx.closePath();
      break;
    case ROOK:
      ctx.moveTo(-0.32, 0.46);
      ctx.lineTo(0.32, 0.46);
      ctx.lineTo(0.24, 0.34);
      ctx.lineTo(0.19, -0.08);
      ctx.lineTo(0.3, -0.08);
      ctx.lineTo(0.3, -0.3);
      ctx.lineTo(0.16, -0.3);
      ctx.lineTo(0.16, -0.19);
      ctx.lineTo(0.07, -0.19);
      ctx.lineTo(0.07, -0.3);
      ctx.lineTo(-0.07, -0.3);
      ctx.lineTo(-0.07, -0.19);
      ctx.lineTo(-0.16, -0.19);
      ctx.lineTo(-0.16, -0.3);
      ctx.lineTo(-0.3, -0.3);
      ctx.lineTo(-0.3, -0.08);
      ctx.lineTo(-0.19, -0.08);
      ctx.lineTo(-0.24, 0.34);
      ctx.closePath();
      break;
    case KNIGHT:
      ctx.moveTo(-0.32, 0.46);
      ctx.lineTo(0.32, 0.46);
      ctx.lineTo(0.27, 0.33);
      ctx.lineTo(0.25, 0.08);
      ctx.lineTo(0.19, -0.12);
      ctx.lineTo(0.1, -0.29);
      ctx.lineTo(0.04, -0.44);
      ctx.lineTo(-0.03, -0.29);
      ctx.lineTo(-0.11, -0.38);
      ctx.lineTo(-0.24, -0.3);
      ctx.lineTo(-0.35, -0.09);
      ctx.lineTo(-0.2, -0.05);
      ctx.lineTo(-0.29, 0.07);
      ctx.lineTo(-0.12, 0.07);
      ctx.lineTo(-0.05, 0.2);
      ctx.lineTo(-0.14, 0.33);
      ctx.closePath();
      break;
    case BISHOP:
      ctx.moveTo(-0.3, 0.46);
      ctx.lineTo(0.3, 0.46);
      ctx.lineTo(0.22, 0.34);
      ctx.lineTo(0.14, 0.16);
      ctx.bezierCurveTo(0.28, 0.02, 0.2, -0.24, 0, -0.34);
      ctx.bezierCurveTo(-0.2, -0.24, -0.28, 0.02, -0.14, 0.16);
      ctx.lineTo(-0.22, 0.34);
      ctx.closePath();
      break;
    case QUEEN:
      ctx.moveTo(-0.32, 0.46);
      ctx.lineTo(0.32, 0.46);
      ctx.lineTo(0.24, 0.34);
      ctx.lineTo(0.16, 0.02);
      ctx.lineTo(0.3, 0.02);
      ctx.lineTo(0.34, -0.34);
      ctx.lineTo(0.19, -0.14);
      ctx.lineTo(0.1, -0.36);
      ctx.lineTo(0, -0.14);
      ctx.lineTo(-0.1, -0.36);
      ctx.lineTo(-0.19, -0.14);
      ctx.lineTo(-0.34, -0.34);
      ctx.lineTo(-0.3, 0.02);
      ctx.lineTo(-0.16, 0.02);
      ctx.lineTo(-0.24, 0.34);
      ctx.closePath();
      break;
    default: // KING
      ctx.moveTo(-0.32, 0.46);
      ctx.lineTo(0.32, 0.46);
      ctx.lineTo(0.24, 0.34);
      ctx.lineTo(0.16, 0.04);
      ctx.lineTo(0.26, -0.04);
      ctx.lineTo(0.26, -0.2);
      ctx.lineTo(0.08, -0.2);
      ctx.lineTo(0.08, -0.3);
      ctx.lineTo(0.16, -0.3);
      ctx.lineTo(0.16, -0.4);
      ctx.lineTo(0.08, -0.4);
      ctx.lineTo(0.08, -0.5);
      ctx.lineTo(-0.08, -0.5);
      ctx.lineTo(-0.08, -0.4);
      ctx.lineTo(-0.16, -0.4);
      ctx.lineTo(-0.16, -0.3);
      ctx.lineTo(-0.08, -0.3);
      ctx.lineTo(-0.08, -0.2);
      ctx.lineTo(-0.26, -0.2);
      ctx.lineTo(-0.26, -0.04);
      ctx.lineTo(-0.16, 0.04);
      ctx.lineTo(-0.24, 0.34);
      ctx.closePath();
      break;
  }
  if (king) { /* checkers crown drawn separately */ }
}

function drawPiece(ctx, code, cx, cy, size, light, checkers, faded) {
  const type = typeOf(code);
  const king = checkers && type === CKING;
  const fill = light ? '#e8f3ff' : '#182446';
  const line = light ? '#0b1830' : PAL.magenta;
  const rim = light ? PAL.cyan : PAL.magenta;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size, size);
  if (faded) ctx.globalAlpha = 0.45;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 0.055;

  // Soft contact shadow keeps the piece from floating on the square.
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(0.02, 0.44, 0.3, 0.09, 0, 0, TAU);
  ctx.fill();

  ctx.shadowColor = rim;
  ctx.shadowBlur = 6 / size;
  piecePath(ctx, type, checkers, king);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = line;
  ctx.stroke();

  if (checkers) {
    ctx.beginPath();
    ctx.arc(0, 0, 0.28, 0, TAU);
    ctx.strokeStyle = light ? alpha(PAL.cyan, 0.7) : alpha(PAL.magenta, 0.8);
    ctx.lineWidth = 0.045;
    ctx.stroke();
    if (king) {
      // Three-point crown for a crowned disc.
      ctx.beginPath();
      ctx.moveTo(-0.19, 0.1);
      ctx.lineTo(-0.24, -0.14);
      ctx.lineTo(-0.09, -0.02);
      ctx.lineTo(0, -0.18);
      ctx.lineTo(0.09, -0.02);
      ctx.lineTo(0.24, -0.14);
      ctx.lineTo(0.19, 0.1);
      ctx.closePath();
      ctx.fillStyle = light ? PAL.yellow : PAL.yellow;
      ctx.fill();
      ctx.lineWidth = 0.03;
      ctx.strokeStyle = '#3a2c00';
      ctx.stroke();
    }
  } else if (type === KNIGHT) {
    ctx.beginPath();
    ctx.arc(-0.12, -0.19, 0.035, 0, TAU);
    ctx.fillStyle = light ? '#0b1830' : PAL.magenta;
    ctx.fill();
  } else if (type === BISHOP) {
    ctx.beginPath();
    ctx.moveTo(0.05, -0.22);
    ctx.lineTo(-0.04, -0.04);
    ctx.lineWidth = 0.04;
    ctx.strokeStyle = line;
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------- meta */

export const meta = {
  id: 'chess',
  title: 'MICRO CHESS & CHECKERS',
  short: 'MICRO CHESS',
  category: 'STRATEGY',
  desc: 'Two six-by-six board games against a real alpha-beta engine: micro '
      + 'chess with full legal-move rules, or forced-capture checkers. Pick '
      + 'your poison and your depth.',
  accent: PAL.violet,
  view: VIEW,
  controls: [
    'POINTER — tap a piece, then a marked square',
    'A — undo your last move',
    'B — back to mode select',
  ],
  touch: { buttons: [{ id: 'a', label: 'UNDO' }, { id: 'b', label: 'MODE' }] },
  art(ctx, w, h, accent) {
    const c = 26;
    const ox = (w - c * 6) / 2;
    const oy = (h - c * 6) / 2 + 4;
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        ctx.fillStyle = (x + y) & 1 ? '#111c30' : '#1d2c4a';
        ctx.fillRect(ox + x * c, oy + y * c, c, c);
      }
    }
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;
    ctx.strokeRect(ox - 1, oy - 1, c * 6 + 2, c * 6 + 2);
    ctx.restore();
    drawPiece(ctx, KING | WHITE, ox + c * 1.5, oy + c * 4.5, c * 0.9, true, false);
    drawPiece(ctx, KNIGHT | WHITE, ox + c * 3.5, oy + c * 4.5, c * 0.9, true, false);
    drawPiece(ctx, QUEEN | BLACK, ox + c * 2.5, oy + c * 1.5, c * 0.9, false, false);
    drawPiece(ctx, CKING | BLACK, ox + c * 4.5, oy + c * 2.5, c * 0.9, false, true);
    ctx.save();
    ctx.fillStyle = alpha(PAL.lime, 0.75);
    ctx.beginPath();
    ctx.arc(ox + c * 2.5, oy + c * 3.5, 4, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ox + c * 4.5, oy + c * 3.5, 4, 0, TAU);
    ctx.fill();
    ctx.restore();
  },
};

/* ------------------------------------------------------------------ game */

const DIFFS = [
  { name: 'CASUAL', depth: 2, budget: 60 },
  { name: 'CLUB', depth: 4, budget: 110 },
  { name: 'MASTER', depth: 6, budget: 130 },
];

const SLICE_MS = 42;     // hard ceiling on search time inside a single frame

export function create(api) {
  let phase;              // 'menu' | 'play' | 'over'
  let mode, diffIdx;
  let st, rules;
  let human, cpu;         // colours
  let legal;              // legal moves for whoever is to move
  let sel, dests;         // selected square + its destination moves
  let lastMove, lastPath;
  let log;                // notation lines
  let anim;               // sliding piece animation
  let think;              // AI search runtime
  let searcher;
  let snapshots;          // undo stack of whole positions
  let repeats;            // position hash -> count
  let banner, bannerT;
  let checkPulse;
  let result;             // 'win' | 'loss' | 'draw' | null
  let menuHit;            // clickable menu rects, rebuilt each render
  let captures;           // material taken, for the panel
  let plyCount;

  /* ------------------------------------------------------------ helpers */

  const sqX = (sq) => BX + (sq % N) * CELL;
  const sqY = (sq) => BY + (((sq / N) | 0)) * CELL;
  const sqName = (sq) => FILES[sq % N] + (N - ((sq / N) | 0));

  function pieceLetter(p) {
    const t = typeOf(p);
    return t === KNIGHT ? 'N' : t === BISHOP ? 'B' : t === ROOK ? 'R'
      : t === QUEEN ? 'Q' : t === KING ? 'K' : '';
  }

  /** Algebraic-ish notation, built before the move is played. */
  function notate(mv) {
    if (mode === 'checkers') {
      let s = sqName(mv.from);
      if (mv.caps && mv.caps.length) {
        for (const p of mv.path) s += 'x' + sqName(p);
      } else {
        s += '-' + sqName(mv.to);
      }
      return s + (mv.promo ? '=K' : '');
    }
    const p = st.b[mv.from];
    let s = pieceLetter(p) + sqName(mv.from);
    s += mv.cap || mv.epCap ? 'x' : '-';
    s += sqName(mv.to);
    if (mv.promo) s += '=Q';
    return s;
  }

  function snapshot() {
    snapshots.push({
      b: st.b.slice(), side: st.side, ep: st.ep, half: st.half,
      log: log.length, last: lastMove, path: lastPath,
      score: api.score, caps: captures.slice(), ply: plyCount,
    });
    if (snapshots.length > 64) snapshots.shift();
  }

  function restore(snap) {
    st.b.set(snap.b);
    st.side = snap.side;
    st.ep = snap.ep;
    st.half = snap.half;
    st.ut = 0;
    log.length = snap.log;
    lastMove = snap.last;
    lastPath = snap.path;
    captures = snap.caps.slice();
    plyCount = snap.ply;
    api.setScore(snap.score);
  }

  function bumpRepeat(delta) {
    const k = posKey(st);
    const c = (repeats.get(k) || 0) + delta;
    if (c <= 0) repeats.delete(k);
    else repeats.set(k, c);
    return c;
  }

  function say(msg, secs = 2) {
    banner = msg;
    bannerT = secs;
  }

  /* ------------------------------------------------------------- flow */

  function startMatch() {
    st = makeState();
    rules = RULES[mode];
    rules.setup(st);
    human = WHITE;
    cpu = BLACK;
    sel = -1;
    dests = [];
    lastMove = null;
    lastPath = null;
    log = [];
    anim = null;
    think = null;
    snapshots = [];
    repeats = new Map();
    captures = [];
    plyCount = 0;
    result = null;
    checkPulse = 0;
    bumpRepeat(1);
    legal = rules.gen(st, st.side);
    phase = 'play';
    api.setStatus({ MODE: mode === 'chess' ? 'CHESS' : 'DRAUGHTS', AI: DIFFS[diffIdx].name });
    say(mode === 'chess' ? 'WHITE TO MOVE' : 'YOUR MOVE', 1.6);
    api.sfx('select');
  }

  function scoreCapture(piece) {
    if (!piece) return;
    const t = typeOf(piece);
    const pts = mode === 'chess' ? Math.round(PVAL[t] / 10) : t === CKING ? 30 : 15;
    api.addScore(pts);
    captures.push(piece);
    if (captures.length > 12) captures.shift();
    return pts;
  }

  /** Play a move on the live board, with sfx, particles and the notation log. */
  function playMove(mv) {
    const note = notate(mv);
    const moverIsHuman = st.side === human;
    const cx = sqX(mv.to) + CELL / 2;
    const cy = sqY(mv.to) + CELL / 2;

    snapshot();

    let taken = 0;
    if (mode === 'checkers') {
      for (const c of mv.caps || []) {
        const pts = scoreCapture(st.b[c]) || 0;
        if (moverIsHuman) taken += pts;
        api.particles.burst(sqX(c) + CELL / 2, sqY(c) + CELL / 2, 10, {
          speed: 90, life: 0.5, size: 2.6, color: [PAL.yellow, PAL.white], glow: 9, drag: 3,
        });
      }
    } else if (mv.cap || mv.epCap) {
      const capSq = mv.epCap ? mv.to + (colorOf(st.b[mv.from]) === WHITE ? N : -N) : mv.to;
      const pts = scoreCapture(st.b[capSq]) || 0;
      if (moverIsHuman) taken += pts;
      api.particles.burst(sqX(capSq) + CELL / 2, sqY(capSq) + CELL / 2, 14, {
        speed: 110, life: 0.55, size: 3, color: [PAL.magenta, PAL.white], glow: 10, drag: 3,
      });
    }

    if (taken > 0) api.particles.popText(cx, cy - 12, '+' + taken, PAL.yellow);

    const wasCapture = mode === 'checkers' ? !!(mv.caps && mv.caps.length) : !!(mv.cap || mv.epCap);
    api.sfx(wasCapture ? 'hit' : 'blip', { vol: wasCapture ? 0.9 : 0.55 });
    if (wasCapture) api.shakeScreen(3);
    if (mv.promo) {
      api.sfx('powerup');
      api.particles.burst(cx, cy, 16, {
        speed: 100, life: 0.7, size: 3, color: [PAL.yellow, PAL.cyan], glow: 12, drag: 2.4,
      });
    }

    anim = { from: mv.from, to: mv.to, piece: st.b[mv.from], t: 0, dur: 0.16 };
    rules.make(st, mv);
    st.ut = 0;                       // live play never unwinds through the stack
    plyCount++;
    lastMove = { from: mv.from, to: mv.to };
    lastPath = mv.path || null;
    log.push(note);

    const rep = bumpRepeat(1);
    legal = rules.gen(st, st.side);
    checkPulse = rules.inCheck(st, st.side) ? 1 : 0;
    if (checkPulse) api.sfx('alert', { vol: 0.6 });

    evaluateEnd(rep);
  }

  /** Terminal-position bookkeeping after every played move. */
  function evaluateEnd(rep) {
    if (result) return;
    const side = st.side;

    if (!legal.length) {
      const loser = side;
      if (mode === 'chess' && !chessInCheck(st, side)) {
        finish('draw', 'STALEMATE');
      } else if (loser === cpu) {
        finish('win', mode === 'chess' ? 'CHECKMATE' : 'ALL PIECES TRAPPED');
      } else {
        finish('loss', mode === 'chess' ? 'CHECKMATED' : 'NO MOVES LEFT');
      }
      return;
    }

    if (mode === 'checkers') {
      let w = 0;
      let b = 0;
      for (let i = 0; i < N * N; i++) {
        const p = st.b[i];
        if (!p) continue;
        if (colorOf(p) === WHITE) w++; else b++;
      }
      if (!b) finish('win', 'BOARD SWEPT');
      else if (!w) finish('loss', 'WIPED OUT');
    }

    if (result) return;
    if (st.half >= 100) finish('draw', '50-MOVE RULE');
    else if (rep >= 3) finish('draw', 'THREEFOLD REPETITION');
    else if (mode === 'chess') {
      // Bare kings can never mate.
      let men = 0;
      for (let i = 0; i < N * N; i++) if (st.b[i] && typeOf(st.b[i]) !== KING) men++;
      if (!men) finish('draw', 'INSUFFICIENT MATERIAL');
    }
  }

  function finish(kind, msg) {
    if (result) return;
    // No hit-stop here: freezing a turn-based board reads as a stutter, not
    // as impact. The flash alone marks the moment.
    api.flash(kind === 'win' ? PAL.lime : PAL.red, 0.35);
    result = kind;
    phase = 'over';
    sel = -1;
    dests = [];
    think = null;
    say(msg, 6);

    const stats = {
      MODE: mode === 'chess' ? 'MICRO CHESS' : 'CHECKERS',
      AI: DIFFS[diffIdx].name,
      MOVES: Math.ceil(plyCount / 2),
      TAKEN: captures.length,
    };

    if (kind === 'win') {
      const bonus = 400 + diffIdx * 250;
      api.addScore(bonus);
      api.shakeScreen(10, 4);
      for (let i = 0; i < 5; i++) {
        api.particles.burst(BX + Math.random() * BOARD, BY + Math.random() * BOARD, 12, {
          speed: 140, life: 0.9, size: 3, color: [PAL.lime, PAL.yellow, PAL.white], glow: 12, drag: 1.6,
        });
      }
      stats.BONUS = bonus;
      api.win({ message: msg + ' — YOU WIN', stats });
    } else if (kind === 'draw') {
      api.addScore(120);
      api.gameOver({ message: 'DRAWN — ' + msg, stats });
    } else {
      api.shakeScreen(9, 5);
      api.gameOver({ message: msg, stats });
    }
  }

  /* ------------------------------------------------------------ ai turn */

  function beginThink() {
    think = {
      depth: 1, best: null, score: 0, spent: 0, wait: 0.22,
      target: DIFFS[diffIdx].depth, budget: DIFFS[diffIdx].budget,
    };
  }

  function stepThink(dt) {
    if (think.wait > 0) {
      think.wait -= dt;
      return;
    }
    const slice = Math.min(SLICE_MS, think.budget - think.spent);
    const t0 = now();
    const res = searcher.root(st, rules, think.depth, think.best, Math.max(6, slice));
    think.spent += now() - t0;

    if (res && res.move) {
      think.best = res.move;
      think.score = res.score;
      think.depth++;
    }

    // Out of depth, out of time, or the slice was cut short: commit.
    const done = !res || !think.best || think.depth > think.target || think.spent >= think.budget;
    if (done) {
      const mv = think.best || (legal.length ? api.rng.pick(legal) : null);
      think = null;
      if (mv) playMove(mv);
    }
  }

  /* -------------------------------------------------------------- input */

  function squareAt(x, y) {
    if (x < BX || y < BY || x >= BX + BOARD || y >= BY + BOARD) return -1;
    const cx = ((x - BX) / CELL) | 0;
    const cy = ((y - BY) / CELL) | 0;
    return cy * N + cx;
  }

  function selectSquare(sq) {
    const p = st.b[sq];
    if (p && colorOf(p) === human) {
      const list = legal.filter((m) => m.from === sq);
      if (!list.length) {
        api.sfx('deny', { vol: 0.5 });
        // In checkers a forced capture elsewhere can freeze this piece.
        sel = -1;
        dests = [];
        return;
      }
      sel = sq;
      dests = list;
      api.sfx('select', { vol: 0.6 });
      return;
    }
    sel = -1;
    dests = [];
  }

  function tapBoard(sq) {
    if (sq < 0 || st.side !== human || anim || think) return;
    if (sel >= 0) {
      const mv = dests.find((m) => m.to === sq);
      if (mv) {
        sel = -1;
        dests = [];
        playMove(mv);
        return;
      }
    }
    selectSquare(sq);
  }

  function undo() {
    if (phase !== 'play' || st.side !== human || anim) return;
    if (snapshots.length < 2) {
      api.sfx('deny', { vol: 0.6 });
      return;
    }
    repeats.clear();
    snapshots.pop();                       // AI reply
    const snap = snapshots.pop();          // our move
    restore(snap);
    bumpRepeat(1);
    legal = rules.gen(st, st.side);
    sel = -1;
    dests = [];
    think = null;
    checkPulse = rules.inCheck(st, st.side) ? 1 : 0;
    api.sfx('back');
    say('TAKEN BACK', 1.2);
  }

  function toMenu() {
    phase = 'menu';
    sel = -1;
    dests = [];
    think = null;
    anim = null;
    api.sfx('back');
  }

  /* ------------------------------------------------------------- render */

  function hitRect(list, id, x, y, w, h) {
    const r = { id, x, y, w, h };
    list.push(r);
    return r;
  }

  function button(ctx, r, label, on, accent) {
    ctx.save();
    ctx.globalAlpha = on ? 1 : 0.7;
    ctx.fillStyle = on ? alpha(accent, 0.22) : 'rgba(255,255,255,0.04)';
    roundRect(ctx, r.x, r.y, r.w, r.h, 5);
    ctx.fill();
    ctx.strokeStyle = on ? accent : PAL.dim;
    ctx.lineWidth = on ? 1.6 : 1;
    if (on) {
      ctx.shadowColor = accent;
      ctx.shadowBlur = 8;
    }
    ctx.stroke();
    ctx.restore();
    text(ctx, label, r.x + r.w / 2, r.y + r.h / 2, {
      size: Math.min(11, r.h * 0.5), color: on ? PAL.white : PAL.dim,
      align: 'center', baseline: 'middle',
    });
  }

  function renderMenu(ctx) {
    const W = api.w;
    menuHit = [];

    text(ctx, 'MICRO CHESS & CHECKERS', W / 2, 22, {
      size: 18, color: PAL.violet, align: 'center', glow: 14,
    });
    text(ctx, 'SIX SQUARES A SIDE — PICK YOUR GAME', W / 2, 44, {
      size: 9, color: PAL.dim, align: 'center',
    });

    const cw = 176;
    const ch = 120;
    const gap = 24;
    const cx0 = W / 2 - cw - gap / 2;
    const modes = [
      { id: 'chess', label: 'MICRO CHESS', sub: '6x6 · FULL RULES' },
      { id: 'checkers', label: 'CHECKERS', sub: '6x6 · FORCED JUMPS' },
    ];
    modes.forEach((m, i) => {
      const x = cx0 + i * (cw + gap);
      const y = 62;
      const r = hitRect(menuHit, 'mode:' + m.id, x, y, cw, ch);
      const on = mode === m.id;
      ctx.save();
      ctx.fillStyle = on ? alpha(PAL.violet, 0.16) : 'rgba(255,255,255,0.03)';
      roundRect(ctx, x, y, cw, ch, 8);
      ctx.fill();
      ctx.strokeStyle = on ? PAL.violet : PAL.grid;
      ctx.lineWidth = on ? 2 : 1;
      if (on) {
        ctx.shadowColor = PAL.violet;
        ctx.shadowBlur = 12;
      }
      ctx.stroke();
      ctx.restore();

      // Little board vignette inside each card.
      const c = 17;
      const ox = x + cw / 2 - c * 3;
      const oy = y + 16;
      for (let by = 0; by < 4; by++) {
        for (let bx = 0; bx < 6; bx++) {
          ctx.fillStyle = (bx + by) & 1 ? '#14203a' : '#1d2c4a';
          ctx.fillRect(ox + bx * c, oy + by * c, c, c);
        }
      }
      if (m.id === 'chess') {
        drawPiece(ctx, KING | WHITE, ox + c * 1.5, oy + c * 3.5, c * 0.95, true, false);
        drawPiece(ctx, KNIGHT | BLACK, ox + c * 3.5, oy + c * 1.5, c * 0.95, false, false);
        drawPiece(ctx, ROOK | WHITE, ox + c * 4.5, oy + c * 2.5, c * 0.95, true, false);
      } else {
        drawPiece(ctx, CMAN | WHITE, ox + c * 0.5, oy + c * 3.5, c * 0.95, true, true);
        drawPiece(ctx, CKING | WHITE, ox + c * 2.5, oy + c * 3.5, c * 0.95, true, true);
        drawPiece(ctx, CMAN | BLACK, ox + c * 3.5, oy + c * 0.5, c * 0.95, false, true);
        drawPiece(ctx, CMAN | BLACK, ox + c * 1.5, oy + c * 0.5, c * 0.95, false, true);
      }
      text(ctx, m.label, x + cw / 2, y + ch - 30, {
        size: 12, color: on ? PAL.white : PAL.dim, align: 'center',
      });
      text(ctx, m.sub, x + cw / 2, y + ch - 15, {
        size: 8, color: on ? PAL.cyan : PAL.dim, align: 'center',
      });
      void r;
    });

    text(ctx, 'ENGINE STRENGTH', W / 2, 196, { size: 9, color: PAL.dim, align: 'center' });
    const bw = 96;
    DIFFS.forEach((d, i) => {
      const x = W / 2 - (bw * 3 + 16) / 2 + i * (bw + 8);
      const r = hitRect(menuHit, 'diff:' + i, x, 210, bw, 26);
      button(ctx, r, d.name + ' ' + d.depth, diffIdx === i, PAL.cyan);
    });

    const sr = hitRect(menuHit, 'start', W / 2 - 90, 254, 180, 34);
    button(ctx, sr, 'START MATCH', true, PAL.lime);

    text(ctx, 'YOU PLAY THE LIGHT PIECES · TAP TO MOVE', W / 2, 302, {
      size: 8, color: PAL.dim, align: 'center',
    });
    text(ctx, 'A = UNDO     B = MODE SELECT', W / 2, 316, {
      size: 8, color: PAL.dim, align: 'center',
    });
  }

  function renderBoard(ctx) {
    const checkers = mode === 'checkers';

    // Squares.
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dark = (x + y) & 1;
        ctx.fillStyle = dark ? '#101a2e' : '#1c2b48';
        ctx.fillRect(BX + x * CELL, BY + y * CELL, CELL, CELL);
      }
    }

    // Last move trail.
    if (lastMove) {
      ctx.fillStyle = alpha(PAL.cyan, 0.16);
      ctx.fillRect(sqX(lastMove.from), sqY(lastMove.from), CELL, CELL);
      ctx.fillRect(sqX(lastMove.to), sqY(lastMove.to), CELL, CELL);
      if (lastPath) {
        for (const p of lastPath) {
          ctx.fillStyle = alpha(PAL.cyan, 0.1);
          ctx.fillRect(sqX(p), sqY(p), CELL, CELL);
        }
      }
    }

    // Selection.
    if (sel >= 0) {
      ctx.save();
      ctx.strokeStyle = PAL.yellow;
      ctx.lineWidth = 2;
      ctx.shadowColor = PAL.yellow;
      ctx.shadowBlur = 10;
      ctx.strokeRect(sqX(sel) + 1.5, sqY(sel) + 1.5, CELL - 3, CELL - 3);
      ctx.restore();
    }

    // Check indicator on the king in danger.
    if (checkPulse > 0 && !checkers) {
      const k = kingSquare(st, st.side);
      if (k >= 0) {
        const pulse = 0.45 + 0.35 * Math.sin(api.time * 8);
        ctx.save();
        ctx.strokeStyle = alpha(PAL.red, pulse + 0.25);
        ctx.lineWidth = 3;
        ctx.shadowColor = PAL.red;
        ctx.shadowBlur = 14;
        ctx.strokeRect(sqX(k) + 2, sqY(k) + 2, CELL - 4, CELL - 4);
        ctx.restore();
      }
    }

    // Board frame + coordinates.
    ctx.save();
    ctx.strokeStyle = alpha(PAL.violet, 0.8);
    ctx.lineWidth = 2;
    ctx.shadowColor = PAL.violet;
    ctx.shadowBlur = 10;
    ctx.strokeRect(BX - 1, BY - 1, BOARD + 2, BOARD + 2);
    ctx.restore();
    for (let i = 0; i < N; i++) {
      text(ctx, FILES[i], BX + i * CELL + CELL - 4, BY + BOARD - 11, {
        size: 7, color: alpha(PAL.white, 0.28), align: 'right',
      });
      text(ctx, String(N - i), BX + 3, BY + i * CELL + 3, {
        size: 7, color: alpha(PAL.white, 0.28),
      });
    }

    // Pieces (the animating one is drawn last, on top).
    for (let sq = 0; sq < N * N; sq++) {
      const p = st.b[sq];
      if (!p) continue;
      if (anim && sq === anim.to) continue;
      drawPiece(ctx, p, sqX(sq) + CELL / 2, sqY(sq) + CELL / 2, CELL * 0.86,
        colorOf(p) === WHITE, checkers);
    }

    // Destination dots.
    for (const m of dests) {
      const cx = sqX(m.to) + CELL / 2;
      const cy = sqY(m.to) + CELL / 2;
      const cap = checkers ? m.caps && m.caps.length : m.cap || m.epCap;
      ctx.save();
      ctx.shadowColor = cap ? PAL.magenta : PAL.lime;
      ctx.shadowBlur = 10;
      if (cap) {
        ctx.strokeStyle = PAL.magenta;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, CELL * 0.4, 0, TAU);
        ctx.stroke();
      } else {
        ctx.fillStyle = alpha(PAL.lime, 0.85);
        ctx.beginPath();
        ctx.arc(cx, cy, 5.5, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    if (anim) {
      const t = Math.min(1, anim.t / anim.dur);
      const e = t * t * (3 - 2 * t);
      const x = sqX(anim.from) + (sqX(anim.to) - sqX(anim.from)) * e + CELL / 2;
      const y = sqY(anim.from) + (sqY(anim.to) - sqY(anim.from)) * e + CELL / 2;
      const p = st.b[anim.to] || anim.piece;
      drawPiece(ctx, p, x, y - Math.sin(e * Math.PI) * 6, CELL * 0.86,
        colorOf(anim.piece) === WHITE, checkers);
    }
  }

  function renderPanel(ctx) {
    menuHit = [];
    ctx.save();
    ctx.fillStyle = 'rgba(10,16,30,0.75)';
    roundRect(ctx, PX, PY, PW, BOARD, 6);
    ctx.fill();
    ctx.strokeStyle = alpha(PAL.violet, 0.35);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    const turnCpu = st.side === cpu;
    text(ctx, mode === 'chess' ? 'MICRO CHESS' : 'CHECKERS', PX + PW / 2, PY + 8, {
      size: 10, color: PAL.violet, align: 'center',
    });
    text(ctx, DIFFS[diffIdx].name + ' · DEPTH ' + DIFFS[diffIdx].depth, PX + PW / 2, PY + 22, {
      size: 8, color: PAL.dim, align: 'center',
    });

    let label = turnCpu ? 'ENGINE THINKING' : 'YOUR MOVE';
    let col = turnCpu ? PAL.magenta : PAL.lime;
    if (result) {
      label = result === 'win' ? 'VICTORY' : result === 'draw' ? 'DRAW' : 'DEFEAT';
      col = result === 'win' ? PAL.lime : result === 'draw' ? PAL.yellow : PAL.red;
    } else if (checkPulse > 0 && mode === 'chess') {
      label = turnCpu ? 'ENGINE IN CHECK' : 'YOU ARE IN CHECK';
      col = PAL.red;
    }
    ctx.save();
    ctx.globalAlpha = turnCpu && !result ? 0.55 + 0.45 * Math.sin(api.time * 7) : 1;
    text(ctx, label, PX + PW / 2, PY + 38, { size: 10, color: col, align: 'center', glow: 8 });
    ctx.restore();

    // Search progress bar while the engine works.
    if (think) {
      const w = PW - 24;
      const f = Math.min(1, think.spent / Math.max(1, DIFFS[diffIdx].budget));
      ctx.fillStyle = alpha(PAL.magenta, 0.2);
      ctx.fillRect(PX + 12, PY + 54, w, 3);
      ctx.fillStyle = PAL.magenta;
      ctx.fillRect(PX + 12, PY + 54, w * f, 3);
      text(ctx, 'PLY ' + Math.max(1, think.depth - 1), PX + PW / 2, PY + 60, {
        size: 7, color: PAL.dim, align: 'center',
      });
    }

    // Material advantage read-out.
    const advantage = Math.round(rules.evaluate(st) / (mode === 'chess' ? 100 : 100) * 10) / 10;
    text(ctx, 'EVAL ' + (advantage > 0 ? '+' : '') + advantage.toFixed(1),
      PX + PW / 2, PY + 74, { size: 8, color: advantage >= 0 ? PAL.cyan : PAL.orange, align: 'center' });

    // Move log.
    text(ctx, 'MOVE LOG', PX + 10, PY + 92, { size: 8, color: PAL.dim });
    ctx.save();
    ctx.strokeStyle = alpha(PAL.white, 0.08);
    ctx.beginPath();
    ctx.moveTo(PX + 10, PY + 104.5);
    ctx.lineTo(PX + PW - 10, PY + 104.5);
    ctx.stroke();
    ctx.restore();

    const lines = [];
    for (let i = 0; i < log.length; i += 2) {
      const no = i / 2 + 1;
      lines.push(String(no).padStart(2, ' ') + '. ' + log[i].padEnd(9, ' ')
        + (log[i + 1] || ''));
    }
    const view = lines.slice(-11);
    view.forEach((l, i) => {
      const fresh = i === view.length - 1;
      text(ctx, l, PX + 10, PY + 110 + i * 13, {
        size: 9, color: fresh ? PAL.white : alpha(PAL.white, 0.5),
      });
    });

    // Captured material strip.
    if (captures.length) {
      const y = PY + BOARD - 26;
      text(ctx, 'TAKEN', PX + 10, y - 12, { size: 7, color: PAL.dim });
      captures.slice(-9).forEach((p, i) => {
        drawPiece(ctx, p, PX + 18 + i * 15, y + 6, 15, colorOf(p) === WHITE, mode === 'checkers');
      });
    }
  }

  function renderButtons(ctx) {
    const y = BY + BOARD + 6;
    const w = (BOARD - 8) / 2;
    const u = hitRect(menuHit, 'undo', BX, y, w, 24);
    const m = hitRect(menuHit, 'menu', BX + w + 8, y, w, 24);
    button(ctx, u, 'UNDO', snapshots.length >= 2 && st.side === human && !result, PAL.yellow);
    button(ctx, m, 'MODE SELECT', true, PAL.cyan);
  }

  /* --------------------------------------------------------- lifecycle */

  return {
    init() {
      searcher = makeSearcher();
      mode = 'chess';
      diffIdx = 1;
      phase = 'menu';
      st = makeState();
      rules = RULES.chess;
      rules.setup(st);
      legal = [];
      log = [];
      dests = [];
      sel = -1;
      captures = [];
      snapshots = [];
      repeats = new Map();
      menuHit = [];
      plyCount = 0;
      result = null;
      checkPulse = 0;
      banner = '';
      bannerT = 0;
      anim = null;
      think = null;
      api.setStatus({ MODE: 'SELECT', AI: DIFFS[diffIdx].name });
    },

    update(dt) {
      if (bannerT > 0) bannerT -= dt;
      if (phase !== 'play') return;

      if (anim) {
        anim.t += dt;
        if (anim.t >= anim.dur) anim = null;
        return;                              // let the slide finish first
      }
      if (result) return;

      if (st.side === cpu) {
        if (!think) beginThink();
        stepThink(dt);
      }
    },

    handleInput(e) {
      if (e.type === 'press') {
        if (e.action === 'a') {
          if (phase === 'menu') diffIdx = (diffIdx + 1) % DIFFS.length;
          else undo();
          return;
        }
        if (e.action === 'b') {
          if (phase === 'menu') {
            mode = mode === 'chess' ? 'checkers' : 'chess';
            api.sfx('blip');
          } else {
            toMenu();
          }
          return;
        }
      }

      if (e.type !== 'pointerdown') return;
      const { x, y } = e;

      if (phase === 'menu') {
        for (const r of menuHit) {
          if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) continue;
          if (r.id.startsWith('mode:')) {
            mode = r.id.slice(5);
            api.sfx('blip');
          } else if (r.id.startsWith('diff:')) {
            diffIdx = +r.id.slice(5);
            api.sfx('blip');
          } else if (r.id === 'start') {
            startMatch();
          }
          return;
        }
        return;
      }

      if (phase === 'play') {
        for (const r of menuHit) {
          if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) continue;
          if (r.id === 'undo') undo();
          else if (r.id === 'menu') toMenu();
          return;
        }
        tapBoard(squareAt(x, y));
      }
    },

    render(ctx) {
      const W = api.w;
      const H = api.h;

      // Backdrop.
      ctx.fillStyle = '#070a14';
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#111a2c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 24) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, H);
      }
      for (let y = 0; y <= H; y += 24) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(W, y + 0.5);
      }
      ctx.stroke();
      ctx.restore();

      if (phase === 'menu') {
        renderMenu(ctx);
        api.particles.render(ctx);
        return;
      }

      renderBoard(ctx);
      renderPanel(ctx);
      renderButtons(ctx);
      api.particles.render(ctx);

      // Header + transient banner.
      text(ctx, mode === 'chess' ? 'MICRO CHESS 6x6' : 'MICRO CHECKERS 6x6', BX, 10, {
        size: 11, color: PAL.violet, glow: 8,
      });
      text(ctx, 'MOVE ' + Math.max(1, Math.ceil((plyCount + 1) / 2)), PX + PW, 12, {
        size: 9, color: PAL.dim, align: 'right',
      });

      if (bannerT > 0 && banner) {
        const a = Math.min(1, bannerT);
        ctx.save();
        ctx.globalAlpha = a;
        const bw = Math.max(150, banner.length * 9 + 30);
        ctx.fillStyle = 'rgba(6,10,20,0.85)';
        roundRect(ctx, BX + BOARD / 2 - bw / 2, BY + BOARD / 2 - 18, bw, 36, 6);
        ctx.fill();
        ctx.strokeStyle = alpha(result === 'loss' ? PAL.red : PAL.cyan, 0.8);
        ctx.stroke();
        text(ctx, banner, BX + BOARD / 2, BY + BOARD / 2, {
          size: 13, color: result === 'loss' ? PAL.red : PAL.white,
          align: 'center', baseline: 'middle', glow: 10,
        });
        ctx.restore();
      }
    },

    destroy() {
      think = null;
      searcher = null;
    },
  };
}
