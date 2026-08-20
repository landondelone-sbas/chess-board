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

// --- Online multiplayer wire protocol -------------------------------------

export type ClientMessage =
  | { type: "create"; token: string; color: Color }
  | { type: "join"; room: string; token: string }
  | { type: "rejoin"; room: string; token: string }
  | { type: "move"; move: Move }
  | { type: "restart" };

export type ServerMessage =
  | { type: "created"; room: string; color: Color }
  | { type: "joined"; room: string; color: Color }
  | { type: "opponent-joined" }
  | { type: "opponent-move"; move: Move }
  | { type: "opponent-restart" }
  | { type: "opponent-left" }
  | { type: "opponent-reconnected" }
  | { type: "error"; message: string };

export type ConnectionStatus = "idle" | "connecting" | "waiting" | "connected" | "disconnected";
