// Relay checks: the relay must stay up, keep serving, and enforce its limits, whatever a client sends.
//
// Each test starts its own copy of the relay on a free local port and talks to it like a browser would.
// Every protection has a test written so that removing the protection makes it fail. Some tests start the relay
// with a limit changed through its RELAY_* environment variables, so one layer is checked without another hiding it.
//
// Needs the server's dependencies installed once: npm --prefix server ci
// RELAY_PATH=<file> npm test runs the same checks against a different copy of the relay (for before/after proof).
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  admitted,
  assertAlive,
  assertStillServing,
  connect,
  createGame,
  eventually,
  freePort,
  got,
  joinGame,
  nest,
  padded,
  rawUpgrade,
  sendJson,
  sleep,
  spawnRelay,
  startRelay,
  timeToAnswer,
  tryAdmit,
} from "./relayHarness.mjs";

test("ignores JSON frames that are not objects", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const client = await connect(relay.port);
  for (const frame of ["null", "123", '"text"', "[]", "true"]) client.ws.send(frame);
  await assertStillServing(relay, "non-object JSON frames");
});

test("rejects malformed fields with an error and creates no room", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const badFrames = [
    { type: "create", token: "T", color: "x" },
    { type: "create", token: "T", color: null },
    { type: "create", token: "", color: "w" },
    { type: "create", color: "w" },
    { type: "create", token: "x".repeat(65), color: "w" },
    { type: "create", token: "T", color: "w", timeControl: "forever" },
    { type: "create", token: "T", color: "w", timeControl: { a: 1 } },
    { type: "join", room: "ABCDE" },
    { type: "rejoin", room: "ABCDE" },
  ];
  for (const frame of badFrames) {
    const client = await connect(relay.port);
    sendJson(client, frame);
    assert.ok(await eventually(() => got(client, (m) => m.type === "error" && m.message === "bad-request")), `bad-request for ${JSON.stringify(frame)}`);
    assert.ok(!got(client, (m) => m.type === "created"), "no room may be created from a bad request");
  }
  for (const room of ["ZZZZZ", 12345, "TOOLONGCODE"]) {
    const client = await connect(relay.port);
    sendJson(client, { type: "join", room, token: "T" });
    assert.ok(await eventually(() => got(client, (m) => m.message === "room-not-found")), `room-not-found for ${JSON.stringify(room)}`);
  }
  assertAlive(relay, "malformed fields");
});

test("survives hostile frames: odd types, bad bytes, oversize and deeply nested JSON", { timeout: 60000 }, async (t) => {
  const relay = await startRelay(t);
  const hostile = [
    ["type is an object", () => JSON.stringify({ type: { x: 1 } })],
    ["move before joining", () => JSON.stringify({ type: "move", move: { from: 1, to: 2 } })],
    ["prototype-style key", () => '{"type":"create","__proto__":{"polluted":true},"color":"w","token":"t"}'],
    ["text frame that is not valid UTF-8", () => Buffer.from([0xc3, 0x28, 0xa0, 0xa1])],
    ["oversize frame (10 KB)", () => "x".repeat(10 * 1024)],
    ["huge nested color (single frame)", () => '{"type":"create","token":"t","color":' + nest(20000) + "}"],
    ["huge nested timeControl", () => '{"type":"create","token":"t","color":"w","timeControl":' + nest(20000) + "}"],
    ["nested color within the size cap", () => '{"type":"create","token":"t","color":' + nest(1000) + "}"],
  ];
  for (const [name, makeFrame] of hostile) {
    const client = await connect(relay.port);
    client.ws.send(makeFrame(), { binary: false });
    await assertStillServing(relay, name);
  }
});

