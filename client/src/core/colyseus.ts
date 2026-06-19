import { Client } from "@colyseus/sdk";

// Use secure WebSocket (wss) on https hosts like Render, ws on local http.
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
export const colyseusSDK = new Client(`${protocol}//${location.host}/colyseus`);
