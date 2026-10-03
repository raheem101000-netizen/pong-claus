/* colyseus-adapter.js — socket.io API shim over Colyseus SDK
 * Loaded by rooms.html and pong-multiplayer.html in place of socket.io CDN.
 * Detects context from URL: pong-multiplayer path → joins game_room by URL code.
 * Everything else → joins persistent lobby_room.
 */
(function () {
  'use strict';

  var isGame = location.pathname.indexOf('pong-multiplayer') !== -1;
  var roomCodeFromURL = new URLSearchParams(location.search).get('room');
  var serverURL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;

  var _sdkReady = false;
  var _sdkQueue = [];

  function whenReady(fn) {
    if (_sdkReady) { fn(); } else { _sdkQueue.push(fn); }
  }

  var script = document.createElement('script');
  script.src = '/colyseus-sdk.js';
  script.onload = function () {
    _sdkReady = true;
    var q = _sdkQueue.splice(0);
    for (var i = 0; i < q.length; i++) { q[i](); }
  };
  script.onerror = function () {
    console.error('[colyseus-adapter] Failed to load Colyseus SDK from CDN');
  };
  document.head.appendChild(script);

  window.io = function () {
    var handlers = {};
    var mgr = {};
    var pending = [];
    var _room = null;
    var _roomId = null;
    var _connected = false;
    var _attempts = 0;

    var socket = {
      get connected() { return _connected; },
      id: null,
      io: {
        on: function (ev, cb) {
          if (!mgr[ev]) mgr[ev] = [];
          mgr[ev].push(cb);
        }
      },
      on: function (ev, cb) {
        if (!handlers[ev]) handlers[ev] = [];
        handlers[ev].push(cb);
        return socket;
      },
      emit: function (ev, data) {
        if (_room && _connected) {
          _room.send(ev, data);
        } else {
          pending.push({ ev: ev, data: data });
        }
      },
      disconnect: function () {
        if (_room) { _room.leave(true); _room = null; }
        _connected = false;
      }
    };

    function fire(ev, arg) {
      var cbs = handlers[ev] || [];
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](arg); } catch (e) { console.error('[colyseus-adapter]', e); }
      }
    }

    function fireMgr(ev, arg) {
      var cbs = mgr[ev] || [];
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](arg); } catch (e) { console.error('[colyseus-adapter]', e); }
      }
    }

    function attach(room) {
      _room = room;
      _roomId = room.roomId;
      _connected = true;
      socket.id = room.sessionId;

      room.onMessage('*', function (type, msg) { fire(type, msg); });

      room.onLeave(function (code) {
        _connected = false;
        fire('disconnect', 'transport close');
        if (code === 1000) return;
        // Lobby: resume the SAME session (the server holds the seat for 12
        // minutes). The game page keeps its own rejoin below.
        if (!isGame) { resumeLobby(room.reconnectionToken); return; }
        setTimeout(reconnect, 1500);
      });
      if (!isGame) {
        // The SDK's own quick retries run only ~3 s; then resumeLobby takes
        // over (it also learns at once when the seat has expired).
        if (room.reconnection) room.reconnection.maxRetries = 4;
        if (room.onDrop) room.onDrop(function () { fire('drop'); });
        if (room.onReconnect) room.onReconnect(function () { fire('resume'); });
      }

      room.onError(function (code, msg) {
        console.error('[colyseus-adapter] room error', code, msg);
      });

      var q = pending.splice(0);
      for (var i = 0; i < q.length; i++) { room.send(q[i].ev, q[i].data); }

      fire('connect');
    }

    // tenten.run login (stored by the lobby from the handoff): the server's
    // onAuth turns this token into the player's real account.
    function authedClient() {
      var client = new Colyseus.Client(serverURL);
      try {
        var a = JSON.parse(sessionStorage.getItem('pongmp_auth'));
        if (a && a.token) { client.auth.token = a.token; return { client: client, opts: { playerId: a.playerId } }; }
      } catch (e) {}
      return { client: client, opts: {} };
    }

    var gameRejoinFails = 0;
    function reconnect() {
      if (!_roomId) return;
      var c = authedClient();
      c.client.joinById(_roomId, c.opts)
        .then(function (room) {
          _attempts++;
          gameRejoinFails = 0;
          attach(room);
          fireMgr('reconnect', _attempts);
        })
        .catch(function (e) {
          // Game page: the match room no longer exists (both players gone, so it
          // closed) → tell the page instead of retrying forever on a frozen board.
          if (isGame) {
            gameRejoinFails++;
            var gone = e && (e.code === 522 || /not found|disposed|locked/i.test(e.message || ''));
            if (gone || gameRejoinFails >= 10) { fire('match_gone'); return; }
          }
          setTimeout(reconnect, 3000);
        });
    }

    // ── Lobby: reconnecting after a drop (phone in the background, network blip)
    // The SDK retries on its own for about a minute; after that we keep trying
    // to resume the SAME lobby session — every few seconds and as soon as the
    // tab is back in front — for up to 12 minutes (the server holds the seat
    // that long). If the seat/room is gone: 'connection_lost', then a fresh
    // lobby session so the room list keeps working.
    var LOBBY_RECONNECT_MS = 12 * 60 * 1000;
    var resume = null;
    function resumeLobby(token) {
      if (!token) { lobbyLost(); return; }
      resume = { token: token, until: Date.now() + LOBBY_RECONNECT_MS, busy: false, timer: null };
      fire('drop');
      tryResume();
    }
    function tryResume() {
      var r = resume;
      if (!r || r.busy) return;
      if (Date.now() > r.until) { lobbyLost(); return; }
      r.busy = true;
      authedClient().client.reconnect(r.token).then(function (room) {
        if (resume !== r) { try { room.leave(); } catch (e) {} return; }
        resume = null;
        _attempts++;
        attach(room);
        fire('resume');
        fireMgr('reconnect', _attempts);
      }).catch(function (e) {
        r.busy = false;
        // Seat/room gone (522/524 also arrive message-less through Cloudflare).
        if (e && (e.code === 522 || e.code === 524 || /expired|not found|invalid/i.test(e.message || ''))) { lobbyLost(); return; }
        r.timer = setTimeout(tryResume, 5000);
      });
    }
    function lobbyLost() {
      if (resume) clearTimeout(resume.timer);
      resume = null;
      fire('connection_lost');
      reconnect();
    }
    if (!isGame) {
      // Closing or leaving the page is a real leave (frees the seat now), unlike
      // a phone switching apps, which only hides the page and keeps the hold.
      window.addEventListener('pagehide', function () { if (_room) { try { _room.leave(true); } catch (e) {} } });
      document.addEventListener('visibilitychange', function () { if (!document.hidden && resume) { clearTimeout(resume.timer); tryResume(); } });
      window.addEventListener('online', function () { if (resume) { clearTimeout(resume.timer); tryResume(); } });
    }

    whenReady(function () {
      var c = authedClient(), client = c.client;
      var promise;
      if (isGame) {
        // Matches are only ever started from the lobby (the server refuses a
        // client-created game_room).
        promise = roomCodeFromURL
          ? client.joinById(roomCodeFromURL, c.opts)
          : Promise.reject(new Error('Matches can only be started from the lobby'));
      } else {
        promise = client.joinOrCreate('lobby_room', c.opts);
      }
      promise.then(attach).catch(function (e) { fire('connect_error', e); });
    });

    return socket;
  };
})();
