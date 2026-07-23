export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
export type Color = "w" | "b";

export interface Piece {
  type: PieceType;
  color: Color;
}

export type Square = Piece | null;
export type Board = Square[]; // length 64, index = rank * 8 + file (rank 0 = rank 1, file 0 = a-file)

export interface CastlingRights {
  wK: boolean; // white kingside
  wQ: boolean; // white queenside
  bK: boolean; // black kingside
  bQ: boolean; // black queenside
}

export type CastleSide = "K" | "Q";

export interface Move {
  from: number;
  to: number;
  piece: Piece;
  capturedPiece: Piece | null;
  promotion?: PieceType;
  isEnPassant?: boolean;
  isCastle?: CastleSide;
  notation: string;
}

export type GameStatus = "playing" | "check" | "checkmate" | "stalemate";

export interface GameState {
  board: Board;
  turn: Color;
  castlingRights: CastlingRights;
  enPassantTarget: number | null;
  moveHistory: Move[];
  capturedPieces: Piece[];
  status: GameStatus;
}