test("drops moves that are not two real board squares, and delivers only the valid one", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const { host, room } = await createGame(relay);
  const guest = await joinGame(relay, room);
  const badMoves = [undefined, null, "text", 5, [], {}, { from: 12 }, { from: 12, to: 4294967294 }, { from: -1, to: 5 }, { from: "12", to: "28" }, { from: 1.5, to: 2 }];
  for (const move of badMoves) sendJson(host, { type: "move", move });
  sendJson(host, { type: "move", move: { from: 12, to: 28 } }); // the barrier: it arrives after any wrongly forwarded one
  assert.ok(await eventually(() => got(guest, (m) => m.type === "opponent-move" && m.move?.to === 28)), "the valid move must arrive");
  const delivered = guest.inbox.filter((m) => m.type === "opponent-move");
  assert.equal(delivered.length, 1, `only the valid move may be delivered, got ${JSON.stringify(delivered)}`);
});

test("passes on only a move's squares and promotion piece, nothing else a sender attaches", { timeout: 30000 }, async (t) => {
  // Raised size cap so the hostile extras (a huge nested value, markup, padding) actually reach the relay.
  const relay = await startRelay(t, { RELAY_MAX_PAYLOAD_BYTES: String(4 * 1024 * 1024), RELAY_RATE_LIMIT_MESSAGES: "1000" });
  const { host, room } = await createGame(relay);
  const guest = await joinGame(relay, room);
  const extras = '"piece":{"type":"q","color":"b"},"capturedPiece":{"type":"k","color":"w"},"isCastle":"K","notation":"<img src=x onerror=alert(1)>","pad":"' + "x".repeat(3000) + '","extra":' + nest(20000);
  host.ws.send('{"type":"move","move":{"from":12,"to":28,' + extras + "}}");
  host.ws.send('{"type":"move","move":{"from":52,"to":60,"promotion":"n",' + extras + "}}");
  assert.ok(await eventually(() => guest.inbox.filter((m) => m.type === "opponent-move").length === 2), `both moves must arrive\n${relay.why()}`);
  const delivered = guest.inbox.filter((m) => m.type === "opponent-move").map((m) => m.move);
  assert.deepEqual(delivered, [{ from: 12, to: 28 }, { from: 52, to: 60, promotion: "n" }], "only the squares and the promotion piece may be passed on");
  assertAlive(relay, "hostile move extras");
});

test("drops a move whose promotion piece is not one a pawn can become", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const { host, room } = await createGame(relay);
  const guest = await joinGame(relay, room);
  for (const promotion of ["k", "p", "x", "queen", "", null, 5, ["q"], { q: 1 }]) sendJson(host, { type: "move", move: { from: 52, to: 60, promotion } });
  for (const promotion of ["q", "r", "b", "n"]) sendJson(host, { type: "move", move: { from: 52, to: 60, promotion } });
  assert.ok(await eventually(() => guest.inbox.filter((m) => m.type === "opponent-move").length >= 4), "the four real promotions must arrive");
  await assertStillServing(relay, "bad promotion pieces"); // the valid ones were sent last, so nothing wrong can still be on its way
  assert.deepEqual(guest.inbox.filter((m) => m.type === "opponent-move").map((m) => m.move.promotion), ["q", "r", "b", "n"]);
});

test("refuses frames over the size cap and closes that connection, but accepts normal-sized ones", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const small = await connect(relay.port);
  small.ws.send(padded({ type: "create", token: "T", color: "w" }, 3000)); // far bigger than any real message, still under the cap
  assert.ok(await eventually(() => got(small, (m) => m.type === "created")), "a frame under the cap must be accepted");
  const big = await connect(relay.port);
  big.ws.send(padded({ type: "create", token: "T", color: "w" }, 10 * 1024)); // a perfectly valid message, just too big
  assert.ok(await eventually(() => big.closeCode !== null), "the oversize connection must be closed");
  assert.equal(big.closeCode, 1009, "closed with 'message too big'");
  assert.ok(!got(big, (m) => m.type === "created"), "an oversize frame must never be processed");
  assertAlive(relay, "oversize frame");
});

