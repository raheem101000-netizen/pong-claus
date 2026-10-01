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
        if (code !== 1000) {
          setTimeout(reconnect, 1500);
        }
      });

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

    function reconnect() {
      if (!_roomId) return;
      var c = authedClient();
      c.client.joinById(_roomId, c.opts)
        .then(function (room) {
          _attempts++;
          attach(room);
          fireMgr('reconnect', _attempts);
        })
        .catch(function () { setTimeout(reconnect, 3000); });
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
