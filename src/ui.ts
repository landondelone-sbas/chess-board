import type { Color, GameState, Move, Piece, PieceType } from "./types";
import { fileOf, rankOf, toAlgebraic, opponent } from "./board";
import { createInitialState, getLegalMoves, makeMove } from "./engine";
import { findKing, generatePseudoLegalMoves, getAttackers } from "./moveGenerator";
import { chooseComputerMove } from "./ai";

const DIFFICULTY_LABELS = ["Easy", "Medium", "Hard"] as const;
const DIFFICULTY_DEPTHS = [1, 2, 3] as const;

const PIECE_GLYPHS: Record<Piece["color"], Record<PieceType, string>> = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};

const PROMOTION_LABELS: Record<PieceType, string> = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight", p: "Pawn", k: "King" };

const PIECE_RULES: Record<PieceType, string> = {
  p: "Pawns move straight ahead one square (two on their first move) and capture one square diagonally forward. They can't capture straight ahead, and near the far rank they can also capture en passant or promote.",
  n: "Knights move in an L-shape: two squares in one direction, then one square perpendicular. They're the only piece that can jump over others.",
  b: "Bishops slide diagonally any number of squares, staying on one color of square for the whole game.",
  r: "Rooks slide horizontally or vertically any number of squares.",
  q: "Queens combine the rook and bishop: they slide any number of squares in any straight or diagonal direction.",
  k: "Kings move one square in any direction. If it hasn't moved and neither has the rook, and nothing is in the way or under attack, it can also castle.",
};

export class ChessUI {
  private state: GameState = createInitialState();
  private selected: number | null = null;
  private legalMoves: Move[] = [];
  private teachingMode = true;
  private showCoords = true;
  private opponent: "human" | "computer" = "human";
  private humanColor: Color = "w";
  private difficulty = 1; // index into DIFFICULTY_LABELS/DIFFICULTY_DEPTHS
  private thinking = false;

