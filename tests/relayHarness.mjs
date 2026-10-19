// Shared test helpers: start a real copy of the relay on a free local port and talk to it like a browser would.
//
// Needs the server's dependencies installed once: npm --prefix server ci
// RELAY_PATH=<file> npm test runs the same checks against a different copy of the relay (for before/after proof).
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const SERVER_DIR = fileURLToPath(new URL("../server/", import.meta.url));
export const RELAY = process.env.RELAY_PATH || path.join(SERVER_DIR, "index.js");
export const WebSocket = createRequire(SERVER_DIR)("ws");

export const nest = (depth) => "[".repeat(depth) + "]".repeat(depth);
export const padded = (message, bytes) => JSON.stringify(message).padEnd(bytes, " "); // trailing spaces keep it valid JSON
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for a condition instead of sleeping a fixed time. Returns whether it became true.
export async function eventually(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Every test relay listens on loopback only, and starts from the same known settings whatever the developer's shell
// has set. The per-address caps start out high so only the tests about them are affected by them.
export function spawnRelay(port, env = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RELAY_")));
  const settings = { RELAY_HOST: "127.0.0.1", RELAY_MAX_CONNECTIONS_PER_IP: "1000", RELAY_MAX_ROOMS_PER_IP: "1000", ...env };
  const child = spawn(process.execPath, [RELAY], { cwd: path.dirname(RELAY), env: { ...inherited, PORT: String(port), ...settings } });
  const state = { exited: false, code: null, signal: null, stdout: "", stderr: "" };
  child.on("exit", (code, signal) => Object.assign(state, { exited: true, code, signal })); // any exit counts, including a signal
  child.stdout.on("data", (chunk) => (state.stdout += chunk));
  child.stderr.on("data", (chunk) => (state.stderr += chunk));
  return { child, state };
}

export async function startRelay(t, env = {}) {
  const port = await freePort();
  const { child, state } = spawnRelay(port, env);
  t.after(() => child.kill()); // registered first, so a slow or failed start never leaves a process running
  await eventually(() => state.stdout.includes("listening") || state.exited, 10000);
  assert.ok(!state.exited && state.stdout.includes("listening"), `relay failed to start\n${state.stderr}`);
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    alive: () => !state.exited,
    stdout: () => state.stdout,
    why: () => `exit code=${state.code} signal=${state.signal}\n${state.stderr.slice(-600)}`,
  };
}

// A bare TCP client that sends a WebSocket upgrade request by hand and resolves with the first thing the relay says
// (status is that first line, such as "HTTP/1.1 101 Switching Protocols" or "HTTP/1.1 503 Service Unavailable").
// With pause it then stops reading, so it can never answer a close: a client that ignores the close handshake.
export function rawUpgrade(port, { pause = false } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const client = { socket, status: "", closed: false };
    socket.on("error", () => {});
    socket.on("close", () => {
      client.closed = true;
      resolve(client);
    });
    socket.once("connect", () =>
      socket.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
    );
    socket.once("data", (chunk) => {
      client.status = chunk.toString("latin1").split("\r\n")[0];
      if (pause) socket.pause();
      resolve(client);
    });
  });
}

// headers: what a proxy in front of the relay would add, such as { "X-Forwarded-For": "203.0.113.5" }.
export function connect(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    const client = { ws, inbox: [], closeCode: null, closeReason: null };
    let opened = false;
    ws.on("message", (data) => client.inbox.push(JSON.parse(data.toString())));
    ws.on("open", () => {
      opened = true;
      resolve(client);
    });
    ws.on("close", (code, reason) => {
      client.closeCode = code;
      client.closeReason = reason.toString();
    });
    // After it is open, the relay may cut this client off on purpose (oversize frames, rate limit).
    ws.on("error", (err) => !opened && reject(err));
  });
}

export const sendJson = (client, message) => client.ws.send(JSON.stringify(message));
export const got = (client, predicate) => client.inbox.some(predicate);
export const assertAlive = (relay, what) => assert.ok(relay.alive(), `relay must survive: ${what}\n${relay.why()}`);

// The barrier for "nothing bad happened": a brand-new client must still get an answer, which proves the relay was
// still running after whatever came before. No sleeping.
export async function assertStillServing(relay, what) {
  const probe = await connect(relay.port);
  sendJson(probe, { type: "create", token: "probe", color: "w" });
  assert.ok(await eventually(() => got(probe, (m) => m.type === "created" || m.type === "error")), `relay stopped answering after: ${what}\n${relay.why()}`);
  assertAlive(relay, what);
  probe.ws.close();
}

// Did the relay accept this connection? One it accepts answers a request; one it refuses is closed straight away.
export async function admitted(client) {
  try {
    sendJson(client, { type: "join", room: "ZZZZZ", token: "probe" });
  } catch {
    // already closed by the relay
  }
  await eventually(() => client.closeCode !== null || got(client, (m) => m.type === "error"));
  return client.closeCode === null && got(client, (m) => m.message === "room-not-found");
}

// A whole new connection: was it accepted and served? A relay that turns the handshake away counts as "no".
export async function tryAdmit(port, headers = {}) {
  try {
    const client = await connect(port, headers);
    const served = await admitted(client);
    client.ws.close();
    return served;
  } catch {
    return false;
  }
}

// How long a brand-new client waits for the relay's first answer, in milliseconds.
export async function timeToAnswer(relay) {
  const started = Date.now();
  const probe = await connect(relay.port);
  sendJson(probe, { type: "join", room: "ZZZZZ", token: "probe" });
  await eventually(() => got(probe, (m) => m.type === "error"), 30000);
  probe.ws.close();
  return Date.now() - started;
}

export async function createGame(relay, token = "A", headers = {}) {
  const host = await connect(relay.port, headers);
  sendJson(host, { type: "create", token, color: "w", timeControl: "none" });
  assert.ok(await eventually(() => got(host, (m) => m.type === "created")), "host should get a room");
  return { host, room: host.inbox.find((m) => m.type === "created").room };
}

export async function joinGame(relay, room, token = "B", headers = {}) {
  const guest = await connect(relay.port, headers);
  sendJson(guest, { type: "join", room, token });
  assert.ok(await eventually(() => got(guest, (m) => m.type === "joined")), "guest should join");
  return guest;
}
