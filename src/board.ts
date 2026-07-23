import type { Board, CastlingRights, Piece, PieceType } from "./types";

// Index <-> algebraic helpers. index = rank * 8 + file (rank 0 = "1", file 0 = "a")
export function fileOf(index: number): number {
  return index % 8;
}

export function rankOf(index: number): number {
  return Math.floor(index / 8);
}

export function toAlgebraic(index: number): string {
  const file = String.fromCharCode("a".charCodeAt(0) + fileOf(index));
  const rank = rankOf(index) + 1;
  return `${file}${rank}`;
}

export function toIndex(file: number, rank: number): number {
  return rank * 8 + file;
}

export function isOnBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

const BACK_RANK: PieceType[] = ["r", "n", "b", "q", "k", "b", "n", "r"];

export function createInitialBoard(): Board {
  const board: Board = new Array(64).fill(null);

  for (let file = 0; file < 8; file++) {
    board[toIndex(file, 0)] = { type: BACK_RANK[file], color: "w" };
    board[toIndex(file, 1)] = { type: "p", color: "w" };
    board[toIndex(file, 6)] = { type: "p", color: "b" };
    board[toIndex(file, 7)] = { type: BACK_RANK[file], color: "b" };
  }

  return board;
}

export function createInitialCastlingRights(): CastlingRights {
  return { wK: true, wQ: true, bK: true, bQ: true };
}

export function cloneBoard(board: Board): Board {
  return board.map((sq) => (sq ? { ...sq } : null));
}

export function opponent(color: Piece["color"]): Piece["color"] {
  return color === "w" ? "b" : "w";
}
