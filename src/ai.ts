import type { Color, GameState, Move, PieceType } from "./types";
import { getAllLegalMoves, makeMove } from "./engine";
import { fileOf, rankOf } from "./board";

const PIECE_VALUES: Record<PieceType, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// Simplified piece-square tables (chessprogramming.org "simplified evaluation"),
// written a8..h1 (index 0 = rank 8) — reward central control and, for the king, back-rank safety.
const PAWN_TABLE = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];

const KNIGHT_TABLE = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];

const BISHOP_TABLE = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];

const KING_TABLE = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
];

const PIECE_TABLES: Partial<Record<PieceType, number[]>> = { p: PAWN_TABLE, n: KNIGHT_TABLE, b: BISHOP_TABLE, k: KING_TABLE };

function squareBonus(type: PieceType, color: Color, index: number): number {
  const table = PIECE_TABLES[type];
  if (!table) return 0;
  const file = fileOf(index);
  const rank = rankOf(index);
  const tableIndex = color === "w" ? (7 - rank) * 8 + file : rank * 8 + file;
  return table[tableIndex];
}

function evaluate(state: GameState): number {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
    if (!piece) continue;
    const value = PIECE_VALUES[piece.type] + squareBonus(piece.type, piece.color, i);
    score += piece.color === "w" ? value : -value;
  }
  return score;
}

// Try captures first (biggest captured piece, smallest attacker) — improves alpha-beta cutoffs.
function orderMoves(moves: Move[]): Move[] {
  return [...moves].sort((a, b) => {
    const scoreOf = (m: Move) => (m.capturedPiece ? PIECE_VALUES[m.capturedPiece.type] * 10 - PIECE_VALUES[m.piece.type] : 0);
    return scoreOf(b) - scoreOf(a);
  });
}

const MATE_SCORE = 1_000_000;

function negamax(state: GameState, depth: number, alpha: number, beta: number, ply: number): number {
  if (state.status === "checkmate") return -MATE_SCORE + ply;
  if (state.status === "stalemate") return 0;
  if (depth === 0) {
    const raw = evaluate(state);
    return state.turn === "w" ? raw : -raw;
  }

  const moves = orderMoves(getAllLegalMoves(state, state.turn));
  let best = -Infinity;
  for (const move of moves) {
    const child = makeMove(state, move);
    const score = -negamax(child, depth - 1, -beta, -alpha, ply + 1);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/** Picks a move for the side to move via minimax + alpha-beta search. Ties broken randomly. */
export function chooseComputerMove(state: GameState, depth: number): Move | null {
  const moves = orderMoves(getAllLegalMoves(state, state.turn));
  if (moves.length === 0) return null;

  let bestMoves: Move[] = [];
  let bestScore = -Infinity;
  let alpha = -Infinity;
  const beta = Infinity;

  for (const move of moves) {
    const child = makeMove(state, move);
    const score = -negamax(child, depth - 1, -beta, -alpha, 1);
    if (score > bestScore) {
      bestScore = score;
      bestMoves = [move];
      alpha = Math.max(alpha, score);
    } else if (score === bestScore) {
      bestMoves.push(move);
    }
  }

  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}
