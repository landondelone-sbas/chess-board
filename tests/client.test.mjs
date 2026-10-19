// Client checks: what a player sees when the relay refuses or drops them.
//
// The relay answers with short codes ("server-busy", "too-many-rooms", ...). These tests check that each code reaches
// the screen as its own plain sentence, and that a relay that hangs up on a client does not leave the "Creating
// room..." screen waiting forever. Part of this runs the real RoomConnection against a real relay; the rest uses a
// stand-in WebSocket so exact timings and close codes can be controlled.
//
// The screen code itself (src/ui.ts) needs a browser, so that part is covered by the real-run check in /preship.
import test from "node:test";
import assert from "node:assert/strict";
import { describeRejoinError, describeRelayError, isPermanentRejoinFailure } from "../src/relayErrors.ts";
import { RoomConnection } from "../src/net.ts";
import { createInitialState, getLegalMoves } from "../src/engine.ts";
import { resolveOpponentMove } from "../src/opponentMove.ts";
import { connect, createGame, eventually, freePort, joinGame, sleep, startRelay } from "./relayHarness.mjs";
import { idx, stateFromFen } from "./fen.mjs";

const GENERIC_CREATE = "Could not create a game. Please try again.";
const GENERIC_JOIN = "Could not join that game. Please try again.";

// What a browser provides and net.ts uses. Replaced per test and put back afterwards.
function setGlobal(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => (original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]));
}

function useSessionStorage(t, initial = {}) {
  const store = new Map(Object.entries(initial));
  setGlobal(t, "sessionStorage", {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  });
  return store;
}

// A WebSocket the test drives by hand.
class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState < 2) this.readyState = 2; // closing; the close event comes later
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(message) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) }));
  }
  finishClose(code) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

function useFakeWebSocket(t) {
  FakeWebSocket.instances = [];
  setGlobal(t, "WebSocket", FakeWebSocket);
  return () => FakeWebSocket.instances.at(-1);
}

// Waits for a promise, but gives up after a while so a promise that never settles shows up as a failure, not a hang.
const settle = (promise, ms = 4000) =>
  Promise.race([promise.then((value) => ({ state: "resolved", value }), (error) => ({ state: "rejected", error })), sleep(ms).then(() => ({ state: "pending" }))]);

async function rejectionOf(promise, what) {
  const result = await settle(promise);
  assert.equal(result.state, "rejected", `${what}: expected the request to fail, but it ${result.state === "pending" ? "never finished" : "succeeded"}`);
  return result.error.message;
}

test("every relay and connection error has its own plain sentence", () => {
  const codes = ["room-full", "room-not-found", "server-busy", "too-many-rooms", "too-many-connections", "already-in-room", "bad-request", "connection-failed", "connection-closed"];
  const expected = {
    "room-full": /full/,
    "room-not-found": /not found.*expire/,
    "server-busy": /busy/,
    "too-many-rooms": /Too many games/,
    "too-many-connections": /too many connections/,
    "already-in-room": /already in a game/,
    "bad-request": /Reload/,
    "connection-failed": /reach the game server/,
    "connection-closed": /connection .* lost/,
  };
  const seen = new Set();
  for (const code of codes) {
    const text = describeRelayError(code, "create");
    assert.match(text, expected[code], code);
    assert.notEqual(text, GENERIC_CREATE, `${code} must not fall back to the generic message`);
    assert.equal(describeRelayError(code, "join"), text, `${code} reads the same when joining`);
    assert.doesNotMatch(text, /[<>&]/, `${code}: the screen inserts this text as HTML`);
    assert.ok(!seen.has(text), `${code} needs a message of its own`);
    seen.add(text);
  }
});

