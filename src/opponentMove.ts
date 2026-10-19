import type { Color, GameState, Move } from "./types";
import { getLegalMoves } from "./engine";

/**
 * The engine's own move that matches what the opponent sent, or null when it is not a legal move for them right now.
 * Only the squares (and promotion piece) are used from what arrived; the piece, capture, castling and notation all
 * come from the engine, so a tampered or buggy message cannot change anything it should not.
 */
export function resolveOpponentMove(state: GameState, opponentColor: Color, received: unknown): Move | null {
  if (state.turn !== opponentColor) return null; // it is not their turn
  if (received === null || typeof received !== "object") return null;
  const { from, to, promotion } = received as { from?: unknown; to?: unknown; promotion?: unknown };
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  return getLegalMoves(state, from as number).find((move) => move.to === to && move.promotion === promotion) ?? null;
}
