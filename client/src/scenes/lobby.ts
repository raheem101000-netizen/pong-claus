import { k } from "../App";
import { Room } from "@colyseus/sdk";
import type { MyRoomState } from "../../../server/src/rooms/schema/MyRoomState";

const W = 400, H = 660;
const BALL_R = Math.round(Math.min(W, H) * 0.018);
const PADDLE_LONG = Math.round(W * 0.28);
const PADDLE_SHORT = Math.round(H * 0.018);

export function createLobbyScene() {
  k.scene("lobby", (room: Room<MyRoomState>) => {
    const state = room.state;
    const mySessionId = room.sessionId;

    const scale = Math.min(k.width() / W, k.height() / H);
    const offsetX = (k.width() - W * scale) / 2;
    const offsetY = (k.height() - H * scale) / 2;
    const sx = (x: number) => offsetX + x * scale;
    const sy = (y: number) => offsetY + y * scale;

    function myRole(): "p1" | "p2" {
      if (state.p2 && state.p2.sessionId === mySessionId) return "p2";
      return "p1";
    }

    const myPaddleObj = k.add([
      k.rect(PADDLE_LONG * scale, PADDLE_SHORT * scale),
      k.pos(sx(W / 2 - PADDLE_LONG / 2), sy(H - PADDLE_SHORT - Math.round(H * 0.04))),
      k.color(76, 255, 108),
    ]);

    const oppPaddleObj = k.add([
      k.rect(PADDLE_LONG * scale, PADDLE_SHORT * scale),
      k.pos(sx(W / 2 - PADDLE_LONG / 2), sy(Math.round(H * 0.04))),
      k.color(255, 255, 255),
    ]);

    const ballObj = k.add([
      k.circle(BALL_R * scale),
      k.pos(sx(W / 2), sy(H / 2)),
      k.color(255, 255, 255),
      k.anchor("center"),
    ]);

    k.onUpdate(() => {
      if (!state.p1 || !state.p2 || !state.ball) return;
      const role = myRole();
      const me = role === "p1" ? state.p1 : state.p2;
      const opp = role === "p1" ? state.p2 : state.p1;

      const myX = role === "p2" ? W - me.x - PADDLE_LONG : me.x;
      const oppX = role === "p2" ? W - opp.x - PADDLE_LONG : opp.x;
      myPaddleObj.pos.x = sx(myX);
      oppPaddleObj.pos.x = sx(oppX);

      const bx = role === "p2" ? W - state.ball.x : state.ball.x;
      const by = role === "p2" ? H - state.ball.y : state.ball.y;
      ballObj.pos.x = sx(bx);
      ballObj.pos.y = sy(by);
    });

    function sendMove(screenX: number) {
      let serverX = (screenX - offsetX) / scale - PADDLE_LONG / 2;
      if (myRole() === "p2") serverX = W - serverX - PADDLE_LONG;
      serverX = Math.max(0, Math.min(W - PADDLE_LONG, serverX));
      room.send("move", { x: serverX });
    }
    k.onMouseMove((pos: any) => { if (k.isMouseDown()) sendMove(pos.x); });
    k.onMouseDown((pos: any) => sendMove(pos.x));

    k.onUpdate(() => {
      if (!state.p1 || !state.p2) return;
      const role = myRole();
      const me = role === "p1" ? state.p1 : state.p2;
      const speed = W * 0.028;
      let dir = 0;
      if (k.isKeyDown("left") || k.isKeyDown("a")) dir -= 1;
      if (k.isKeyDown("right") || k.isKeyDown("d")) dir += 1;
      if (dir !== 0) {
        let nx = me.x + dir * speed * (role === "p2" ? -1 : 1);
        nx = Math.max(0, Math.min(W - PADDLE_LONG, nx));
        room.send("move", { x: nx });
      }
    });
  });
}
