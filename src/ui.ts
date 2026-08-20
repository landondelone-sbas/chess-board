import type { Color, ConnectionStatus, GameState, Move, Piece, PieceType } from "./types";
import { fileOf, rankOf, toAlgebraic, opponent } from "./board";
import { createInitialState, getLegalMoves, makeMove } from "./engine";
import { findKing, generatePseudoLegalMoves, getAttackers } from "./moveGenerator";
import { chooseComputerMove } from "./ai";
import { RoomConnection } from "./net";

const DIFFICULTY_LABELS = ["Easy", "Medium", "Hard"] as const;
const DIFFICULTY_DEPTHS = [1, 2, 3] as const;
const OPPONENT_MODES = ["human", "computer", "online"] as const;
type OpponentMode = (typeof OPPONENT_MODES)[number];
const WS_URL = import.meta.env.VITE_WS_URL;
const ONLINE_STATE_KEY = "chess-net-state";

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
  private opponent: OpponentMode = "human";
  private humanColor: Color = "w";
  private difficulty = 1; // index into DIFFICULTY_LABELS/DIFFICULTY_DEPTHS
  private thinking = false;

  private net: RoomConnection | null = null;
  private onlineColor: Color | null = null;
  private onlinePreferredColor: Color = "w";
  private connectionStatus: ConnectionStatus = "idle";
  private onlineStep: "choice" | "connecting" | "creating" | "waiting" | "joining" = "choice";
  private onlineError: string | null = null;

  private root: HTMLElement;
  private boardEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private onlineBanner!: HTMLElement;
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
  private onlineModal!: HTMLElement;
  private onlineModalBody!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.buildLayout();
    if (RoomConnection.hasStoredSession()) {
      this.opponent = "online";
      this.enterOnlineMode();
    }
    this.render();
  }

  private buildLayout() {
    this.root.innerHTML = `
      <div class="app-shell">
        <div class="lcd-badge" title="LocalChess">LCD</div>
        <header class="app-header">
          <h1>LocalChess</h1>
          <div class="status" id="status"></div>
          <div class="online-banner hidden" id="online-banner"></div>
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
      <div class="modal-overlay hidden" id="online-modal">
        <div class="modal online-modal">
          <h3>Play Online</h3>
          <div class="online-modal-body" id="online-modal-body"></div>
          <button class="modal-close-btn" id="online-modal-close" type="button">Cancel</button>
        </div>
      </div>
    `;

    this.boardEl = this.root.querySelector("#board")!;
    this.statusEl = this.root.querySelector("#status")!;
    this.onlineBanner = this.root.querySelector("#online-banner")!;
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
    this.onlineModal = this.root.querySelector("#online-modal")!;
    this.onlineModalBody = this.root.querySelector("#online-modal-body")!;

    this.root.querySelector("#online-modal-close")!.addEventListener("click", () => {
      this.setOpponentMode("human");
    });

    this.root.querySelector("#new-game")!.addEventListener("click", () => {
      if (this.opponent === "online") {
        if (this.connectionStatus !== "connected") return;
        this.net?.sendRestart();
      }
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
      const next = OPPONENT_MODES[(OPPONENT_MODES.indexOf(this.opponent) + 1) % OPPONENT_MODES.length];
      this.setOpponentMode(next);
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
    if (this.opponent === "online") this.persistOnlineState();
    this.render();
    this.maybeTriggerAiMove();
  }

  private setOpponentMode(mode: OpponentMode) {
    if (this.opponent === "online" && mode !== "online") {
      this.net?.leave();
      this.net = null;
      this.onlineColor = null;
      this.connectionStatus = "idle";
      sessionStorage.removeItem(ONLINE_STATE_KEY);
      this.hideOnlineModal();
    }
    this.opponent = mode;
    if (mode === "online") {
      this.enterOnlineMode();
    } else {
      this.startNewGame();
    }
    this.render();
  }

  private enterOnlineMode() {
    this.net = new RoomConnection(WS_URL);
    this.wireNetHandlers(this.net);
    this.onlineError = null;

    if (this.net.hasStoredSession()) {
      this.onlineStep = "connecting";
      this.showOnlineModal();
      this.net
        .rejoin()
        .then(({ color }) => {
          this.onlineColor = color;
          const saved = sessionStorage.getItem(ONLINE_STATE_KEY);
          this.state = saved ? (JSON.parse(saved) as GameState) : createInitialState();
          this.selected = null;
          this.legalMoves = [];
          this.hideOnlineModal();
          this.render();
        })
        .catch(() => {
          this.net?.leave();
          sessionStorage.removeItem(ONLINE_STATE_KEY);
          this.onlineStep = "choice";
          this.renderOnlinePanel();
        });
      return;
    }

    const roomFromUrl = new URLSearchParams(location.search).get("room");
    this.onlineStep = "choice";
    this.showOnlineModal(roomFromUrl ?? "");
  }

  private wireNetHandlers(net: RoomConnection) {
    net.onConnectionStatus((status) => {
      this.connectionStatus = status;
      this.render();
    });
    net.onOpponentJoined(() => {
      this.startNewGame();
      this.hideOnlineModal();
    });
    net.onOpponentMove((move) => {
      this.state = makeMove(this.state, move);
      this.selected = null;
      this.legalMoves = [];
      this.persistOnlineState();
      this.render();
    });
    net.onOpponentRestart(() => {
      this.startNewGame();
    });
    net.onOpponentLeft(() => this.render());
    net.onOpponentReconnected(() => this.render());
  }

  private persistOnlineState() {
    sessionStorage.setItem(ONLINE_STATE_KEY, JSON.stringify(this.state));
  }

  private showOnlineModal(roomCodeInputValue = "") {
    this.onlineModal.classList.remove("hidden");
    this.renderOnlinePanel(roomCodeInputValue);
  }

  private hideOnlineModal() {
    this.onlineModal.classList.add("hidden");
  }

  private renderOnlinePanel(roomCodeInputValue = "") {
    const body = this.onlineModalBody;
    const errorHtml = this.onlineError ? `<p class="online-error">${this.onlineError}</p>` : "";

    if (this.onlineStep === "connecting") {
      body.innerHTML = `<p>Reconnecting to your game…</p>`;
      return;
    }

    if (this.onlineStep === "creating") {
      body.innerHTML = `<p>Creating room…</p>`;
      return;
    }

    if (this.onlineStep === "joining") {
      body.innerHTML = `<p>Joining room…</p>`;
      return;
    }

    const activeRoom = this.net?.currentRoom ?? null;
    if (this.onlineStep === "waiting" && activeRoom) {
      const link = `${location.origin}${location.pathname}?room=${activeRoom}`;
      body.innerHTML = `
        <p>Share this code or link with your opponent:</p>
        <div class="room-code">${activeRoom}</div>
        <button type="button" class="primary-btn" id="online-copy-link">Copy Link</button>
        <p class="online-waiting">Waiting for opponent to join…</p>
      `;
      body.querySelector("#online-copy-link")!.addEventListener("click", () => {
        navigator.clipboard?.writeText(link);
      });
      return;
    }

    body.innerHTML = `
      <p>Create a game and share the link with a friend, or join one they've shared with you.</p>
      <div class="online-row">
        <span>You'll play:</span>
        <button type="button" class="toggle-btn" id="online-color-toggle">${this.onlinePreferredColor === "w" ? "White" : "Black"}</button>
      </div>
      <button type="button" class="primary-btn" id="online-create-btn">Create Game</button>
      <hr />
      <div class="online-row">
        <input type="text" id="online-room-input" maxlength="5" placeholder="Room code" value="${roomCodeInputValue}" />
        <button type="button" class="primary-btn" id="online-join-btn">Join Game</button>
      </div>
      ${errorHtml}
    `;

    body.querySelector("#online-color-toggle")!.addEventListener("click", () => {
      this.onlinePreferredColor = this.onlinePreferredColor === "w" ? "b" : "w";
      this.renderOnlinePanel(roomCodeInputValue);
    });

    body.querySelector("#online-create-btn")!.addEventListener("click", () => {
      this.onlineStep = "creating";
      this.onlineError = null;
      this.renderOnlinePanel();
      this.net!.createRoom(this.onlinePreferredColor)
        .then(({ color }) => {
          this.onlineColor = color;
          this.onlineStep = "waiting";
          this.renderOnlinePanel();
        })
        .catch(() => {
          this.onlineError = "Could not create a game. Please try again.";
          this.onlineStep = "choice";
          this.renderOnlinePanel();
        });
    });

    const input = body.querySelector<HTMLInputElement>("#online-room-input")!;
    body.querySelector("#online-join-btn")!.addEventListener("click", () => {
      const code = input.value.trim();
      if (!code) return;
      this.onlineStep = "joining";
      this.onlineError = null;
      this.renderOnlinePanel();
      this.net!.joinRoom(code)
        .then(({ color }) => {
          this.onlineColor = color;
          this.startNewGame();
          this.hideOnlineModal();
        })
        .catch((err: Error) => {
          this.onlineError = err.message === "room-full" ? "That room is already full." : "Room not found — check the code.";
          this.onlineStep = "choice";
          this.renderOnlinePanel(code);
        });
    });
  }

  private onSquareClick(index: number) {
    if (this.state.status === "checkmate" || this.state.status === "stalemate") return;
    if (this.thinking) return;
    if (this.opponent === "computer" && this.state.turn !== this.humanColor) return;
    if (this.opponent === "online" && (this.connectionStatus !== "connected" || this.state.turn !== this.onlineColor)) return;

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
    if (this.opponent === "online") {
      this.net?.sendMove(move);
      this.persistOnlineState();
    }
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

    const opponentLabel = this.opponent === "human" ? "Human" : this.opponent === "computer" ? "Computer" : "Online";
    this.opponentToggle.textContent = `Opponent: ${opponentLabel}`;
    this.opponentToggle.classList.toggle("active", this.opponent !== "human");
    this.colorToggle.textContent = `You play: ${this.humanColor === "w" ? "White" : "Black"}`;
    this.colorToggle.classList.toggle("hidden", this.opponent !== "computer");
    this.difficultyToggle.textContent = `Difficulty: ${DIFFICULTY_LABELS[this.difficulty]}`;
    this.difficultyToggle.classList.toggle("hidden", this.opponent !== "computer");

    this.onlineBanner.classList.toggle("hidden", this.opponent !== "online");
    this.boardEl.classList.toggle("net-frozen", this.opponent === "online" && this.connectionStatus !== "connected");
    if (this.opponent === "online") {
      const colorLabel = this.onlineColor === "w" ? "White" : "Black";
      const text =
        this.connectionStatus === "waiting"
          ? `Room ${this.net?.currentRoom ?? ""} — waiting for opponent to join…`
          : this.connectionStatus === "connecting"
            ? "Reconnecting…"
            : this.connectionStatus === "disconnected"
              ? "Connection lost — reload this page to try reconnecting."
              : this.connectionStatus === "connected"
                ? `Connected — you are ${colorLabel}`
                : "";
      this.onlineBanner.textContent = text;
      this.onlineBanner.className = `online-banner status-${this.connectionStatus}`;
    }

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
