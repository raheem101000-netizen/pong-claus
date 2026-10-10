import { Room, Client, matchMaker } from "@colyseus/core";
import { authenticateGameToken, PongAuth } from "../auth";
import { issueLaunchTicket } from "../launchTickets";
import { Prize, PrizeMode, asPrize, asPrizeMode } from "../prizes";

// ── Account-owned seats (same model as FIFA's FifaLobby / Kurver) ─────────────
// A seat belongs to the ACCOUNT (userId), not to a connection. The same
// account coming back on a new connection (reload, new tab, Safari bfcache,
// a drop the server never noticed) takes its seat over — same seat, ready
// state and host role. Presence comes from the page's own "hb" heartbeat
// (every ~5 s), not Colyseus pings (Render/Cloudflare swallow those):
//   AWAY_AFTER_MS without a heartbeat     → shown as away
//   host away HOST_HANDOFF_MS             → host role passes to a present player
//   away SEAT_HOLD_MS                     → seat released
// The env overrides are for local tests only.
const AWAY_AFTER_MS   = Number(process.env.PONG_AWAY_AFTER_MS) || 15_000;
const HOST_HANDOFF_MS = Number(process.env.PONG_HOST_HANDOFF_MS) || 60_000;
const SEAT_HOLD_MS    = Number(process.env.PONG_SEAT_HOLD_MS) || 12 * 60_000;
const SWEEP_MS        = 2_000;
// Fast path: Colyseus holds a dropped connection's session this long so the
// SDK can resume it with its reconnection token. Account rejoin (above) is the
// reliable fallback when that resume isn't possible.
const LOBBY_RECONNECT_SECONDS = Number(process.env.LOBBY_RECONNECT_SECONDS) || SEAT_HOLD_MS / 1000;
// Pong is 1v1: a room seats 2 distinct accounts.
const SEATS_PER_ROOM = 2;
// Rematch: a pending rematch is cancelled when one of its two players is
// away this long (closed the tab instead of accepting) — that player is
// treated as having left the room.
const REMATCH_CANCEL_MS = Number(process.env.PONG_REMATCH_CANCEL_MS) || 30_000;
const CHAT_HISTORY_MAX = 100;

// ── Prize (same rules as FIFA's FifaLobby) ───────────────────────────────────
// Every room is created as a $5 room, a $10 room, or "both" (the two players
// agree on $5 or $10 in the room). The server owns prizeMode, each player's
// pick and each player's ready state. Ready is only accepted while both picks
// are the same; any prize change clears both players' Ready; the match
// launches only with both ready on one prize, which the game_room credits.

interface PlayerData {
  id: string;        // the connection currently (or last) holding this seat
  userId: number;    // real tenten.run account (from the login handoff token) — owns the seat
  name: string;
  ready: boolean;
  master: boolean;
  pick: Prize | null; // the prize this player wants (null: host of a "both" room who hasn't chosen yet)
  color: string;
  connected: boolean; // a live connection is attached (false from the moment the server sees it drop)
  lastSeen: number;  // last heartbeat from the seat's connection (ms epoch)
  away: boolean;
  awaySince: number;
}

interface LobbyRoomData {
  code: string;
  name: string;
  open: boolean;
  password: string | null;   // private rooms: the host's password (never sent to clients)
  master: number;            // host's account
  players: Record<number, PlayerData>; // by account
  started: boolean;
  kicked: Set<number>;       // accounts the host removed; they can't rejoin this room
  chat: { player: string; content: string; system?: true }[]; // kept for the room's life, across matches and rematches
  // "5" / "10": fixed prize (only the host can change it); "both": each player picks.
  prizeMode: PrizeMode;
  lastPrize: Prize | null;   // the prize of the last match launched (a rematch starts both players on it)
  matchId: string | null;    // the game_room launched from this room (while started)
  // Rematch pressed by one player, waiting for the other. Only both presses
  // reset the room for a new match; one press changes nothing else.
  rematch: { by: Set<number> } | null;
}

