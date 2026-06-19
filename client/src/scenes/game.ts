import { k } from "../App";
import { Room } from "@colyseus/sdk";
import type { MyRoomState } from "../../../server/src/rooms/schema/MyRoomState";

const W = 400, H = 660;
const BALL_R = Math.round(Math.min(W, H) * 0.018);
const PADDLE_LONG = Math.round(W * 0.28);
const PADDLE_SHORT = Math.round(H * 0.018);

export function createGameScene() {
  k.scene("game", ({ room, myName }: { room: Room<MyRoomState>, myName: string }) => {
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

    for (let i = 0; i < 12; i++) {
      k.add([k.rect(W * scale * 0.04, 2), k.pos(sx(W * (i / 12) + W * 0.01), sy(H / 2)), k.color(50, 50, 60)]);
    }

    const myPaddle = k.add([k.rect(PADDLE_LONG * scale, PADDLE_SHORT * scale, { radius: 4 }), k.pos(sx(W / 2 - PADDLE_LONG / 2), sy(H - PADDLE_SHORT - Math.round(H * 0.04))), k.color(76, 255, 108)]);
    const oppPaddle = k.add([k.rect(PADDLE_LONG * scale, PADDLE_SHORT * scale, { radius: 4 }), k.pos(sx(W / 2 - PADDLE_LONG / 2), sy(Math.round(H * 0.04))), k.color(255, 255, 255)]);
    const ball = k.add([k.circle(BALL_R * scale), k.pos(sx(W / 2), sy(H / 2)), k.color(255, 255, 255), k.anchor("center")]);
    const myScoreTxt = k.add([k.text("0", { size: 48 }), k.pos(sx(W * 0.5), sy(H * 0.62)), k.anchor("center"), k.color(60, 60, 70)]);
    const oppScoreTxt = k.add([k.text("0", { size: 48 }), k.pos(sx(W * 0.5), sy(H * 0.38)), k.anchor("center"), k.color(60, 60, 70)]);
    const info = k.add([k.text("Waiting for opponent...", { size: 18 }), k.pos(k.width()/2, sy(H*0.5)), k.anchor("center"), k.color(150,150,150)]);
    const codeLabel = k.add([k.text("Room code: " + room.roomId, { size: 16 }), k.pos(k.width()/2, sy(H*0.5)+40), k.anchor("center"), k.color(120,200,255)]);

    k.onUpdate(() => {
      if (!state.p1 || !state.p2 || !state.ball) return;
      const role = myRole();
      const me = role === "p1" ? state.p1 : state.p2;
      const opp = role === "p1" ? state.p2 : state.p1;
      myPaddle.pos.x = sx(role === "p2" ? W - me.x - PADDLE_LONG : me.x);
      oppPaddle.pos.x = sx(role === "p2" ? W - opp.x - PADDLE_LONG : opp.x);
      const bx = role === "p2" ? W - state.ball.x : state.ball.x;
      const by = role === "p2" ? H - state.ball.y : state.ball.y;
      ball.pos.x = sx(bx); ball.pos.y = sy(by);
      myScoreTxt.text = `${me.score}`;
      oppScoreTxt.text = `${opp.score}`;
      if (state.winner) {
        const iWon = state.winner === role;
        info.text = iWon ? "YOU WIN!" : "YOU LOSE";
        info.color = iWon ? k.rgb(76,255,108) : k.rgb(255,80,80);
        codeLabel.hidden = true;
      } else if (state.numPlayers < 2) { info.text = "Waiting for opponent..."; codeLabel.hidden = false; }
      else if (state.delay > 0) { info.text = "Get ready!"; codeLabel.hidden = true; }
      else { info.text = ""; codeLabel.hidden = true; }
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
