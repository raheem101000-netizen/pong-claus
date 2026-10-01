import { Room, Client } from "@colyseus/core";
import { authenticateGameToken, PongAuth } from "../auth";
import { consumeLaunchTicket } from "../launchTickets";
import { creditPongWin } from "../payouts";

const TICK_RATE     = 60;
// First to 10 wins. PONG_POINTS_TO_WIN overrides it for local tests only (never set in production).
const POINTS_TO_WIN = Number(process.env.PONG_POINTS_TO_WIN) || 10;
const W = 400, H = 660;
const BALL_R       = Math.round(Math.min(W, H) * 0.018);
const PADDLE_LONG  = Math.round(W * 0.28);
const PADDLE_SHORT = Math.round(H * 0.018);
const BALL_SPEED   = Math.min(W, H) * 0.022;
const SPEED_MAX    = Math.min(W, H) * 0.040;
const FORGIVE      = Math.round(W * 0.05);
// Longest a missed crossing is held open waiting for the defender's input.
const MISS_WINDOW_MAX_MS = 250;

const POWERUP_TYPES: Record<string, { emoji: string; color: string; duration: number }> = {
  ice:    { emoji: '❄️',  color: '#00cfff', duration: 3000 },
  fire:   { emoji: '🔥',  color: '#ff6600', duration: 3000 },
  shrink: { emoji: '🔒',  color: '#cc44ff', duration: 4000 },
  ghost:  { emoji: '👻',  color: '#aaffaa', duration: 3000 },
};
const POWERUP_KEYS = Object.keys(POWERUP_TYPES);
const OBSTACLE_INTERVAL = 480;

interface PlayerSlot { sessionId: string; bid: string | null; name: string; userId: number; }
interface BallState  { x: number; y: number; vx: number; vy: number; lastHitter: 'p1' | 'p2' | null; }
interface PaddleState { x: number; y: number; score: number; }
interface PowerupState { type: string; x: number; y: number; r: number; life: number; pulse: number; }
interface EffectState { type: string; expires: number; }
interface ObstacleState { x: number; y: number; w: number; h: number; life: number; }
interface GameState {
  ball: BallState; p1: PaddleState; p2: PaddleState;
  delay: number; _pendingDir?: boolean; _serveRamp?: number;
  powerup: PowerupState | null;
  powerupSpawnIn: number;
  activeEffects: { p1?: EffectState; p2?: EffectState; ball?: EffectState };
  obstacles: ObstacleState[];
  obstacleTimer: number;
  bannerSeq: number; bannerText: string; bannerColor: string;
}
// A ball that crossed a paddle's line while the paddle wasn't there (yet).
// Judged once that player's input from the moment they SAW the crossing has
// had time to arrive (see tickBall).
interface PendingMiss { x: number; t: number; until: number; }

function randomPowerupSpawnTicks(): number {
  return Math.floor((5 + Math.random() * 6) * TICK_RATE);
}

function initGameState(): GameState {
  return {
    ball: { x: W/2, y: H/2, vx: 0, vy: 0, lastHitter: null },
    p1: { x: W/2 - PADDLE_LONG/2, y: H - PADDLE_SHORT - Math.round(H*0.04), score: 0 },
    p2: { x: W/2 - PADDLE_LONG/2, y: Math.round(H*0.04), score: 0 },
    delay: 180, _pendingDir: true,
    powerup: null,
    powerupSpawnIn: randomPowerupSpawnTicks(),
    activeEffects: {},
    obstacles: [],
    obstacleTimer: 0,
    bannerSeq: 0, bannerText: '', bannerColor: ''
  };
}

export class GameRoom extends Room {
  maxClients = 4;

  private gameJoined: PlayerSlot[] = [];
  private gs: GameState | null = null;
  private gameInterval: ReturnType<typeof setInterval> | null = null;
  private broadcastCounter = 0;
  private p1Wins = 0;
  private p2Wins = 0;

  // Lag compensation: per-player one-way latency (from the client's pings) and
  // any not-yet-judged miss per side.
  private p1LatencyMs = 0;
  private p2LatencyMs = 0;
  private pendingMiss: { p1?: PendingMiss; p2?: PendingMiss } = {};
  // The two lobby accounts allowed in this match, and whether its result has
  // been credited (a game_room hosts exactly one match).
  private allowedUserIds: number[] = [];
  private matchSettled = false;

