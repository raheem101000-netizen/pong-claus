import { Room, Client, matchMaker } from "@colyseus/core";
import { authenticateGameToken, PongAuth } from "../auth";
import { consumeLaunchTicket } from "../launchTickets";
import { creditPongWin } from "../payouts";
import { Prize, asPrize, prizeAmount, entryFeeFor } from "../prizes";

const TICK_RATE     = 60;
// First to 10 wins. PONG_POINTS_TO_WIN overrides it for local tests only (never set in production).
const POINTS_TO_WIN = Number(process.env.PONG_POINTS_TO_WIN) || 10;
const W = 400, H = 660;
const BALL_R       = Math.round(Math.min(W, H) * 0.018);
const PADDLE_LONG  = Math.round(W * 0.28);
const PADDLE_SHORT = Math.round(H * 0.018);
const BALL_SPEED   = Math.min(W, H) * 0.022;
// Used only by the Fire power-up's own cap (×1.3); rally hits have no cap.
const SPEED_MAX    = Math.min(W, H) * 0.040;
const FORGIVE      = Math.round(W * 0.05);
// Hit judgement (see "Lag compensation" below): longest a crossing waits for
// the defender's paddle report, and how far behind the current tick a report
// may say its screen was.
const JUDGE_MAX_MS  = 400;
const ACK_MAX_TICKS = 24;

const POWERUP_TYPES: Record<string, { emoji: string; color: string; duration: number }> = {
  ice:    { emoji: '❄️',  color: '#00cfff', duration: 3000 },
  fire:   { emoji: '🔥',  color: '#ff6600', duration: 3000 },
  shrink: { emoji: '🔒',  color: '#cc44ff', duration: 4000 },
  ghost:  { emoji: '👻',  color: '#aaffaa', duration: 3000 },
};
const POWERUP_KEYS = Object.keys(POWERUP_TYPES);
const OBSTACLE_INTERVAL = 480;

// ── Account-owned seats (same model as FIFA's FifaRoom / the Pong lobby) ─────
// A match seat belongs to the account: the same account on a new connection
// (reload, new tab, bfcache, a drop the server never saw) takes its paddle
// back. Presence comes from the page's "hb" heartbeat (~5 s), not Colyseus
// pings. The room stays open while any seat is held, so a finished match can
// always be reported to a player who comes back. Env overrides: tests only.
const AWAY_AFTER_MS    = Number(process.env.PONG_AWAY_AFTER_MS) || 15_000;
// A player away this long during play hands the opponent who is still there
// the win (walkover — same endMatch/credit path as before).
const WALKOVER_AFTER_MS = Number(process.env.PONG_WALKOVER_AFTER_MS) || 30_000;
// Seats are held this long with nobody present; then the room closes. Pong
// matches are a few minutes, so shorter than FIFA's 60 min.
const MATCH_SEAT_HOLD_MS = Number(process.env.PONG_MATCH_SEAT_HOLD_MS) || 20 * 60_000;
// Once decided, close after nobody has been here this long (as FIFA).
const MATCH_DONE_LINGER_MS = 15 * 60_000;
// Hard cap on a match room's life (as FIFA).
const MATCH_MAX_AGE_MS = 4 * 60 * 60_000;
const SWEEP_MS = 2_000;

