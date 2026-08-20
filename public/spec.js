/* spec.js — the shared vocabulary.
   Runs in the browser (studio + phone) and in Node (server), so there is exactly
   one definition of what a source is, what an action is, and what the handout says. */
(function (root) {
  'use strict';

  /* Everything the phone can measure. Each one is already normalised, so a kid
     never sees a raw sensor number. */
  var SOURCES = {
    tiltLR: {
      label: 'Tilt left / right',
      blurb: 'Tip the phone so one edge drops. Works in any grip — flat, upright, whatever you calibrated.',
      range: [-100, 100], signed: true
    },
    tiltFB: {
      label: 'Tilt forward / back',
      blurb: 'Tip the top edge away from you or toward you.',
      range: [-100, 100], signed: true
    },
    spin: {
      label: 'Twist speed',
      blurb: 'How fast the phone is being twisted right now — not how far. Good for flicks.',
      range: [-100, 100], signed: true
    },
    shakeAmount: {
      label: 'Shake force',
      blurb: 'How hard the phone is being moved. Rests near 0, spikes when shaken.',
      range: [0, 100], signed: false
    },
    touchX: {
      label: 'Finger left / right',
      blurb: 'Where a finger is on the phone screen. Never drifts.',
      range: [-100, 100], signed: true
    },
    touchY: {
      label: 'Finger up / down',
      blurb: 'Where a finger is on the phone screen. Never drifts.',
      range: [-100, 100], signed: true
    },
    touchHold: {
      label: 'Finger down',
      blurb: 'Sits at 100 while a finger is on the screen, 0 when it lifts.',
      range: [0, 100], signed: false
    },
    /* Experimental, and the only source that is not a single tuned number. Four
       coupled values that mean nothing apart — running a dead zone or a gain
       over one of them would leave something that is no longer a rotation — so
       it skips the tuning pipeline entirely. */
    rotation: {
      label: '3D rotation (experimental)',
      blurb: 'The phone\'s whole orientation at once, measured from the last Set centre. ' +
        'Arrives as {x,y,z,w}, not a number, so it cannot be smoothed, flipped or dead-zoned. ' +
        'Turning about the upright axis drifts and needs recentring.',
      vector: true
    }
  };

  /* How a source gets turned into something a game can read. */
  var KINDS = {
    range:  { label: 'Number',  blurb: 'A number that slides smoothly as you move.' },
    switch: { label: 'On / off', blurb: 'true while you hold the move, false otherwise.' },
    event:  { label: 'Trigger', blurb: 'Counts up by one each time you do the move.' },
    pose:   { label: 'Rotation', blurb: 'Four numbers describing which way the phone is facing.' }
  };

  function isVector(action) {
    var src = SOURCES[action && action.source];
    return !!(src && src.vector);
  }

  /* A vector source can only be a rotation, and a rotation can only come from a
     vector source. Kept here so the studio, the phone and the server cannot
     drift into disagreeing about it. */
  function normaliseAction(a) {
    if (isVector(a)) a.kind = 'pose';
    else if (a.kind === 'pose') a.kind = 'range';
    return a;
  }

  function kindsFor(action) {
    return isVector(action) ? ['pose'] : ['range', 'switch', 'event'];
  }

  var OUTS = {
    signed: { label: '-100 to 100', min: -100, max: 100 },
    unit:   { label: '0 to 100',    min: 0,    max: 100 },
    small:  { label: '0 to 1',      min: 0,    max: 1 }
  };

  function defaultsFor(kind) {
    if (kind === 'pose')   return {};   // nothing to tune; it is not a number
    if (kind === 'event')  return { threshold: 45, cooldown: 350, deadzone: 0, smooth: 0.1, gain: 1 };
    if (kind === 'switch') return { threshold: 50, cooldown: 0,   deadzone: 0, smooth: 0.2, gain: 1 };
    return { threshold: 50, cooldown: 0, deadzone: 5, smooth: 0.25, gain: 1.3, out: 'signed' };
  }

  function makeAction(name, source, kind) {
    var base = { id: 'a' + Math.random().toString(36).slice(2, 8), name: name, source: source, kind: kind };
    normaliseAction(base);
    if (base.kind === 'pose') return base;
    var d = defaultsFor(base.kind);
    return Object.assign(base, { invert: false, out: d.out || 'signed' }, d);
  }

  /* Experimental extras ride alongside the actions rather than inside them, so
     turning one on cannot change a single existing value. */
  function starterConfig() {
    return {
      v: 1,
      rate: 30,
      actions: [
        makeAction('steer', 'tiltLR', 'range'),
        makeAction('lean', 'tiltFB', 'range'),
        makeAction('jump', 'shakeAmount', 'event'),
        makeAction('hold', 'touchHold', 'switch')
      ]
    };
  }

  /* Names become JS identifiers in the kid's game, so keep them boring. */
  function cleanName(raw, taken) {
    var n = String(raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!n || /^[0-9]/.test(n)) n = 'action' + n;
    n = n.slice(0, 20);
    if (taken) {
      var base = n, i = 2;
      while (taken.indexOf(n) !== -1) n = base + (i++);
    }
    return n;
  }

  function outRange(action) {
    if (action.kind !== 'range') return null;
    var o = OUTS[action.out] || OUTS.signed;
    var src = SOURCES[action.source];
    if (src && !src.signed && action.out === 'signed') return { min: 0, max: 100 };
    return { min: o.min, max: o.max };
  }

  /* ---- What the phone draws on screen ----
     Only touch actions need a widget; tilt, spin and shake are driven by moving
     the phone itself, so a room bound to those alone draws nothing and the
     screen stays clear. Kept here, next to SOURCES, so adding a touch source
     later cannot leave the phone rendering the wrong control. */

  var TOUCHES = { touchX: 1, touchY: 1, touchHold: 1 };

  function touchWidgets(config) {
    var by = {};
    ((config && config.actions) || []).forEach(function (a) {
      if (a.name && TOUCHES[a.source] && !by[a.source]) by[a.source] = a.name;
    });
    var out = [];
    if (by.touchX || by.touchY) {
      out.push({
        kind: 'pad',
        axes: { x: !!by.touchX, y: !!by.touchY },
        label: by.touchX && by.touchY ? by.touchX + ' + ' + by.touchY : (by.touchX || by.touchY)
      });
    }
    // A hold gets its own button, so pressing it cannot drag the pad's value.
    if (by.touchHold) out.push({ kind: 'hold', axes: { hold: true }, label: by.touchHold });
    return out;
  }

  /* ---- experimental: putting a rotation on screen ----
     The phone's frame is right-handed: x right, y up the screen, z out of the
     glass. CSS is x right, y *down*, z toward the viewer — a mirror, not a
     rotation. A mirror reverses the sense of every turn, so the fix is to remap
     the axes, not to negate the whole quaternion (which would invert all three
     and look right only on the one you happened to test).

     Mirroring through the y axis sends a turn about axis a into a turn about
     (a.x, -a.y, a.z) by the *opposite* angle, which on the components works out
     as x and z flipping sign while y keeps it. */

  function screenQuat(q) {
    return { x: -q.x, y: q.y, z: -q.z, w: q.w };
  }

  /* A quaternion straight into a CSS transform, so a game does not have to
     rediscover the handedness problem above. */
  function cssMatrix(q) {
    var s = screenQuat(q);
    var x = s.x, y = s.y, z = s.z, w = s.w;
    var m = [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1
    ];
    return 'matrix3d(' + m.map(function (n) { return Math.round(n * 100000) / 100000; }).join(',') + ')';
  }

  /* ---- The phone handout ----
     The other side of the same coin: buildSpec tells an AI how to read the
     values, this tells one how to restyle the thing that sends them. */

  function buildPhoneSpec(config, opts) {
    opts = opts || {};
    var room = opts.room || 'ROOM';
    var actions = (config.actions || []).filter(function (a) { return a.name; });
    var widgets = touchWidgets(config);

    var L = [];
    L.push('# Restyling the phone controller — room ' + room);
    L.push('');
    L.push('## Read this first');
    L.push('');
    L.push('You are changing how a phone controller **looks**. It already works. Every');
    L.push('behaviour — sensors, calibration, the socket, reconnecting, the one-at-a-time');
    L.push('rule — lives in `phone.js`, and none of it reads a class name, an id, or the');
    L.push('order elements appear in.');
    L.push('');
    L.push('- **Edit `phone.html` and the CSS.** Colours, fonts, wording, layout, language,');
    L.push('  whole sections removed — all fair game.');
    L.push('- **Do not edit `phone.js`.** Nothing about the appearance lives there.');
    L.push('- **Do not add sensor code, socket code, or a permission prompt.** They exist.');
    L.push('');
    L.push('## The only rule');
    L.push('');
    L.push('`phone.js` finds the page through `data-vsn="..."` attributes. Keep each one on');
    L.push('*something* and the page keeps working. Move them, rename the visible text,');
    L.push('restyle the element, wrap them in whatever structure you like.');
    L.push('');
    L.push('| Attribute | What it gets | If you remove it |');
    L.push('| --- | --- | --- |');
    L.push('| `code` | the room code, on every element that has it | code is not shown |');
    L.push('| `gate` | hidden once the sensors start | first screen never hides |');
    L.push('| `live` | revealed once the sensors start | play screen never appears |');
    L.push('| `start` | asks for motion permission on tap | **a plain button is added back** |');
    L.push('| `warn` | where permission problems are written | problems go unexplained |');
    L.push('| `zero` | recalibrate — "Set centre" | **a plain button is added back** |');
    L.push('| `strips` | the live meters | no meters, everything else fine |');
    L.push('| `controls` | on-screen touch controls | **a plain host is added back** |');
    L.push('| `status` | `connecting` / `linked` / `dropped` | no status text |');
    L.push('| `dot` | gets class `on` or `off` | no status light |');
    L.push('| `rate` | packets per second | no rate readout |');
    L.push('');
    L.push('The three marked in bold are the ones the phone cannot be used without, so they');
    L.push('are recreated unstyled rather than silently missing. Better to keep them and');
    L.push('style them yourself.');
    L.push('');
    L.push('## What this room will actually draw');
    L.push('');

    if (!actions.length) {
      L.push('_No actions are bound yet, so the play screen will be empty._');
      L.push('');
    } else {
      L.push('One meter per action, inside `strips`:');
      L.push('');
      actions.forEach(function (a) {
        var src = SOURCES[a.source] || { label: a.source };
        L.push('- **' + a.name + '** — ' + KINDS[a.kind].label.toLowerCase() + ', from ' + src.label.toLowerCase());
      });
      L.push('');
    }

    if (!widgets.length) {
      L.push('**No on-screen touch controls.** Every action here is driven by moving the');
      L.push('phone, so `controls` stays empty — the phone itself is the controller. Do not');
      L.push('design a joystick or buttons for it; there is nothing to wire them to.');
    } else {
      L.push('Inside `controls`, ' + widgets.length + ' touch ' +
        (widgets.length === 1 ? 'control' : 'controls') + ' will be created:');
      L.push('');
      widgets.forEach(function (w) {
        L.push('- `<div class="ctl ' + w.kind + '">` labelled **' + w.label + '** — ' +
          (w.kind === 'hold' ? 'a press-and-hold button' :
            (w.axes.x && w.axes.y ? 'a pad tracking a finger in both directions' :
              'a strip tracking a finger ' + (w.axes.x ? 'left and right' : 'up and down'))));
      });
      L.push('');
      L.push('Style `.ctl`, `.ctl.pad` and `.ctl.hold` to taste. The class `lit` is added');
      L.push('while a finger is down. **Size them generously** — they are the actual');
      L.push('controls, not decoration.');
    }
    L.push('');
    L.push('## The screen you cannot edit');
    L.push('');
    L.push('When the room is busy, or the controller is handed on after fifteen seconds of');
    L.push('stillness, `phone.js` injects a full-screen `.vsn-halt` overlay explaining why');
    L.push('and offering a **Rejoin** button. It is injected rather than written into the');
    L.push('page so that editing cannot remove the one screen that explains a dead phone.');
    L.push('');
    L.push('Its default styling is inserted ahead of every stylesheet, so you can restyle it');
    L.push('freely — target `.vsn-halt` in your own CSS and you win:');
    L.push('');
    L.push('```css');
    L.push('.vsn-halt { background: #1a0033; font-family: Georgia, serif; }');
    L.push('.vsn-halt h1 { color: gold; }');
    L.push('```');
    L.push('');
    L.push('## Things that will bite you');
    L.push('');
    L.push('- **Do not put `touch-action: none` on `body`.** It stops the page scrolling as');
    L.push('  well as dragging. It belongs on `.ctl`, which already has it.');
    L.push('- **Keep the recalibrate button reachable while playing.** It is sticky at the');
    L.push('  bottom for a reason: a phone that drifts is re-centred mid-game, not by');
    L.push('  scrolling to find a button.');
    L.push('- **Leave room for the home bar** on phones with a gesture area —');
    L.push('  `padding-bottom: env(safe-area-inset-bottom)`.');
    L.push('- **The play screen starts hidden** via the `hidden` attribute. If your CSS sets');
    L.push('  `display` on that element, add `[hidden] { display: none }` or it will show');
    L.push('  through from the start.');
    L.push('- Dark backgrounds suit a phone held up in a bright room; this is a controller');
    L.push('  glanced at, not a page read.');
    L.push('');
    L.push('## Asking for it');
    L.push('');
    L.push('Paste this whole file, then say what you want. For example:');
    L.push('');
    L.push('> Restyle this phone controller to look like a 1970s hi-fi — brushed aluminium,');
    L.push('> orange indicator lamps, chunky serif labels. Keep every `data-vsn` attribute');
    L.push('> exactly where it is. Give me the new `phone.html` and CSS only.');
    L.push('');
    return L.join('\n');
  }

  /* ---- The handout ---- */

  function buildSpec(config, opts) {
    opts = opts || {};
    var room = opts.room || 'ROOM';
    var origin = (opts.origin || 'https://your-server').replace(/\/+$/, '');
    var wsScheme = origin.indexOf('https://') === 0 ? 'wss://' : 'ws://';
    var wsUrl = wsScheme + origin.replace(/^https?:\/\//, '') + '/ws?room=' + room + '&type=display';
    var actions = (config.actions || []).filter(function (a) { return a.name; });

    var ranges = actions.filter(function (a) { return a.kind === 'range'; });
    var switches = actions.filter(function (a) { return a.kind === 'switch'; });
    var events = actions.filter(function (a) { return a.kind === 'event'; });
    var poses = actions.filter(function (a) { return a.kind === 'pose'; });

    var L = [];
    L.push('# Phone controller spec — room ' + room);
    L.push('');
    L.push('## Read this first');
    L.push('');
    L.push('A student is controlling this app in real time by moving their phone. The phone');
    L.push('has already done all the sensor maths. It sends plain, named values on a fixed');
    L.push('schedule. Read the names directly.');
    L.push('');
    L.push('Do not write orientation maths, quaternion code, gravity removal, or filtering.');
    L.push('Do not call any browser motion API. The values below are the whole interface.');
    L.push('');
    L.push('## Connecting');
    L.push('');
    L.push('Add this one line to the page. It connects, reconnects on drop, and keeps');
    L.push('`Sensor.actions` up to date:');
    L.push('');
    L.push('```html');
    L.push('<script src="' + origin + '/sensor-client.js" data-room="' + room + '"></script>');
    L.push('```');
    L.push('');
    L.push('Keep that `src` exactly as written. **Do not** copy the file into the project,');
    L.push('inline its contents, bundle it, or change it to a relative path. The script works');
    L.push('out which server to open its socket to from the address it was itself loaded from,');
    L.push('so a local copy points at the wrong host, connects to nothing, and shows no error —');
    L.push('the app just sits there reading zeroes.');
    L.push('');
    L.push('This one file is the entire integration. Nothing else from the server gets copied');
    L.push('into the project, and there is nothing to install.');
    L.push('');
    L.push('If the app must be served somewhere that cannot reach that URL, name the socket');
    L.push('explicitly instead — but prefer the script tag above:');
    L.push('');
    L.push('```js');
    L.push('Sensor.connect({ room: \'' + room + '\', url: \'' + wsUrl + '\' });');
    L.push('```');
    L.push('');
    L.push('## What you can read');
    L.push('');

    if (!actions.length) {
      L.push('_No actions set up yet. Add some in the studio and copy this again._');
      L.push('');
    } else {
      L.push('| Name | Type | Reads | What the student does |');
      L.push('| --- | --- | --- | --- |');
      actions.forEach(function (a) {
        var src = SOURCES[a.source] || { label: a.source, blurb: '' };
        var reads;
        if (a.kind === 'range') { var r = outRange(a); reads = r.min + ' to ' + r.max; }
        else if (a.kind === 'switch') reads = 'true / false';
        else if (a.kind === 'pose') reads = '`{x, y, z, w}`';
        else reads = 'a counter that goes up';
        L.push('| `' + a.name + '` | ' + KINDS[a.kind].label + ' | ' + reads + ' | ' + src.label.toLowerCase() + ' |');
      });
      L.push('');
    }

    if (ranges.length) {
      L.push('### Numbers — read every frame');
      L.push('');
      L.push('```js');
      var pad = 0;
      ranges.forEach(function (a) { pad = Math.max(pad, a.name.length); });
      ranges.forEach(function (a) {
        var r = outRange(a);
        var gap = new Array(pad - a.name.length + 3).join(' ') + '  ';
        L.push('Sensor.actions.' + a.name + gap + '// ' + r.min + ' … ' + r.max +
          (r.min < 0 ? ', 0 means centred' : ', 0 means resting'));
      });
      L.push('```');
      L.push('');
      L.push('These update ' + (config.rate || 30) + ' times a second. Read them inside your animation');
      L.push('loop; never wait for them.');
      L.push('');
    }

    if (switches.length) {
      L.push('### On / off — read every frame');
      L.push('');
      L.push('```js');
      switches.forEach(function (a) { L.push('if (Sensor.actions.' + a.name + ') { /* held right now */ }'); });
      L.push('```');
      L.push('');
    }

    if (events.length) {
      L.push('### Triggers — these are counters, not booleans');
      L.push('');
      L.push('A trigger is sent as a number that increases by one each time it happens. That way');
      L.push('a dropped packet cannot lose the event and a slow frame cannot fire it twice.');
      L.push('**Never test a trigger for truthiness** — it will be true forever after the first one.');
      L.push('');
      L.push('```js');
      L.push('// inside your loop:');
      events.forEach(function (a) {
        L.push('if (Sensor.fired(\'' + a.name + '\')) { /* runs once per ' + a.name + ' */ }');
      });
      L.push('');
      L.push('// or as a callback, outside the loop:');
      L.push('Sensor.on(\'' + events[0].name + '\', () => { /* runs once per ' + events[0].name + ' */ });');
      L.push('```');
      L.push('');
    }

    if (poses.length) {
      L.push('### Rotations — experimental');
      L.push('');
      L.push('These read as an object, not a number: the phone\'s whole orientation, measured');
      L.push('from wherever the student last tapped *Set centre*. They have none of the');
      L.push('tuning the values above have, because a dead zone or a gain applied to one');
      L.push('component would leave something that is no longer a rotation.');
      L.push('');
      L.push('```js');
      poses.forEach(function (a) {
        L.push('const q = Sensor.actions.' + a.name + ';   // { x, y, z, w } — check for null');
      });
      L.push('```');
      L.push('');
      L.push('- **Check for null every time.** It is null before the first packet, null if the');
      L.push('  device cannot report orientation, and null when a desktop keyboard is standing');
      L.push('  in for the phone.');
      L.push('- Identity (`x:0, y:0, z:0, w:1`) means "exactly as calibrated", not "flat".');
      L.push('- Turning about the vertical axis drifts over minutes — the phone has no fixed');
      L.push('  reference for it. Tapping *Set centre* is the only cure, so say so on screen');
      L.push('  rather than trying to correct it in code.');
      L.push('- Prefer the named actions for anything a game reacts to. Use this for showing');
      L.push('  an object that mirrors the phone, which is what it is good at.');
      L.push('');
      L.push('**Do not convert the quaternion to a CSS transform yourself.** The phone\'s');
      L.push('frame is right-handed with y up the screen; CSS has y pointing down, which is a');
      L.push('mirror rather than a rotation, and it silently reverses the direction of two of');
      L.push('the three turns. Getting it wrong looks correct on whichever axis you test');
      L.push('first. It is already solved:');
      L.push('');
      L.push('```html');
      L.push('<script src="' + origin + '/spec.js"></script>');
      L.push('```');
      L.push('```js');
      L.push('const q = Sensor.rotation;');
      L.push('if (q) box.style.transform = VSN.cssMatrix(q);   // needs transform-style: preserve-3d');
      L.push('```');
      L.push('');
      L.push('For WebGL or three.js, take `VSN.screenQuat(q)` instead and hand those four');
      L.push('numbers straight to the library — same axis fix, no matrix.');
      L.push('');
    }

    L.push('## Things that will bite you');
    L.push('');
    L.push('- The phone may not be connected yet. Check `Sensor.connected` and show something');
    L.push('  useful when it is false — the student needs to know it is the link, not your game.');
    L.push('- Values are already smoothed and dead-zoned. Adding your own easing on top makes');
    L.push('  the controls feel laggy.');
    L.push('- Arrow keys and the space bar drive the same values on a desktop, so the student');
    L.push('  can test without picking up the phone. Do not add your own keyboard handling.');
    L.push('- Never sample faster than your render loop or store a history of packets unless');
    L.push('  the app actually needs it.');
    L.push('');
    L.push('## Full packet shape');
    L.push('');
    L.push('```json');
    L.push('{');
    L.push('  "t": "data",');
    L.push('  "meta": { "room": "' + room + '", "seq": 1024, "t": 1730000000000 },');
    L.push('  "actions": {');
    var lines = actions.map(function (a, i) {
      var last = i === actions.length - 1;
      var value, comment = '';
      if (a.kind === 'range') { var r = outRange(a); value = '0'; comment = '  // ' + r.min + ' … ' + r.max; }
      else if (a.kind === 'switch') { value = 'false'; }
      else if (a.kind === 'pose') { value = '{ "x": 0, "y": 0, "z": 0, "w": 1 }'; comment = '  // centred'; }
      else { value = '3'; comment = '  // counter, goes up by one each time'; }
      return '    "' + a.name + '": ' + value + (last ? '' : ',') + comment;
    });
    L.push(lines.join('\n'));
    L.push('  }');
    L.push('}');
    L.push('```');
    L.push('');
    L.push('## Asking for the app');
    L.push('');
    L.push('Paste this whole file, then say what you want. For example:');
    L.push('');
    L.push('> Build a single HTML file with a canvas. A car sits at the bottom and blocks fall');
    L.push('> from the top.' + (ranges[0] ? ' Use `' + ranges[0].name + '` to move the car sideways.' : '') +
      (ranges[1] ? ' Use `' + ranges[1].name + '` to change how fast the blocks fall.' : '') +
      (events[0] ? ' When `' + events[0].name + '` fires, the car jumps.' : ''));
    L.push('> Show a message when `Sensor.connected` is false.');
    L.push('');
    return L.join('\n');
  }

  var API = {
    SOURCES: SOURCES, KINDS: KINDS, OUTS: OUTS,
    makeAction: makeAction, starterConfig: starterConfig,
    cleanName: cleanName, outRange: outRange, defaultsFor: defaultsFor,
    touchWidgets: touchWidgets, screenQuat: screenQuat, cssMatrix: cssMatrix,
    isVector: isVector, normaliseAction: normaliseAction, kindsFor: kindsFor,
    buildSpec: buildSpec, buildPhoneSpec: buildPhoneSpec
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.VSN = API;
})(typeof self !== 'undefined' ? self : this);
