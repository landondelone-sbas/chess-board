import type { Board, Color, GameState, Move, PieceType } from "./types";
import {
  cloneBoard,
  createInitialBoard,
  createInitialCastlingRights,
  opponent,
  rankOf,
  fileOf,
  toIndex,
  toAlgebraic,
} from "./board";
import { generatePseudoLegalMoves, isSquareAttacked, findKing } from "./moveGenerator";

export function createInitialState(): GameState {
  return {
    board: createInitialBoard(),
    turn: "w",
    castlingRights: createInitialCastlingRights(),
    enPassantTarget: null,
    moveHistory: [],
    capturedPieces: [],
    status: "playing",
  };
}

function applyMoveToBoard(board: Board, move: Move): Board {
  const next = cloneBoard(board);
  const piece = next[move.from]!;
  next[move.from] = null;

  if (move.isEnPassant) {
    const capturedRank = rankOf(move.from);
    const capturedFile = fileOf(move.to);
    next[toIndex(capturedFile, capturedRank)] = null;
  }

  next[move.to] = move.promotion ? { type: move.promotion, color: piece.color } : piece;

  if (move.isCastle) {
    const homeRank = rankOf(move.from);
    if (move.isCastle === "K") {
      next[toIndex(5, homeRank)] = next[toIndex(7, homeRank)];
      next[toIndex(7, homeRank)] = null;
    } else {
      next[toIndex(3, homeRank)] = next[toIndex(0, homeRank)];
      next[toIndex(0, homeRank)] = null;
    }
  }

  return next;
}

/** Pseudo-legal moves filtered to those that don't leave the mover's own king in check. */
export function getLegalMoves(state: GameState, from: number): Move[] {
  const piece = state.board[from];
  if (!piece || piece.color !== state.turn) return [];
  const pseudo = generatePseudoLegalMoves(state, from);
  return pseudo.filter((move) => {
    const boardAfter = applyMoveToBoard(state.board, move);
    const kingIndex = findKing(boardAfter, piece.color);
    return !isSquareAttacked(boardAfter, kingIndex, opponent(piece.color));
  });
}

export function getAllLegalMoves(state: GameState, color: Color): Move[] {
  const moves: Move[] = [];
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i];
    if (piece && piece.color === color) moves.push(...getLegalMoves(state, i));
  }
  return moves;
}

const PIECE_LETTERS: Record<PieceType, string> = { p: "", n: "N", b: "B", r: "R", q: "Q", k: "K" };

function buildNotation(move: Move, isCheck: boolean, isCheckmate: boolean): string {
  if (move.isCastle === "K") return isCheckmate ? "O-O#" : isCheck ? "O-O+" : "O-O";
  if (move.isCastle === "Q") return isCheckmate ? "O-O-O#" : isCheck ? "O-O-O+" : "O-O-O";

  let notation = PIECE_LETTERS[move.piece.type];
  const isCapture = !!move.capturedPiece;
  if (move.piece.type === "p" && isCapture) {
    notation += String.fromCharCode("a".charCodeAt(0) + fileOf(move.from));
  }
  if (isCapture) notation += "x";
  notation += toAlgebraic(move.to);
  if (move.promotion) notation += `=${PIECE_LETTERS[move.promotion]}`;
  if (isCheckmate) notation += "#";
  else if (isCheck) notation += "+";
  return notation;
}

export function makeMove(state: GameState, move: Move): GameState {
  const board = applyMoveToBoard(state.board, move);
  const piece = move.piece;

  const castlingRights = { ...state.castlingRights };
  if (piece.type === "k") {
    if (piece.color === "w") {
      castlingRights.wK = false;
      castlingRights.wQ = false;
    } else {
      castlingRights.bK = false;
      castlingRights.bQ = false;
    }
  }
  if (move.from === toIndex(0, 0) || move.to === toIndex(0, 0)) castlingRights.wQ = false;
  if (move.from === toIndex(7, 0) || move.to === toIndex(7, 0)) castlingRights.wK = false;
  if (move.from === toIndex(0, 7) || move.to === toIndex(0, 7)) castlingRights.bQ = false;
  if (move.from === toIndex(7, 7) || move.to === toIndex(7, 7)) castlingRights.bK = false;

  let enPassantTarget: number | null = null;
  if (piece.type === "p" && Math.abs(rankOf(move.to) - rankOf(move.from)) === 2) {
    enPassantTarget = toIndex(fileOf(move.from), (rankOf(move.from) + rankOf(move.to)) / 2);
  }

  const capturedPieces = move.capturedPiece ? [...state.capturedPieces, move.capturedPiece] : state.capturedPieces;
  const nextTurn = opponent(state.turn);

  const nextStateForCheck: GameState = {
    board,
    turn: nextTurn,
    castlingRights,
    enPassantTarget,
    moveHistory: [],
    capturedPieces,
    status: "playing",
  };
  const inCheck = isSquareAttacked(board, findKing(board, nextTurn), state.turn);
  const opponentLegalMoves = getAllLegalMoves(nextStateForCheck, nextTurn);

  let status: GameState["status"] = "playing";
  if (opponentLegalMoves.length === 0) {
    status = inCheck ? "checkmate" : "stalemate";
  } else if (inCheck) {
    status = "check";
  }

  const notation = buildNotation(move, inCheck, status === "checkmate");
  const moveHistory = [...state.moveHistory, { ...move, notation }];

  return { board, turn: nextTurn, castlingRights, enPassantTarget, moveHistory, capturedPieces, status };
}