interface PlayerSlot { sessionId: string; bid: string | null; name: string; userId: number; connected: boolean; lastSeen: number; away: boolean; awaySince: number; }
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
// A ball reaching a paddle's line. The server calls it at once from the
// paddle position it has (prov), then confirms or corrects that call from the
// defender's own reports of where their paddle was on their screen.
interface Judgement {
  s: number;                 // tick the ball reached the line
  c: number;                 // exact moment of contact, in ticks (s-1 … s)
  x: number; y: number;      // contact point (ball centre)
  vx: number; vy: number;    // incoming velocity
  prov: boolean;             // provisional call: true = returned
  prevHitter: 'p1' | 'p2' | null;
  t: number; until: number;  // ms: opened at / latest decision time
}
// A paddle position from a client, tagged with the server tick (fractional:
// the drawn ball is between ticks) that client had on screen when it was there.
interface PaddleSample { seen: number; x: number; }

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
  // Two seats, with spare connection headroom so a player's own replacement
  // connection is never refused as "full" (stale ones are cancelled on takeover).
  maxClients = 8;
  // Closed by the presence sweep once no seat is held, not when it empties.
  autoDispose = false;

  private gameJoined: PlayerSlot[] = [];
  private gs: GameState | null = null;
  private gameInterval: ReturnType<typeof setInterval> | null = null;
  private broadcastCounter = 0;
  private p1Wins = 0;
  private p2Wins = 0;

  // Lag compensation (see "Lag compensation" below).
  private tickNo = 0;
  private samples: { p1: PaddleSample[]; p2: PaddleSample[] } = { p1: [], p2: [] };
  private xBeforeSamples = { p1: 0, p2: 0 };   // paddle x before the oldest kept sample
  private lastSeen = { p1: 0, p2: 0 };
  private judge: { p1?: Judgement; p2?: Judgement } = {};
  // The two lobby accounts allowed in this match, and whether its result has
  // been credited (a game_room hosts exactly one match).
  private allowedUserIds: number[] = [];
  private matchSettled = false;
  // What a player who comes back after the match ended is shown (display
  // only — the result and payout were already decided): the end-of-match
  // message and, for the winner, the prize message.
  private finalResult: any = null;
  private creditResult: { userId: number; state: { status: string; amount?: string } } | null = null;
  // Play was stopped because both players were gone (no one to award).
  private abandoned = false;
  // The lobby this match was launched from (rematch handshake).
  private lobbyRoomId: string | null = null;
  // The prize both players were ready on when the lobby launched this match
  // (5 or 10). The winner is credited exactly this; each player's entry fee
  // for it is entryFee() (not charged yet).
  private agreedPrize: Prize = 5;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastPresentAt = Date.now();
  private createdAt = Date.now();
  private held = new Map<string, { reject: (e?: any) => void }>(); // pending token resumes, by connection

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
    const agreed = asPrize(options?.agreedPrize);
    if (!agreed) throw new Error("A match needs an agreed prize");
    this.agreedPrize = agreed;
    this.lobbyRoomId = typeof options?.lobbyRoomId === 'string' ? options.lobbyRoomId : null;
    this.setMetadata({ over: false });
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);

    this.onMessage("joinRoom", (client: Client, data: { code?: string; name?: string; bid?: string }) => {
      // Identity comes from the login token (onAuth), never from the client.
      const auth = client.auth as PongAuth;
      const name = auth.displayName || 'Player';
      const bid = data.bid || null;

      // Reconnect / reload / second tab: the same account takes its existing
      // slot back; a different connection that held it is told and let go.
      const prior = this.gameJoined.find(p => p.userId === auth.userId) || null;
      if (prior) {
        console.log('REBIND:', name, 'bid=' + bid, prior.sessionId, '->', client.sessionId);
        const old = prior.sessionId;
        if (old !== client.sessionId) {
          const oldClient = this.clients.find(c => c.sessionId === old);
          if (oldClient) { oldClient.send('superseded', { message: 'You opened this match somewhere else.' }); oldClient.leave(4000); }
          const h = this.held.get(old);
          if (h) { this.held.delete(old); h.reject(false); }
        }
        prior.sessionId = client.sessionId;
        prior.connected = true;
        this.touch(prior);
        const idx = this.gameJoined.indexOf(prior);
        client.send('roomJoined', {
          code: this.roomId, role: idx === 0 ? 'p1' : 'p2',
          myName: name, paddlePos: idx === 0 ? 'BOTTOM' : 'TOP',
          prize: prizeAmount(this.agreedPrize)
        });
        const other = this.gameJoined[idx === 0 ? 1 : 0];
        if (other) client.send('opponentName', { name: other.name });
        this.sendPresence(client);
        // Back after the match was decided without them (e.g. away too long →
        // walkover): show them the result instead of a frozen board.
        if (this.finalResult) {
          client.send('matchEnd', { ...this.finalResult, rejoined: true });
          if (this.creditResult && this.creditResult.userId === auth.userId) client.send('pongmp:credit', this.creditResult.state);
          if (this.rematchAvailable()) client.send('rematch:available', {});
        } else if (this.abandoned) {
          client.send('opponentLeft');
        }
        return;
      }

      if (this.gameJoined.find(p => p.sessionId === client.sessionId)) return;
      if (this.gameJoined.length >= 2) return;

      this.gameJoined.push({ sessionId: client.sessionId, bid, name, userId: auth.userId, connected: true, lastSeen: Date.now(), away: false, awaySince: 0 });
      const myIndex = this.gameJoined.length - 1;
      const role = myIndex === 0 ? 'p1' : 'p2';

      client.send('roomJoined', {
        code: this.roomId, role,
        myName: name, paddlePos: role === 'p1' ? 'BOTTOM' : 'TOP',
        prize: prizeAmount(this.agreedPrize)   // the agreed prize, for the winner's message
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

    this.onMessage("paddleMove", (client: Client, data: { x: number; seen?: number }) => {
      if (!this.gs) return;
      const idx = this.gameJoined.findIndex(p => p.sessionId === client.sessionId);
      if (idx === -1) { console.log('[paddleMove] DROP idx=-1 session=' + client.sessionId); return; }
      this.touch(this.gameJoined[idx]);
      const key: 'p1' | 'p2' = idx === 0 ? 'p1' : 'p2';
      const paddle = idx === 0 ? this.gs.p1 : this.gs.p2;
      if (!this.isFrozen(key) && Number.isFinite(data?.x)) {
        const len = this.getPaddleLen(key);
        paddle.x = Math.max(0, Math.min(W - len, data.x));
      }
      // Which tick was on this player's screen (bounded: never ahead of the
      // server, at most ACK_MAX_TICKS behind, never going backwards).
      const raw = Number.isFinite(data?.seen) ? Math.round((data.seen as number) * 100) / 100 : this.tickNo;
      const seen = Math.max(this.lastSeen[key], Math.min(this.tickNo, Math.max(this.tickNo - ACK_MAX_TICKS, raw)));
      this.lastSeen[key] = seen;
      const arr = this.samples[key];
      arr.push({ seen, x: paddle.x });
      if (arr.length > 240) { this.xBeforeSamples[key] = arr[arr.length - 241].x; arr.splice(0, arr.length - 240); }
    });

    // Presence heartbeat (~5 s): answered so the page can spot a dead
    // connection, and keeps this account's seat present.
    // Rematch (match-over screen): only once the match is decided AND its
    // credit has finished. The lobby runs the two-press handshake; a rematch
    // is a new game_room, so it has its own 'pongmp:<roomId>' credit key and
    // can never re-pay this match.
    this.onMessage("rematch", async (client: Client) => {
      const slot = this.gameJoined.find(p => p.sessionId === client.sessionId);
      if (!slot || !this.rematchAvailable() || !this.lobbyRoomId) return;
      try {
        const out: any = await matchMaker.remoteRoomCall(this.lobbyRoomId, 'requestRematch' as any, [this.roomId, slot.userId]);
        if (out && out.ok) this.broadcast('rematch:go', { byName: slot.name });
        else client.send('rematch:error', { message: out?.error || 'Rematch not possible right now' });
      } catch (e) {
        client.send('rematch:error', { message: 'Rematch not possible right now' });
      }
    });

    this.onMessage("hb", (client: Client) => {
      client.send("hb");
      const slot = this.gameJoined.find(p => p.sessionId === client.sessionId);
      if (slot) this.touch(slot);
    });

    this.onMessage("ping", (client: Client, data: { ts: number }) => {
      client.send("pong", { ts: data.ts });
    });

    // Clients still report latency; hit judging no longer uses an estimate
    // (it uses the tick each paddle report says was on screen).
    this.onMessage("latency", () => {});

  }

  onJoin(_client: Client, _options: any, auth: PongAuth) {
    if (!this.allowedUserIds.includes(auth.userId)) {
      throw new Error("You're not a player in this match");
    }
  }

  // Fast path: a dropped connection can resume the SAME session with its
  // reconnection token. The seat doesn't depend on it — the heartbeat decides
  // presence, and joinRoom from a new connection takes the seat back.
  onDrop(client: Client) {
    const slot = this.gameJoined.find(p => p.sessionId === client.sessionId);
    if (slot) this.markGone(slot);                    // shown away at once (as FIFA)
    const held: any = this.allowReconnection(client, MATCH_SEAT_HOLD_MS / 1000);
    if (held?.reject) this.held.set(client.sessionId, held);
    const done = () => { if (this.held.get(client.sessionId) === held) this.held.delete(client.sessionId); };
    held?.then?.(done, done);
  }

  onReconnect(client: Client) {
    const slot = this.gameJoined.find(p => p.sessionId === client.sessionId);
    if (!slot) { if (this.gameJoined.length >= 2) client.leave(4000); return; } // seat taken over meanwhile
    slot.connected = true;
    this.touch(slot);
  }

  // A connection is gone for good: its seat stays with the account (away once
  // the heartbeat stops — see sweep()).
  onLeave(client: Client) {
    console.log('LEAVE: session=' + client.sessionId);
    const slot = this.gameJoined.find(p => p.sessionId === client.sessionId);
    if (slot) this.markGone(slot);
  }

  onDispose() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.gameInterval) clearInterval(this.gameInterval);
    if (this.lobbyRoomId) matchMaker.remoteRoomCall(this.lobbyRoomId, 'matchClosed' as any, [this.roomId]).catch(() => {});
  }

  // Entry fee each player pays for this match's prize — the hook for when
  // entry-fee charging is built (nothing is charged yet).
  public entryFee(): string {
    return entryFeeFor(this.agreedPrize);
  }

  private rematchAvailable() {
    return !!this.finalResult && !!this.creditResult && !this.abandoned;
  }

  private markGone(slot: PlayerSlot) {
    slot.connected = false;
    if (!slot.away) { slot.away = true; slot.awaySince = Date.now(); this.sendPresence(); }
  }

  private touch(slot: PlayerSlot) {
    slot.lastSeen = Date.now();
    if (slot.away && slot.connected) { slot.away = false; slot.awaySince = 0; this.sendPresence(); }
  }

  // Who is away, to everyone (or one client).
  private sendPresence(to?: Client) {
    const msg = { p1Away: !!this.gameJoined[0]?.away, p2Away: !!this.gameJoined[1]?.away };
    if (to) to.send('presence', msg); else this.broadcast('presence', msg);
  }

  // Presence check: quiet seats show as away; a player away too long during
  // play loses by walkover (or play stops if both are gone); the room closes
  // once no seat has been held for MATCH_SEAT_HOLD_MS.
  private sweep() {
    const now = Date.now();
    let changed = false;
    for (const slot of this.gameJoined) {
      if (!slot.away && (!slot.connected || now - slot.lastSeen > AWAY_AFTER_MS)) { slot.away = true; slot.awaySince = now; changed = true; }
    }
    if (changed) this.sendPresence();

    const anyoneHere = this.gameJoined.some(p => !p.away);
    if (anyoneHere) this.lastPresentAt = now;
    const decided = !!this.finalResult || this.abandoned;
    if ((decided && !anyoneHere && now - this.lastPresentAt > MATCH_DONE_LINGER_MS) ||
        (!anyoneHere && now - this.lastPresentAt > MATCH_SEAT_HOLD_MS) ||
        now - this.createdAt > MATCH_MAX_AGE_MS) {
      console.log('[match] ' + this.roomId + ': nobody holding a seat — closing');
      this.setMetadata({ over: true });
      this.disconnect();
      return;
    }

    if (!this.gs || this.matchSettled) return; // walkover only while a match is being played
    const gone = this.gameJoined.filter(p => p.away && now - p.awaySince > WALKOVER_AFTER_MS);
    if (!gone.length) return;
    if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }

    // Walkover (same as FIFA / Puz Royale / Kurver): the player who left
    // didn't come back in time, so the opponent who is still here wins —
    // through the same endMatch → creditWinner path and the same
    // 'pongmp:<roomId>' key, so a normal finish and a walkover can't both pay.
    const slot = gone[0];
    const other = this.gameJoined.find(p => p !== slot);
    if (gone.length === 1 && other && !other.away) {
      console.log('WALKOVER: ' + slot.name + ' away — ' + other.name + ' wins');
      this.endMatch(this.gameJoined.indexOf(other) === 0 ? 'p1' : 'p2', true);
      return;
    }
    console.log('[match] ' + this.roomId + ': both players away — play stopped');
    this.gs = null;
    this.abandoned = true;
    this.setMetadata({ over: true });
    this.broadcast('opponentLeft');
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
    this.tickNo = 0;
    this.samples = { p1: [], p2: [] };
    this.xBeforeSamples = { p1: this.gs.p1.x, p2: this.gs.p2.x };
    this.lastSeen = { p1: 0, p2: 0 };
    this.judge = {};
    this.gameInterval = setInterval(() => {
      if (!this.gs) return;
      this.tickNo++;
      const winner = this.tickBall();
      this.broadcastCounter++;
      // Every tick (60 Hz), to each player (see sendState).
      this.sendState();
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

    // Confirm or correct earlier provisional calls once the defender's
    // paddle reports for that moment are in.
    this.settleJudgement('p1', now);
    this.settleJudgement('p2', now);

    const p1x = s.p1.x, p2x = s.p2.x;
    const p1Len = this.getPaddleLen('p1');
    const p2Len = this.getPaddleLen('p2');

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
    // Guarantees crossed-check fires at any speed (rally speed has no cap).
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
      const inX = b.x, inVx = b.vx, inVy = b.vy, inHitter = b.lastHitter;
      const fr = (i + 1) / steps;   // how far through this tick the ball is
      if (this.hitPaddle(s.p1, p1x, true,  prevY, prevX, p1Len)) { this.openJudgement('p1', true, inX, inVx, inVy, inHitter, now, fr); break; }
      if (this.hitPaddle(s.p2, p2x, false, prevY, prevX, p2Len)) { this.openJudgement('p2', true, inX, inVx, inVy, inHitter, now, fr); break; }
      this.noteCrossing('p1', prevY, prevX, now, i, steps);
      this.noteCrossing('p2', prevY, prevX, now, i, steps);
      if (this.scoreIfOut()) return this.checkScore();
    }
    if (this.scoreIfOut()) return this.checkScore();
    this.checkPowerupCollision();
    return null;
  }

  // ── Lag compensation: judge from the defender's own screen ───────────────
  // Your own paddle is drawn instantly, but the ball reaches your screen a
  // little late and your paddle reports reach us a little late. So when the
  // ball reaches a paddle's line, the server's copy of that paddle is out of
  // date. The server makes a provisional call from what it has (no delay in
  // the usual case), then settles it from the defender's reports: the paddle
  // positions they had in the moment before the ball touched the line ON
  // THEIR SCREEN (each report says which tick, to a fraction, was on screen).
  // Moves made after that — the ball already at or past the line on their
  // own screen — never count. If the reports disagree with the provisional call,
  // the ball is corrected (late hit / late miss). The defender's page applies
  // the same rule, so on their own screen the true outcome shows at once.
  private coversX(paddleX: number, len: number, x: number): boolean {
    return x + BALL_R > paddleX - FORGIVE && x - BALL_R < paddleX + len + FORGIVE;
  }

  private contactY(key: 'p1' | 'p2'): number {
    const s = this.gs!;
    return key === 'p1' ? s.p1.y - BALL_R - 1 : s.p2.y + PADDLE_SHORT + BALL_R + 1;
  }

  private openJudgement(key: 'p1' | 'p2', prov: boolean, x: number, vx: number, vy: number, prevHitter: 'p1' | 'p2' | null, now: number, frac: number) {
    if (this.judge[key]) return;
    const c = Math.round((this.tickNo - 1 + Math.max(0, Math.min(1, frac))) * 100) / 100;
    this.judge[key] = { s: this.tickNo, c, x, y: this.contactY(key), vx, vy, prov, prevHitter, t: now, until: now + JUDGE_MAX_MS };
  }

  // Ball crossed this player's contact line, moving toward them, without a
  // provisional hit: provisional miss at the crossing point.
  private noteCrossing(key: 'p1' | 'p2', prevY: number, prevX: number, now: number, step: number, steps: number) {
    if (this.judge[key]) return;
    const s = this.gs!, b = s.ball, isP1 = key === 'p1';
    if (isP1 ? b.vy <= 0 : b.vy >= 0) return;
    const p = isP1 ? s.p1 : s.p2;
    const paddleY = isP1 ? p.y : p.y + PADDLE_SHORT;
    const before = isP1 ? prevY + BALL_R : prevY - BALL_R, after = isP1 ? b.y + BALL_R : b.y - BALL_R;
    const crossed = isP1 ? (before < paddleY && after >= paddleY) : (before > paddleY && after <= paddleY);
    if (!crossed) return;
    const f = (paddleY - before) / (after - before);
    this.openJudgement(key, false, prevX + (b.x - prevX) * f, b.vx, b.vy, b.lastHitter, now, (step + f) / steps);
  }

  private settleJudgement(key: 'p1' | 'p2', now: number) {
    const j = this.judge[key];
    if (!j) return;
    const arr = this.samples[key];
    // Counted: where the paddle was in the last tick before contact on the
    // defender's screen (the position carried into it, plus every move made
    // during it). Reports arrive in order, so one from the contact moment or
    // later means all earlier ones are in. Without one (a still paddle sends
    // none), wait up to JUDGE_MAX_MS; the last known position is then the
    // position it kept.
    const complete = arr.length > 0 && arr[arr.length - 1].seen >= j.c;
    if (!complete && now < j.until) return;
    let carried = this.xBeforeSamples[key];
    const during: number[] = [];
    for (const sm of arr) {
      if (sm.seen < j.c - 1) carried = sm.x;
      else if (sm.seen < j.c) during.push(sm.x);
    }
    const len = this.getPaddleLen(key);
    const viewX = [carried, ...during].find(x => this.coversX(x, len, j.x));
    const viewHit = viewX !== undefined;
    if (viewHit && !j.prov) this.lateHit(key, j, viewX as number, len, now);
    if (!viewHit && j.prov) this.lateMiss(key, j, now);
    delete this.judge[key];
  }

  private ticksSince(j: Judgement, now: number): number {
    return Math.min(30, Math.max(0, (now - j.t) / (1000 / TICK_RATE)));
  }

  private foldWalls(b: { x: number; vx: number }) {
    if (b.x - BALL_R < 0) { b.x = 2 * BALL_R - b.x; b.vx =  Math.abs(b.vx); }
    if (b.x + BALL_R > W) { b.x = 2 * (W - BALL_R) - b.x; b.vx = -Math.abs(b.vx); }
  }

  // Provisional miss, but the defender's paddle was there: bounce from the
  // contact point (as hitPaddle would have), carried on for the elapsed time.
  private lateHit(key: 'p1' | 'p2', j: Judgement, paddleX: number, len: number, now: number) {
    const b = this.gs!.ball, isP1 = key === 'p1';
    const rel = Math.max(-1, Math.min(1, (j.x - (paddleX + len / 2)) / (len / 2)));
    const spd = Math.hypot(j.vx, j.vy) + 0.3;   // same as hitPaddle: +0.3 per hit, no cap
    b.vx = Math.sin(rel * (Math.PI / 4)) * spd;
    b.vy = Math.cos(rel * (Math.PI / 4)) * spd * (isP1 ? -1 : 1);
    const k = this.ticksSince(j, now);
    b.x = j.x + b.vx * k; b.y = j.y + b.vy * k;
    this.foldWalls(b);
    b.lastHitter = key;
  }

  // Provisional hit, but on the defender's screen the paddle wasn't there:
  // the ball carries on through the line toward their goal.
  private lateMiss(key: 'p1' | 'p2', j: Judgement, now: number) {
    const b = this.gs!.ball;
    b.vx = j.vx; b.vy = j.vy;
    const k = this.ticksSince(j, now);
    b.x = j.x + b.vx * k; b.y = j.y + b.vy * k;
    this.foldWalls(b);
    b.lastHitter = j.prevHitter;
  }

  // Score only once the call for the side that let it through is settled.
  private scoreIfOut(): boolean {
    const s = this.gs!, b = s.ball;
    if (b.y > H + 20 && !this.judge.p1) { s.p2.score++; this.resetBall(false); return true; }
    if (b.y < -20    && !this.judge.p2) { s.p1.score++; this.resetBall(true);  return true; }
    return false;
  }

  // Each player gets the state with the tick number. While a provisional miss
  // at one player's line is being settled, the OTHER player sees the ball held
  // at that line (so they never see it go past and come back); the defender
  // gets the true ball plus the judgement, which their page resolves itself.
  private sendState() {
    const s = this.gs!;
    const base = {
      tick: this.tickNo,
      p1: s.p1, p2: s.p2, delay: s.delay,
      powerup: s.powerup,
      activeEffects: s.activeEffects,
      obstacles: s.obstacles,
      bannerSeq: s.bannerSeq, bannerText: s.bannerText, bannerColor: s.bannerColor
    };
    this.gameJoined.forEach((slot, idx) => {
      const c = this.clients.find(cl => cl.sessionId === slot.sessionId);
      if (!c) return;
      const mine = idx === 0 ? this.judge.p1 : this.judge.p2;
      const theirs = idx === 0 ? this.judge.p2 : this.judge.p1;
      const ball = theirs && !theirs.prov ? { ...s.ball, x: theirs.x, y: theirs.y } : s.ball;
      c.send('state', { ...base, ball, judge: mine ? { s: mine.s, c: mine.c, x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy, prov: mine.prov } : null });
    });
  }

  // Returns true if a collision occurred (caller should stop sub-stepping).
  // paddleX is the server's current copy of the player's position — a
  // provisional call, settled from the player's own reports (see above);
  // p.y never changes during a match.
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
    const spd = Math.hypot(b.vx, b.vy) + 0.3;   // +0.3 per paddle hit, no upper limit
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
    this.judge = {};
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
    this.finalResult = {
      winner,
      p1Score: s.p1.score,
      p2Score: s.p2.score,
      p1Wins: this.p1Wins, p2Wins: this.p2Wins,
      walkover,
      p1Name: this.gameJoined[0]?.name || null,
      p2Name: this.gameJoined[1]?.name || null,
    };
    this.broadcast('matchEnd', this.finalResult);
    this.gs = null;
    this.setMetadata({ over: true });

    // Auto-credit replaces the old "$8 — claim by PayPal" flow: the winner's
    // tenten.run account gets the agreed prize ($5 or $10), once.
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
        const out = await creditPongWin({ roomId: this.roomId, winnerUserId: winner.userId, loserUserId: loser ? loser.userId : null, prize: this.agreedPrize });
        console.log(`[pongmp-credit] match ${this.roomId} → user ${winner.userId}: ${out.status}` +
          (out.status === 'credited' ? ` $${out.amount} (${out.balanceBefore} → ${out.balanceAfter})` : '') +
          (out.status === 'disabled' ? ' — payouts are OFF (PONGMP_PAYOUTS_ENABLED=false)' : ''));
        state = out.status === 'disabled' ? { status: 'disabled' } : { status: 'credited', amount: prizeAmount(this.agreedPrize) };
        break;
      } catch (e) {
        console.error(`[pongmp-credit] attempt failed for match ${this.roomId} → user ${winner.userId}:`, e);
      }
    }
    if (state.status === 'failed') console.error(`[pongmp-credit] GAVE UP — match ${this.roomId}, winner user ${winner.userId} is owed $${prizeAmount(this.agreedPrize)}`);
    // winner.sessionId tracks the current session even across a reconnect.
    this.creditResult = { userId: winner.userId, state };
    const winnerClient = this.clients.find(c => c.sessionId === winner.sessionId);
    winnerClient?.send('pongmp:credit', state);
    // Decided and paid: both players may now ask for a rematch.
    this.broadcast('rematch:available', {});
  }
}
