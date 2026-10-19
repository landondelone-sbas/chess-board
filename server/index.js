import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";

// Settings. All are optional environment variables; the defaults suit a small public relay.
//   PORT                          port to listen on (8787)
//   RELAY_HOST                    address to bind (all interfaces; the tests use 127.0.0.1)
//   RELAY_MAX_PAYLOAD_BYTES       largest accepted frame (4096)
//   RELAY_MAX_ROOMS               rooms alive at once, all players together (500)
//   RELAY_MAX_ROOMS_PER_IP        rooms alive at once from one address (10)
//   RELAY_MAX_CONNECTIONS_PER_IP  open connections from one address (20); twice this many, counting ones being
//                                 turned away, and further connections are rejected before the handshake finishes
//   RELAY_RATE_LIMIT_MESSAGES     messages, pings and pongs per connection per 10 seconds (30); one over it is dropped
//   RELAY_MAX_BUFFERED_BYTES      unsent bytes allowed for one peer before it is cut off (65536)
//   RELAY_HEARTBEAT_MS            how often every connection is pinged; one that misses a pong is dropped (30000; keep
//                                 it above about 400 or each pong uses up the rate limit)
//   RELAY_WAITING_ROOM_TTL_MS     how long a room nobody joined survives after its host leaves (300000)
//   RELAY_SWEEP_INTERVAL_MS       how often expired rooms are removed (15000)
//   RELAY_HANDSHAKE_TIMEOUT_MS    how long a new connection has to finish sending its HTTP request (10000)
//   RELAY_TRUST_PROXY_HOPS        how many proxies in front of the relay add an X-Forwarded-For entry we may trust (1,
//                                 which suits Render; set 0 if clients connect to the relay directly)
//   RELAY_LOG_CONNECTIONS         "off" stops the log line written for each new connection (it shows the socket address,
//                                 the X-Forwarded-For header and the address the limits count; at most 20 lines per 10 s)
// Real traffic is tiny (a move is about 200 bytes and a game sends a few messages a second at most), so the limits
// are generous for players and cheap protection against abuse.
//
// First deploy behind a proxy (Render): the right RELAY_TRUST_PROXY_HOPS is not known until the real X-Forwarded-For
// header has been seen. The connection log shows it, and counted-as= must be the player's own address. Until it is, run
// with RELAY_MAX_CONNECTIONS_PER_IP=1000 and RELAY_MAX_ROOMS_PER_IP=1000, so a wrong hop count cannot lock players out
// by putting them all under the proxy's address. Read the first log lines, set RELAY_TRUST_PROXY_HOPS so counted-as=
// is right, then lower the two limits again (or delete the two variables to get the defaults above).
const PORT = process.env.PORT || 8787;
const HOST = process.env.RELAY_HOST || undefined;
const limit = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
const MAX_PAYLOAD_BYTES = limit("RELAY_MAX_PAYLOAD_BYTES", 4 * 1024); // bigger frames are junk or an attack
const MAX_ROOMS = limit("RELAY_MAX_ROOMS", 500);
const MAX_ROOMS_PER_IP = limit("RELAY_MAX_ROOMS_PER_IP", 10);
const MAX_CONNECTIONS_PER_IP = limit("RELAY_MAX_CONNECTIONS_PER_IP", 20);
const MAX_BUFFERED_BYTES = limit("RELAY_MAX_BUFFERED_BYTES", 64 * 1024); // a peer this far behind is not reading
const RATE_LIMIT_MESSAGES = limit("RELAY_RATE_LIMIT_MESSAGES", 30); // per connection...
const RATE_LIMIT_WINDOW_MS = 10 * 1000; // ...in this window
const HEARTBEAT_MS = limit("RELAY_HEARTBEAT_MS", 30 * 1000);
const WAITING_ROOM_TTL_MS = limit("RELAY_WAITING_ROOM_TTL_MS", 5 * 60 * 1000); // long enough to switch apps and send the link
const IDLE_ROOM_TTL_MS = 10 * 60 * 1000; // a started game with nobody connected: long enough to come back
const SWEEP_INTERVAL_MS = limit("RELAY_SWEEP_INTERVAL_MS", 15 * 1000);
const HANDSHAKE_TIMEOUT_MS = limit("RELAY_HANDSHAKE_TIMEOUT_MS", 10 * 1000);
const TRUSTED_PROXY_HOPS = /^\d+$/.test(process.env.RELAY_TRUST_PROXY_HOPS ?? "") ? Number(process.env.RELAY_TRUST_PROXY_HOPS) : 1;
const LOG_CONNECTIONS = process.env.RELAY_LOG_CONNECTIONS !== "off";
const LOG_LINES_PER_WINDOW = 20;
const LOG_WINDOW_MS = 10 * 1000;

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const ROOM_CODE_LENGTH = 5;
const MAX_TOKEN_LENGTH = 64;
const VALID_COLORS = new Set(["w", "b"]);
const VALID_TIME_CONTROLS = new Set(["none", "bullet", "blitz", "rapid"]); // matches TimeControlId in src/types.ts
const VALID_PROMOTIONS = new Set(["q", "r", "b", "n"]); // matches PROMOTION_CHOICES in src/moveGenerator.ts
const VALID_PIECE_TYPES = new Set(["p", "n", "b", "r", "q", "k"]); // matches PieceType in src/types.ts
const MAX_NOTATION_LENGTH = 16;
const NOTATION_PATTERN = /^[A-Za-z0-9=+#-]*$/; // "e4", "exd5=Q#", "O-O-O+"

const isToken = (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;
const isRoomCode = (value) => typeof value === "string" && value.length === ROOM_CODE_LENGTH;
const isSquare = (n) => Number.isInteger(n) && n >= 0 && n < 64;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A piece as { type, color } rebuilt from the two checked values, or null if it is not one.
function cleanPiece(p) {
  return isPlainObject(p) && VALID_PIECE_TYPES.has(p.type) && VALID_COLORS.has(p.color) ? { type: p.type, color: p.color } : null;
}

// The relay cannot judge whether a move is legal, but it can make sure that what it passes on is a move and nothing
// else. Every field is checked and the move is rebuilt from the checked values, so no extra field, odd type or markup
// gets through. Players on an older version of the site read the whole move, so all of its fields are kept; the
// current site only uses the squares and the promotion piece, and checks them against the rules itself.
// Returns null for anything that is not a well-formed move.
function cleanMove(m) {
  if (!isPlainObject(m) || !isSquare(m.from) || !isSquare(m.to)) return null;
  const piece = cleanPiece(m.piece);
  if (!piece) return null;
  const move = { from: m.from, to: m.to, piece, capturedPiece: null, notation: "" };
  if (m.capturedPiece !== null && m.capturedPiece !== undefined) {
    move.capturedPiece = cleanPiece(m.capturedPiece);
    if (!move.capturedPiece) return null;
  }
  if (m.promotion !== undefined) {
    if (!VALID_PROMOTIONS.has(m.promotion)) return null;
    move.promotion = m.promotion;
  }
  if (m.isEnPassant !== undefined) {
    if (typeof m.isEnPassant !== "boolean") return null;
    move.isEnPassant = m.isEnPassant;
  }
  if (m.isCastle !== undefined) {
    if (m.isCastle !== "K" && m.isCastle !== "Q") return null;
    move.isCastle = m.isCastle;
  }
  if (m.notation !== undefined) {
    if (typeof m.notation !== "string" || m.notation.length > MAX_NOTATION_LENGTH || !NOTATION_PATTERN.test(m.notation)) return null;
    move.notation = m.notation;
  }
  return move;
}

/** @typedef {{ socket: import("ws").WebSocket | null, token: string }} Seat */
/** @typedef {{ white: Seat | null, black: Seat | null, emptySince: number | null, timeControl: string, creatorIp: string }} Room */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, number>} open connections per client address */
const connectionsByIp = new Map();

// The first four groups of an IPv6 address (the /64 network a home or office gets as one block). Counting each full
// address would let one machine use a different one for every connection.
function ipv6Prefix(ip) {
  const [head, tail] = ip.split("::");
  // An IPv4 tail (::1.2.3.4) is worth two groups; it sits in the last 32 bits, which never reach the first four groups.
  const groups = (part) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const before = groups(head);
  const after = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill("0"), ...after];
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

// The key the limits count for an address, or null if the text is not an address. Accepts the forms proxies produce:
// a port after IPv4 ("1.2.3.4:5555") or in brackets after IPv6 ("[2001:db8::1]:443"), and IPv4 seen through an IPv6
// socket ("::ffff:1.2.3.4"). A zone suffix ("fe80::1%eth0") is dropped before anything is counted: net.isIPv6 accepts a
// zone that itself contains colons ("1::2%a:b:c:d:e:f:g:h:i"), which would throw off the count of address groups below.
function addressKey(raw) {
  let ip = String(raw ?? "").trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  ip = ip.replace(/%.*$/, "").replace(/^::ffff:/i, "");
  if (net.isIPv4(ip)) return ip;
  return net.isIPv6(ip) ? ipv6Prefix(ip) : null;
}

// The address a client really comes from. Behind a proxy every connection arrives from the proxy, so the real
// address is in X-Forwarded-For. Each proxy appends the address it saw, and anything before those entries was
// written by the client and can be faked, so only the entry added by our own proxy (counted from the right) is used.
// If the header is missing, too short or not an address, fall back to the socket address.
function clientIp(req) {
  if (req.relayAddress) return req.relayAddress; // worked out once per request
  let direct = "unknown";
  let found = direct;
  try {
    direct = addressKey(req.socket.remoteAddress) ?? "unknown";
    found = direct;
    if (TRUSTED_PROXY_HOPS > 0) {
      const entries = String(req.headers["x-forwarded-for"] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
      const candidate = entries.length >= TRUSTED_PROXY_HOPS ? addressKey(entries[entries.length - TRUSTED_PROXY_HOPS]) : null;
      if (candidate) found = candidate;
    }
  } catch {
    // The header is written by whoever connects. Whatever is in it, it must never take the relay down: count by socket address.
    found = direct;
  }
  req.relayAddress = found;
  return found;
}

// One log line per new connection, so the real X-Forwarded-For chain can be read from the host's logs. The header is
// written by whoever connects, so it is cut short and quoted (a client cannot forge extra log fields), and the number of
// lines is capped so a flood of connections cannot also flood the log.
let logWindowStart = 0;
let logged = 0;
let notLogged = 0;
function logConnection(req, counted) {
  if (!LOG_CONNECTIONS) return;
  const now = Date.now();
  if (now - logWindowStart > LOG_WINDOW_MS) {
    if (notLogged) console.log(`(${notLogged} further connections not logged)`);
    logWindowStart = now;
    logged = 0;
    notLogged = 0;
  }
  if (++logged > LOG_LINES_PER_WINDOW) {
    notLogged++;
    return;
  }
  const header = req.headers["x-forwarded-for"];
  const shown = header === undefined ? "none" : JSON.stringify(String(header).slice(0, 300));
  console.log(`Connection: socket=${req.socket.remoteAddress} x-forwarded-for=${shown} counted-as=${counted}`);
}

function countRoomsFor(ip) {
  let count = 0;
  for (const room of rooms.values()) if (room.creatorIp === ip) count++;
  return count;
}

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
    // A peer that is not reading makes messages pile up in memory: cut it off instead.
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.terminate();
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The message could not be encoded, or the socket is closing: drop it rather than crash the relay.
    }
  }
}

