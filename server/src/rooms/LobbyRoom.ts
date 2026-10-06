import { Room, Client, matchMaker } from "@colyseus/core";
import { authenticateGameToken, PongAuth } from "../auth";
import { issueLaunchTicket } from "../launchTickets";

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

interface PlayerData {
  id: string;        // the connection currently (or last) holding this seat
  userId: number;    // real tenten.run account (from the login handoff token) — owns the seat
  name: string;
  ready: boolean;
  master: boolean;
  color: string;
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
  return { id: p.id, name: p.name, ready: p.ready, master: p.master, color: p.color, away: p.away };
}

function serializeRoom(r: LobbyRoomData) {
  return {
    id: r.code, code: r.code, name: r.name, open: r.open, locked: !!r.password,
    master: r.players[r.master]?.id ?? null, started: r.started,
    players: Object.values(r.players).map(serializePlayer)
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
      // One seat per account: creating a room gives up a seat held elsewhere.
      this.releaseAccountSeat(auth.userId);
      this.userMatch.delete(auth.userId);
      const code = generateCode(this.lobbyRooms);
      const pd: PlayerData = {
        id: client.sessionId,
        userId: auth.userId,
        name: auth.displayName || 'Player 1',
        color: data.player?.color || '#b450ff',
        ready: false, master: true,
        lastSeen: Date.now(), away: false, awaySince: 0
      };
      const room: LobbyRoomData = {
        code, name,
        open: !priv, password: priv ? password : null, master: auth.userId,
        players: { [auth.userId]: pd }, started: false, kicked: new Set<number>()
      };
      this.lobbyRooms[code] = room;
      this.bindSeat(client, room, pd);
      client.send('room:created', { room: serializeRoom(room), player: serializePlayer(pd) });
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

      this.releaseAccountSeat(auth.userId);
      this.userMatch.delete(auth.userId);
      const pd: PlayerData = {
        id: client.sessionId,
        userId: auth.userId,
        name: auth.displayName || 'Player 2',
        color: data.player?.color || '#4488FF',
        ready: false, master: false,
        lastSeen: Date.now(), away: false, awaySince: 0
      };
      if (this.pendingDeletion.has(code)) {
        clearTimeout(this.pendingDeletion.get(code));
        this.pendingDeletion.delete(code);
      }
      if (Object.keys(room.players).length === 0) { pd.master = true; room.master = auth.userId; }
      room.players[auth.userId] = pd;
      this.bindSeat(client, room, pd);
      client.send('room:joined', { room: serializeRoom(room), player: serializePlayer(pd) });
      this.sendToRoom(room, 'room:player:join', { player: serializePlayer(pd) });
      this.sendToRoom(room, 'room:state', serializeRoom(room));
      this.broadcastList();
    });

    this.onMessage("room:ready", (client: Client) => {
      const seat = this.seatOf(client);
      if (!seat) return;
      seat.pd.ready = true;
      this.sendToRoom(seat.room, 'room:player:ready', { player: serializePlayer(seat.pd) });
      this.sendToRoom(seat.room, 'room:state', serializeRoom(seat.room));
    });

    this.onMessage("room:launch", async (client: Client) => {
      const seat = this.seatOf(client);
      if (!seat) return;
      const { room } = seat;
      if (room.started || room.master !== seat.pd.userId) return;
      const players = Object.values(room.players);
      // Pong is 1v1: a match needs its 2 players, and the non-host player must
      // have pressed Ready (the host starts instead of readying). No payment.
      if (players.length < SEATS_PER_ROOM) { client.send('room:error', { message: 'Need 2 players' }); return; }
      // Nobody starts a match for a player who isn't there.
      const away = players.filter(p => p.away).map(p => p.name);
      if (away.length) { client.send('room:error', { message: 'Waiting for ' + away.join(', ') + ' to come back' }); return; }
      if (!players.filter(p => p.userId !== room.master).every(p => p.ready)) {
        client.send('room:error', { message: 'Waiting for your opponent to be ready' }); return;
      }

      room.started = true; // no second launch while the match room is being created
      try {
        const gameRoom = await matchMaker.createRoom("game_room", {
          launchTicket: issueLaunchTicket(), // proves this match came from a lobby, not a client
          allowedUserIds: players.map(p => p.userId),
        });
        this.sendToRoom(room, 'room:game:start', {
          code: gameRoom.roomId,
          players: players.map(serializePlayer)
        });
        // The seats now live in the match room (account-owned there too). A
        // page that reloads into the lobby is sent back to the match while it's
        // still being played (room:rejoin → room:match).
        for (const p of players) {
          this.userMatch.set(p.userId, gameRoom.roomId);
          if (this.clientRoom.get(p.id) === room.code) this.clientRoom.delete(p.id);
          if (this.userRoom.get(p.userId) === room.code) this.userRoom.delete(p.userId);
        }
        delete this.lobbyRooms[room.code];
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
      this.sendToRoom(seat.room, 'room:talk', { player: seat.pd.name || 'Unknown', content: data.content || '' });
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
    const held: any = this.allowReconnection(client, LOBBY_RECONNECT_SECONDS);
    if (held?.reject) this.held.set(client.sessionId, held);
    const done = () => { if (this.held.get(client.sessionId) === held) this.held.delete(client.sessionId); };
    held?.then?.(done, done);
  }

  // Back after a drop: present again; resend their room and the list.
  onReconnect(client: Client) {
    const seat = this.seatOf(client);
    if (seat) {
      this.touch(seat.room, seat.pd);
      client.send('room:state', serializeRoom(seat.room));
    }
    client.send('room:list', { rooms: this.serializeList() });
  }

  // A connection is gone for good. Its seat stays with the account (shown
  // away once the heartbeat stops); only room:leave, a kick or the seat hold
  // running out gives it up.
  onLeave(client: Client) {
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
    if (pd.away) {
      pd.away = false; pd.awaySince = 0;
      if (notify) this.sendToRoom(room, 'room:state', serializeRoom(room));
    }
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

    this.sendToRoom(room, 'room:player:leave', { id: pd.id });

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
    if (prev) { prev.master = false; prev.ready = false; }
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
        const quiet = now - pd.lastSeen > AWAY_AFTER_MS;
        if (quiet !== pd.away) { pd.away = quiet; pd.awaySince = quiet ? now : 0; changed = true; }
      }
      for (const pd of Object.values(room.players)) {
        if (pd.away && now - pd.awaySince > SEAT_HOLD_MS) {
          console.log(`[lobby] seat of account ${pd.userId} released in room ${room.code} (away too long)`);
          this.releaseSeat(room, pd.userId);
          changed = false; // releaseSeat already sent the room's state
        }
      }
      if (!this.lobbyRooms[room.code]) continue;
      const host = room.players[room.master];
      if (host && host.away && now - host.awaySince > HOST_HANDOFF_MS) {
        const next = Object.values(room.players).find(p => !p.away);
        if (next) { this.setMaster(room, next); changed = true; }
      }
      if (changed) this.sendToRoom(room, 'room:state', serializeRoom(room));
    }
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
        players: Object.keys(r.players).length
      }));
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