test("allows only one room per connection", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const { host, room } = await createGame(relay);
  sendJson(host, { type: "create", token: "A", color: "w" });
  sendJson(host, { type: "join", room, token: "A" });
  sendJson(host, { type: "rejoin", room, token: "A" });
  assert.ok(await eventually(() => host.inbox.filter((m) => m.message === "already-in-room").length === 3), "each extra create/join/rejoin must be refused");
  assert.equal(host.inbox.filter((m) => m.type === "created").length, 1, "only one room may be created");
  await joinGame(relay, room); // and the first room still works
});

test("caps the total number of rooms", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t, { RELAY_MAX_ROOMS: "3" });
  const first = await createGame(relay, "T1");
  await createGame(relay, "T2");
  await createGame(relay, "T3");
  const extra = await connect(relay.port);
  sendJson(extra, { type: "create", token: "T4", color: "w" });
  assert.ok(await eventually(() => got(extra, (m) => m.message === "server-busy")), "the room over the cap must be refused");
  assert.ok(!got(extra, (m) => m.type === "created"));
  await joinGame(relay, first.room); // the cap only limits new rooms, not people joining existing ones
});

test("caps the rooms one address can have open, without blocking other addresses", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t, { RELAY_MAX_ROOMS_PER_IP: "2" });
  const first = await createGame(relay, "T1");
  await createGame(relay, "T2");
  const extra = await connect(relay.port);
  sendJson(extra, { type: "create", token: "T3", color: "w" });
  assert.ok(await eventually(() => got(extra, (m) => m.message === "too-many-rooms")), "the third room from one address must be refused");
  assert.ok(!got(extra, (m) => m.type === "created"));
  await createGame(relay, "T4", { "X-Forwarded-For": "10.0.0.5" }); // another address is unaffected
  await joinGame(relay, first.room); // and joining a room is not limited by it
});

test("rooms nobody used expire, so abandoned ones cannot fill the room cap", { timeout: 30000 }, async (t) => {
  // The periodic sweep is switched off (an hour), so only the cleanup done when a room is requested can free the space.
  const slow = { RELAY_WAITING_ROOM_TTL_MS: "200", RELAY_SWEEP_INTERVAL_MS: "3600000" };
  for (const [name, env] of [
    ["total", { ...slow, RELAY_MAX_ROOMS: "2" }],
    ["per address", { ...slow, RELAY_MAX_ROOMS_PER_IP: "2" }],
  ]) {
    const relay = await startRelay(t, env);
    for (const token of ["T1", "T2"]) (await createGame(relay, token)).host.ws.close(); // two players create a room and walk away
    await sleep(700);
    const real = await connect(relay.port);
    sendJson(real, { type: "create", token: "REAL", color: "w" });
    assert.ok(await eventually(() => got(real, (m) => m.type === "created" || m.type === "error")), `${name}: the relay must answer`);
    assert.ok(got(real, (m) => m.type === "created"), `${name} cap: a real player must get a room once the abandoned ones expired, got ${JSON.stringify(real.inbox)}`);
  }
});

test("deletes a waiting room soon after its host leaves, but keeps started games and connected hosts", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t, { RELAY_WAITING_ROOM_TTL_MS: "300", RELAY_SWEEP_INTERVAL_MS: "100" });
  const abandoned = await createGame(relay, "ABANDONED");
  const waiting = await createGame(relay, "WAITING"); // its host stays connected
  const started = await createGame(relay, "STARTED");
  const guest = await joinGame(relay, started.room, "GUEST");
  abandoned.host.ws.close();
  started.host.ws.close();
  guest.ws.close();
  await sleep(1500); // several times the waiting-room lifetime
  const late = await connect(relay.port);
  sendJson(late, { type: "join", room: abandoned.room, token: "LATE" });
  assert.ok(await eventually(() => got(late, (m) => m.type === "error")), "the relay must answer");
  assert.ok(got(late, (m) => m.message === "room-not-found"), `a room whose host left before anyone joined must be gone, got ${JSON.stringify(late.inbox)}`);
  await joinGame(relay, waiting.room, "LATE2"); // a host who is still there keeps the room
  const back = await connect(relay.port);
  sendJson(back, { type: "rejoin", room: started.room, token: "STARTED" });
  assert.ok(await eventually(() => got(back, (m) => m.type === "joined")), "a game that had started stays available for the player to come back to");
});

