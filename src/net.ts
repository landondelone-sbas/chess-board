import type { ClientMessage, Color, ConnectionStatus, Move, ServerMessage, TimeControlId } from "./types";

type ConnectResult = { room: string; color: Color; timeControl?: TimeControlId };

const TOKEN_KEY = "chess-net-token";
const ROOM_KEY = "chess-net-room";

function randomToken(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

/**
 * Wraps a WebSocket connection to the relay server, handling room
 * create/join/rejoin as promises and exposing in-game events (moves,
 * restarts, opponent presence) via callbacks.
 */
export class RoomConnection {
  private socket: WebSocket | null = null;
  private token: string;
  private room: string | null = null;
  private color: Color | null = null;

  private pendingConnect: { resolve: (v: ConnectResult) => void; reject: (e: Error) => void } | null = null;

  private moveHandler: ((move: Move) => void) | null = null;
  private opponentJoinedHandler: (() => void) | null = null;
  private opponentLeftHandler: (() => void) | null = null;
  private opponentReconnectedHandler: (() => void) | null = null;
  private opponentRestartHandler: (() => void) | null = null;
  private statusHandler: ((status: ConnectionStatus) => void) | null = null;

  private readonly url: string;

  constructor(url: string) {
    this.url = url;
    this.token = sessionStorage.getItem(TOKEN_KEY) ?? randomToken();
  }

  get currentRoom() {
    return this.room;
  }

  get currentColor() {
    return this.color;
  }

  /** A room/token from a previous session in this tab was saved and can be rejoined. */
  hasStoredSession(): boolean {
    return RoomConnection.hasStoredSession();
  }

  /** Static form so callers can check before constructing an instance. */
  static hasStoredSession(): boolean {
    return sessionStorage.getItem(TOKEN_KEY) !== null && sessionStorage.getItem(ROOM_KEY) !== null;
  }

  onOpponentMove(cb: (move: Move) => void) {
    this.moveHandler = cb;
  }
  onOpponentJoined(cb: () => void) {
    this.opponentJoinedHandler = cb;
  }
  onOpponentLeft(cb: () => void) {
    this.opponentLeftHandler = cb;
  }
  onOpponentReconnected(cb: () => void) {
    this.opponentReconnectedHandler = cb;
  }
  onOpponentRestart(cb: () => void) {
    this.opponentRestartHandler = cb;
  }
  onConnectionStatus(cb: (status: ConnectionStatus) => void) {
    this.statusHandler = cb;
  }

  createRoom(color: Color, timeControl: TimeControlId): Promise<ConnectResult> {
    return this.connectAndSend({ type: "create", token: this.token, color, timeControl });
  }

  joinRoom(room: string): Promise<ConnectResult> {
    return this.connectAndSend({ type: "join", room: room.toUpperCase(), token: this.token });
  }

  rejoin(): Promise<ConnectResult> {
    const room = sessionStorage.getItem(ROOM_KEY);
    if (!room) return Promise.reject(new Error("no-stored-session"));
    return this.connectAndSend({ type: "rejoin", room, token: this.token });
  }

  sendMove(move: Move) {
    this.send({ type: "move", move });
  }

  sendRestart() {
    this.send({ type: "restart" });
  }

  /** Clears the saved session and closes the socket (used when leaving online mode). */
  leave() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(ROOM_KEY);
    this.socket?.close();
    this.socket = null;
    this.room = null;
    this.color = null;
    this.setStatus("idle");
  }

  private setStatus(status: ConnectionStatus) {
    this.statusHandler?.(status);
  }

  private send(message: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private connectAndSend(message: ClientMessage): Promise<ConnectResult> {
    return new Promise((resolve, reject) => {
      this.pendingConnect = { resolve, reject };
      this.setStatus("connecting");
      this.openSocket()
        .then((socket) => socket.send(JSON.stringify(message)))
        .catch((err) => {
          this.pendingConnect = null;
          this.setStatus("idle");
          reject(err);
        });
    });
  }

  private openSocket(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.socket);
    }
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", () => reject(new Error("connection-failed")));
      socket.addEventListener("close", () => {
        if (this.room) this.setStatus("disconnected");
      });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
    });
  }

  private handleMessage(raw: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "created": {
        this.room = msg.room;
        this.color = msg.color;
        sessionStorage.setItem(TOKEN_KEY, this.token);
        sessionStorage.setItem(ROOM_KEY, msg.room);
        this.setStatus("waiting");
        this.pendingConnect?.resolve({ room: msg.room, color: msg.color });
        this.pendingConnect = null;
        break;
      }
      case "joined": {
        this.room = msg.room;
        this.color = msg.color;
        sessionStorage.setItem(TOKEN_KEY, this.token);
        sessionStorage.setItem(ROOM_KEY, msg.room);
        this.setStatus("connected");
        this.pendingConnect?.resolve({ room: msg.room, color: msg.color, timeControl: msg.timeControl });
        this.pendingConnect = null;
        break;
      }
      case "opponent-joined":
        this.setStatus("connected");
        this.opponentJoinedHandler?.();
        break;
      case "opponent-move":
        this.moveHandler?.(msg.move);
        break;
      case "opponent-restart":
        this.opponentRestartHandler?.();
        break;
      case "opponent-left":
        this.setStatus("disconnected");
        this.opponentLeftHandler?.();
        break;
      case "opponent-reconnected":
        this.setStatus("connected");
        this.opponentReconnectedHandler?.();
        break;
      case "error":
        this.pendingConnect?.reject(new Error(msg.message));
        this.pendingConnect = null;
        break;
    }
  }
}
