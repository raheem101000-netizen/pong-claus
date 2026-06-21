import { Room, Client } from "@colyseus/core";

const TICK_RATE     = 60;
const POINTS_TO_WIN = 10;
const TOTAL_MATCHES = 1;
const W = 400, H = 660;
const BALL_R       = Math.round(Math.min(W, H) * 0.018);
const PADDLE_LONG  = Math.round(W * 0.28);
const PADDLE_SHORT = Math.round(H * 0.018);
const BALL_SPEED   = Math.min(W, H) * 0.022;
const SPEED_MAX    = Math.min(W, H) * 0.040;
const FORGIVE      = Math.round(W * 0.05);

interface PlayerSlot { sessionId: string; bid: string | null; name: string; }
interface BallState  { x: number; y: number; vx: number; vy: number; }
interface PaddleState { x: number; y: number; score: number; }
interface GameState {
  ball: BallState; p1: PaddleState; p2: PaddleState;
  delay: number; _pendingDir?: boolean; _serveRamp?: number;
}
interface PaddleXSample { t: number; x: number; }

function initGameState(): GameState {
  return {
    ball: { x: W/2, y: H/2, vx: 0, vy: 0 },
    p1: { x: W/2 - PADDLE_LONG/2, y: H - PADDLE_SHORT - Math.round(H*0.04), score: 0 },
    p2: { x: W/2 - PADDLE_LONG/2, y: Math.round(H*0.04), score: 0 },
    delay: 180, _pendingDir: true
  };
}

export class GameRoom extends Room {
  maxClients = 4;

  private gameJoined: PlayerSlot[] = [];
  private gs: GameState | null = null;
  private gameInterval: ReturnType<typeof setInterval> | null = null;
  private broadcastCounter = 0;
  private seriesMatch = 1;
  private p1Wins = 0;
  private p2Wins = 0;
  private p1Balance = 0;
  private p2Balance = 0;
  private results: string[] = [];
  private nextMatchReady = new Set<string>();

  // Lag compensation: per-player one-way latency and paddle position history.
  private p1LatencyMs = 0;
  private p2LatencyMs = 0;
  private p1History: PaddleXSample[] = [];
  private p2History: PaddleXSample[] = [];

  onCreate() {
    this.onMessage("joinRoom", (client: Client, data: { code?: string; name?: string; bid?: string }) => {
      const name = data.name || 'Player';
      const bid = data.bid || null;

      const prior = bid ? this.gameJoined.find(p => p.bid === bid) : null;
      if (prior) {
        console.log('REBIND:', name, 'bid=' + bid, prior.sessionId, '->', client.sessionId);
        prior.sessionId = client.sessionId;
        const idx = this.gameJoined.indexOf(prior);
        client.send('roomJoined', {
          code: this.roomId, role: idx === 0 ? 'p1' : 'p2',
          myName: name, paddlePos: idx === 0 ? 'BOTTOM' : 'TOP'
        });
        return;
      }

      if (this.gameJoined.find(p => p.sessionId === client.sessionId)) return;
      if (this.gameJoined.length >= 2) return;

      this.gameJoined.push({ sessionId: client.sessionId, bid, name });
      const myIndex = this.gameJoined.length - 1;
      const role = myIndex === 0 ? 'p1' : 'p2';

      client.send('roomJoined', {
        code: this.roomId, role,
        myName: name, paddlePos: role === 'p1' ? 'BOTTOM' : 'TOP'
      });

      if (this.gameJoined.length === 2) {
        const p1 = this.gameJoined[0], p2 = this.gameJoined[1];
        const p1c = this.clients.find(c => c.sessionId === p1.sessionId);
        const p2c = this.clients.find(c => c.sessionId === p2.sessionId);
        p1c?.send('opponentName', { name: p2.name });
        p2c?.send('opponentName', { name: p1.name });
        this.startCountdown();
      }
    });

    this.onMessage("paddleMove", (client: Client, data: { x: number }) => {
      if (!this.gs) return;
      const idx = this.gameJoined.findIndex(p => p.sessionId === client.sessionId);
      if (idx === -1) { console.log('[paddleMove] DROP idx=-1 session=' + client.sessionId); return; }
      const clamped = Math.max(0, Math.min(W - PADDLE_LONG, data.x));
      if (idx === 0) this.gs.p1.x = clamped;
      if (idx === 1) this.gs.p2.x = clamped;
    });

    this.onMessage("hb", () => {});

    this.onMessage("ping", (client: Client, data: { ts: number }) => {
      client.send("pong", { ts: data.ts });
    });

    this.onMessage("latency", (client: Client, data: { ms: number }) => {
      const idx = this.gameJoined.findIndex(p => p.sessionId === client.sessionId);
      const clamped = Math.max(0, Math.min(250, data.ms | 0));
      if (idx === 0) this.p1LatencyMs = clamped;
      if (idx === 1) this.p2LatencyMs = clamped;
    });

    this.onMessage("nextMatch", (client: Client) => {
      if (!this.gameJoined.find(p => p.sessionId === client.sessionId)) return;
      this.nextMatchReady.add(client.sessionId);
      if (this.nextMatchReady.size >= 2) {
        this.nextMatchReady.clear();
        this.startNextMatch();
      } else {
        client.send('waitingForOpponent');
      }
    });
  }