test("an unknown or missing error gets a generic message for what the player was doing", () => {
  for (const code of [undefined, "", "something-new", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(describeRelayError(code, "create"), GENERIC_CREATE, String(code));
    assert.equal(describeRelayError(code, "join"), GENERIC_JOIN, String(code));
  }
});

test("a failed attempt to resume a saved game says what happened, and only a game that is gone is forgotten", () => {
  for (const code of ["room-not-found", "bad-request"]) assert.equal(isPermanentRejoinFailure(code), true, code);
  for (const code of ["too-many-connections", "connection-failed", "connection-closed", "server-busy", "too-many-rooms", "room-full", undefined, "", "something-new", "constructor"]) {
    assert.equal(isPermanentRejoinFailure(code), false, `${code} may pass, so the game is kept`);
    const text = describeRejoinError(code);
    assert.match(text, /still saved/, `${code}: tell the player the game is kept`);
    assert.match(text, /[Rr]eload/, `${code}: and how to try again`);
  }
  assert.match(describeRejoinError("too-many-connections"), /too many connections/, "the reason comes first");
  assert.match(describeRejoinError("something-new"), /^Could not reconnect to your game\./, "an unknown reason still reads as a failed reconnect");
  assert.match(describeRejoinError("room-not-found"), /ended or expired/);
  assert.doesNotMatch(describeRejoinError("room-not-found"), /still saved/, "a game that is gone is not still saved");
  assert.match(describeRejoinError("bad-request"), /could not be resumed/);
  for (const code of ["room-not-found", "bad-request", "connection-failed", undefined]) assert.doesNotMatch(describeRejoinError(code), /[<>&]/, "the screen inserts this text as HTML");
});

const SCENARIOS = [
  {
    code: "too-many-connections",
    env: { RELAY_MAX_CONNECTIONS_PER_IP: "1" },
    prepare: (relay) => connect(relay.port), // another connection from this address already holds the only slot
    action: (conn) => conn.createRoom("w", "none"),
  },
  { code: "server-busy", env: { RELAY_MAX_ROOMS: "1" }, prepare: (relay) => createGame(relay), action: (conn) => conn.createRoom("w", "none") },
  { code: "too-many-rooms", env: { RELAY_MAX_ROOMS_PER_IP: "1" }, prepare: (relay) => createGame(relay), action: (conn) => conn.createRoom("w", "none") },
  { code: "room-not-found", prepare: () => {}, action: (conn) => conn.joinRoom("ZZZZZ") },
  {
    code: "room-full",
    prepare: async (relay) => {
      const { room } = await createGame(relay);
      await joinGame(relay, room);
      return room;
    },
    action: (conn, room) => conn.joinRoom(room),
  },
  {
    code: "already-in-room",
    prepare: () => {},
    action: async (conn) => {
      await conn.createRoom("w", "none");
      return conn.createRoom("w", "none"); // a second room on the same connection
    },
  },
  { code: "bad-request", sessionToken: "", prepare: () => {}, action: (conn) => conn.createRoom("w", "none") }, // a damaged saved token
];

for (const { code, env, sessionToken, prepare, action } of SCENARIOS) {
  test(`against the real relay, "${code}" reaches the player as a clear message`, { timeout: 30000 }, async (t) => {
    useSessionStorage(t, sessionToken === undefined ? {} : { "chess-net-token": sessionToken });
    const relay = await startRelay(t, env);
    const prepared = await prepare(relay);
    const conn = new RoomConnection(relay.url);
    const statuses = [];
    conn.onConnectionStatus((status) => statuses.push(status));
    try {
      const message = await rejectionOf(action(conn, prepared), code);
      assert.equal(message, code, "the connection layer passes the relay's code on unchanged");
      assert.notEqual(describeRelayError(message, "create"), GENERIC_CREATE, "and the screen has a specific sentence for it");
      assert.notEqual(statuses.at(-1), "connecting", "the connection must not be left looking like it is still connecting");
    } finally {
      conn.leave(); // before the stand-in sessionStorage is removed
    }
  });
}

test("when the relay cannot be reached the player is told so", { timeout: 30000 }, async (t) => {
  useSessionStorage(t);
  const conn = new RoomConnection(`ws://127.0.0.1:${await freePort()}`); // nothing is listening there
  assert.equal(await rejectionOf(conn.createRoom("w", "none"), "connection-failed"), "connection-failed");
});

test("a relay that hangs up before answering fails the request instead of leaving it waiting", async (t) => {
  useSessionStorage(t);
  const latest = useFakeWebSocket(t);
  const conn = new RoomConnection("ws://fake");
  const statuses = [];
  conn.onConnectionStatus((status) => statuses.push(status));
  const request = conn.createRoom("w", "none");
  latest().open();
  await sleep(0);
  latest().finishClose(1006);
  assert.equal(await rejectionOf(request, "hang-up"), "connection-closed");
  assert.equal(statuses.at(-1), "idle");
  const second = conn.createRoom("w", "none");
  latest().open();
  await sleep(0);
  latest().finishClose(1013); // the relay's "too many connections" code
  assert.equal(await rejectionOf(second, "refused"), "too-many-connections");
});

test("a late close from a socket the connection already replaced does not fail the new request", async (t) => {
  useSessionStorage(t);
  const latest = useFakeWebSocket(t);
  const conn = new RoomConnection("ws://fake");
  const first = conn.createRoom("w", "none");
  const oldSocket = latest();
  oldSocket.open();
  await sleep(0);
  oldSocket.receive({ type: "created", room: "ABCDE", color: "w" });
  await first;
  conn.leave(); // closing the old socket takes a moment...
  const second = conn.createRoom("w", "none");
  const newSocket = latest();
  assert.notEqual(newSocket, oldSocket);
  newSocket.open();
  await sleep(0);
  oldSocket.finishClose(1000); // ...and its close arrives while the new request is waiting
  assert.equal((await settle(second, 100)).state, "pending", "the new request must keep waiting for its own answer");
  newSocket.receive({ type: "created", room: "FGHJK", color: "w" });
  assert.equal((await settle(second)).state, "resolved");
});

test("an error reply nobody asked for leaves the status of a running game alone", async (t) => {
  useSessionStorage(t);
  const latest = useFakeWebSocket(t);
  const conn = new RoomConnection("ws://fake");
  const statuses = [];
  conn.onConnectionStatus((status) => statuses.push(status));
  const request = conn.createRoom("w", "none");
  latest().open();
  await sleep(0);
  latest().receive({ type: "created", room: "ABCDE", color: "w" });
  await request;
  const before = statuses.length;
  latest().receive({ type: "error", message: "already-in-room" });
  await sleep(0);
  assert.equal(statuses.length, before, `no status change expected, got ${statuses.slice(before)}`);
});

test("a connection that drops after a game was set up still reports as disconnected", async (t) => {
  useSessionStorage(t);
  const latest = useFakeWebSocket(t);
  const conn = new RoomConnection("ws://fake");
  const statuses = [];
  conn.onConnectionStatus((status) => statuses.push(status));
  const request = conn.createRoom("w", "none");
  latest().open();
  await sleep(0);
  latest().receive({ type: "created", room: "ABCDE", color: "w" });
  await request;
  latest().finishClose(1006);
  assert.equal(statuses.at(-1), "disconnected");
});

test("leaving can keep the saved game so a reload can resume it, and by default forgets it", async (t) => {
  const store = useSessionStorage(t);
  const latest = useFakeWebSocket(t);
  const conn = new RoomConnection("ws://fake");
  const request = conn.createRoom("w", "none");
  latest().open();
  await sleep(0);
  latest().receive({ type: "created", room: "ABCDE", color: "w" });
  await request;
  assert.equal(store.get("chess-net-room"), "ABCDE");
  conn.leave(true);
  assert.equal(store.get("chess-net-room"), "ABCDE", "the saved room stays");
  assert.ok(store.get("chess-net-token"), "and so does the token");
  assert.ok(RoomConnection.hasStoredSession(), "so a reload would try to resume it");
  conn.leave();
  assert.equal(store.has("chess-net-room") || store.has("chess-net-token"), false, "a plain leave forgets the game");
});

test("a move is sent as just its squares and promotion piece, never the rest of the move", async (t) => {
  useSessionStorage(t);
  const latest = useFakeWebSocket(t);
  const conn = new RoomConnection("ws://fake");
  const request = conn.createRoom("w", "none");
  latest().open();
  await sleep(0);
  latest().receive({ type: "created", room: "ABCDE", color: "w" });
  await request;
  const piece = { type: "p", color: "w" };
  conn.sendMove({ from: 12, to: 28, piece, capturedPiece: null, notation: "e4" });
  conn.sendMove({ from: 52, to: 60, piece, capturedPiece: { type: "r", color: "b" }, promotion: "n", notation: "dxe8=N" });
  const moves = latest().sent.filter((m) => m.type === "move");
  assert.deepEqual(moves, [
    { type: "move", move: { from: 12, to: 28 } },
    { type: "move", move: { from: 52, to: 60, promotion: "n" } },
  ]);
});

test("moves cross the real relay and come out the other end as the engine's own legal moves", { timeout: 30000 }, async (t) => {
  const store = useSessionStorage(t);
  const relay = await startRelay(t);
  const host = new RoomConnection(relay.url);
  await host.createRoom("w", "none");
  store.clear(); // the second player is a different browser tab, with its own saved token
  const guest = new RoomConnection(relay.url);
  const received = [];
  guest.onOpponentMove((move) => received.push(move));
  try {
    await guest.joinRoom(host.currentRoom);
    const start = createInitialState();
    const opening = getLegalMoves(start, idx("e2")).find((m) => m.to === idx("e4"));
    const promotionPosition = stateFromFen("4k3/P7/8/8/8/8/8/4K3 w - -");
    const promotion = getLegalMoves(promotionPosition, idx("a7")).find((m) => m.to === idx("a8") && m.promotion === "n");
    assert.ok(opening && promotion, "test setup: both moves exist");
    host.sendMove(opening);
    host.sendMove(promotion);
    assert.ok(await eventually(() => received.length === 2), "both moves must arrive");
    assert.deepEqual(received, [{ from: idx("e2"), to: idx("e4") }, { from: idx("a7"), to: idx("a8"), promotion: "n" }], "what travels is only the squares");
    assert.deepEqual(resolveOpponentMove(start, "w", received[0]), opening);
    assert.deepEqual(resolveOpponentMove(promotionPosition, "w", received[1]), promotion);
  } finally {
    host.leave();
    guest.leave();
  }
});
