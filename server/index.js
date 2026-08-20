import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8787;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const ROOM_CODE_LENGTH = 5;
const IDLE_ROOM_TTL_MS = 10 * 60 * 1000; // 10 minutes with no connected sockets

/** @typedef {{ socket: import("ws").WebSocket | null, token: string }} Seat */
/** @typedef {{ white: Seat | null, black: Seat | null, emptySince: number | null }} Room */

/** @type {Map<string, Room>} */
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function otherColor(color) {
  return color === "w" ? "b" : "w";
}

function seatFor(room, color) {
  return color === "w" ? room.white : room.black;
}

function setSeat(room, color, seat) {
  if (color === "w") room.white = seat;
  else room.black = seat;
}

function send(socket, message) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function roomIsEmpty(room) {
  return !room.white?.socket && !room.black?.socket;
}

function sweepIdleRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (roomIsEmpty(room) && room.emptySince && now - room.emptySince > IDLE_ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}
setInterval(sweepIdleRooms, 60 * 1000).unref();

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket) => {
  // Populated once the socket has created/joined a room.
  /** @type {{ room: string, color: "w" | "b" } | null} */
  let meta = null;

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "create") {
      const room = { white: null, black: null, emptySince: null };
      const code = generateRoomCode();
      setSeat(room, msg.color, { socket, token: msg.token });
      rooms.set(code, room);
      meta = { room: code, color: msg.color };
      send(socket, { type: "created", room: code, color: msg.color });
      return;
    }

    if (msg.type === "join") {
      const room = rooms.get(msg.room);
      if (!room) {
        send(socket, { type: "error", message: "room-not-found" });
        return;
      }
      const takenColor = room.white ? "w" : room.black ? "b" : null;
      if (takenColor === null) {
        send(socket, { type: "error", message: "room-not-found" });
        return;
      }
      const joinColor = otherColor(takenColor);
      if (seatFor(room, joinColor)) {
        send(socket, { type: "error", message: "room-full" });
        return;
      }
      setSeat(room, joinColor, { socket, token: msg.token });
      room.emptySince = null;
      meta = { room: msg.room, color: joinColor };
      send(socket, { type: "joined", room: msg.room, color: joinColor });
      send(seatFor(room, takenColor)?.socket, { type: "opponent-joined" });
      return;
    }

    if (msg.type === "rejoin") {
      const room = rooms.get(msg.room);
      if (!room) {
        send(socket, { type: "error", message: "room-not-found" });
        return;
      }
      const color = room.white?.token === msg.token ? "w" : room.black?.token === msg.token ? "b" : null;
      if (!color) {
        send(socket, { type: "error", message: "room-not-found" });
        return;
      }
      setSeat(room, color, { socket, token: msg.token });
      room.emptySince = null;
      meta = { room: msg.room, color };
      send(socket, { type: "joined", room: msg.room, color });
      send(seatFor(room, otherColor(color))?.socket, { type: "opponent-reconnected" });
      return;
    }

    if (!meta) return;
    const room = rooms.get(meta.room);
    if (!room) return;
    const peer = seatFor(room, otherColor(meta.color))?.socket;

    if (msg.type === "move") {
      send(peer, { type: "opponent-move", move: msg.move });
    } else if (msg.type === "restart") {
      send(peer, { type: "opponent-restart" });
    }
  });

  socket.on("close", () => {
    if (!meta) return;
    const room = rooms.get(meta.room);
    if (!room) return;
    const seat = seatFor(room, meta.color);
    if (seat) seat.socket = null;
    if (roomIsEmpty(room)) room.emptySince = Date.now();
    send(seatFor(room, otherColor(meta.color))?.socket, { type: "opponent-left" });
  });
});

console.log(`Chess relay server listening on ws://localhost:${PORT}`);