const CLOSE_GRACE_MS = 3000;

// Close with a reason, but do not wait on a client that ignores the close handshake: ws would keep the connection
// for 30 seconds, which lets one address pile up open sockets while it is being refused.
function closeWithReason(socket, code, reason) {
  if (socket.readyState !== socket.OPEN) return; // already closing: a flood of frames must not stack up timers
  socket.close(code, reason);
  const force = setTimeout(() => socket.terminate(), CLOSE_GRACE_MS);
  force.unref();
  socket.once("close", () => clearTimeout(force));
}

function roomIsEmpty(room) {
  return !room.white?.socket && !room.black?.socket;
}

function roomIsFull(room) {
  return Boolean(room.white && room.black);
}

function sweepIdleRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!roomIsEmpty(room) || !room.emptySince) continue;
    // A room nobody ever joined is dropped soon after its host leaves, so abandoned rooms cannot hold the cap.
    // A started game is kept longer so a player who lost connection can come back.
    const ttl = roomIsFull(room) ? IDLE_ROOM_TTL_MS : WAITING_ROOM_TTL_MS;
    if (now - room.emptySince > ttl) rooms.delete(code);
  }
}
setInterval(sweepIdleRooms, SWEEP_INTERVAL_MS).unref();

// The HTTP server is created here (instead of letting ws make one) so a connection that never finishes its request is
// dropped after the handshake timeout instead of being held for the Node default of a minute or more.
const server = http.createServer(
  { headersTimeout: HANDSHAKE_TIMEOUT_MS, requestTimeout: HANDSHAKE_TIMEOUT_MS, connectionsCheckingInterval: Math.min(1000, HANDSHAKE_TIMEOUT_MS) },
  (req, res) => {
    const body = http.STATUS_CODES[426];
    res.writeHead(426, { "Content-Length": body.length, "Content-Type": "text/plain" });
    res.end(body);
  }
);

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD_BYTES,
  // ws would answer every ping itself, even from a connection already being closed for flooding, and that is slow enough
  // that one connection sending pings freezes the relay for everyone. Pings are answered below, and only within the limit.
  autoPong: false,
  // An address that keeps opening connections past its limit (they are turned away politely, but each is held a moment)
  // is turned away at the handshake once it has twice the limit open or closing.
  verifyClient: (info, done) => {
    if ((connectionsByIp.get(clientIp(info.req)) ?? 0) >= MAX_CONNECTIONS_PER_IP * 2) done(false, 503, "Service Unavailable");
    else done(true);
  },
});

