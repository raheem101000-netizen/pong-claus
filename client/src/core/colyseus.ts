import { Client } from "@colyseus/sdk";

// Matchmaking lives at the server root. The /colyseus path is only the monitor
// dashboard, so the client connects to the host root, not /colyseus.
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
export const colyseusSDK = new Client(`${protocol}//${location.host}`);