test("sends a heartbeat ping and drops a connection that stops answering it", { timeout: 30000 }, async (t) => {
  // 500 ms: slow enough that a busy test machine cannot make a healthy client miss a pong, quick enough to keep the test short.
  const relay = await startRelay(t, { RELAY_HEARTBEAT_MS: "500", RELAY_RATE_LIMIT_MESSAGES: "1000000" });
  const { host, room } = await createGame(relay);
  const guest = await joinGame(relay, room);
  guest.ws.pause(); // the guest goes silent, like a phone that lost signal: it reads nothing, so it never answers a ping
  assert.ok(await eventually(() => got(host, (m) => m.type === "opponent-left"), 8000), "the silent connection must be dropped and the opponent told");
  await sleep(1600); // several more heartbeats: a connection that does answer must not be dropped
  sendJson(host, { type: "create", token: "A", color: "w" }); // already in a room, so the relay answers with an error: proof it is still served
  assert.ok(await eventually(() => got(host, (m) => m.message === "already-in-room")), "the healthy connection must still be served");
  assert.equal(host.closeCode, null, "the healthy connection must not be closed");
});

test("answers a client's ping with a pong carrying the same data", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const client = await connect(relay.port);
  const pongs = [];
  client.ws.on("pong", (data) => pongs.push(data.toString()));
  client.ws.ping("are-you-there");
  assert.ok(await eventually(() => pongs.length === 1), "the relay must answer a ping");
  assert.deepEqual(pongs, ["are-you-there"]);
});

test("counts ping and pong frames toward the rate limit and drops the sender", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t, { RELAY_RATE_LIMIT_MESSAGES: "5" });
  const pinger = await connect(relay.port);
  for (let i = 0; i < 20; i++) pinger.ws.ping();
  assert.ok(await eventually(() => pinger.closeCode !== null), "a ping flood must be cut off");
  const ponger = await connect(relay.port);
  for (let i = 0; i < 20; i++) ponger.ws.pong();
  assert.ok(await eventually(() => ponger.closeCode !== null), "a pong flood must be cut off");
  await assertStillServing(relay, "control-frame flood");
});

test("a flood of ping frames from one connection does not slow the relay down for anyone else", { timeout: 60000 }, async (t) => {
  const relay = await startRelay(t); // default limits
  const normal = await timeToAnswer(relay);
  const flooder = await rawUpgrade(relay.port);
  t.after(() => flooder.socket.destroy());
  assert.match(flooder.status, / 101 /, "the flooding connection must get in first");
  const frames = 500000; // 3 MB of empty, masked ping frames sent in one go
  const burst = Buffer.alloc(frames * 6);
  for (let i = 0; i < frames; i++) burst.writeUInt16BE(0x8980, i * 6);
  flooder.socket.write(burst);
  const during = await timeToAnswer(relay); // measured while the burst is being processed
  assert.ok(during < 1500, `a new client waited ${during} ms for an answer during the flood (${normal} ms normally)`);
  // Dropped at once, not asked politely to close (which a client that ignores it holds open for the 3 s grace period).
  assert.ok(await eventually(() => flooder.closed, 1000), "the flooding connection must be dropped straight away");
  assertAlive(relay, "ping flood");
});

