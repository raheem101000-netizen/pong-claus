import { Room, Client } from "@colyseus/core";
import { MyRoomState, Paddle } from "./schema/MyRoomState";

const W = 400, H = 660;
const BALL_R       = Math.round(Math.min(W, H) * 0.018);
const PADDLE_LONG  = Math.round(W * 0.28);
const PADDLE_SHORT = Math.round(H * 0.018);
const BALL_SPEED   = Math.min(W, H) * 0.022;
const SPEED_MAX    = Math.min(W, H) * 0.040;
const WIN_SCORE    = 7;
const FORGIVE      = Math.round(W * 0.05);

export class MyRoom extends Room {
  maxClients = 2;
  state = new MyRoomState();

  onCreate() {
    this.state.p1.x = W / 2 - PADDLE_LONG / 2;
    this.state.p1.y = H - PADDLE_SHORT - Math.round(H * 0.04);
    this.state.p2.x = W / 2 - PADDLE_LONG / 2;
    this.state.p2.y = Math.round(H * 0.04);
    this.resetBall(true);

    this.onMessage("move", (client, message: { x: number }) => {
      const paddle = this.paddleFor(client.sessionId);
      if (!paddle) return;
      paddle.x = Math.max(0, Math.min(W - PADDLE_LONG, message.x));
    });

    this.setSimulationInterval(() => this.tick(), 1000 / 60);
  }

  paddleFor(sessionId: string): Paddle | null {
    if (this.state.p1.sessionId === sessionId) return this.state.p1;
    if (this.state.p2.sessionId === sessionId) return this.state.p2;
    return null;
  }

  onJoin(client: Client) {
    if (!this.state.p1.sessionId) {
      this.state.p1.sessionId = client.sessionId;
    } else if (!this.state.p2.sessionId) {
      this.state.p2.sessionId = client.sessionId;
    }
    this.state.numPlayers++;
    if (this.state.numPlayers === 2) {
      this.state.playing = true;
      this.state.delay = 180;
    }
    console.log(client.sessionId, "joined as",
      this.state.p1.sessionId === client.sessionId ? "p1" : "p2");
  }

  onLeave(client: Client) {
    if (this.state.p1.sessionId === client.sessionId) this.state.p1.sessionId = "";
    if (this.state.p2.sessionId === client.sessionId) this.state.p2.sessionId = "";
    this.state.numPlayers--;
    this.state.playing = false;
  }

  resetBall(towardP1: boolean) {
    const b = this.state.ball;
    b.x = W / 2; b.y = H / 2; b.vx = 0; b.vy = 0;
    this.state.delay = 120;
    (this.state as any)._pendingDir = towardP1;
  }

  tick() {
    if (!this.state.playing) return;
    const s = this.state, b = s.ball;

    if (s.delay > 0) {
      s.delay--;
      if (s.delay === 0) {
        b.vx = BALL_SPEED * (Math.random() > 0.5 ? 1 : -1);
        b.vy = BALL_SPEED * ((s as any)._pendingDir !== false ? 1 : -1);
      }
      return;
    }

    b.x += b.vx; b.y += b.vy;

    if (b.x - BALL_R < 0) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
    if (b.x + BALL_R > W) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }

    this.hitPaddle(s.p1, true);
    this.hitPaddle(s.p2, false);

    if (b.y > H + 20) { s.p2.score++; this.afterScore(false); return; }
    if (b.y < -20)    { s.p1.score++; this.afterScore(true);  return; }
  }

  hitPaddle(p: Paddle, isP1: boolean) {
    const b = this.state.ball;
    const prevY = b.y - b.vy;
    const hitX = b.x + BALL_R > p.x - FORGIVE && b.x - BALL_R < p.x + PADDLE_LONG + FORGIVE;
    const hitYNow = b.y + BALL_R > p.y && b.y - BALL_R < p.y + PADDLE_SHORT;
    const paddleY = isP1 ? p.y : p.y + PADDLE_SHORT;
    const crossed = isP1
      ? (prevY - BALL_R > paddleY && b.y - BALL_R <= paddleY)
      : (prevY + BALL_R < paddleY && b.y + BALL_R >= paddleY);

    if (hitX && (hitYNow || crossed)) {
      const rel = (b.x - (p.x + PADDLE_LONG / 2)) / (PADDLE_LONG / 2);
      const clampedRel = Math.max(-1, Math.min(1, rel));
      const spd = Math.min(Math.hypot(b.vx, b.vy) + 0.3, SPEED_MAX);
      b.vx = Math.sin(clampedRel * (Math.PI / 4)) * spd;
      b.vy = Math.cos(clampedRel * (Math.PI / 4)) * spd * (isP1 ? -1 : 1);
      b.y = isP1 ? p.y - BALL_R - 1 : p.y + PADDLE_SHORT + BALL_R + 1;
    }
  }

  afterScore(towardP1: boolean) {
    if (this.state.p1.score >= WIN_SCORE || this.state.p2.score >= WIN_SCORE) {
      this.state.playing = false;
      return;
    }
    this.resetBall(towardP1);
  }
}
