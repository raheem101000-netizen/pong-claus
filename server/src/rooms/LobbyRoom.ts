import { Room, Client, matchMaker } from "@colyseus/core";
import { authenticateGameToken, PongAuth } from "../auth";
import { issueLaunchTicket } from "../launchTickets";

// How long a dropped player's seat is held (12 minutes; LOBBY_RECONNECT_SECONDS
// overrides it for tests only).
const LOBBY_RECONNECT_SECONDS = Number(process.env.LOBBY_RECONNECT_SECONDS) || 12 * 60;

interface PlayerData {
  id: string;
  userId: number; // real tenten.run account (from the login handoff token)
  name: string;
  ready: boolean;
  master: boolean;
  color: string;
  paying: boolean;
}

interface LobbyRoomData {
  code: string;
  name: string;
  open: boolean;
  password: string | null;   // private rooms: the host's password (never sent to clients)
  master: string;
  players: Record<string, PlayerData>;
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
  return { id: p.id, name: p.name, ready: p.ready, master: p.master, color: p.color };
}

function serializeRoom(r: LobbyRoomData) {
  return {
    id: r.code, code: r.code, name: r.name, open: r.open, locked: !!r.password,
    master: r.master, started: r.started,
    players: Object.values(r.players).map(serializePlayer)
  };
}

export class LobbyRoom extends Room {
  autoDispose = false;
  maxClients = 200;

  private lobbyRooms: Record<string, LobbyRoomData> = {};
  private clientRoom = new Map<string, string>();
  private clientData = new Map<string, PlayerData>();
  private pendingDeletion = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingPaymentCleanup = new Map<string, ReturnType<typeof setTimeout>>();

  // Every lobby connection must be a logged-in tenten.run account.
  static async onAuth(token: string, options: any) {
    return authenticateGameToken(token, options?.playerId);
  }