test("rate limit: exactly the allowed number of messages pass and the next one closes the connection", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t, { RELAY_RATE_LIMIT_MESSAGES: "5" });
  const client = await connect(relay.port);
  for (let i = 0; i < 4; i++) client.ws.send('{"type":"restart"}');
  sendJson(client, { type: "create", token: "T", color: "w" }); // the fifth message
  assert.ok(await eventually(() => got(client, (m) => m.type === "created")), "the fifth message is within the limit and must be processed");
  assert.equal(client.closeCode, null, "the connection stays open at the limit");
  client.ws.send('{"type":"restart"}'); // the sixth
  assert.ok(await eventually(() => client.closeCode !== null), "the sixth message must close the connection");
  assert.equal(client.closeCode, 1008);
});

test("rate-limits each connection and closes one that floods", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const normal = await connect(relay.port);
  for (let i = 0; i < 20; i++) normal.ws.send('{"type":"restart"}'); // a busy but legitimate burst
  sendJson(normal, { type: "create", token: "T", color: "w" });
  assert.ok(await eventually(() => got(normal, (m) => m.type === "created")), "a busy but legitimate client is not limited");
  const flood = await connect(relay.port);
  for (let i = 0; i < 100; i++) flood.ws.send('{"type":"restart"}');
  assert.ok(await eventually(() => flood.closeCode !== null), "a flooding connection must be closed");
  assert.equal(flood.closeCode, 1008, "closed for breaking the policy");
  await assertStillServing(relay, "message flood");
});

test("cuts off a peer that stops reading instead of buffering for it forever", { timeout: 120000 }, async (t) => {
  // Every message the relay sends is tiny now, so the buffer limit is set low and many messages are sent: the guest's
  // socket buffers fill first, then the relay's own queue for it grows past the limit.
  const relay = await startRelay(t, { RELAY_RATE_LIMIT_MESSAGES: "1000000000", RELAY_MAX_BUFFERED_BYTES: "2048" });
  const { host, room } = await createGame(relay);
  const guest = await joinGame(relay, room);
  guest.ws.pause(); // the guest stops reading from its socket
  const batch = '{"type":"move","move":{"from":12,"to":28}}';
  for (let round = 0; round < 400 && !got(host, (m) => m.type === "opponent-left"); round++) {
    for (let i = 0; i < 1000; i++) host.ws.send(batch);
    await new Promise((resolve) => host.ws.send(batch, () => resolve())); // wait for this batch to leave before sending more
  }
  assert.ok(await eventually(() => got(host, (m) => m.type === "opponent-left"), 10000), "the relay must disconnect the guest that is not reading");
  assertAlive(relay, "slow reader");
});

test("limits open connections per address and frees the slot when one closes", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t, { RELAY_MAX_CONNECTIONS_PER_IP: "2" });
  const first = await connect(relay.port);
  const second = await connect(relay.port);
  assert.ok(await admitted(first) && (await admitted(second)), "connections within the limit are served");
  const third = await connect(relay.port);
  assert.ok(await eventually(() => third.closeCode !== null), "a connection over the limit must be closed");
  assert.equal(third.closeCode, 1013, "closed as 'try again later'");
  assert.equal(third.closeReason, "too-many-connections");
  first.ws.close();
  let served = false;
  for (let attempt = 0; attempt < 40 && !served; attempt++) {
    served = await tryAdmit(relay.port);
    if (!served) await sleep(50);
  }
  assert.ok(served, "once a connection closes, its slot must be free again");
});

test("turns an address away at the handshake once it has twice its limit open or closing", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t, { RELAY_MAX_CONNECTIONS_PER_IP: "2" });
  // Clients that never read, so they can never answer the relay's close: the two over the limit stay counted for a few seconds.
  const stuck = [];
  for (let i = 0; i < 4; i++) {
    const client = await rawUpgrade(relay.port, { pause: true });
    t.after(() => client.socket.destroy());
    stuck.push(client);
  }
  assert.deepEqual(stuck.map((c) => c.status.split(" ")[1]), ["101", "101", "101", "101"], "up to twice the limit gets as far as the polite refusal");
  const fifth = await rawUpgrade(relay.port, { pause: true });
  t.after(() => fifth.socket.destroy());
  assert.match(fifth.status, / 503 /, "the next one must be turned away before the handshake completes");
  assertAlive(relay, "connection pile-up");
});

