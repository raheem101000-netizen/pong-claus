import { Room, Client, matchMaker } from "@colyseus/core";

interface PlayerData {
  id: string;
  name: string;
  ready: boolean;
  master: boolean;
  color: string;
}

interface LobbyRoomData {
  code: string;
  name: string;
  open: boolean;
  master: string;
  players: Record<string, PlayerData>;
  started: boolean;
}

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
    id: r.code, code: r.code, name: r.name, open: r.open,
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

  onCreate() {
    this.onMessage("room:list", (client: Client) => {
      client.send("room:list", { rooms: this.serializeList() });
    });

    this.onMessage("room:create", (client: Client, data: any) => {
      const code = generateCode(this.lobbyRooms);
      const pd: PlayerData = {
        id: client.sessionId,
        name: data.playerName || data.player?.name || 'Player 1',
        color: data.player?.color || '#b450ff',
        ready: false, master: true
      };
      const room: LobbyRoomData = {
        code, name: data.name || 'Room ' + code,
        open: data.open !== false, master: client.sessionId,
        players: { [client.sessionId]: pd }, started: false
      };
      this.lobbyRooms[code] = room;
      this.clientRoom.set(client.sessionId, code);
      this.clientData.set(client.sessionId, pd);
      client.send('room:created', { room: serializeRoom(room), player: serializePlayer(pd) });
      this.broadcastList();
    });

    this.onMessage("room:join", (client: Client, data: any) => {
      const code = data.code || data.room;
      const room = this.lobbyRooms[code];
      if (!room) { client.send('room:error', { message: 'Room not found' }); return; }
      if (room.started) { client.send('room:error', { message: 'Game already started' }); return; }
      if (Object.keys(room.players).length >= 2) { client.send('room:error', { message: 'Room is full' }); return; }

      const pd: PlayerData = {
        id: client.sessionId,
        name: data.playerName || data.player?.name || 'Player 2',
        color: data.player?.color || '#4488FF',
        ready: false, master: false
      };
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
      if (players.length < 2) { client.send('room:error', { message: 'Need 2 players' }); return; }
      const guestReady = players.filter(p => !p.master).every(p => p.ready);
      if (!guestReady) { client.send('room:error', { message: 'Waiting for opponent to ready up' }); return; }

      try {
        const gameRoom = await matchMaker.createRoom("game_room", {});
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

    this.onMessage("room:talk", (client: Client, data: any) => {
      const code = this.clientRoom.get(client.sessionId);
      if (!code) return;
      const room = this.lobbyRooms[code];
      if (!room) return;
      const pd = this.clientData.get(client.sessionId);
      this.sendToRoom(room, 'room:talk', { player: pd?.name || 'Unknown', content: data.content || '' });
    });

    this.onMessage("room:leave", (client: Client) => {
      this.handleLeave(client);
    });
  }

  onJoin(_client: Client) {}

  onLeave(client: Client) {
    this.handleLeave(client);
  }

  private handleLeave(client: Client) {
    const code = this.clientRoom.get(client.sessionId);
    if (!code) return;
    const room = this.lobbyRooms[code];
    if (!room) { this.clientRoom.delete(client.sessionId); this.clientData.delete(client.sessionId); return; }

    delete room.players[client.sessionId];
    this.clientRoom.delete(client.sessionId);
    this.clientData.delete(client.sessionId);

    this.sendToRoom(room, 'room:player:leave', { id: client.sessionId });

    if (Object.keys(room.players).length === 0) {
      delete this.lobbyRooms[code];
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
      .filter(r => !r.started && r.open)
      .map(r => ({
        id: r.code, name: r.name, open: r.open,
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
