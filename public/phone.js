/* phone.js — everything the controller page *does*.
   phone.html is now markup and nothing else: rearrange it, restyle it, translate
   it, throw parts of it away. Nothing in here reads a class name or an id, so
   styling cannot break the wiring.

   The page is addressed through data-vsn="..." hooks, and every one is optional:

     code       filled with the room code (any number of them)
     gate       hidden once the sensors are running
     live       revealed once the sensors are running
     start      the button that asks for motion permission
     warn       where permission problems are written
     zero       recalibrate — "Set centre"
     strips     host for the live meters
     controls   host for the on-screen touch controls
     status     text: connecting / linked / dropped
     dot        gets .on or .off
     rate       packets per second

   Three of those the experience cannot work without — start, zero and controls —
   so if the markup has dropped them they are created rather than missed. The
   busy/handed-on overlay is not in the markup at all: it is injected here, the
   same way sensor-client.js injects the QR screen, so an edit cannot remove the
   one screen that explains why the phone stopped working. */
(function () {
  'use strict';

  var CHAN = ['var(--c5)', 'var(--c1)', 'var(--c4)', 'var(--c2)', 'var(--c6)', 'var(--c3)'];

  function pick(name) { return document.querySelector('[data-vsn="' + name + '"]'); }
  function pickAll(name) { return document.querySelectorAll('[data-vsn="' + name + '"]'); }
  function text(name, value) {
    var list = pickAll(name);
    for (var i = 0; i < list.length; i++) list[i].textContent = value;
  }
  function show(name, on) { var el = pick(name); if (el) el.hidden = !on; }

  var m = location.pathname.match(/^\/p\/([A-Za-z0-9]{1,8})/);
  var room = ((m && m[1]) || new URLSearchParams(location.search).get('room') || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

  var config = VSN.starterConfig();
  var ws = null, seq = 0, sendTimer = null, lastSent = null, lastFullAt = 0;
  var sent = 0, wakeLock = null;
  var halted = false, retryTimer = null;
  var counters = {};

  text('code', room || '????');

  var warn = pick('warn');
  if (!window.isSecureContext && warn) {
    warn.innerHTML = '<div class="alert">This page is not on HTTPS, so the browser will not share ' +
      'any movement. Ask for the https:// link and open that instead.</div>';
  }

  /* ---------------------------------------------------------------- start --- */

  // iOS only grants motion access from a real tap, so a button has to exist.
  var startBtn = pick('start') || inject('start', 'Turn on sensors');

  startBtn.addEventListener('click', async function () {
    startBtn.disabled = true;
    startBtn.textContent = 'Asking…';
    var ok = await Sensors.start();
    if (!ok) {
      if (warn) warn.innerHTML = '<div class="alert">' + (Sensors.reason || 'Could not read motion.') + '</div>';
      startBtn.disabled = false;
      startBtn.textContent = 'Try again';
      return;
    }
    Sensors.calibrate();
    Sensors.setConfig(config);
    show('gate', false);
    show('live', true);
    render();
    connect();
    startSending();
    keepAwake();
    requestAnimationFrame(tick);
  });

  var zeroBtn = pick('zero') || inject('zero', 'Set centre');
  var zeroLabel = zeroBtn.textContent;
  zeroBtn.addEventListener('click', function () {
    Sensors.calibrate();
    zeroBtn.textContent = 'Centre set';
    setTimeout(function () { zeroBtn.textContent = zeroLabel; }, 1200);
  });

  /* A page that has been edited down to nothing still needs these two buttons. */
  function inject(name, label) {
    var el = document.createElement('button');
    el.setAttribute('data-vsn', name);
    el.className = 'vsn-added';
    el.textContent = label;
    (document.querySelector('.stage') || document.body).appendChild(el);
    return el;
  }

  /* A phone that sleeps mid-round is the most common way this falls over. */
  async function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    document.addEventListener('visibilitychange', async function () {
      if (document.visibilityState === 'visible') {
        try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
      }
    });
  }

  /* --------------------------------------------------------------- socket --- */

  function connect() {
    clearTimeout(retryTimer);
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws?room=' + room + '&type=phone');
    ws.onopen = function () { setLink(true, 'linked'); };
    ws.onclose = function () {
      setLink(false, 'dropped');
      // Held off deliberately when the room turned us away or timed us out:
      // reconnecting on a timer would just take the slot straight back.
      if (!halted) setTimeout(connect, 1000);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }

      if (msg.t === 'busy') {
        return halt('Someone else is playing',
          'Only one phone can drive the room at a time. The controller frees up once they stop moving.',
          msg.after);
      }
      if (msg.t === 'idle') {
        return halt('Handed on',
          'The phone sat still for a while, so the controller went to whoever is next. Rejoin whenever you like.',
          0);
      }
      if ((msg.t === 'hello' || msg.t === 'config') && msg.config) {
        config = msg.config;
        Sensors.setConfig(config);
        render();
        startSending();
      }
    };
  }

  function setLink(ok, label) {
    var dot = pick('dot');
    if (dot) dot.className = 'dot ' + (ok ? 'on' : 'off');
    text('status', label);
    if (!ok) text('rate', '—');
  }

  function startSending() {
    clearInterval(sendTimer);
    var rate = Math.max(5, Math.min(60, config.rate || 30));
    sendTimer = setInterval(push, 1000 / rate);
  }

  function push() {
    if (!ws || ws.readyState !== 1) return;
    var actions = Sensors.compute();
    var body = JSON.stringify(actions);
    var now = Date.now();
    // Nothing moved? Drop to a heartbeat instead of flooding the room's wifi.
    if (body === lastSent && now - lastFullAt < 250) return;
    lastSent = body;
    lastFullAt = now;
    ws.send(JSON.stringify({ t: 'data', meta: { room: room, seq: ++seq, t: now }, actions: actions }));
    sent++;
  }

  setInterval(function () { text('rate', sent ? sent + '/s' : 'still'); sent = 0; }, 1000);

  /* ----------------------------------------------------- the stop overlay --- */
  /* Injected, not authored, so no amount of editing can leave a phone sitting on
     a dead socket with no explanation. The baseline styles go in ahead of any
     stylesheet, so app.css — or anything a student writes — overrides them. */

  var halt$ = null;

  function haltEl() {
    if (halt$) return halt$;

    var css = document.createElement('style');
    css.textContent =
      '.vsn-halt{position:fixed;inset:0;z-index:20;display:flex;align-items:center;' +
      'justify-content:center;padding:28px;background:#0E1D24;color:#E4EAEA;' +
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}' +
      '.vsn-halt[hidden]{display:none}' +
      '.vsn-halt h1{font-size:28px;margin:0 0 10px}' +
      '.vsn-halt p{color:#97AAB1;margin:0 0 22px;font-size:14px}' +
      '.vsn-halt button{width:100%;font-size:17px;padding:18px}' +
      '.vsn-added{width:100%;font-size:15px;padding:14px;margin-top:10px}';
    document.head.insertBefore(css, document.head.firstChild);

    halt$ = document.createElement('div');
    halt$.className = 'vsn-halt halt';
    halt$.hidden = true;
    halt$.innerHTML = '<div><h1></h1><p></p><button type="button"></button></div>';
    halt$.querySelector('button').textContent = 'Rejoin';
    halt$.querySelector('button').addEventListener('click', rejoin);
    document.body.appendChild(halt$);
    return halt$;
  }

  function halt(title, message, retryAfter) {
    halted = true;
    var el = haltEl();
    el.querySelector('h1').textContent = title;
    el.querySelector('p').textContent = message;
    el.hidden = false;
    clearTimeout(retryTimer);
    // Waiting phones try again on their own, so a queue moves without tapping.
    if (retryAfter > 0) retryTimer = setTimeout(rejoin, Math.min(retryAfter + 500, 30000));
  }

  function rejoin() {
    halted = false;
    haltEl().hidden = true;
    clearTimeout(retryTimer);
    if (ws && ws.readyState <= 1) { try { ws.close(); } catch (e) {} }
    connect();
  }

  /* --------------------------------------------------------------- meters --- */

  function render() {
    var host = pick('strips');
    if (host) {
      host.innerHTML = '';
      (config.actions || []).forEach(function (a, i) {
        var row = document.createElement('div');
        row.className = 'strip';
        row.style.setProperty('--chan', CHAN[i % CHAN.length]);
        row.style.gridTemplateColumns = '20px minmax(70px,1fr) 2fr';
        var src = VSN.SOURCES[a.source];
        row.innerHTML =
          '<span class="n">' + (i + 1) + '</span>' +
          '<span class="nm">' + a.name + '</span>' +
          '<div class="meter" data-meter="' + a.id + '">' +
            (src && src.signed && a.kind === 'range' ? '<span class="zero" style="left:50%"></span>' : '') +
            '<span class="fill"></span><span class="num">0</span></div>';
        host.appendChild(row);
      });
    }
    renderControls();
  }

  /* On-screen controls come from the config. A room bound only to tilt and shake
     — the phone itself is the controller — renders none of these, instead of
     showing a touch pad nothing reads. */
  function renderControls() {
    var widgets = VSN.touchWidgets(config);
    var host = pick('controls');
    if (!host && !widgets.length) return;
    if (!host) {
      // Touch actions with nowhere to live would be silently undrivable.
      host = document.createElement('div');
      host.setAttribute('data-vsn', 'controls');
      host.className = 'controls';
      (document.querySelector('.stage') || document.body).appendChild(host);
    }
    host.innerHTML = '';
    widgets.forEach(function (w) {
      var el = document.createElement('div');
      el.className = 'ctl ' + w.kind + (w.kind === 'pad' && !w.axes.y ? ' wide' : '');
      el.textContent = w.label;
      el.addEventListener('touchstart', function () { el.classList.add('lit'); }, { passive: true });
      ['touchend', 'touchcancel'].forEach(function (ev) {
        el.addEventListener(ev, function () { el.classList.remove('lit'); }, { passive: true });
      });
      host.appendChild(el);
      Sensors.bindTouchSurface(el, w.axes);
    });
  }

  function tick() {
    var vals = Sensors.actions || {};
    (config.actions || []).forEach(function (a) {
      var el = document.querySelector('[data-meter="' + a.id + '"]');
      if (!el) return;
      var fill = el.querySelector('.fill'), num = el.querySelector('.num');
      var v = vals[a.name];

      if (a.kind === 'event') {
        var prev = counters[a.id];
        counters[a.id] = v;
        if (typeof v === 'number' && typeof prev === 'number' && v > prev) {
          el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
        }
        fill.style.width = '0';
        num.textContent = (v || 0) + '×';
        return;
      }
      if (a.kind === 'switch') {
        fill.style.left = '0';
        fill.style.width = v ? '100%' : '0';
        num.textContent = v ? 'on' : 'off';
        return;
      }
      if (a.kind === 'pose') {
        // No "amount" to a rotation — show how far it is from centred instead.
        var off = v && typeof v.w === 'number'
          ? Math.min(1, Math.acos(Math.min(1, Math.abs(v.w))) / (Math.PI / 2)) : 0;
        fill.style.left = '0';
        fill.style.width = (off * 100) + '%';
        num.textContent = v ? Math.round(off * 180) + '°' : '—';
        return;
      }
      var r = VSN.outRange(a);
      if (typeof v !== 'number') { fill.style.width = '0'; num.textContent = '—'; return; }
      var t = Math.max(0, Math.min(1, (v - r.min) / (r.max - r.min || 1)));
      if (r.min < 0) {
        fill.style.left = (Math.min(t, 0.5) * 100) + '%';
        fill.style.width = (Math.abs(t - 0.5) * 100) + '%';
      } else {
        fill.style.left = '0';
        fill.style.width = (t * 100) + '%';
      }
      num.textContent = r.max <= 1 ? v.toFixed(2) : Math.round(v);
    });
    requestAnimationFrame(tick);
  }

  /* Dragging on a control must not drag the page; everywhere else still scrolls. */
  document.addEventListener('touchmove', function (e) {
    if (e.target.closest && e.target.closest('.ctl')) e.preventDefault();
  }, { passive: false });
})();