test("drops a connection that never finishes sending its HTTP request", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t, { RELAY_HANDSHAKE_TIMEOUT_MS: "500" });
  const slow = net.connect(relay.port, "127.0.0.1");
  slow.on("error", () => {});
  slow.resume(); // read whatever the relay sends, or the socket would never notice it was closed
  let closed = false;
  slow.on("close", () => (closed = true));
  t.after(() => slow.destroy());
  slow.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n"); // the headers never end
  assert.ok(await eventually(() => closed, 6000), "a half-sent request must be dropped after the handshake timeout");
  assert.ok(await tryAdmit(relay.port), "and normal clients are unaffected");
});

// Behind a proxy every connection comes from the proxy, so the relay reads the client's address from X-Forwarded-For.
// The proxy appends the address it saw, and anything before that was written by the client, so only the entry added by
// our own proxy (counted from the right) is trusted. Each case allows one connection per address, opens one client with
// the first headers and one with the second, and says whether the second is counted as the same address (refused).
const ADDRESS_CASES = [
  { name: "a faked leftmost entry does not hide a client", first: "6.6.6.6, 10.0.0.1", second: "7.7.7.7, 10.0.0.1", sameClient: true },
  { name: "different clients behind one proxy are counted separately", first: "6.6.6.6, 10.0.0.1", second: "6.6.6.6, 10.0.0.2", sameClient: false },
  { name: "with no trusted proxy the header is ignored", env: { RELAY_TRUST_PROXY_HOPS: "0" }, first: "10.0.0.1", second: "10.0.0.2", sameClient: true },
  { name: "a header that is not an address falls back to the connection address", first: "not-an-ip", second: undefined, sameClient: true },
  { name: "an IPv4 address in IPv6 form is the same client", first: "::ffff:10.0.0.9", second: "10.0.0.9", sameClient: true },
  { name: "a header shorter than the trusted hops falls back to the connection address", env: { RELAY_TRUST_PROXY_HOPS: "2" }, first: "10.0.0.1", second: "10.0.0.2", sameClient: true },
  { name: "with two trusted proxies the second entry from the right is the client", env: { RELAY_TRUST_PROXY_HOPS: "2" }, first: "1.1.1.1, 10.0.0.1, 10.9.9.9", second: "1.1.1.1, 10.0.0.1, 10.9.9.8", sameClient: true },
  // IPv6: one machine or household gets a whole /64 (the first four groups), so that is what counts as one client.
  { name: "two addresses in the same IPv6 /64 are one client", first: "2001:db8:0:1::1", second: "2001:db8:0:1:ffff:eeee:dddd:2", sameClient: true },
  { name: "IPv6 written in a different form is the same client", first: "2001:DB8:0:1:0:0:0:1", second: "2001:db8:0:1::5", sameClient: true },
  { name: "a shortened IPv6 address is placed in the same /64 as its long form", first: "2001:db8::1", second: "2001:db8:0:0:9::2", sameClient: true },
  { name: "different IPv6 /64 networks are separate clients", first: "2001:db8:0:1::1", second: "2001:db8:0:2::1", sameClient: false },
  { name: "an IPv6 zone suffix is ignored", first: "fe80::1%eth0", second: "fe80::2", sameClient: true },
  // Some proxies add the client's port to the address.
  { name: "an IPv4 address with a port is that address", first: "10.0.0.7:5555", second: "10.0.0.7:6666", sameClient: true },
  { name: "different IPv4 addresses with ports are separate clients", first: "10.0.0.7:5555", second: "10.0.0.8:5555", sameClient: false },
  { name: "a bracketed IPv6 address with a port is that network", first: "[2001:db8:0:1::1]:443", second: "2001:db8:0:1::9", sameClient: true },
];

