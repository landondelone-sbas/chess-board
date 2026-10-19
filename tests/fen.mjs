// Builds a game state from a FEN string, so tests can set up a position directly.
// The engine has no FEN loader of its own; this reads the four fields it needs: pieces, side to move, castling, en passant.

export const idx = (square) => (Number(square[1]) - 1) * 8 + (square.charCodeAt(0) - 97); // "e2" -> 12

export function stateFromFen(fen) {
  const [placement, turn, castling, enPassant] = fen.split(" ");
  const board = new Array(64).fill(null);
  placement.split("/").forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }
      board[(7 - i) * 8 + file] = { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? "w" : "b" };
      file++;
    }
  });
  return {
    board,
    turn,
    castlingRights: { wK: castling.includes("K"), wQ: castling.includes("Q"), bK: castling.includes("k"), bQ: castling.includes("q") },
    enPassantTarget: enPassant && enPassant !== "-" ? idx(enPassant) : null,
    moveHistory: [],
    capturedPieces: [],
    status: "playing",
  };
}
