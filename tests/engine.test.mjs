// Engine checks: move generation against published "perft" counts, plus game-end detection.
//
// Perft counts every legal move sequence of a given length from a known position. Any rules bug (castling,
// en passant, promotion, pins, checks) changes the count, so matching the published numbers is strong proof.
// Reference values: https://www.chessprogramming.org/Perft_Results
//
// Needs Node 22.18 or newer (it runs the TypeScript source directly). Run PERFT_DEEP=1 npm test for the
// slower, deeper searches (about two minutes).
import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, getAllLegalMoves, makeMove } from "../src/engine.ts";
import { idx, stateFromFen } from "./fen.mjs";

function play(state, from, to) {
  const move = getAllLegalMoves(state, state.turn).find((m) => m.from === idx(from) && m.to === idx(to));
  assert.ok(move, `expected ${from}${to} to be legal`);
  return makeMove(state, move);
}

function perft(state, depth) {
  const moves = getAllLegalMoves(state, state.turn);
  if (depth === 1) return moves.length;
  let total = 0;
  for (const move of moves) total += perft(makeMove(state, move), depth - 1);
  return total;
}

// counts[i] is the published number of move sequences of length i + 1; deep adds the slower depths.
const POSITIONS = [
  { name: "start position", fen: null, counts: [20, 400, 8902, 197281], deep: [4865609] },
  { name: "Kiwipete (castling, pins, en passant)", fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -", counts: [48, 2039, 97862], deep: [4085603] },
  { name: "position 3 (en passant, discovered check)", fen: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -", counts: [14, 191, 2812, 43238], deep: [674624] },
  { name: "position 4 (promotions, castling into check)", fen: "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", counts: [6, 264, 9467, 422333], deep: [] },
  { name: "position 5 (promotion with capture)", fen: "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", counts: [44, 1486, 62379], deep: [2103487] },
  { name: "position 6 (quiet middlegame)", fen: "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", counts: [46, 2079, 89890], deep: [3894594] },
];

for (const position of POSITIONS) {
  test(`move generation matches published perft counts: ${position.name}`, { timeout: 300000 }, () => {
    const start = position.fen ? stateFromFen(position.fen) : createInitialState();
    const expected = process.env.PERFT_DEEP ? [...position.counts, ...position.deep] : position.counts;
    expected.forEach((want, i) => assert.equal(perft(start, i + 1), want, `depth ${i + 1}`));
  });
}

test("fool's mate ends in checkmate", () => {
  let state = createInitialState();
  for (const [from, to] of [["f2", "f3"], ["e7", "e5"], ["g2", "g4"], ["d8", "h4"]]) state = play(state, from, to);
  assert.equal(state.status, "checkmate");
  assert.equal(state.moveHistory.at(-1).notation, "Qh4#");
});

test("king and queen against a cornered king can end in stalemate", () => {
  const state = play(stateFromFen("7k/5K2/8/7Q/8/8/8/8 w - -"), "h5", "g6");
  assert.equal(state.status, "stalemate");
});

test("a rook on the open file gives check", () => {
  const state = play(stateFromFen("4k3/8/8/8/8/8/4R3/4K3 w - -"), "e2", "e7");
  assert.equal(state.status, "check");
});

// Known gap, tracked here so it shows up in every test run without failing it. When draw rules exist,
// change the expected status to whatever the engine reports and remove the todo.
test("bare kings are a draw", { todo: "the engine has no draw rules yet (insufficient material, repetition, 50 moves)" }, () => {
  const state = play(stateFromFen("4k3/8/8/8/8/8/8/4K3 w - -"), "e1", "e2");
  assert.equal(state.status, "draw");
});