for (const { name, env = {}, first, second, sameClient } of ADDRESS_CASES) {
  test(`client address from X-Forwarded-For: ${name}`, { timeout: 30000 }, async (t) => {
    const relay = await startRelay(t, { RELAY_MAX_CONNECTIONS_PER_IP: "1", ...env });
    const headersFor = (value) => (value === undefined ? {} : { "X-Forwarded-For": value });
    const one = await connect(relay.port, headersFor(first));
    assert.ok(await admitted(one), "the first connection is served");
    const two = await connect(relay.port, headersFor(second));
    if (sameClient) {
      assert.ok(await eventually(() => two.closeCode !== null), "the second connection counts as the same address and must be refused");
      assert.equal(two.closeCode, 1013);
    } else {
      assert.ok(await admitted(two), "a different address must be served");
    }
  });
}

test("logs one line per new connection with the X-Forwarded-For chain and the address the limits count", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const proxied = await connect(relay.port, { "X-Forwarded-For": "1.1.1.1, 10.0.0.9" });
  const direct = await connect(relay.port);
  assert.ok((await admitted(proxied)) && (await admitted(direct)));
  assert.ok(await eventually(() => /Connection: socket=\S+ x-forwarded-for="1\.1\.1\.1, 10\.0\.0\.9" counted-as=10\.0\.0\.9\r?\n/.test(relay.stdout())), `chain line missing, log was:\n${relay.stdout()}`);
  assert.match(relay.stdout(), /Connection: socket=\S+ x-forwarded-for=none counted-as=127\.0\.0\.1\r?\n/);
  assert.match(relay.stdout(), /trusting 1 proxy hop\(s\)/, "the start-up line says how many proxies are trusted");
});

test("the connection log quotes and shortens the header, so a client cannot forge log fields or flood a line", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const quoting = await connect(relay.port, { "X-Forwarded-For": 'a" counted-as=6.6.6.6 b' });
  const long = await connect(relay.port, { "X-Forwarded-For": "a".repeat(1000) });
  assert.ok((await admitted(quoting)) && (await admitted(long)));
  assert.ok(await eventually(() => relay.stdout().includes('x-forwarded-for="a\\" counted-as=6.6.6.6 b"')), `quoted header missing, log was:\n${relay.stdout()}`);
  assert.ok(relay.stdout().includes(`x-forwarded-for="${"a".repeat(300)}"`), "a long header is cut to 300 characters");
});

test("the connection log is limited to 20 lines per 10 seconds and can be switched off", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const clients = [];
  for (let i = 0; i < 25; i++) clients.push(await connect(relay.port));
  assert.ok(await admitted(clients[24]));
  await sleep(300);
  const lines = (relay.stdout().match(/^Connection:/gm) ?? []).length;
  assert.equal(lines, 20, "a burst of 25 connections must log 20 lines, not 25");

  const quiet = await startRelay(t, { RELAY_LOG_CONNECTIONS: "off" });
  assert.ok(await admitted(await connect(quiet.port)));
  await sleep(300);
  assert.doesNotMatch(quiet.stdout(), /Connection:/, "switched off, no connection lines are written");
});

test("a refused client that ignores the close handshake is dropped soon, not held open", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t, { RELAY_MAX_CONNECTIONS_PER_IP: "1" });
  const holder = await connect(relay.port);
  assert.ok(await admitted(holder));
  // A raw connection that completes the WebSocket handshake and then never reads: it cannot answer the relay's close.
  const stubborn = await rawUpgrade(relay.port, { pause: true });
  t.after(() => stubborn.socket.destroy());
  assert.match(stubborn.status, / 101 /);
  holder.ws.close(); // one slot is free again, but the stubborn refused connection still counts until the relay drops it
  let served = false;
  for (let attempt = 0; attempt < 30 && !served; attempt++) {
    served = await tryAdmit(relay.port);
    if (!served) await sleep(300);
  }
  assert.ok(served, "the relay must drop the refused connection itself instead of waiting for its close handshake");
});

