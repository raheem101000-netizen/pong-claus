/* colyseus-adapter.js — socket.io API shim over Colyseus SDK
 * Loaded by rooms.html and pong-multiplayer.html in place of socket.io CDN.
 * Detects context from URL: pong-multiplayer path → joins game_room by URL code.
 * Everything else → joins persistent lobby_room.
 *
 * Reconnection (same model as FIFA / Kurver — seats belong to the account):
 *   1. fast resume: the SDK resumes the SAME session with its reconnection token;
 *   2. account rejoin: otherwise a fresh connection is opened and the page asks
 *      for its account's seat back ('connect' fires again — the lobby page sends
 *      room:rejoin, the game page joinRoom), which the server hands over.
 * A heartbeat ('hb' every 5 s, answered by the server) is the presence signal
 * and also spots a dead connection the browser never reported (phone asleep,
 * network switch, Safari bfcache): no answer for 15 s → reconnect.
 *
 * Events for the page: 'connect' (every new connection), 'resume' (same session
 * back), 'drop' (connection lost, reconnecting), 'superseded' (this seat was
 * opened in another tab/device — no more reconnecting), 'match_gone',
 * 'connect_error'.
 */
(function () {
  'use strict';

  var isGame = location.pathname.indexOf('pong-multiplayer') !== -1;
  var roomCodeFromURL = new URLSearchParams(location.search).get('room');
  var serverURL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;

  var HB_EVERY_MS = 5000;
  var HB_DEAD_MS = 15000;

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

  // tenten.run login, stored by the lobby from the handoff. Kept on the device
  // (localStorage) so a reload, a new tab or a page restored from bfcache stays
  // logged in; the server still bounds the token's age.
  window.pongmpAuth = function () {
    var raw = null;
    try { raw = localStorage.getItem('pongmp_auth'); } catch (e) {}
    if (!raw) { try { raw = sessionStorage.getItem('pongmp_auth'); } catch (e) {} }
    try { return JSON.parse(raw) || null; } catch (e) { return null; }
  };

  window.io = function () {
    var handlers = {};
    var mgr = {};
    var pending = [];
    var _room = null;
    var _roomId = isGame ? roomCodeFromURL : null;
    var _connected = false;
    var _attempts = 0;
    var _gen = 0;              // which connection is current (older ones are ignored)
    var _stopped = false;      // left on purpose or superseded: no reconnecting
    var _superseded = false;
    var _dropAt = 0;           // when the SDK's fast resume started
    var _joining = false;
    var _retryTimer = null;
    var _lastAck = 0;
    var _everConnected = false;

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
        _stopped = true;
        clearTimeout(_retryTimer);
        if (_room) { try { _room.leave(true); } catch (e) {} _room = null; }
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
      var gen = ++_gen;
      _room = room;
      _roomId = room.roomId;
      _connected = true;
      _lastAck = Date.now();
      socket.id = room.sessionId;

      room.onMessage('*', function (type, msg) {
        if (gen !== _gen) return;
        if (type === 'hb') { _lastAck = Date.now(); return; }
        if (type === 'superseded' || type === 'room:superseded') onSuperseded(type, msg);
        fire(type, msg);
      });

      // Fast resume: the SDK's own retries with the reconnection token
      // (the server holds the session for that).
      if (room.reconnection) room.reconnection.maxRetries = 6;
      if (room.onDrop) room.onDrop(function () {
        if (gen !== _gen) return;
        _connected = false;
        _dropAt = Date.now();
        fire('drop');
      });
      if (room.onReconnect) room.onReconnect(function () {
        if (gen !== _gen) return;
        _connected = true;
        _lastAck = Date.now();
        flush();
        fire('resume');
        beat();
      });

      room.onLeave(function (code) {
        if (gen !== _gen) return;
        _connected = false;
        _room = null;
        fire('disconnect', 'transport close');
        if (_stopped || code === 1000) return;
        // Resume wasn't possible (session gone, retries used up, server
        // closed us): account rejoin on a fresh connection.
        fire('drop');
        scheduleRejoin(1000);
      });

      room.onError(function (code, msg) {
        console.error('[colyseus-adapter] room error', code, msg);
      });

      flush();
      fire('connect');
      if (_everConnected) fireMgr('reconnect', ++_attempts);
      _everConnected = true;
      beat();
    }

    function flush() {
      var q = pending.splice(0);
      for (var i = 0; i < q.length; i++) { _room.send(q[i].ev, q[i].data); }
    }

    // The game page's seat moved to another tab/device: stop here. (The lobby
    // connection stays — only its seat moved — so the room list keeps working.)
    function onSuperseded(type) {
      if (type !== 'superseded') return;
      _stopped = true;
      _superseded = true;
      clearTimeout(_retryTimer);
    }

    function authedClient() {
      var client = new Colyseus.Client(serverURL);
      var a = window.pongmpAuth();
      if (a && a.token) { client.auth.token = a.token; return { client: client, opts: { playerId: a.playerId } }; }
      return { client: client, opts: {} };
    }

    // Open a fresh connection (first load, or account rejoin after a failed resume).
    function join() {
      if (_stopped || _joining) return;
      _joining = true;
      clearTimeout(_retryTimer);
      var c = authedClient();
      var p;
      if (isGame) {
        // Matches are only ever started from the lobby (the server refuses a
        // client-created game_room).
        p = _roomId ? c.client.joinById(_roomId, c.opts) : Promise.reject(new Error('Matches can only be started from the lobby'));
      } else {
        p = c.client.joinOrCreate('lobby_room', c.opts);
      }
      p.then(function (room) {
        _joining = false;
        if (_stopped) { try { room.leave(true); } catch (e) {} return; }
        attach(room);
      }).catch(function (e) {
        _joining = false;
        if (e && (e.code === 401 || /log in|login has expired/i.test(e.message || ''))) { fire('connect_error', e); return; }
        // Game page: the match room no longer exists (no seat held for a long
        // time, so it closed) → tell the page instead of a frozen board.
        if (isGame && e && (e.code === 522 || e.code === 4212 || /not found|disposed|locked|not a player/i.test(e.message || ''))) { fire('match_gone'); return; }
        if (!_everConnected) fire('connect_error', e);
        scheduleRejoin(3000);
      });
    }

    // Give up on the current connection (dead, or stuck resuming) without
    // triggering the SDK's own reconnection, and rejoin with the account.
    function abandon() {
      var old = _room;
      _gen++; _room = null; _connected = false;
      if (old) { try { old.connection.close(1000); } catch (e) {} }
      fire('drop');
      join();
    }

    function scheduleRejoin(ms) {
      if (_stopped) return;
      clearTimeout(_retryTimer);
      _retryTimer = setTimeout(join, ms);
    }

    // Heartbeat: presence for the server, and a dead-connection check for us.
    function beat() {
      if (_stopped) return;
      if (_room && _connected) {
        if (Date.now() - _lastAck > HB_DEAD_MS) {
          // The connection is dead even though the browser never said so:
          // drop it and rejoin with the account.
          console.info('[colyseus-adapter] no answer from the server — reconnecting');
          abandon();
          return;
        }
        try { _room.send('hb'); } catch (e) {}
      } else if (_room && !_connected) {
        // Fast resume taking too long: fall back to account rejoin.
        if (Date.now() - _dropAt > HB_DEAD_MS) abandon();
      } else if (!_room && !_joining && _everConnected) {
        join();
      }
    }
    setInterval(beat, HB_EVERY_MS);

    // Back in front / back online / restored from bfcache: check at once.
    function wake() {
      if (_stopped || document.visibilityState === 'hidden') return;
      if (_room) { beat(); return; }   // connected, or the SDK is resuming
      if (!_joining) { clearTimeout(_retryTimer); join(); }
    }
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) {
        // A page restored from bfcache: its old connection is dead — rejoin.
        if (_superseded) return;
        _stopped = false;
        abandon();
      }
    });
    // Leaving the page is NOT a leave: the seat stays with the account (so a
    // reload, bfcache or a quick app switch comes straight back to it). Only
    // the room's Leave button gives a seat up.

    whenReady(join);

    return socket;
  };
})();