  private root: HTMLElement;
  private boardEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private capturedWhiteEl!: HTMLElement;
  private capturedBlackEl!: HTMLElement;
  private historyEl!: HTMLElement;
  private coachEl!: HTMLElement;
  private teachingToggle!: HTMLButtonElement;
  private coordsToggle!: HTMLButtonElement;
  private opponentToggle!: HTMLButtonElement;
  private colorToggle!: HTMLButtonElement;
  private difficultyToggle!: HTMLButtonElement;
  private promotionModal!: HTMLElement;
  private promotionOptions!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.buildLayout();
    this.render();
  }

  private buildLayout() {
    this.root.innerHTML = `
      <div class="app-shell">
        <div class="lcd-badge" title="LocalChess">LCD</div>
        <header class="app-header">
          <h1>LocalChess</h1>
          <div class="status" id="status"></div>
          <div class="toolbar">
            <button class="toggle-btn" id="teaching-toggle" type="button"></button>
            <button class="toggle-btn" id="coords-toggle" type="button"></button>
            <button class="toggle-btn" id="opponent-toggle" type="button"></button>
            <button class="toggle-btn" id="color-toggle" type="button"></button>
            <button class="toggle-btn" id="difficulty-toggle" type="button"></button>
          </div>
        </header>
        <div class="game-area">
          <div class="graveyard" id="captured-black" aria-label="Pieces captured by White"></div>
          <div class="board" id="board"></div>
          <aside class="side-panel">
            <div class="graveyard" id="captured-white" aria-label="Pieces captured by Black"></div>
            <div class="coach" id="coach"></div>
            <h2>Move History</h2>
            <ol class="history" id="history"></ol>
            <button class="new-game-btn" id="new-game">New Game</button>
          </aside>
        </div>
      </div>
      <div class="modal-overlay hidden" id="promotion-modal">
        <div class="modal">
          <h3>Promote pawn to:</h3>
          <div class="promotion-options" id="promotion-options"></div>
        </div>
      </div>
    `;

    this.boardEl = this.root.querySelector("#board")!;
    this.statusEl = this.root.querySelector("#status")!;
    this.capturedWhiteEl = this.root.querySelector("#captured-white")!;
    this.capturedBlackEl = this.root.querySelector("#captured-black")!;
    this.historyEl = this.root.querySelector("#history")!;
    this.coachEl = this.root.querySelector("#coach")!;
    this.teachingToggle = this.root.querySelector("#teaching-toggle")!;
    this.coordsToggle = this.root.querySelector("#coords-toggle")!;
    this.opponentToggle = this.root.querySelector("#opponent-toggle")!;
    this.colorToggle = this.root.querySelector("#color-toggle")!;
    this.difficultyToggle = this.root.querySelector("#difficulty-toggle")!;
    this.promotionModal = this.root.querySelector("#promotion-modal")!;
    this.promotionOptions = this.root.querySelector("#promotion-options")!;

    this.root.querySelector("#new-game")!.addEventListener("click", () => {
      this.startNewGame();
    });

    this.teachingToggle.addEventListener("click", () => {
      this.teachingMode = !this.teachingMode;
      this.render();
    });

    this.coordsToggle.addEventListener("click", () => {
      this.showCoords = !this.showCoords;
      this.render();
    });

    this.opponentToggle.addEventListener("click", () => {
      this.opponent = this.opponent === "human" ? "computer" : "human";
      this.startNewGame();
    });

    this.colorToggle.addEventListener("click", () => {
      this.humanColor = this.humanColor === "w" ? "b" : "w";
      this.startNewGame();
    });

    this.difficultyToggle.addEventListener("click", () => {
      this.difficulty = (this.difficulty + 1) % DIFFICULTY_LABELS.length;
      this.render();
    });

    for (let i = 0; i < 64; i++) {
      const square = document.createElement("div");
      square.className = "square";
      square.dataset.index = String(i);
      square.setAttribute("role", "button");
      square.tabIndex = 0;
      square.addEventListener("click", () => this.onSquareClick(i));
      square.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.onSquareClick(i);
        }
      });

      if (rankOf(i) === 0) {
        const fileLabel = document.createElement("span");
        fileLabel.className = "coord-label file-label";
        fileLabel.textContent = toAlgebraic(i)[0];
        square.appendChild(fileLabel);
      }
      if (fileOf(i) === 0) {
        const rankLabel = document.createElement("span");
        rankLabel.className = "coord-label rank-label";
        rankLabel.textContent = toAlgebraic(i)[1];
        square.appendChild(rankLabel);
      }

      const pieceGlyph = document.createElement("span");
      pieceGlyph.className = "piece-glyph";
      square.appendChild(pieceGlyph);

      this.boardEl.appendChild(square);
    }
  }

  private startNewGame() {
    this.state = createInitialState();
    this.selected = null;
    this.legalMoves = [];
    this.thinking = false;
    this.render();
    this.maybeTriggerAiMove();
  }

  private onSquareClick(index: number) {
    if (this.state.status === "checkmate" || this.state.status === "stalemate") return;
    if (this.thinking) return;
    if (this.opponent === "computer" && this.state.turn !== this.humanColor) return;

    const targetMove = this.legalMoves.find((m) => m.to === index);
    if (this.selected !== null && targetMove) {
      const sameDestination = this.legalMoves.filter((m) => m.to === index);
      if (sameDestination.length > 1) {
        this.promptPromotion(sameDestination);
      } else {
        this.commitMove(sameDestination[0]);
      }
      return;
    }

    const piece = this.state.board[index];
    if (piece && piece.color === this.state.turn) {
      this.selected = index;
      this.legalMoves = getLegalMoves(this.state, index);
    } else {
      this.selected = null;
      this.legalMoves = [];
    }
    this.render();
  }

  private promptPromotion(choices: Move[]) {
    this.promotionOptions.innerHTML = "";
    for (const move of choices) {
      const btn = document.createElement("button");
      btn.className = "promotion-choice";
      btn.textContent = `${PIECE_GLYPHS[move.piece.color][move.promotion!]} ${PROMOTION_LABELS[move.promotion!]}`;
      btn.addEventListener("click", () => {
        this.promotionModal.classList.add("hidden");
        this.commitMove(move);
      });
      this.promotionOptions.appendChild(btn);
    }
    this.promotionModal.classList.remove("hidden");
  }

  private commitMove(move: Move) {
    this.state = makeMove(this.state, move);
    this.selected = null;
    this.legalMoves = [];
    this.render();
    this.maybeTriggerAiMove();
  }

  private maybeTriggerAiMove() {
    if (this.opponent !== "computer") return;
    if (this.state.status === "checkmate" || this.state.status === "stalemate") return;
    if (this.state.turn === this.humanColor) return;

    this.thinking = true;
    this.render();

    setTimeout(() => {
      const move = chooseComputerMove(this.state, DIFFICULTY_DEPTHS[this.difficulty]);
      if (move) this.state = makeMove(this.state, move);
      this.thinking = false;
      this.selected = null;
      this.legalMoves = [];
      this.render();
    }, 50);
  }

  private render() {
    const { board, turn, status, moveHistory, capturedPieces } = this.state;

    this.boardEl.classList.toggle("show-coords", this.showCoords);
    this.teachingToggle.textContent = `Teaching Mode: ${this.teachingMode ? "On" : "Off"}`;
    this.teachingToggle.classList.toggle("active", this.teachingMode);
    this.coordsToggle.textContent = `Coordinates: ${this.showCoords ? "On" : "Off"}`;
    this.coordsToggle.classList.toggle("active", this.showCoords);

    this.opponentToggle.textContent = `Opponent: ${this.opponent === "human" ? "Human" : "Computer"}`;
    this.opponentToggle.classList.toggle("active", this.opponent === "computer");
    this.colorToggle.textContent = `You play: ${this.humanColor === "w" ? "White" : "Black"}`;
    this.colorToggle.classList.toggle("hidden", this.opponent !== "computer");
    this.difficultyToggle.textContent = `Difficulty: ${DIFFICULTY_LABELS[this.difficulty]}`;
    this.difficultyToggle.classList.toggle("hidden", this.opponent !== "computer");

    for (let i = 0; i < 64; i++) {
      const square = this.boardEl.children[i] as HTMLElement;
      const isLight = (fileOf(i) + rankOf(i)) % 2 === 1;
      const piece = board[i];

      square.className = "square " + (isLight ? "light" : "dark");
      const glyphEl = square.querySelector(".piece-glyph")!;
      glyphEl.textContent = piece ? PIECE_GLYPHS[piece.color][piece.type] : "";
      if (piece) square.classList.add(piece.color === "w" ? "piece-white" : "piece-black");
      square.setAttribute(
        "aria-label",
        piece ? `${toAlgebraic(i)}, ${piece.color === "w" ? "White" : "Black"} ${PROMOTION_LABELS[piece.type]}` : toAlgebraic(i)
      );

      if (this.selected === i) square.classList.add("selected");

      const move = this.legalMoves.find((m) => m.to === i);
      if (move) square.classList.add(move.capturedPiece || move.isEnPassant ? "legal-capture" : "legal-move");
    }

    if (status === "check" || status === "checkmate") {
      const kingIndex = findKing(board, turn);
      const kingSquare = this.boardEl.children[kingIndex] as HTMLElement;
      kingSquare?.classList.add("in-check");
    }

    const colorName = (c: "w" | "b") => (c === "w" ? "White" : "Black");
    if (this.thinking) {
      this.statusEl.textContent = "Computer is thinking…";
      this.statusEl.className = "status status-thinking";
    } else if (status === "checkmate") {
      this.statusEl.textContent = `Checkmate — ${colorName(turn === "w" ? "b" : "w")} wins!`;
      this.statusEl.className = "status status-end";
    } else if (status === "stalemate") {
      this.statusEl.textContent = "Stalemate — draw.";
      this.statusEl.className = "status status-end";
    } else if (status === "check") {
      this.statusEl.textContent = `${colorName(turn)} is in check`;
      this.statusEl.className = "status status-check";
    } else {
      this.statusEl.textContent = `${colorName(turn)} to move`;
      this.statusEl.className = "status";
    }

    this.capturedWhiteEl.innerHTML = capturedPieces
      .filter((p) => p.color === "w")
      .map((p) => `<span class="captured-piece">${PIECE_GLYPHS.w[p.type]}</span>`)
      .join("");
    this.capturedBlackEl.innerHTML = capturedPieces
      .filter((p) => p.color === "b")
      .map((p) => `<span class="captured-piece">${PIECE_GLYPHS.b[p.type]}</span>`)
      .join("");

    this.historyEl.innerHTML = "";
    for (let i = 0; i < moveHistory.length; i += 2) {
      const li = document.createElement("li");
      const white = moveHistory[i]?.notation ?? "";
      const black = moveHistory[i + 1]?.notation ?? "";
      li.innerHTML = `<span class="move-white">${white}</span><span class="move-black">${black}</span>`;
      this.historyEl.appendChild(li);
    }
    this.historyEl.scrollTop = this.historyEl.scrollHeight;

    this.renderCoach();
  }

  private renderCoach() {
    this.coachEl.classList.toggle("hidden", !this.teachingMode);
    if (!this.teachingMode) return;

    const { board, turn, status } = this.state;

    if (this.selected !== null) {
      const piece = board[this.selected]!;
      const pseudoCount = generatePseudoLegalMoves(this.state, this.selected).length;
      const legalCount = this.legalMoves.length;
      const colorName = piece.color === "w" ? "White" : "Black";
      let text = `<strong>${colorName} ${PROMOTION_LABELS[piece.type]}</strong> (${toAlgebraic(this.selected)}) — ${PIECE_RULES[piece.type]}`;
      if (legalCount === 0 && pseudoCount > 0) {
        text += ` <em>It has no legal moves right now — moving it would leave your king in check.</em>`;
      } else {
        text += ` <em>It has ${legalCount} legal move${legalCount === 1 ? "" : "s"} right now, highlighted on the board.</em>`;
      }
      this.coachEl.innerHTML = text;
      return;
    }

    if (status === "check" || status === "checkmate") {
      const kingIndex = findKing(board, turn);
      const attackers = getAttackers(board, kingIndex, opponent(turn));
      const attackerText = attackers
        .map((a) => `the ${board[a]!.color === "w" ? "White" : "Black"} ${PROMOTION_LABELS[board[a]!.type]} on ${toAlgebraic(a)}`)
        .join(" and ");
      this.coachEl.innerHTML = `<strong>${turn === "w" ? "White" : "Black"} is in check</strong> from ${attackerText}. You must block the attack, capture the attacker, or move your king to safety.`;
      return;
    }

    this.coachEl.innerHTML = `Click any piece to see how it moves — its legal squares will light up on the board.`;
  }
}
