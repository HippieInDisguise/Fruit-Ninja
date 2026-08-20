/* sensor-client.js — drop this into a game and read Sensor.actions.
     <script src="https://your-server/sensor-client.js" data-room="ABCD"></script>
   Handles connecting, reconnecting, staleness, and desktop keyboard stand-ins. */
(function (root) {
  'use strict';

  var script = document.currentScript;

  var Sensor = {
    actions: {},
    connected: false,
    room: null,
    config: null,
    usingKeyboard: false,

    _ws: null, _seen: {}, _handlers: {}, _lastPacket: 0,
    _retry: 0, _timer: null, _keys: {}, _kb: null,
    _gate: null, _gateOn: true,

    connect: function (opts) {
      opts = opts || {};
      this.room = (opts.room || this.room || '').toUpperCase();
      if (!this.room) {
        console.warn('[Sensor] No room given. Pass one as data-room="ABCD" or Sensor.connect({room:"ABCD"}).');
        return this;
      }
      this._url = opts.url || defaultUrl(this.room);
      this._gateOn = opts.gate !== false;
      this._open();
      if (opts.keyboard !== false) this._enableKeyboard();
      if (this._gateOn) this._buildGate();
      return this;
    },

    /* True exactly once per trigger. Triggers arrive as counters, so this stays
       correct even if packets are dropped or the frame rate stutters. */
    fired: function (name) {
      var v = this.actions[name];
      if (typeof v !== 'number') return false;
      var was = this._seen[name];
      this._seen[name] = v;
      return was !== undefined && v > was;
    },

    on: function (name, fn) {
      (this._handlers[name] = this._handlers[name] || []).push(fn);
      return this;
    },

    _open: function () {
      var self = this;
      var ws;
      try { ws = new WebSocket(this._url); } catch (err) {
        console.warn('[Sensor] Bad address:', this._url, err.message);
        return;
      }
      this._ws = ws;

      ws.onopen = function () { self._retry = 0; };

      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (err) { return; }

        if (msg.t === 'hello' || msg.t === 'config') {
          self.config = msg.config || self.config;
          self._mapKeys();
        }
        if (msg.t !== 'data' || !msg.actions) return;

        self._lastPacket = Date.now();
        if (!self.connected) { self.connected = true; self._emit('connect'); }
        self.usingKeyboard = false;

        var prev = self.actions;
        self.actions = msg.actions;
        for (var name in msg.actions) {
          var handlers = self._handlers[name];
          if (!handlers) continue;
          var now = msg.actions[name], before = prev[name];
          var isTrigger = typeof now === 'number' && typeof before === 'number' && now > before &&
            self.config && (self.config.actions || []).some(function (a) {
              return a.name === name && a.kind === 'event';
            });
          var isPress = now === true && before !== true;
          if (isTrigger || isPress) handlers.forEach(function (fn) { try { fn(now); } catch (e) { console.error(e); } });
        }
      };

      ws.onclose = function () { self._down(); self._requeue(); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };

      clearInterval(this._timer);
      // The socket can stay open while the phone is asleep or backgrounded, so
      // treat silence as a disconnect rather than trusting readyState.
      this._timer = setInterval(function () {
        if (self.connected && Date.now() - self._lastPacket > 1500) self._down();
        self._showGate(!self.connected && !self.usingKeyboard);
      }, 400);
    },

    _down: function () {
      if (!this.connected) return;
      this.connected = false;
      this._emit('disconnect');
    },

    _requeue: function () {
      var self = this;
      var wait = Math.min(8000, 400 * Math.pow(1.7, this._retry++));
      setTimeout(function () { self._open(); }, wait);
    },

    _emit: function (kind) {
      (this._handlers[kind] || []).forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
    },

    /* Arrow keys and space stand in for the phone so a game can be built and
       tested on a laptop, then run for real without changing a line. */
    _mapKeys: function () {
      var list = (this.config && this.config.actions) || [];
      var ranges = list.filter(function (a) { return a.kind === 'range'; });
      var holds = list.filter(function (a) { return a.kind === 'switch'; });
      var trigs = list.filter(function (a) { return a.kind === 'event'; });
      this._kb = {
        x: ranges[0] || null,
        y: ranges[1] || null,
        hold: holds[0] || null,
        trig: trigs[0] || null
      };
    },

    _enableKeyboard: function () {
      var self = this;
      if (self._kbBound) return;
      self._kbBound = true;

      var axis = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd', a: 'l', d: 'r', w: 'u', s: 'd' };

      window.addEventListener('keydown', function (e) {
        var k = axis[e.key];
        if (k) { self._keys[k] = true; e.preventDefault(); }
        if (e.key === ' ' && !e.repeat && self._kb && self._kb.trig) {
          self._keys.fire = (self._keys.fire || 0) + 1;
          e.preventDefault();
        }
        if (e.key === 'Shift') self._keys.hold = true;
      });
      window.addEventListener('keyup', function (e) {
        var k = axis[e.key];
        if (k) self._keys[k] = false;
        if (e.key === 'Shift') self._keys.hold = false;
      });

      setInterval(function () {
        if (self.connected || !self._kb) return;
        var any = self._keys.l || self._keys.r || self._keys.u || self._keys.d ||
          self._keys.hold || self._keys.fire;
        if (!any && !self.usingKeyboard) return;
        self.usingKeyboard = true;
        var out = {};
        if (self._kb.x) out[self._kb.x.name] = (self._keys.r ? 100 : 0) - (self._keys.l ? 100 : 0);
        if (self._kb.y) out[self._kb.y.name] = (self._keys.d ? 100 : 0) - (self._keys.u ? 100 : 0);
        if (self._kb.hold) out[self._kb.hold.name] = !!self._keys.hold;
        if (self._kb.trig) out[self._kb.trig.name] = self._keys.fire || 0;
        self.actions = out;
      }, 1000 / 30);
    }
  };

  /* ---- the connect gate ----
     Every game needs the same screen: no phone yet, here is the code to scan.
     Building it in means an LLM writing a game never has to be told to, and the
     game reappears with it the moment a phone drops rather than freezing. */

  Sensor._buildGate = function () {
    var self = this;
    if (this._gate) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { self._buildGate(); });
      return;
    }

    var css = document.createElement('style');
    css.textContent =
      '#sensor-gate{position:fixed;inset:0;z-index:2147483647;display:none;' +
      'align-items:center;justify-content:center;padding:24px;' +
      'background:rgba(14,29,36,.92);backdrop-filter:blur(3px);' +
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#E4EAEA}' +
      '#sensor-gate.on{display:flex}' +
      '#sensor-gate .sg-card{text-align:center;max-width:340px}' +
      '#sensor-gate .sg-eyebrow{font-size:10px;letter-spacing:.16em;text-transform:uppercase;' +
      'color:#8A9AA0;margin:0 0 4px}' +
      '#sensor-gate .sg-code{font-size:44px;font-weight:700;letter-spacing:.08em;line-height:1;margin-bottom:16px}' +
      '#sensor-gate .sg-qr{width:190px;height:190px;margin:0 auto;background:#fff;padding:8px;border-radius:3px}' +
      '#sensor-gate .sg-qr svg{display:block;width:100%;height:100%}' +
      '#sensor-gate .sg-hint{font-size:12.5px;color:#97AAB1;margin:14px 0 0;line-height:1.5;word-break:break-all}' +
      '#sensor-gate a{color:#9FC4F0}' +
      '#sensor-gate .sg-keys{font-size:11.5px;color:#6E858D;margin:10px 0 0}';
    document.head.appendChild(css);

    var url = origin() + '/p/' + encodeURIComponent(this.room);
    var el = document.createElement('div');
    el.id = 'sensor-gate';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Connect your phone');
    el.innerHTML =
      '<div class="sg-card">' +
        '<p class="sg-eyebrow">Room</p>' +
        '<div class="sg-code"></div>' +
        '<div class="sg-qr"></div>' +
        '<p class="sg-hint">Scan this, or open<br><a target="_blank" rel="noopener"></a></p>' +
        '<p class="sg-keys">No phone? Arrow keys and space work too.</p>' +
      '</div>';
    el.querySelector('.sg-code').textContent = this.room;
    var link = el.querySelector('a');
    link.href = url;
    link.textContent = url;
    document.body.appendChild(el);
    this._gate = el;

    // The encoder lives on the same server as this script, so it is fetched
    // rather than bundled. If it cannot be reached the link alone still works.
    withQr(function (QR) {
      if (!QR) return;
      try { el.querySelector('.sg-qr').innerHTML = QR.toSvg(url, { fg: '#0E1D24', bg: '#ffffff', quiet: 1 }); }
      catch (err) { /* payload too big for the encoder; the link covers it */ }
    });
  };

  Sensor._showGate = function (want) {
    if (!this._gate || !this._gateOn) return;
    this._gate.classList.toggle('on', !!want);
  };

  function withQr(cb) {
    if (root.QR) return cb(root.QR);
    var s = document.createElement('script');
    s.src = origin() + '/qr.js';
    s.onload = function () { cb(root.QR || null); };
    s.onerror = function () { cb(null); };
    document.head.appendChild(s);
  }

  /* Where this script was served from — which is the broker, not the game. */
  function origin() {
    if (script && script.src) return new URL(script.src, location.href).origin;
    return location.origin;
  }

  function defaultUrl(room) {
    var base;
    if (script && script.src) {
      var u = new URL(script.src, location.href);
      base = (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host;
    } else {
      base = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    }
    return base + '/ws?room=' + encodeURIComponent(room) + '&type=display';
  }

  root.Sensor = Sensor;

  // Auto-connect when a room is declared on the script tag or in the URL.
  var auto = (script && script.getAttribute('data-room')) ||
    new URLSearchParams(location.search).get('room');
  if (auto) {
    Sensor.connect({
      room: auto,
      gate: (script && script.getAttribute('data-gate')) !== 'off'
    });
  }
})(typeof self !== 'undefined' ? self : this);
