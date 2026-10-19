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

// --- Clocks -----------------------------------------------------------------

export type TimeControlId = "none" | "bullet" | "blitz" | "rapid";

// --- Online multiplayer wire protocol -------------------------------------

// A move travels as the whole Move, so players on an older version of the site (which read all of it) keep working.
// The receiving side does not trust it: it uses only the squares and promotion piece and checks them against the rules
// (see opponentMove.ts), and the relay rebuilds the move from checked values before passing it on.
export type ClientMessage =
  | { type: "create"; token: string; color: Color; timeControl: TimeControlId }
  | { type: "join"; room: string; token: string }
  | { type: "rejoin"; room: string; token: string }
  | { type: "move"; move: Move }
  | { type: "restart" };

export type ServerMessage =
  | { type: "created"; room: string; color: Color }
  | { type: "joined"; room: string; color: Color; timeControl: TimeControlId }
  | { type: "opponent-joined" }
  | { type: "opponent-move"; move: Move }
  | { type: "opponent-restart" }
  | { type: "opponent-left" }
  | { type: "opponent-reconnected" }
  | { type: "error"; message: string };

export type ConnectionStatus = "idle" | "connecting" | "waiting" | "connected" | "disconnected";
