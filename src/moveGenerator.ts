import type { Board, Color, GameState, Move, PieceType } from "./types";
import { fileOf, rankOf, toIndex, isOnBoard, opponent } from "./board";

const KNIGHT_OFFSETS = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_OFFSETS = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Raw squares a piece attacks, ignoring en passant/castling (those aren't
 * "attacks" in the check-detection sense). Used for isSquareAttacked.
 */
function pieceAttackSquares(board: Board, index: number): number[] {
  const piece = board[index];
  if (!piece) return [];
  const file = fileOf(index);
  const rank = rankOf(index);
  const attacks: number[] = [];

  switch (piece.type) {
    case "n":
      for (const [df, dr] of KNIGHT_OFFSETS) {
        const f = file + df, r = rank + dr;
        if (isOnBoard(f, r)) attacks.push(toIndex(f, r));
      }
      break;
    case "k":
      for (const [df, dr] of KING_OFFSETS) {
        const f = file + df, r = rank + dr;
        if (isOnBoard(f, r)) attacks.push(toIndex(f, r));
      }
      break;
    case "b":
    case "r":
    case "q": {
      const dirs =
        piece.type === "b" ? BISHOP_DIRS : piece.type === "r" ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
      for (const [df, dr] of dirs) {
        let f = file + df, r = rank + dr;
        while (isOnBoard(f, r)) {
          const idx = toIndex(f, r);
          attacks.push(idx);
          if (board[idx]) break;
          f += df;
          r += dr;
        }
      }
      break;
    }
    case "p": {
      const dir = piece.color === "w" ? 1 : -1;
      for (const df of [-1, 1]) {
        const f = file + df, r = rank + dir;
        if (isOnBoard(f, r)) attacks.push(toIndex(f, r));
      }
      break;
    }
  }
  return attacks;
}

export function isSquareAttacked(board: Board, square: number, byColor: Color): boolean {
  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (piece && piece.color === byColor && pieceAttackSquares(board, i).includes(square)) {
      return true;
    }
  }
  return false;
}

/** Squares of every piece of `byColor` currently attacking `square` — used for teaching-mode explanations. */
export function getAttackers(board: Board, square: number, byColor: Color): number[] {
  const attackers: number[] = [];
  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (piece && piece.color === byColor && pieceAttackSquares(board, i).includes(square)) {
      attackers.push(i);
    }
  }
  return attackers;
}

export function findKing(board: Board, color: Color): number {
  return board.findIndex((sq) => sq && sq.type === "k" && sq.color === color);
}

const PROMOTION_CHOICES: PieceType[] = ["q", "r", "b", "n"];

/** Physically-possible moves for the piece at `from` — no king-safety filtering. */
export function generatePseudoLegalMoves(state: GameState, from: number): Move[] {
  const { board } = state;
  const piece = board[from];
  if (!piece) return [];
  const file = fileOf(from);
  const rank = rankOf(from);
  const moves: Move[] = [];

  const addMove = (to: number, opts: Partial<Move> = {}) => {
    moves.push({
      from,
      to,
      piece,
      capturedPiece: board[to],
      notation: "",
      ...opts,
    });
  };

  switch (piece.type) {
    case "n":
      for (const [df, dr] of KNIGHT_OFFSETS) {
        const f = file + df, r = rank + dr;
        if (!isOnBoard(f, r)) continue;
        const to = toIndex(f, r);
        const target = board[to];
        if (!target || target.color !== piece.color) addMove(to);
      }
      break;

    case "b":
    case "r":
    case "q": {
      const dirs =
        piece.type === "b" ? BISHOP_DIRS : piece.type === "r" ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
      for (const [df, dr] of dirs) {
        let f = file + df, r = rank + dr;
        while (isOnBoard(f, r)) {
          const to = toIndex(f, r);
          const target = board[to];
          if (!target) {
            addMove(to);
          } else {
            if (target.color !== piece.color) addMove(to);
            break;
          }
          f += df;
          r += dr;
        }
      }
      break;
    }

    case "k": {
      for (const [df, dr] of KING_OFFSETS) {
        const f = file + df, r = rank + dr;
        if (!isOnBoard(f, r)) continue;
        const to = toIndex(f, r);
        const target = board[to];
        if (!target || target.color !== piece.color) addMove(to);
      }

      const rights = state.castlingRights;
      const homeRank = piece.color === "w" ? 0 : 7;
      if (rank === homeRank && file === 4) {
        const canCastle = (side: "K" | "Q"): boolean => {
          const kingSide = side === "K";
          if (piece.color === "w" && kingSide && !rights.wK) return false;
          if (piece.color === "w" && !kingSide && !rights.wQ) return false;
          if (piece.color === "b" && kingSide && !rights.bK) return false;
          if (piece.color === "b" && !kingSide && !rights.bQ) return false;

          const emptyFiles = kingSide ? [5, 6] : [1, 2, 3];
          for (const f of emptyFiles) {
            if (board[toIndex(f, homeRank)]) return false;
          }
          const rookFile = kingSide ? 7 : 0;
          const rook = board[toIndex(rookFile, homeRank)];
          if (!rook || rook.type !== "r" || rook.color !== piece.color) return false;

          const opp = opponent(piece.color);
          const kingPathFiles = kingSide ? [4, 5, 6] : [4, 3, 2];
          for (const f of kingPathFiles) {
            if (isSquareAttacked(board, toIndex(f, homeRank), opp)) return false;
          }
          return true;
        };
        if (canCastle("K")) addMove(toIndex(6, homeRank), { isCastle: "K" });
        if (canCastle("Q")) addMove(toIndex(2, homeRank), { isCastle: "Q" });
      }
      break;
    }

    case "p": {
      const dir = piece.color === "w" ? 1 : -1;
      const startRank = piece.color === "w" ? 1 : 6;
      const promoRank = piece.color === "w" ? 7 : 0;

      const oneF = file, oneR = rank + dir;
      if (isOnBoard(oneF, oneR)) {
        const oneTo = toIndex(oneF, oneR);
        if (!board[oneTo]) {
          if (rankOf(oneTo) === promoRank) {
            for (const promotion of PROMOTION_CHOICES) addMove(oneTo, { promotion });
          } else {
            addMove(oneTo);
          }
          if (rank === startRank) {
            const twoTo = toIndex(file, rank + dir * 2);
            if (!board[twoTo]) addMove(twoTo);
          }
        }
      }

      for (const df of [-1, 1]) {
        const f = file + df, r = rank + dir;
        if (!isOnBoard(f, r)) continue;
        const to = toIndex(f, r);
        const target = board[to];
        if (target && target.color !== piece.color) {
          if (rankOf(to) === promoRank) {
            for (const promotion of PROMOTION_CHOICES) addMove(to, { promotion });
          } else {
            addMove(to);
          }
        } else if (!target && state.enPassantTarget === to) {
          addMove(to, { isEnPassant: true, capturedPiece: board[toIndex(f, rank)] });
        }
      }
      break;
    }
  }

  return moves;
}
