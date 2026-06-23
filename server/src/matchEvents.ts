import { EventEmitter } from "events";

// In-process bridge between GameRoom and LobbyRoom — both run in the same
// server process, so a plain EventEmitter is enough to let GameRoom tell
// LobbyRoom "the match for this lobby code just ended" without the two
// Colyseus rooms needing a direct reference to each other.
export const matchEvents = new EventEmitter();
