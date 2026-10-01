import { randomBytes } from "crypto";

/**
 * One-time tickets that let the Pong LobbyRoom — and only the lobby — start a
 * game_room. Room types registered with defineRoom can also be created by any
 * client through matchmaking (POST /matchmake/create/game_room), and the
 * options there are client-controlled, so without this a logged-in player
 * could open a match room with a roster of their choosing and collect a
 * win credit without going through a lobby. A ticket is 128 random bits held
 * only in this server's memory and consumed on first use, so a client can't
 * forge or replay one.
 */
const TICKET_TTL_MS = 60_000;
const tickets = new Map<string, number>(); // ticket -> expiry (ms epoch)

export function issueLaunchTicket(): string {
  const now = Date.now();
  for (const [t, exp] of tickets) if (exp < now) tickets.delete(t);
  const ticket = randomBytes(16).toString("hex");
  tickets.set(ticket, now + TICKET_TTL_MS);
  return ticket;
}

export function consumeLaunchTicket(ticket: unknown): boolean {
  if (typeof ticket !== "string") return false;
  const exp = tickets.get(ticket);
  tickets.delete(ticket);
  return exp !== undefined && exp >= Date.now();
}