const ROOM_NAME_MAX = 24;      // same as Puz Royale's room name field
const ROOM_PASSWORD_MAX = 20;  // same as Puz Royale's password field

function generateCode(rooms: Record<string, LobbyRoomData>): string {
  let code: string;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); }
  while (rooms[code]);
  return code;
}

function serializePlayer(p: PlayerData) {
  return { id: p.id, name: p.name, ready: p.ready, master: p.master, color: p.color, away: p.away, pick: p.pick };
}

// The prize both players want, or null (fewer than two, a pick missing, or they differ).
function agreedPrize(r: LobbyRoomData): Prize | null {
  const players = Object.values(r.players);
  if (players.length < SEATS_PER_ROOM) return null;
  const first = players[0].pick;
  return first && players.every(p => p.pick === first) ? first : null;
}

function serializeRoom(r: LobbyRoomData) {
  const players = Object.values(r.players);
  return {
    id: r.code, code: r.code, name: r.name, open: r.open, locked: !!r.password,
    master: r.players[r.master]?.id ?? null, started: r.started, prizeMode: r.prizeMode,
    players: players.map(serializePlayer),
    rematch: r.rematch ? {
      pending: true,
      by: players.filter(p => r.rematch!.by.has(p.userId)).map(p => p.id),
      names: players.filter(p => r.rematch!.by.has(p.userId)).map(p => p.name),
      waiting: players.filter(p => !r.rematch!.by.has(p.userId)).map(p => p.name),
    } : null,
  };
}

export class LobbyRoom extends Room {
  autoDispose = false;
  maxClients = 200;

  private lobbyRooms: Record<string, LobbyRoomData> = {};
  private clientRoom = new Map<string, string>();     // connection bound to a seat → room code
  private userRoom = new Map<number, string>();       // account → room code it holds a seat in
  private userMatch = new Map<number, string>();      // account → game_room it was launched into
  private held = new Map<string, { reject: (e?: any) => void }>(); // pending token resumes, by connection
  private pendingDeletion = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  // Every lobby connection must be a logged-in tenten.run account.
  static async onAuth(token: string, options: any) {
    return authenticateGameToken(token, options?.playerId);
  }