  onCreate() {
    this.onMessage("room:list", (client: Client) => {
      client.send("room:list", { rooms: this.serializeList() });
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
      const code = generateCode(this.lobbyRooms);
      const pd: PlayerData = {
        id: client.sessionId,
        userId: auth.userId,
        name: auth.displayName || 'Player 1',
        color: data.player?.color || '#b450ff',
        ready: false, master: true, paying: false
      };
      const room: LobbyRoomData = {
        code, name,
        open: !priv, password: priv ? password : null, master: client.sessionId,
        players: { [client.sessionId]: pd }, started: false, kicked: new Set<number>()
      };
      this.lobbyRooms[code] = room;
      this.clientRoom.set(client.sessionId, code);
      this.clientData.set(client.sessionId, pd);
      client.send('room:created', { room: serializeRoom(room), player: serializePlayer(pd) });
      this.broadcastList();
    });

    this.onMessage("room:paying", (client: Client) => {
      const code = this.clientRoom.get(client.sessionId);
      if (!code) return;
      const room = this.lobbyRooms[code];
      if (!room) return;
      const pd = room.players[client.sessionId];
      if (pd) pd.paying = true;
    });

    this.onMessage("room:join", (client: Client, data: any) => {
      const code = data.code || data.room;
      const room = this.lobbyRooms[code];
      if (!room) { client.send('room:error', { message: 'Room not found' }); return; }
      if (room.started) { client.send('room:error', { message: 'Game already started' }); return; }
      const auth = client.auth as PongAuth;
      if (room.kicked.has(auth.userId)) { client.send('room:error', { message: 'You were removed from this room by the host' }); return; }
      // One seat per account: the same account can't take both sides of a 1v1.
      if (Object.values(room.players).some(p => p.userId === auth.userId && !p.paying)) {
        client.send('room:error', { message: 'Your account is already in this room' }); return;
      }
      if (Object.keys(room.players).length >= 2) {
        // Rejoin after leaving the page: matched by account, not by typed name.
        const payingKey = Object.keys(room.players).find(sid => room.players[sid].paying && room.players[sid].userId === auth.userId);
        if (!payingKey) { client.send('room:error', { message: 'Room is full' }); return; }
        const oldTimeout = this.pendingPaymentCleanup.get(payingKey);
        if (oldTimeout) clearTimeout(oldTimeout);
        this.pendingPaymentCleanup.delete(payingKey);
        const rpd = room.players[payingKey];
        rpd.id = client.sessionId;
        rpd.paying = false;
        delete room.players[payingKey];
        room.players[client.sessionId] = rpd;
        if (room.master === payingKey) room.master = client.sessionId;
        this.clientRoom.set(client.sessionId, code);
        this.clientData.set(client.sessionId, rpd);
        client.send('room:joined', { room: serializeRoom(room), player: serializePlayer(rpd) });
        this.sendToRoom(room, 'room:player:join', { player: serializePlayer(rpd) });
        this.sendToRoom(room, 'room:state', serializeRoom(room));
        this.broadcastList();
        return;
      }

      // Private room: the host's password (a player already seated rejoins above without it).
      if (room.password && data?.password !== room.password) {
        client.send('room:error', { message: data?.password ? 'Wrong password' : 'This room is private — enter its password' }); return;
      }

      const pd: PlayerData = {
        id: client.sessionId,
        userId: auth.userId,
        name: auth.displayName || 'Player 2',
        color: data.player?.color || '#4488FF',
        ready: false, master: false, paying: false
      };
      if (this.pendingDeletion.has(code)) {
        clearTimeout(this.pendingDeletion.get(code));
        this.pendingDeletion.delete(code);
      }
      if (Object.keys(room.players).length === 0) { pd.master = true; room.master = client.sessionId; }
      room.players[client.sessionId] = pd;
      this.clientRoom.set(client.sessionId, code);
      this.clientData.set(client.sessionId, pd);
      client.send('room:joined', { room: serializeRoom(room), player: serializePlayer(pd) });
      this.sendToRoom(room, 'room:player:join', { player: serializePlayer(pd) });
      this.sendToRoom(room, 'room:state', serializeRoom(room));
      this.broadcastList();
    });

    this.onMessage("room:ready", (client: Client) => {
      const code = this.clientRoom.get(client.sessionId);
      if (!code) return;
      const room = this.lobbyRooms[code];
      if (!room) return;
      const pd = room.players[client.sessionId];
      if (!pd) return;
      pd.ready = true;
      this.sendToRoom(room, 'room:player:ready', { player: serializePlayer(pd) });
      this.sendToRoom(room, 'room:state', serializeRoom(room));
    });

    this.onMessage("room:launch", async (client: Client) => {
      const code = this.clientRoom.get(client.sessionId);
      if (!code) return;
      const room = this.lobbyRooms[code];
      if (!room || room.master !== client.sessionId) return;
      const players = Object.values(room.players);
      // Pong is 1v1: a match needs its 2 players, and the non-host player must
      // have pressed Ready (the host starts instead of readying). No payment.
      if (players.length < 2) { client.send('room:error', { message: 'Need 2 players' }); return; }
      if (!players.filter(p => p.id !== room.master).every(p => p.ready)) {
        client.send('room:error', { message: 'Waiting for your opponent to be ready' }); return;
      }

      try {
        const gameRoom = await matchMaker.createRoom("game_room", {
          launchTicket: issueLaunchTicket(), // proves this match came from a lobby, not a client
          allowedUserIds: players.map(p => p.userId),
        });
        room.started = true;
        this.broadcastList();
        this.sendToRoom(room, 'room:game:start', {
          code: gameRoom.roomId,
          players: players.map(serializePlayer)
        });
      } catch (e) {
        client.send('room:error', { message: 'Failed to start game' });
      }
    });

    // Host kick: only the host, never themselves; the removed player is told
    // why, taken out of the room (as if they'd left), and can't rejoin it.
    this.onMessage("room:kick", (client: Client, data: any) => {
      const code = this.clientRoom.get(client.sessionId);
      const room = code ? this.lobbyRooms[code] : undefined;
      if (!room || room.master !== client.sessionId) { client.send('room:error', { message: 'Only the host can remove players' }); return; }
      if (room.started) return;
      const targetId = String(data?.id || '');
      if (targetId === client.sessionId) { client.send('room:error', { message: "You can't remove yourself" }); return; }
      const target = room.players[targetId];
      if (!target) { client.send('room:error', { message: 'Player not found' }); return; }
      room.kicked.add(target.userId);
      const targetClient = this.clients.find(c => c.sessionId === targetId);
      if (targetClient) {
        targetClient.send('room:kicked', { message: 'You were removed by the host' });
        this.handleLeave(targetClient, true);
      } else {
        delete room.players[targetId];
        this.sendToRoom(room, 'room:state', serializeRoom(room));
        this.broadcastList();
      }
    });

    this.onMessage("room:talk", (client: Client, data: any) => {
      const code = this.clientRoom.get(client.sessionId);
      if (!code) return;
      const room = this.lobbyRooms[code];
      if (!room) return;
      const pd = this.clientData.get(client.sessionId);
      this.sendToRoom(room, 'room:talk', { player: pd?.name || 'Unknown', content: data.content || '' });
    });

    this.onMessage("room:leave", (client: Client) => {
      this.handleLeave(client, true);
    });
  }

