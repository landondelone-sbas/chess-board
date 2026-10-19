// What happens to a move that arrives from the opponent: it is played only if it is a legal move for them right now,
// and only the squares (and promotion piece) of what arrived are used. The relay cannot judge moves, so this is the check.
import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, getLegalMoves, makeMove } from "../src/engine.ts";
import { resolveOpponentMove } from "../src/opponentMove.ts";
import { idx, stateFromFen } from "./fen.mjs";

const wire = (from, to, promotion) => ({ from: idx(from), to: idx(to), ...(promotion ? { promotion } : {}) });
const engineMove = (state, from, to, promotion) => getLegalMoves(state, idx(from)).find((m) => m.to === idx(to) && m.promotion === promotion);

test("a legal move from the opponent resolves to the engine's own move", () => {
  const state = createInitialState();
  const resolved = resolveOpponentMove(state, "w", wire("e2", "e4"));
  assert.deepEqual(resolved, engineMove(state, "e2", "e4"));
  assert.equal(makeMove(state, resolved).turn, "b");
});

test("a move arriving when it is not the opponent's turn is rejected, even if it would be legal for the other side", () => {
  const state = createInitialState(); // white to move
  assert.equal(resolveOpponentMove(state, "b", wire("e2", "e4")), null, "black may not play white's legal move on white's turn");
  assert.equal(resolveOpponentMove(state, "b", wire("e7", "e5")), null, "nor its own move out of turn");
});

test("moving a piece of the wrong colour is rejected", () => {
  const state = createInitialState();
  assert.equal(resolveOpponentMove(state, "w", wire("e7", "e5")), null);
});

test("moves that break the rules are rejected", () => {
  const state = createInitialState();
  assert.equal(resolveOpponentMove(state, "w", wire("e2", "e5")), null, "a pawn cannot move three squares");
  assert.equal(resolveOpponentMove(state, "w", wire("e1", "e2")), null, "onto your own piece");
  assert.equal(resolveOpponentMove(state, "w", wire("e4", "e5")), null, "from an empty square");
  const pinned = stateFromFen("4k3/4r3/8/8/8/8/4B3/4K3 w - -"); // the bishop shields its king from the rook
  assert.equal(resolveOpponentMove(pinned, "w", wire("e2", "d3")), null, "a move that leaves the king in check");
});

test("a promotion must name a piece a pawn can become", () => {
  const state = stateFromFen("4k3/P7/8/8/8/8/8/4K3 w - -");
  assert.equal(resolveOpponentMove(state, "w", wire("a7", "a8")), null, "no piece chosen");
  for (const promotion of ["k", "p", "x", "queen", null, 5]) {
    assert.equal(resolveOpponentMove(state, "w", { ...wire("a7", "a8"), promotion }), null, `promotion ${JSON.stringify(promotion)}`);
  }
  for (const promotion of ["q", "r", "b", "n"]) {
    const resolved = resolveOpponentMove(state, "w", wire("a7", "a8", promotion));
    assert.equal(resolved?.promotion, promotion);
    assert.equal(resolved?.piece.type, "p");
  }
});

test("a promotion piece on a move that is not a promotion is rejected", () => {
  assert.equal(resolveOpponentMove(createInitialState(), "w", wire("e2", "e4", "q")), null);
});

test("anything that is not two whole-number squares is rejected without an error", () => {
  const state = createInitialState();
  const junk = [undefined, null, 5, "e2e4", [], [12, 28], {}, { from: 12 }, { to: 28 }, { from: "12", to: 28 }, { from: 12, to: "28" }, { from: 12.5, to: 28 }, { from: NaN, to: 28 }, { from: -1, to: 5 }, { from: 64, to: 5 }, { from: 12, to: 99 }];
  for (const received of junk) assert.equal(resolveOpponentMove(state, "w", received), null, JSON.stringify(received));
});

test("extra fields on a received move cannot change the move that is played", () => {
  const state = createInitialState();
  const tampered = { ...wire("e2", "e4"), piece: { type: "q", color: "w" }, capturedPiece: { type: "k", color: "b" }, isCastle: "K", isEnPassant: true, notation: "<img src=x onerror=alert(1)>" };
  const resolved = resolveOpponentMove(state, "w", tampered);
  assert.deepEqual(resolved, engineMove(state, "e2", "e4"), "the engine's move, untouched by what arrived with it");
  assert.equal(resolved.piece.type, "p");
  assert.equal(makeMove(state, resolved).moveHistory.at(-1).notation, "e4", "the written-down move is the engine's, not the sender's text");
});