  onCreate() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);

    this.onMessage("room:list", (client: Client) => {
      client.send("room:list", { rooms: this.serializeList() });
    });

    // Presence heartbeat from the page (~5 s): answered so the page can tell
    // a dead connection from a quiet one, and keeps the account's seat present.
    this.onMessage("hb", (client: Client) => {
      client.send("hb");
      const seat = this.seatOf(client);
      if (seat) this.touch(seat.room, seat.pd);
    });

    // Account rejoin: the page asks, on every fresh connection, for the seat
    // its account holds (it may hint the room it remembers). Takes the seat
    // over; or, if the account was launched into a match that's still going,
    // sends the page there.
    this.onMessage("room:rejoin", async (client: Client) => {
      const auth = client.auth as PongAuth;
      const code = this.userRoom.get(auth.userId);
      const room = code ? this.lobbyRooms[code] : undefined;
      if (room && room.players[auth.userId]) { this.takeOver(client, room); return; }
      const matchId = await this.liveMatchOf(auth.userId);
      if (matchId) { client.send('room:match', { code: matchId }); return; }
      client.send('room:rejoin:none', {});
    });

    this.onMessage("room:create", (client: Client, data: any) => {
      const auth = client.auth as PongAuth;
      // Same create rules as Puz Royale: the host names the room; a private
      // room needs the host's password, and joining it needs that password.
      const name = typeof data?.name === 'string' ? data.name.trim().slice(0, ROOM_NAME_MAX) : '';
      if (!name) { client.send('room:error', { message: 'Enter a room name' }); return; }
      const priv = data?.open === false;
      const password = priv && typeof data?.password === 'string' ? data.password.slice(0, ROOM_PASSWORD_MAX) : '';
      if (priv && !password.trim()) { client.send('room:error', { message: 'Enter a password for a private room' }); return; }
      const prizeMode = asPrizeMode(data?.prizeMode);
      if (!prizeMode) { client.send('room:error', { message: 'Pick a prize first' }); return; }
      // One seat per account: creating a room gives up a seat held elsewhere.
      this.releaseAccountSeat(auth.userId);
      this.userMatch.delete(auth.userId);
      const code = generateCode(this.lobbyRooms);
      const pd: PlayerData = {
        id: client.sessionId,
        userId: auth.userId,
        name: auth.displayName || 'Player 1',
        color: data.player?.color || '#b450ff',
        ready: false, master: true, connected: true,
        // Fixed room: the host's pick is the room's prize; "both": no pick yet.
        pick: prizeMode === 'both' ? null : Number(prizeMode) as Prize,
        lastSeen: Date.now(), away: false, awaySince: 0
      };
      const room: LobbyRoomData = {
        code, name,
        open: !priv, password: priv ? password : null, master: auth.userId,
        players: { [auth.userId]: pd }, started: false, kicked: new Set<number>(),
        chat: [], matchId: null, rematch: null,
        prizeMode, lastPrize: null
      };
      this.lobbyRooms[code] = room;
      this.bindSeat(client, room, pd);
      client.send('room:created', { room: serializeRoom(room), player: serializePlayer(pd), chat: room.chat });
      this.broadcastList();
    });

    // Old Stripe flow (unused while FREE_PLAY): a player leaving for checkout
    // simply keeps their account's seat like any other absence.
    this.onMessage("room:paying", () => {});

    this.onMessage("room:join", (client: Client, data: any) => {
      const code = data.code || data.room;
      const room = this.lobbyRooms[code];
      if (!room) { client.send('room:error', { message: 'Room not found' }); return; }
      const auth = client.auth as PongAuth;
      // Same account joining again takes over its existing seat (no password
      // needed for your own seat) instead of "already in this room".
      if (room.players[auth.userId]) { this.takeOver(client, room); return; }
      if (room.started) { client.send('room:error', { message: 'Game already started' }); return; }
      if (room.kicked.has(auth.userId)) { client.send('room:error', { message: 'You were removed from this room by the host' }); return; }
      // Capacity counts distinct accounts, never connections.
      if (Object.keys(room.players).length >= SEATS_PER_ROOM) { client.send('room:error', { message: 'Room is full' }); return; }

      // Private room: the host's password (a player already seated rejoins above without it).
      if (room.password && data?.password !== room.password) {
        client.send('room:error', { message: data?.password ? 'Wrong password' : 'This room is private — enter its password' }); return;
      }

      // The new seat's prize. Fixed room: joining means agreeing to it.
      // "both" room: the joiner must bring a pick (the page asks first); an
      // empty room's next player becomes host and may start with none.
      const becomesHost = Object.keys(room.players).length === 0;
      let pick: Prize | null = null;
      if (room.prizeMode !== 'both') pick = Number(room.prizeMode) as Prize;
      else if (!becomesHost) {
        pick = asPrize(data?.prize);
        if (!pick) { client.send('room:pick-prize', { code: room.code, message: 'The host is open to both. Pick the prize' }); return; }
      }

      this.releaseAccountSeat(auth.userId);
      this.userMatch.delete(auth.userId);
      const pd: PlayerData = {
        id: client.sessionId,
        userId: auth.userId,
        name: auth.displayName || 'Player 2',
        color: data.player?.color || '#4488FF',
        ready: false, master: false, connected: true,
        pick,
        lastSeen: Date.now(), away: false, awaySince: 0
      };
      if (this.pendingDeletion.has(code)) {
        clearTimeout(this.pendingDeletion.get(code));
        this.pendingDeletion.delete(code);
      }
      if (Object.keys(room.players).length === 0) { pd.master = true; room.master = auth.userId; }
      // Someone new at the table: any earlier Ready was for a different pairing.
      for (const p of Object.values(room.players)) p.ready = false;
      room.players[auth.userId] = pd;
      this.bindSeat(client, room, pd);
      client.send('room:joined', { room: serializeRoom(room), player: serializePlayer(pd), chat: room.chat });
      this.sendToRoom(room, 'room:player:join', { player: serializePlayer(pd) });
      this.sendToRoom(room, 'room:state', serializeRoom(room));
      this.broadcastList();
    });

    this.onMessage("room:ready", (client: Client) => {
      const seat = this.seatOf(client);
      if (!seat) return;
      if (seat.room.rematch) { client.send('room:error', { message: 'Waiting for both players to accept the rematch' }); return; }
      if (seat.room.started) return;
      // Ready means "I accept the prize showing right now": only once both
      // players are here and want the same prize.
      if (!agreedPrize(seat.room)) {
        client.send('room:error', { message: Object.keys(seat.room.players).length < SEATS_PER_ROOM ? 'Need a second player first' : 'Agree on a prize before pressing Ready' });
        return;
      }
      seat.pd.ready = true;
      this.sendToRoom(seat.room, 'room:player:ready', { player: serializePlayer(seat.pd) });
      this.sendToRoom(seat.room, 'room:state', serializeRoom(seat.room));
    });

    // A player changes the prize. "both" room: anyone, their own pick only.
    // Fixed room: only the host, and it changes the room's prize (both picks).
    // Any real change clears Ready for BOTH players.
    this.onMessage("room:prize", (client: Client, data: any) => {
      const seat = this.seatOf(client);
      if (!seat) return;
      const { room, pd } = seat;
      if (room.started) return;
      if (room.rematch) { client.send('room:error', { message: 'Waiting for both players to accept the rematch' }); return; }
      const prize = asPrize(data?.prize);
      if (!prize) { client.send('room:error', { message: 'Pick $5 or $10' }); return; }
      if (room.prizeMode === 'both') {
        if (pd.pick === prize) return;
        pd.pick = prize;
      } else {
        if (room.master !== pd.userId) { client.send('room:error', { message: 'Only the host can change the prize' }); return; }
        if (room.prizeMode === String(prize)) return;
        room.prizeMode = String(prize) as PrizeMode;
        for (const p of Object.values(room.players)) p.pick = prize;
        const line = { player: '', content: `${pd.name} changed the prize to $${prize}`, system: true as const };
        this.pushChat(room, line);
        this.sendToRoom(room, 'room:talk', line);
        this.broadcastList();
      }
      for (const p of Object.values(room.players)) p.ready = false;
      this.sendToRoom(room, 'room:state', serializeRoom(room));
    });

    this.onMessage("room:launch", async (client: Client) => {
      const seat = this.seatOf(client);
      if (!seat) return;
      const { room } = seat;
      if (room.started || room.master !== seat.pd.userId) return;
      if (room.rematch) { client.send('room:error', { message: 'Waiting for both players to accept the rematch' }); return; }
      const players = Object.values(room.players);
      // Pong is 1v1: a match needs its 2 players, both Ready on the same prize
      // (the host too — Ready is accepting the prize). No payment yet.
      if (players.length < SEATS_PER_ROOM) { client.send('room:error', { message: 'Need 2 players' }); return; }
      // Nobody starts a match for a player who isn't there.
      const away = players.filter(p => p.away).map(p => p.name);
      if (away.length) { client.send('room:error', { message: 'Waiting for ' + away.join(', ') + ' to come back' }); return; }
      const agreed = agreedPrize(room);
      if (!agreed) { client.send('room:error', { message: 'Agree on a prize first' }); return; }
      if (!players.every(p => p.ready)) {
        client.send('room:error', { message: 'Waiting for both players to be ready' }); return;
      }

      room.started = true; // no second launch while the match room is being created
      try {
        // A new game_room per match (rematches included): its room id is the
        // match's credit key ('pongmp:<roomId>'), so each match pays once.
        const gameRoom = await matchMaker.createRoom("game_room", {
          launchTicket: issueLaunchTicket(), // proves this match came from a lobby, not a client
          allowedUserIds: players.map(p => p.userId),
          lobbyRoomId: this.roomId,          // for the rematch handshake
          agreedPrize: agreed,               // the prize both were ready on — the winner is credited this
        });
        room.lastPrize = agreed;
        this.sendToRoom(room, 'room:game:start', {
          code: gameRoom.roomId,
          players: players.map(serializePlayer)
        });
        // The seats now live in the match room (account-owned there too). A
        // page that reloads into the lobby is sent back to the match while it's
        // still being played (room:rejoin → room:match). The room itself (its
        // players and chat) is kept, hidden from the list, for a rematch; it's
        // dropped when the match room closes without one.
        room.matchId = gameRoom.roomId;
        for (const p of players) {
          this.userMatch.set(p.userId, gameRoom.roomId);
          if (this.clientRoom.get(p.id) === room.code) this.clientRoom.delete(p.id);
          if (this.userRoom.get(p.userId) === room.code) this.userRoom.delete(p.userId);
        }
        this.broadcastList();
      } catch (e) {
        room.started = false;
        client.send('room:error', { message: 'Failed to start game' });
      }
    });

    // Host kick: only the host, never themselves; the removed player is told
    // why, taken out of the room (as if they'd left), and can't rejoin it.
    this.onMessage("room:kick", (client: Client, data: any) => {
      const seat = this.seatOf(client);
      const room = seat?.room;
      if (!room || room.master !== seat!.pd.userId) { client.send('room:error', { message: 'Only the host can remove players' }); return; }
      if (room.started) return;
      const targetId = String(data?.id || '');
      const target = Object.values(room.players).find(p => p.id === targetId);
      if (!target) { client.send('room:error', { message: 'Player not found' }); return; }
      if (target.userId === seat!.pd.userId) { client.send('room:error', { message: "You can't remove yourself" }); return; }
      room.kicked.add(target.userId);
      this.clients.find(c => c.sessionId === target.id)?.send('room:kicked', { message: 'You were removed by the host' });
      this.releaseSeat(room, target.userId);
    });

    this.onMessage("room:talk", (client: Client, data: any) => {
      const seat = this.seatOf(client);
      if (!seat) return;
      const msg = { player: seat.pd.name || 'Unknown', content: String(data?.content || '').slice(0, 200) };
      this.pushChat(seat.room, msg);
      this.sendToRoom(seat.room, 'room:talk', msg);
    });

    // The second player accepting a pending rematch (from the room's chat).
    this.onMessage("room:rematch", (client: Client) => {
      const seat = this.seatOf(client);
      if (seat && seat.room.rematch) this.addRematchPress(seat.room, seat.pd.userId);
    });

    // The only way to give a seat up yourself.
    this.onMessage("room:leave", (client: Client) => {
      const seat = this.seatOf(client);
      if (seat) this.releaseSeat(seat.room, seat.pd.userId);
    });
  }

  onJoin(_client: Client) {}

  // Fast path: a seated connection that drops can resume the SAME session
  // with its reconnection token. Its seat doesn't depend on this — presence
  // (heartbeat) decides away/release, and account rejoin takes it back.
  onDrop(client: Client) {
    if (!this.clientRoom.has(client.sessionId)) return; // not holding a seat: nothing to resume
    const seat = this.seatOf(client);
    if (seat) this.markGone(seat.room, seat.pd);       // shown away at once (as FIFA)
    const held: any = this.allowReconnection(client, LOBBY_RECONNECT_SECONDS);
    if (held?.reject) this.held.set(client.sessionId, held);
    const done = () => { if (this.held.get(client.sessionId) === held) this.held.delete(client.sessionId); };
    held?.then?.(done, done);
  }

  // Back after a drop: present again; resend their room and the list.
  onReconnect(client: Client) {
    const seat = this.seatOf(client);
    if (seat) {
      seat.pd.connected = true;
      this.touch(seat.room, seat.pd);
      client.send('room:state', serializeRoom(seat.room));
    }
    client.send('room:list', { rooms: this.serializeList() });
  }

  // A connection is gone for good. Its seat stays with the account (shown
  // away once the heartbeat stops); only room:leave, a kick or the seat hold
  // running out gives it up.
  onLeave(client: Client) {
    const seat = this.seatOf(client);
    if (seat) this.markGone(seat.room, seat.pd);
    this.clientRoom.delete(client.sessionId);
  }

  onDispose() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // ── Seats ──────────────────────────────────────────────────────────────────

  // The seat this connection currently holds, if any.
  private seatOf(client: Client): { room: LobbyRoomData; pd: PlayerData } | null {
    const code = this.clientRoom.get(client.sessionId);
    const room = code ? this.lobbyRooms[code] : undefined;
    if (!room) return null;
    const pd = room.players[(client.auth as PongAuth).userId];
    return pd && pd.id === client.sessionId ? { room, pd } : null;
  }

  // Point the account's seat at this connection. A different connection that
  // held it (another tab/device, or a stale one) is told and unbound, and its
  // pending token resume is cancelled so it can't take the seat back or keep
  // a reserved slot.
  private bindSeat(client: Client, room: LobbyRoomData, pd: PlayerData) {
    const old = pd.id;
    if (old !== client.sessionId) {
      if (this.clientRoom.get(old) === room.code) this.clientRoom.delete(old);
      this.clients.find(c => c.sessionId === old)?.send('room:superseded', { message: 'You opened this room somewhere else.' });
      const h = this.held.get(old);
      if (h) { this.held.delete(old); h.reject(false); }
    }
    pd.id = client.sessionId;
    pd.connected = true;
    this.clientRoom.set(client.sessionId, room.code);
    this.userRoom.set(pd.userId, room.code);
    this.touch(room, pd, false);
  }

  // Same account back on a new connection: keeps seat, ready state, host role.
  private takeOver(client: Client, room: LobbyRoomData) {
    const pd = room.players[(client.auth as PongAuth).userId];
    this.bindSeat(client, room, pd);
    console.log(`[lobby] account ${pd.userId} took its seat back in room ${room.code}`);
    client.send('room:joined', { room: serializeRoom(room), player: serializePlayer(pd), rejoined: true });
    this.sendToRoom(room, 'room:state', serializeRoom(room));
    this.broadcastList();
  }

  private touch(room: LobbyRoomData, pd: PlayerData, notify = true) {
    pd.lastSeen = Date.now();
    if (pd.away && pd.connected) {
      pd.away = false; pd.awaySince = 0;
      if (notify) this.sendToRoom(room, 'room:state', serializeRoom(room));
    }
  }

  // The seat's connection is gone (dropped or left): away from now on.
  private markGone(room: LobbyRoomData, pd: PlayerData) {
    pd.connected = false;
    if (!pd.away) { pd.away = true; pd.awaySince = Date.now(); this.sendToRoom(room, 'room:state', serializeRoom(room)); }
  }

  private releaseAccountSeat(userId: number) {
    const code = this.userRoom.get(userId);
    const room = code ? this.lobbyRooms[code] : undefined;
    if (room && room.players[userId]) this.releaseSeat(room, userId);
    else this.userRoom.delete(userId);
  }

  private releaseSeat(room: LobbyRoomData, userId: number) {
    const pd = room.players[userId];
    if (!pd) return;
    delete room.players[userId];
    if (this.clientRoom.get(pd.id) === room.code) this.clientRoom.delete(pd.id);
    if (this.userRoom.get(userId) === room.code) this.userRoom.delete(userId);
    const h = this.held.get(pd.id);
    if (h) { this.held.delete(pd.id); h.reject(false); }
    const code = room.code;

    for (const p of Object.values(room.players)) p.ready = false;   // a Ready was for the old pairing
    this.sendToRoom(room, 'room:player:leave', { id: pd.id });
    if (room.rematch) {
      room.rematch = null;
      this.sendToRoom(room, 'room:rematch', { cancelled: pd.name + ' left — rematch cancelled.' });
    }

    if (Object.keys(room.players).length === 0) {
      if (!room.started) {
        const t = setTimeout(() => {
          if (this.lobbyRooms[code] && Object.keys(this.lobbyRooms[code].players).length === 0) {
            delete this.lobbyRooms[code];
            this.broadcastList();
          }
          this.pendingDeletion.delete(code);
        }, 5 * 60 * 1000);
        this.pendingDeletion.set(code, t);
      } else {
        delete this.lobbyRooms[code];
      }
    } else if (room.master === userId) {
      const next = Object.values(room.players).find(p => !p.away) || Object.values(room.players)[0];
      this.setMaster(room, next);
    }
    this.sendToRoom(room, 'room:state', serializeRoom(room));
    this.broadcastList();
  }

  private setMaster(room: LobbyRoomData, next: PlayerData) {
    const prev = room.players[room.master];
    if (prev) prev.master = false;
    room.master = next.userId;
    next.master = true;
    this.sendToRoom(room, 'room:master', { master: next.id });
  }

  // Presence check: quiet seats show as away, an away host hands over, an
  // away seat is released once the hold runs out.
  private sweep() {
    const now = Date.now();
    for (const room of Object.values(this.lobbyRooms)) {
      if (room.started) continue;
      let changed = false;
      for (const pd of Object.values(room.players)) {
        if (!pd.away && (!pd.connected || now - pd.lastSeen > AWAY_AFTER_MS)) { pd.away = true; pd.awaySince = now; changed = true; }
      }
      for (const pd of Object.values(room.players)) {
        if (pd.away && now - pd.awaySince > SEAT_HOLD_MS) {
          console.log(`[lobby] seat of account ${pd.userId} released in room ${room.code} (away too long)`);
          this.clients.find(c => c.sessionId === pd.id)?.send('room:released', { message: 'Your seat was released after being away too long.' });
          this.releaseSeat(room, pd.userId);
          changed = false; // releaseSeat already sent the room's state
        }
      }
      if (!this.lobbyRooms[room.code]) continue;
      if (room.rematch) {
        const gone = Object.values(room.players).find(p => p.away && now - p.awaySince > REMATCH_CANCEL_MS);
        if (gone) {
          console.log(`[lobby] rematch in room ${room.code} cancelled: account ${gone.userId} away`);
          this.clients.find(c => c.sessionId === gone.id)?.send('room:released', { message: 'You were away — the rematch was cancelled.' });
          this.releaseSeat(room, gone.userId); // tells the other player and cancels
          changed = false;
          if (!this.lobbyRooms[room.code]) continue;
        }
      }
      const host = room.players[room.master];
      if (host && host.away && now - host.awaySince > HOST_HANDOFF_MS) {
        const next = Object.values(room.players).find(p => !p.away);
        if (next) { this.setMaster(room, next); changed = true; }
      }
      if (changed) this.sendToRoom(room, 'room:state', serializeRoom(room));
    }
  }

  // ── Rematch (called by the game_room through matchMaker.remoteRoomCall) ──

  // A player pressed Rematch on the match-over screen. First press: the room
  // the match was launched from comes back (same players, same chat) with the
  // rematch pending; both players' pages are sent to it. Later presses count
  // towards acceptance. Nothing is reset until both have pressed.
  public requestRematch(matchId: string, userId: number): { ok: boolean; error?: string } {
    const room = Object.values(this.lobbyRooms).find(r => r.matchId === matchId)
      || Object.values(this.lobbyRooms).find(r => r.rematch && r.players[userId]);
    if (!room || !room.players[userId]) return { ok: false, error: 'This room has closed — create a new one.' };
    if (room.rematch) { this.addRematchPress(room, userId); return { ok: true }; }
    if (!room.started) return { ok: false, error: 'This room has closed — create a new one.' };
    const players = Object.values(room.players);
    const elsewhere = players.find(p => { const c = this.userRoom.get(p.userId); return !!c && c !== room.code; });
    if (elsewhere) return { ok: false, error: elsewhere.name + ' has already joined another room.' };

    const now = Date.now();
    room.started = false;
    room.matchId = null;
    room.rematch = { by: new Set([userId]) };
    for (const p of players) {
      this.userMatch.delete(p.userId);
      this.userRoom.set(p.userId, room.code);
      // Grace to get from the match page back to the room.
      p.connected = true; p.lastSeen = now; p.away = false; p.awaySince = 0;
      // Same prize setting; in a "both" room both start on the prize they just played for.
      p.pick = room.prizeMode === 'both' ? room.lastPrize : Number(room.prizeMode) as Prize;
      p.ready = false;
    }
    console.log(`[lobby] rematch requested in room ${room.code} by account ${userId}`);
    // A player already on the room list (not in a room) is brought in now.
    for (const p of players) {
      const c = this.clients.find(cl => (cl.auth as PongAuth)?.userId === p.userId && !this.clientRoom.has(cl.sessionId));
      if (c) this.takeOver(c, room);
    }
    this.broadcastList();
    return { ok: true };
  }

  // The match room closed: if no rematch was asked for, the room goes.
  public matchClosed(matchId: string) {
    const room = Object.values(this.lobbyRooms).find(r => r.matchId === matchId && r.started);
    if (room) delete this.lobbyRooms[room.code];
  }

  private addRematchPress(room: LobbyRoomData, userId: number) {
    if (!room.rematch || !room.players[userId]) return;
    room.rematch.by.add(userId);
    const players = Object.values(room.players);
    if (players.length === SEATS_PER_ROOM && players.every(p => room.rematch!.by.has(p.userId))) {
      // Both pressed: back to the pre-start state — nobody ready; the normal
      // Ready → Start flow runs again for a brand-new match.
      room.rematch = null;
      for (const p of players) p.ready = false;
      console.log(`[lobby] rematch accepted in room ${room.code}`);
      this.sendToRoom(room, 'room:rematch', { accepted: true });
    }
    this.sendToRoom(room, 'room:state', serializeRoom(room));
  }

  // The match this account was launched into, if it's still being played.
  private async liveMatchOf(userId: number): Promise<string | null> {
    const roomId = this.userMatch.get(userId);
    if (!roomId) return null;
    try {
      const [listing] = await matchMaker.query({ name: "game_room", roomId });
      if (listing && !listing.metadata?.over) return roomId;
    } catch (_) {}
    this.userMatch.delete(userId);
    return null;
  }

  private serializeList() {
    return Object.values(this.lobbyRooms)
      // Like Puz Royale: private rooms are listed too, with a lock; joining
      // one needs its password.
      .filter(r => !r.started)
      .map(r => ({
        id: r.code, name: r.name, open: r.open, locked: !!r.password,
        players: Object.keys(r.players).length,
        prizeMode: r.prizeMode
      }));
  }

  private pushChat(room: LobbyRoomData, msg: LobbyRoomData['chat'][number]) {
    room.chat.push(msg);
    if (room.chat.length > CHAT_HISTORY_MAX) room.chat.splice(0, room.chat.length - CHAT_HISTORY_MAX);
  }

  private broadcastList() {
    this.broadcast('room:list', { rooms: this.serializeList() });
  }

  private sendToRoom(room: LobbyRoomData, event: string, data: any) {
    Object.values(room.players).forEach(p => {
      const c = this.clients.find(cl => cl.sessionId === p.id);
      c?.send(event, data);
    });
  }
}