  onJoin(_client: Client) {}

  // Reconnection grace: a player whose connection drops (phone put in the
  // background, network blip) keeps their seat in their Pong room, ready state and presence for LOBBY_RECONNECT_SECONDS; the client SDK resumes the SAME session,
  // so nobody sees them "leave". If they don't come back in time, onLeave runs
  // as for a normal leave. A consented leave (closing the page, the host's
  // kick) skips this and goes straight to onLeave.
  onDrop(client: Client) {
    const held: any = this.allowReconnection(client, LOBBY_RECONNECT_SECONDS);
    held?.catch?.(() => {});
  }

  // Back after a drop: resend their room (anything broadcast while away) and the list.
  onReconnect(client: Client) {
    const code = this.clientRoom.get(client.sessionId);
    const room = code ? this.lobbyRooms[code] : undefined;
    if (room && room.players[client.sessionId]) client.send('room:state', serializeRoom(room));
    client.send('room:list', { rooms: this.serializeList() });
  }

  onLeave(client: Client) {
    this.handleLeave(client, false);
  }

  private handleLeave(client: Client, explicit = true) {
    const code = this.clientRoom.get(client.sessionId);
    if (!code) return;
    const room = this.lobbyRooms[code];
    if (!room) { this.clientRoom.delete(client.sessionId); this.clientData.delete(client.sessionId); return; }

    const pd = this.clientData.get(client.sessionId);

    if (!explicit && pd && pd.paying) {
      const sessionId = client.sessionId;
      const prevTimeout = this.pendingPaymentCleanup.get(sessionId);
      if (prevTimeout) clearTimeout(prevTimeout);
      this.pendingPaymentCleanup.set(sessionId, setTimeout(() => {
        const r2 = this.lobbyRooms[code];
        if (!r2 || !r2.players[sessionId]) return;
        delete r2.players[sessionId];
        this.clientRoom.delete(sessionId);
        this.clientData.delete(sessionId);
        this.pendingPaymentCleanup.delete(sessionId);
        if (Object.keys(r2.players).length === 0 && !r2.started) {
          const t2 = setTimeout(() => { if (this.lobbyRooms[code] && Object.keys(this.lobbyRooms[code].players).length === 0) { delete this.lobbyRooms[code]; this.broadcastList(); } this.pendingDeletion.delete(code); }, 60000);
          this.pendingDeletion.set(code, t2);
        } else if (r2.master === sessionId) {
          const newM = Object.keys(r2.players)[0];
          r2.master = newM; r2.players[newM].master = true;
          this.clients.find(c => c.sessionId === newM)?.send('room:master', { master: newM });
        }
        this.sendToRoom(r2, 'room:state', serializeRoom(r2));
        this.broadcastList();
      }, 5 * 60 * 1000));
      return;
    }

    delete room.players[client.sessionId];
    this.clientRoom.delete(client.sessionId);
    this.clientData.delete(client.sessionId);

    this.sendToRoom(room, 'room:player:leave', { id: client.sessionId });

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
    } else if (room.master === client.sessionId) {
      const newMasterId = Object.keys(room.players)[0];
      room.master = newMasterId;
      room.players[newMasterId].master = true;
      const masterClient = this.clients.find(c => c.sessionId === newMasterId);
      masterClient?.send('room:master', { master: newMasterId });
    }
    this.sendToRoom(room, 'room:state', serializeRoom(room));
    this.broadcastList();
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
    Object.keys(room.players).forEach(sessionId => {
      const c = this.clients.find(cl => cl.sessionId === sessionId);
      c?.send(event, data);
    });
  }
}
