/**
 * Turns the short error codes from the relay server (and from RoomConnection when the socket fails) into sentences
 * a player can act on. Pure text, no DOM, so it can be tested on its own.
 */
export type OnlineAction = "create" | "join" | "rejoin";

const MESSAGES: Record<string, string> = {
  "room-full": "That room is already full.",
  "room-not-found": "Room not found — check the code. Rooms expire a few minutes after their host leaves.",
  "server-busy": "The server is busy right now. Please try again in a few minutes.",
  "too-many-rooms": "Too many games have been started from your network recently. Join an existing game, or try again in a few minutes.",
  "too-many-connections": "There are too many connections from your network right now. Close other tabs or try again shortly.",
  "already-in-room": "This tab is already in a game. Leave it first, or reload the page.",
  "bad-request": "The server could not read that request. Reload the page and try again.",
  "connection-failed": "Could not reach the game server. Check your connection and try again.",
  "connection-closed": "The connection to the game server was lost. Please try again.",
};

const GENERIC: Record<OnlineAction, string> = {
  create: "Could not create a game. Please try again.",
  join: "Could not join that game. Please try again.",
  rejoin: "Could not reconnect to your game.",
};

export function describeRelayError(code: string | undefined, action: OnlineAction): string {
  const known = code === undefined ? undefined : Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : undefined;
  return known ?? GENERIC[action];
}

/** The saved game can never be resumed: the room is gone, or the saved token was not accepted. Anything else may pass. */
export function isPermanentRejoinFailure(code: string | undefined): boolean {
  return code === "room-not-found" || code === "bad-request";
}

/** What to tell a player whose attempt to resume a saved game failed. */
export function describeRejoinError(code: string | undefined): string {
  if (code === "room-not-found") return "Your last game has ended or expired, so it can't be resumed. Start or join a new one.";
  if (isPermanentRejoinFailure(code)) return "Your saved game could not be resumed. Start or join a new one.";
  return `${describeRelayError(code, "rejoin")} Your game is still saved: reload the page to try again, or press Cancel to give it up.`;
}