test("exits with a clear message when its port is already taken", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const { child, state } = spawnRelay(relay.port);
  t.after(() => child.kill());
  assert.ok(await eventually(() => state.exited, 10000), "the second relay must stop");
  assert.equal(state.code, 1);
  assert.match(state.stderr, /Relay server error: EADDRINUSE/);
});

test("exits with a non-zero code on any other bind error too", { timeout: 30000 }, async (t) => {
  // 203.0.113.1 is a documentation address that no machine owns, so binding to it fails with a different error.
  const { child, state } = spawnRelay(await freePort(), { RELAY_HOST: "203.0.113.1" });
  t.after(() => child.kill());
  assert.ok(await eventually(() => state.exited, 10000), `the relay must stop instead of sitting there unable to serve\n${state.stdout}${state.stderr}`);
  assert.equal(state.code, 1, `exit code, stderr: ${state.stderr}`);
  assert.match(state.stderr, /Relay server error: \w+/);
  assert.doesNotMatch(state.stderr, /EADDRINUSE/, "this test must exercise an error other than 'port in use'");
});

test("a late close from a replaced connection does not drop the rejoined player", { timeout: 30000 }, async (t) => {
  // Three connections are open and the limit is three. A new connection is only admitted once the relay has fully
  // processed the old socket's close, so that is the barrier: nothing below runs before the late close is handled.
  const relay = await startRelay(t, { RELAY_MAX_CONNECTIONS_PER_IP: "3" });
  const { host, room } = await createGame(relay);
  const guestOld = await joinGame(relay, room);
  const guestNew = await connect(relay.port); // the player reloads: rejoin on a new socket first...
  sendJson(guestNew, { type: "rejoin", room, token: "B" });
  assert.ok(await eventually(() => got(guestNew, (m) => m.type === "joined")));
  host.inbox.length = 0;
  guestOld.ws.close(); // ...then the old socket's close arrives late
  let handled = false;
  for (let attempt = 0; attempt < 60 && !handled; attempt++) {
    handled = await tryAdmit(relay.port);
    if (!handled) await sleep(25);
  }
  assert.ok(handled, "the relay must finish processing the old socket's close");
  sendJson(host, { type: "move", move: { from: 12, to: 28 } });
  assert.ok(await eventually(() => got(guestNew, (m) => m.type === "opponent-move")), "the rejoined player must still receive moves");
  assert.ok(!got(host, (m) => m.type === "opponent-left"), "the host must not be told the opponent left");
});

test("relays a normal game between two players", { timeout: 30000 }, async (t) => {
  const relay = await startRelay(t);
  const { host, room } = await createGame(relay);
  const guest = await joinGame(relay, room);
  assert.ok(guest.inbox.some((m) => m.type === "joined" && m.color === "b"));
  assert.ok(await eventually(() => got(host, (m) => m.type === "opponent-joined")));
  sendJson(host, { type: "move", move: { from: 12, to: 28 } });
  assert.ok(await eventually(() => got(guest, (m) => m.type === "opponent-move" && m.move.to === 28)));
  sendJson(guest, { type: "move", move: { from: 52, to: 36 } });
  assert.ok(await eventually(() => got(host, (m) => m.type === "opponent-move" && m.move.to === 36)));
  sendJson(host, { type: "restart" });
  assert.ok(await eventually(() => got(guest, (m) => m.type === "opponent-restart")));
  guest.ws.close();
  assert.ok(await eventually(() => got(host, (m) => m.type === "opponent-left")), "a real disconnect still notifies the opponent");
});