// Ping every connection; one that has not answered the previous ping is dead (a phone that lost signal, a closed
// laptop) and is dropped, which frees its seat and tells the opponent. Browsers answer pings automatically.
setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {
      // closing already
    }
  }
}, HEARTBEAT_MS).unref();

// ws forwards server-level errors here. Before the relay is listening, any error (port taken, no permission,
// address not available) means it cannot work: say so and exit non-zero. After that, an error such as running out
// of file handles under a flood is logged and the relay keeps serving.
let listening = false;
wss.on("listening", () => {
  listening = true;
  console.log(`Chess relay server listening on ws://localhost:${PORT} (trusting ${TRUSTED_PROXY_HOPS} proxy hop(s) in X-Forwarded-For)`);
});
wss.on("error", (err) => {
  console.error(`Relay server error: ${err.code ?? err.message}`);
  if (!listening) process.exit(1);
});
server.listen({ port: PORT, host: HOST });

wss.on("connection", (socket, req) => {
  // ws emits "error" for malformed frames (bad UTF-8, oversize) and closes the socket itself.
  // With no listener Node would treat it as uncaught and the whole relay would exit.
  socket.on("error", () => {});

  // Count open connections per client address, and refuse a client that opens too many.
  const ip = clientIp(req);
  logConnection(req, ip);
  const openFromIp = (connectionsByIp.get(ip) ?? 0) + 1;
  connectionsByIp.set(ip, openFromIp);
  socket.on("close", () => {
    const left = (connectionsByIp.get(ip) ?? 1) - 1;
    if (left <= 0) connectionsByIp.delete(ip);
    else connectionsByIp.set(ip, left);
  });
  if (openFromIp > MAX_CONNECTIONS_PER_IP) {
    // Turned away: all it may do now is finish the close handshake. Any frame it sends instead is a flood, and every
    // frame read is time taken from everyone else, so the connection is dropped on the first one.
    for (const event of ["message", "ping", "pong"]) socket.on(event, () => socket.terminate());
    closeWithReason(socket, 1013, "too-many-connections");
    return;
  }

  // Populated once the socket has created/joined a room.
  /** @type {{ room: string, color: "w" | "b" } | null} */
  let meta = null;

  socket.isAlive = true;
  let windowStart = Date.now();
  let messageCount = 0;
  // Messages, pings and pongs all count, so a client cannot flood the relay with control frames either.
  const tooFast = () => {
    const now = Date.now();
    if (now - windowStart > RATE_LIMIT_WINDOW_MS) {
      windowStart = now;
      messageCount = 0;
    }
    return ++messageCount > RATE_LIMIT_MESSAGES;
  };
  // Control frames over the limit are dropped on the spot (no polite close, no reply): every extra step spent on
  // a flood of them is time taken from everyone else.
  socket.on("ping", (data) => {
    if (tooFast()) {
      socket.terminate();
      return;
    }
    try {
      socket.pong(data);
    } catch {
      // closing already
    }
  });
  socket.on("pong", () => {
    socket.isAlive = true;
    if (tooFast()) socket.terminate();
  });

  socket.on("message", (raw) => {
    if (tooFast()) {
      socket.terminate(); // a polite close would keep reading the rest of the flood for the whole grace period
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // JSON.parse also accepts "null", numbers and strings; only objects are valid frames.
    if (!msg || typeof msg !== "object") return;

    // One room per connection: a second create/join/rejoin would orphan the first room's seat (a permanent leak).
    if ((msg.type === "create" || msg.type === "join" || msg.type === "rejoin") && meta) {
      send(socket, { type: "error", message: "already-in-room" });
      return;
    }

    if (msg.type === "create") {
      const timeControl = msg.timeControl ?? "none";
      if (!VALID_COLORS.has(msg.color) || !isToken(msg.token) || !VALID_TIME_CONTROLS.has(timeControl)) {
        send(socket, { type: "error", message: "bad-request" });
        return;
      }
      if (countRoomsFor(ip) >= MAX_ROOMS_PER_IP || rooms.size >= MAX_ROOMS) sweepIdleRooms(); // make room if any expired
      if (countRoomsFor(ip) >= MAX_ROOMS_PER_IP) {
        send(socket, { type: "error", message: "too-many-rooms" });
        return;
      }
      if (rooms.size >= MAX_ROOMS) {
        send(socket, { type: "error", message: "server-busy" });
        return;
      }
      const room = { white: null, black: null, emptySince: null, timeControl, creatorIp: ip };
      const code = generateRoomCode();
      setSeat(room, msg.color, { socket, token: msg.token });
      rooms.set(code, room);
      meta = { room: code, color: msg.color };
      send(socket, { type: "created", room: code, color: msg.color });
      return;
    }

    if (msg.type === "join") {
      if (!isToken(msg.token)) {
        send(socket, { type: "error", message: "bad-request" });
        return;
      }
      const room = isRoomCode(msg.room) ? rooms.get(msg.room) : undefined;
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
      send(socket, { type: "joined", room: msg.room, color: joinColor, timeControl: room.timeControl });
      send(seatFor(room, takenColor)?.socket, { type: "opponent-joined" });
      return;
    }

    if (msg.type === "rejoin") {
      if (!isToken(msg.token)) {
        send(socket, { type: "error", message: "bad-request" });
        return;
      }
      const room = isRoomCode(msg.room) ? rooms.get(msg.room) : undefined;
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
      send(socket, { type: "joined", room: msg.room, color, timeControl: room.timeControl });
      send(seatFor(room, otherColor(color))?.socket, { type: "opponent-reconnected" });
      return;
    }

    if (!meta) return;
    const room = rooms.get(meta.room);
    if (!room) return;
    const peer = seatFor(room, otherColor(meta.color))?.socket;

    if (msg.type === "move") {
      const move = cleanMove(msg.move);
      if (!move) return;
      send(peer, { type: "opponent-move", move });
    } else if (msg.type === "restart") {
      send(peer, { type: "opponent-restart" });
    }
  });

  socket.on("close", () => {
    if (!meta) return;
    const room = rooms.get(meta.room);
    if (!room) return;
    const seat = seatFor(room, meta.color);
    // A late close from an old connection must not clear the seat a newer connection (a rejoin) now holds.
    if (!seat || seat.socket !== socket) return;
    seat.socket = null;
    if (roomIsEmpty(room)) room.emptySince = Date.now();
    send(seatFor(room, otherColor(meta.color))?.socket, { type: "opponent-left" });
  });
});