  static async onAuth(token: string, options: any) {
    return authenticateGameToken(token, options?.playerId);
  }

  onCreate(options: any) {
    // Only the lobby may start a match room (launchTickets.ts), for exactly
    // the two accounts that were in the lobby room.
    if (!consumeLaunchTicket(options?.launchTicket)) {
      throw new Error("Matches can only be started from a lobby");
    }
    const ids = Array.isArray(options?.allowedUserIds) ? options.allowedUserIds : [];
    if (ids.length !== 2 || new Set(ids).size !== 2 || !ids.every((n: unknown) => Number.isInteger(n))) {
      throw new Error("A match needs exactly two different players");
    }
    this.allowedUserIds = ids;

    this.onMessage("joinRoom", (client: Client, data: { code?: string; name?: string; bid?: string }) => {
      // Identity comes from the login token (onAuth), never from the client.
      const auth = client.auth as PongAuth;
      const name = auth.displayName || 'Player';
      const bid = data.bid || null;

      // Reconnect / second tab: the same account takes its existing slot back.
      const prior = this.gameJoined.find(p => p.userId === auth.userId) || null;
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

      this.gameJoined.push({ sessionId: client.sessionId, bid, name, userId: auth.userId });
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
      const key: 'p1' | 'p2' = idx === 0 ? 'p1' : 'p2';
      if (this.isFrozen(key)) return;
      const len = this.getPaddleLen(key);
      const clamped = Math.max(0, Math.min(W - len, data.x));
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

  }

  onJoin(_client: Client, _options: any, auth: PongAuth) {
    if (!this.allowedUserIds.includes(auth.userId)) {
      throw new Error("You're not a player in this match");
    }
  }

  onLeave(client: Client) {
    const sessionId = client.sessionId;
    console.log('LEAVE: session=' + sessionId);
    setTimeout(() => {
      const slot = this.gameJoined.find(p => p.sessionId === sessionId);
      if (!slot) { console.log('LEAVE grace: ' + sessionId + ' rebound — continuing'); return; }
      console.log('LEAVE grace expired — ending game');
      const wasPlaying = !!this.gs; // a match was in progress (not countdown, not already finished)
      if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }

      // Walkover (same as FIFA / Puz Royale / Kurver): the player who left
      // didn't come back within the grace, so the opponent who is still here
      // wins — through the same endMatch → creditWinner path and the same
      // 'pongmp:<roomId>' key, so a normal finish and a walkover can't both pay.
      const other = this.gameJoined.find(p => p !== slot);
      const otherStillHere = !!other && this.clients.some(c => c.sessionId === other.sessionId);
      if (wasPlaying && otherStillHere && !this.matchSettled) {
        console.log('WALKOVER: ' + slot.name + ' left — ' + other!.name + ' wins');
        this.endMatch(this.gameJoined.indexOf(other!) === 0 ? 'p1' : 'p2', true);
        return;
      }
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
    this.pendingMiss = {};
    this.gameInterval = setInterval(() => {
      if (!this.gs) return;
      const winner = this.tickBall();
      this.broadcastCounter++;
      // Every tick (60 Hz): the opponent's paddle and the ball reach each
      // player as soon as the server has them (was every 2nd tick = 30 Hz).
      {
        this.broadcast('state', {
          ball: this.gs.ball, p1: this.gs.p1, p2: this.gs.p2, delay: this.gs.delay,
          powerup: this.gs.powerup,
          activeEffects: this.gs.activeEffects,
          obstacles: this.gs.obstacles,
          bannerSeq: this.gs.bannerSeq, bannerText: this.gs.bannerText, bannerColor: this.gs.bannerColor
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

    this.tickEffects();
    this.tickPowerupSpawn();
    this.tickObstacleSpawn();

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

    const p1x = s.p1.x, p2x = s.p2.x;
    const p1Len = this.getPaddleLen('p1');
    const p2Len = this.getPaddleLen('p2');

    // A pending miss becomes a hit if the paddle reaches the crossing point
    // before that player's window closes; otherwise the miss stands.
    for (const key of ['p1', 'p2'] as const) {
      const pm = this.pendingMiss[key];
      if (!pm) continue;
      if (now > pm.until) { delete this.pendingMiss[key]; continue; }
      if (this.coversX(key === 'p1' ? p1x : p2x, key === 'p1' ? p1Len : p2Len, pm.x)) {
        this.lateHit(key, pm, key === 'p1' ? p1x : p2x, key === 'p1' ? p1Len : p2Len, now);
        delete this.pendingMiss[key];
      }
    }

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
      this.checkObstacleCollisions();
      if (this.hitPaddle(s.p1, p1x, true,  prevY, prevX, p1Len)) { delete this.pendingMiss.p1; break; }
      if (this.hitPaddle(s.p2, p2x, false, prevY, prevX, p2Len)) { delete this.pendingMiss.p2; break; }
      this.notePendingMiss('p1', prevY, now);
      this.notePendingMiss('p2', prevY, now);
      if (this.scoreIfOut()) return this.checkScore();
    }
    if (this.scoreIfOut()) return this.checkScore();
    this.checkPowerupCollision();
    return null;
  }

  // ── Lag compensation ("favour the defender") ─────────────────────────────
  // Each player draws their OWN paddle immediately (client-side prediction),
  // but sees the ball ~one-way-latency late, and their input reaches us
  // another one-way-latency later. So when the ball crosses a paddle's line
  // here, the input showing where that player's paddle was when THEY saw the
  // crossing is still up to 2 × latency away. Instead of calling the miss at
  // once, it's held open that long; if the paddle arrives at the crossing
  // point in time, it counts as a hit (lateHit). Capped so a slow connection
  // can't stretch it.
  private missWindowMs(key: 'p1' | 'p2'): number {
    const lat = key === 'p1' ? this.p1LatencyMs : this.p2LatencyMs;
    return Math.max(1000 / TICK_RATE, Math.min(MISS_WINDOW_MAX_MS, 2 * lat + 1000 / TICK_RATE));
  }

  private coversX(paddleX: number, len: number, x: number): boolean {
    return x + BALL_R > paddleX - FORGIVE && x - BALL_R < paddleX + len + FORGIVE;
  }

  // Ball crossed this player's contact line moving toward them without a hit:
  // open a pending miss (once per crossing).
  private notePendingMiss(key: 'p1' | 'p2', prevY: number, now: number) {
    if (this.pendingMiss[key]) return;
    const s = this.gs!, b = s.ball, isP1 = key === 'p1';
    if (isP1 ? b.vy <= 0 : b.vy >= 0) return;
    const p = isP1 ? s.p1 : s.p2;
    const paddleY = isP1 ? p.y : p.y + PADDLE_SHORT;
    const crossed = isP1
      ? (prevY + BALL_R < paddleY && b.y + BALL_R >= paddleY)
      : (prevY - BALL_R > paddleY && b.y - BALL_R <= paddleY);
    if (crossed) this.pendingMiss[key] = { x: b.x, t: now, until: now + this.missWindowMs(key) };
  }

  // Score only once no pending miss is still open for the side that let it through.
  private scoreIfOut(): boolean {
    const s = this.gs!, b = s.ball;
    if (b.y > H + 20 && !this.pendingMiss.p1) { s.p2.score++; this.resetBall(false); return true; }
    if (b.y < -20    && !this.pendingMiss.p2) { s.p1.score++; this.resetBall(true);  return true; }
    return false;
  }

  // A pending miss turned out to be a hit: bounce as hitPaddle would have at
  // the crossing point, then carry the ball on for the time already elapsed.
  private lateHit(key: 'p1' | 'p2', pm: PendingMiss, paddleX: number, len: number, now: number) {
    const s = this.gs!, b = s.ball, isP1 = key === 'p1', p = isP1 ? s.p1 : s.p2;
    const rel = Math.max(-1, Math.min(1, (pm.x - (paddleX + len / 2)) / (len / 2)));
    const spd = Math.min(Math.hypot(b.vx, b.vy) + 0.3, SPEED_MAX);
    b.vx = Math.sin(rel * (Math.PI / 4)) * spd;
    b.vy = Math.cos(rel * (Math.PI / 4)) * spd * (isP1 ? -1 : 1);
    const ticks = Math.min(30, Math.max(0, (now - pm.t) / (1000 / TICK_RATE)));
    b.x = pm.x + b.vx * ticks;
    b.y = (isP1 ? p.y - BALL_R - 1 : p.y + PADDLE_SHORT + BALL_R + 1) + b.vy * ticks;
    if (b.x - BALL_R < 0) { b.x = 2 * BALL_R - b.x; b.vx =  Math.abs(b.vx); }
    if (b.x + BALL_R > W) { b.x = 2 * (W - BALL_R) - b.x; b.vx = -Math.abs(b.vx); }
    b.lastHitter = key;
  }

  // Returns true if a collision occurred (caller should stop sub-stepping).
  // paddleX is the player's current horizontal position (missed crossings are
  // held open by the pending-miss window above); p.y never changes during a match.
  private hitPaddle(p: PaddleState, paddleX: number, isP1: boolean, prevY: number, prevX: number, len: number): boolean {
    const b = this.gs!.ball;

    // Velocity guard: only collide when ball is actually moving toward this paddle.
    // Prevents double-hits on the tick immediately after a bounce.
    if (isP1 ? b.vy <= 0 : b.vy >= 0) return false;

    const hitX = b.x + BALL_R > paddleX - FORGIVE && b.x - BALL_R < paddleX + len + FORGIVE;
    const hitYNow = b.y + BALL_R > p.y && b.y - BALL_R < p.y + PADDLE_SHORT;
    // paddleY is the contact edge: top for P1 (ball comes from above), bottom for P2.
    const paddleY = isP1 ? p.y : p.y + PADDLE_SHORT;
    const crossed = isP1
      ? (prevY + BALL_R < paddleY && b.y + BALL_R >= paddleY)
      : (prevY - BALL_R > paddleY && b.y - BALL_R <= paddleY);

    // Corner check: ball circle overlapping either contact-face corner point.
    // Catches diagonal approaches where neither hitYNow nor crossed fires.
    // Check both current and previous position to handle high-speed corner grazes.
    const lx = paddleX, rx = paddleX + len, fy = paddleY;
    const cornerNow  = Math.hypot(b.x   - lx, b.y   - fy) < BALL_R
                    || Math.hypot(b.x   - rx, b.y   - fy) < BALL_R;
    const cornerPrev = Math.hypot(prevX - lx, prevY - fy) < BALL_R
                    || Math.hypot(prevX - rx, prevY - fy) < BALL_R;

    if (!((hitX && (hitYNow || crossed)) || cornerNow || cornerPrev)) return false;

    const rel = (b.x - (paddleX + len / 2)) / (len / 2);
    const clamped = Math.max(-1, Math.min(1, rel));
    const spd = Math.min(Math.hypot(b.vx, b.vy) + 0.3, SPEED_MAX);
    b.vx = Math.sin(clamped * (Math.PI / 4)) * spd;
    b.vy = Math.cos(clamped * (Math.PI / 4)) * spd * (isP1 ? -1 : 1);
    b.y = isP1 ? p.y - BALL_R - 1 : p.y + PADDLE_SHORT + BALL_R + 1;
    b.lastHitter = isP1 ? 'p1' : 'p2';
    return true;
  }

  private resetBall(towardsP1: boolean) {
    const s = this.gs!;
    s.ball.x = W/2; s.ball.y = H/2;
    s.ball.vx = 0; s.ball.vy = 0;
    s.ball.lastHitter = null;
    delete s.activeEffects.ball;
    this.pendingMiss = {};
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

  // ── EFFECTS ──────────────────────────────────────────────────────────────
  private getPaddleLen(key: 'p1' | 'p2'): number {
    const eff = this.gs?.activeEffects[key];
    return (eff && eff.type === 'shrink') ? PADDLE_LONG * 0.45 : PADDLE_LONG;
  }

  private isFrozen(key: 'p1' | 'p2'): boolean {
    const eff = this.gs?.activeEffects[key];
    return !!(eff && eff.type === 'frozen');
  }

  private tickEffects() {
    const s = this.gs!;
    const now = Date.now();
    (['p1', 'p2', 'ball'] as const).forEach((key) => {
      const eff = s.activeEffects[key];
      if (eff && eff.expires < now) {
        if (key === 'ball' && eff.type === 'fire') {
          const spd = BALL_SPEED;
          const a = Math.atan2(s.ball.vy, s.ball.vx);
          s.ball.vx = Math.cos(a) * spd;
          s.ball.vy = Math.sin(a) * spd;
        }
        delete s.activeEffects[key];
      }
    });
  }

  private setBanner(text: string, color: string) {
    const s = this.gs!;
    s.bannerSeq++; s.bannerText = text; s.bannerColor = color;
  }

  // ── POWER-UPS ────────────────────────────────────────────────────────────
  private tickPowerupSpawn() {
    const s = this.gs!;
    if (s.powerup) {
      s.powerup.pulse++;
      s.powerup.life--;
      if (s.powerup.life <= 0) {
        s.powerup = null;
        s.powerupSpawnIn = randomPowerupSpawnTicks();
      }
      return;
    }
    if (s.powerupSpawnIn > 0) { s.powerupSpawnIn--; return; }
    this.spawnPowerup();
  }

  private spawnPowerup() {
    const s = this.gs!;
    const type = POWERUP_KEYS[Math.floor(Math.random() * POWERUP_KEYS.length)];
    const margin = Math.min(W, H) * 0.12;
    s.powerup = {
      type,
      x: margin + Math.random() * (W - margin * 2),
      y: H * 0.28 + Math.random() * H * 0.44,
      r: Math.min(W, H) * 0.042,
      life: 300,
      pulse: 0
    };
  }

  private checkPowerupCollision() {
    const s = this.gs!;
    if (!s.powerup) return;
    const b = s.ball;
    if (Math.hypot(b.x - s.powerup.x, b.y - s.powerup.y) < BALL_R + s.powerup.r) {
      // Fresh serve nobody has actually hit yet — no legitimate beneficiary/victim,
      // so leave the power-up un-consumed rather than crediting a player who never touched it.
      if (b.lastHitter === null) return;
      const victim: 'p1' | 'p2' = b.lastHitter === 'p1' ? 'p2' : 'p1';
      this.applyPowerup(s.powerup.type, victim);
      s.powerup = null;
      s.powerupSpawnIn = randomPowerupSpawnTicks();
    }
  }

  private applyPowerup(type: string, victim: 'p1' | 'p2') {
    const s = this.gs!;
    const def = POWERUP_TYPES[type];
    const expires = Date.now() + def.duration;
    const vName = this.gameJoined[victim === 'p1' ? 0 : 1]?.name || (victim === 'p1' ? 'P1' : 'P2');
    if (type === 'ice') {
      s.activeEffects[victim] = { type: 'frozen', expires };
      s.activeEffects.ball = { type: 'ice', expires };
      this.setBanner(`${def.emoji} ${vName} FROZEN!`, def.color);
    } else if (type === 'fire') {
      s.activeEffects.ball = { type: 'fire', expires };
      const spd = Math.min(Math.hypot(s.ball.vx, s.ball.vy) * 1.6, SPEED_MAX * 1.3);
      const a = Math.atan2(s.ball.vy, s.ball.vx);
      s.ball.vx = Math.cos(a) * spd; s.ball.vy = Math.sin(a) * spd;
      this.setBanner(`${def.emoji} FIRE BALL!`, def.color);
    } else if (type === 'shrink') {
      s.activeEffects[victim] = { type: 'shrink', expires };
      this.setBanner(`${def.emoji} ${vName} SHRUNK!`, def.color);
    } else if (type === 'ghost') {
      s.activeEffects.ball = { type: 'ghost', expires };
      this.setBanner(`${def.emoji} GHOST BALL!`, def.color);
    }
  }

  // ── OBSTACLES ────────────────────────────────────────────────────────────
  private tickObstacleSpawn() {
    const s = this.gs!;
    s.obstacleTimer++;
    if (s.obstacleTimer >= OBSTACLE_INTERVAL) {
      s.obstacleTimer = 0;
      if (s.obstacles.length < 3) this.spawnObstacle();
    }
    s.obstacles = s.obstacles.filter(o => { o.life--; return o.life > 0; });
  }

  private spawnObstacle() {
    const s = this.gs!;
    const th = Math.round(Math.min(W, H) * 0.022);
    const len = Math.round(Math.min(W, H) * (0.15 + Math.random() * 0.18));
    const horiz = Math.random() < 0.5;
    let ox: number, oy: number, ow: number, oh: number;
    if (horiz) {
      ow = len; oh = th;
      ox = Math.random() * (W - ow);
      oy = H * 0.28 + Math.random() * H * 0.44;
    } else {
      ow = th; oh = len;
      ox = Math.random() * (W - ow);
      oy = H * 0.28 + Math.random() * (H * 0.44 - oh);
    }
    s.obstacles.push({ x: ox, y: oy, w: ow, h: oh, life: 300 });
  }

  private checkObstacleCollisions() {
    const s = this.gs!;
    const eff = s.activeEffects.ball;
    if (eff && eff.type === 'ghost') return;
    const b = s.ball;
    for (const o of s.obstacles) {
      if (b.x + BALL_R > o.x && b.x - BALL_R < o.x + o.w && b.y + BALL_R > o.y && b.y - BALL_R < o.y + o.h) {
        const oL = (b.x + BALL_R) - o.x, oR = (o.x + o.w) - (b.x - BALL_R);
        const oT = (b.y + BALL_R) - o.y, oB = (o.y + o.h) - (b.y - BALL_R);
        if (Math.min(oL, oR) < Math.min(oT, oB)) {
          b.vx *= -1;
          b.x += b.vx > 0 ? Math.min(oL, oR) : -Math.min(oL, oR);
        } else {
          b.vy *= -1;
          b.y += b.vy > 0 ? Math.min(oT, oB) : -Math.min(oT, oB);
        }
      }
    }
  }

  private endMatch(winner: string, walkover = false) {
    const s = this.gs!;
    const p1won = winner === 'p1';
    if (p1won) this.p1Wins++; else this.p2Wins++;
    this.broadcast('matchEnd', {
      winner,
      p1Score: s.p1.score,
      p2Score: s.p2.score,
      p1Wins: this.p1Wins, p2Wins: this.p2Wins,
      walkover,
    });
    this.gs = null;

    // Auto-credit replaces the old "$8 — claim by PayPal" flow: the winner's
    // tenten.run account gets the server-set prize, once.
    if (this.matchSettled) return;
    this.matchSettled = true;
    const winnerSlot = this.gameJoined[p1won ? 0 : 1];
    const loserSlot = this.gameJoined[p1won ? 1 : 0];
    if (winnerSlot) void this.creditWinner(winnerSlot, loserSlot || null);
  }

  private async creditWinner(winner: PlayerSlot, loser: PlayerSlot | null) {
    let state: { status: string; amount?: string } = { status: 'failed' };
    for (const delay of [0, 1000, 3000]) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      try {
        const out = await creditPongWin({ roomId: this.roomId, winnerUserId: winner.userId, loserUserId: loser ? loser.userId : null });
        console.log(`[pongmp-credit] match ${this.roomId} → user ${winner.userId}: ${out.status}` +
          (out.status === 'credited' ? ` $${out.amount} (${out.balanceBefore} → ${out.balanceAfter})` : '') +
          (out.status === 'disabled' ? ' — payouts are OFF (PONGMP_PAYOUTS_ENABLED=false)' : ''));
        state = out.status === 'disabled' ? { status: 'disabled' } : { status: 'credited', amount: '5.00' };
        break;
      } catch (e) {
        console.error(`[pongmp-credit] attempt failed for match ${this.roomId} → user ${winner.userId}:`, e);
      }
    }
    if (state.status === 'failed') console.error(`[pongmp-credit] GAVE UP — match ${this.roomId}, winner user ${winner.userId} is owed $5.00`);
    // winner.sessionId tracks the current session even across a reconnect.
    const winnerClient = this.clients.find(c => c.sessionId === winner.sessionId);
    winnerClient?.send('pongmp:credit', state);
  }
}