  onJoin(_client: Client) {}

  onLeave(client: Client) {
    const sessionId = client.sessionId;
    console.log('LEAVE: session=' + sessionId);
    setTimeout(() => {
      const slot = this.gameJoined.find(p => p.sessionId === sessionId);
      if (!slot) { console.log('LEAVE grace: ' + sessionId + ' rebound — continuing'); return; }
      console.log('LEAVE grace expired — ending game');
      if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }
      this.broadcast('opponentLeft');
    }, 15000);
  }

  private startCountdown() {
    let count = 3;
    this.broadcast('countdown', { count });
    const t = setInterval(() => {
      count--;
      if (count > 0) this.broadcast('countdown', { count });
      else { clearInterval(t); this.startGameLoop(); }
    }, 1000);
  }

  private startGameLoop() {
    if (this.gameInterval) clearInterval(this.gameInterval);
    this.gs = initGameState();
    this.broadcastCounter = 0;
    this.p1History = [];
    this.p2History = [];
    this.gameInterval = setInterval(() => {
      if (!this.gs) return;
      const winner = this.tickBall();
      this.broadcastCounter++;
      if (this.broadcastCounter % 3 === 0 || winner || this.gs.delay > 0) {
        this.broadcast('state', {
          ball: this.gs.ball, p1: this.gs.p1, p2: this.gs.p2, delay: this.gs.delay
        });
      }
      if (winner) {
        clearInterval(this.gameInterval!); this.gameInterval = null;
        this.endMatch(winner);
      }
    }, 1000 / TICK_RATE);
  }

  private tickBall(): string | null {
    const s = this.gs!;
    const b = s.ball;
    const now = Date.now();

    // Record paddle positions for this tick, then trim history older than 300ms.
    this.p1History.push({ t: now, x: s.p1.x });
    this.p2History.push({ t: now, x: s.p2.x });
    const cutoff = now - 300;
    while (this.p1History.length > 1 && this.p1History[0].t < cutoff) this.p1History.shift();
    while (this.p2History.length > 1 && this.p2History[0].t < cutoff) this.p2History.shift();

    if (s.delay > 0) {
      s.delay--;
      if (s.delay === 0) {
        const dirX = Math.random() > 0.5 ? 1 : -1;
        const dirY = s._pendingDir !== false ? 1 : -1;
        const SERVE_START = BALL_SPEED * 0.45;
        b.vx = SERVE_START * dirX;
        b.vy = SERVE_START * dirY;
        s._serveRamp = 60;
      }
      return null;
    }

    // Rewound paddle x for each player: paddle where they saw it at their screen time.
    const p1x = this.rewindX(this.p1History, now, this.p1LatencyMs, s.p1.x);
    const p2x = this.rewindX(this.p2History, now, this.p2LatencyMs, s.p2.x);

    // Serve ramp: ease ball from 45% to full BALL_SPEED over 60 ticks.
    if (s._serveRamp && s._serveRamp > 0) {
      s._serveRamp--;
      const curSpd = Math.hypot(b.vx, b.vy);
      if (curSpd < BALL_SPEED && curSpd > 0) {
        const SERVE_START = BALL_SPEED * 0.45;
        const targetSpd = Math.min(BALL_SPEED, curSpd + (BALL_SPEED - SERVE_START) / 60);
        const scale = targetSpd / curSpd;
        b.vx *= scale; b.vy *= scale;
      }
    }

    // Sub-step so the ball never moves more than PADDLE_SHORT px per iteration.
    // Guarantees crossed-check fires even at SPEED_MAX.
    const steps = Math.max(1, Math.ceil(Math.abs(b.vy) / PADDLE_SHORT));
    const sx = b.vx / steps;
    const sy = b.vy / steps;
    for (let i = 0; i < steps; i++) {
      const prevY = b.y;
      const prevX = b.x;
      b.x += sx; b.y += sy;
      if (b.x - BALL_R < 0)  { b.x = BALL_R;     b.vx =  Math.abs(b.vx); }
      if (b.x + BALL_R > W)  { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }
      if (this.hitPaddle(s.p1, p1x, true,  prevY, prevX)) break;
      if (this.hitPaddle(s.p2, p2x, false, prevY, prevX)) break;
      if (b.y > H + 20) { s.p2.score++; this.resetBall(false); return this.checkScore(); }
      if (b.y < -20)    { s.p1.score++; this.resetBall(true);  return this.checkScore(); }
    }
    if (b.y > H + 20) { s.p2.score++; this.resetBall(false); return this.checkScore(); }
    if (b.y < -20)    { s.p1.score++; this.resetBall(true);  return this.checkScore(); }
    return null;
  }

  // Look up the interpolated paddle x from history at time (now - latencyMs).
  private rewindX(history: PaddleXSample[], now: number, latencyMs: number, fallback: number): number {
    if (latencyMs === 0 || history.length === 0) return fallback;
    const target = now - latencyMs;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].t <= target) {
        if (i + 1 < history.length) {
          const a = history[i], b = history[i + 1];
          const frac = (target - a.t) / (b.t - a.t);
          return a.x + (b.x - a.x) * frac;
        }
        return history[i].x;
      }
    }
    return history[0].x;
  }

  // Returns true if a collision occurred (caller should stop sub-stepping).
  // paddleX is the lag-compensated (rewound) horizontal position for this player;
  // p.y and p.score are always live values (Y never changes during a match).
  private hitPaddle(p: PaddleState, paddleX: number, isP1: boolean, prevY: number, prevX: number): boolean {
    const b = this.gs!.ball;

    // Velocity guard: only collide when ball is actually moving toward this paddle.
    // Prevents double-hits on the tick immediately after a bounce.
    if (isP1 ? b.vy <= 0 : b.vy >= 0) return false;

    const hitX = b.x + BALL_R > paddleX - FORGIVE && b.x - BALL_R < paddleX + PADDLE_LONG + FORGIVE;
    const hitYNow = b.y + BALL_R > p.y && b.y - BALL_R < p.y + PADDLE_SHORT;
    // paddleY is the contact edge: top for P1 (ball comes from above), bottom for P2.
    const paddleY = isP1 ? p.y : p.y + PADDLE_SHORT;
    const crossed = isP1
      ? (prevY + BALL_R < paddleY && b.y + BALL_R >= paddleY)
      : (prevY - BALL_R > paddleY && b.y - BALL_R <= paddleY);

    // Corner check: ball circle overlapping either contact-face corner point.
    // Catches diagonal approaches where neither hitYNow nor crossed fires.
    // Check both current and previous position to handle high-speed corner grazes.
    const lx = paddleX, rx = paddleX + PADDLE_LONG, fy = paddleY;
    const cornerNow  = Math.hypot(b.x   - lx, b.y   - fy) < BALL_R
                    || Math.hypot(b.x   - rx, b.y   - fy) < BALL_R;
    const cornerPrev = Math.hypot(prevX - lx, prevY - fy) < BALL_R
                    || Math.hypot(prevX - rx, prevY - fy) < BALL_R;

    if (!((hitX && (hitYNow || crossed)) || cornerNow || cornerPrev)) return false;

    const rel = (b.x - (paddleX + PADDLE_LONG / 2)) / (PADDLE_LONG / 2);
    const clamped = Math.max(-1, Math.min(1, rel));
    const spd = Math.min(Math.hypot(b.vx, b.vy) + 0.3, SPEED_MAX);
    b.vx = Math.sin(clamped * (Math.PI / 4)) * spd;
    b.vy = Math.cos(clamped * (Math.PI / 4)) * spd * (isP1 ? -1 : 1);
    b.y = isP1 ? p.y - BALL_R - 1 : p.y + PADDLE_SHORT + BALL_R + 1;
    return true;
  }

  private resetBall(towardsP1: boolean) {
    const s = this.gs!;
    s.ball.x = W/2; s.ball.y = H/2;
    s.ball.vx = 0; s.ball.vy = 0;
    // 210 ticks @ 60 fps: first 120 (2 s) the client countdown check sees count>3
    // so nothing shows — clean "see the score" pause — then 90 ticks of 3/2/1 serve.
    s.delay = 210; s._pendingDir = towardsP1;
  }

  private checkScore(): string | null {
    const s = this.gs!;
    if (s.p1.score >= POINTS_TO_WIN) return 'p1';
    if (s.p2.score >= POINTS_TO_WIN) return 'p2';
    return null;
  }

  private endMatch(winner: string) {
    const s = this.gs!;
    const p1won = winner === 'p1';
    if (p1won) { this.p1Wins++; this.p1Balance += 10; this.p2Balance -= 10; }
    else        { this.p2Wins++; this.p2Balance += 10; this.p1Balance -= 10; }
    this.results.push(winner);
    this.broadcast('matchEnd', {
      winner,
      p1Score: s.p1.score,
      p2Score: s.p2.score,
      seriesOver: this.seriesMatch >= TOTAL_MATCHES,
      match: this.seriesMatch,
      p1Wins: this.p1Wins, p2Wins: this.p2Wins,
      p1Balance: this.p1Balance, p2Balance: this.p2Balance,
      results: this.results
    });
  }

  private startNextMatch() {
    if (this.seriesMatch >= TOTAL_MATCHES) {
      this.broadcast('seriesEnd', {
        p1Wins: this.p1Wins, p2Wins: this.p2Wins,
        p1Balance: this.p1Balance, p2Balance: this.p2Balance,
        results: this.results
      });
      return;
    }
    this.seriesMatch++;
    this.gs = null;
    this.startCountdown();
  }
}
