# Phone controller spec — room JAM9

## Read this first

A student is controlling this app in real time by moving their phone. The phone
has already done all the sensor maths. It sends plain, named values on a fixed
schedule. Read the names directly.

Do not write orientation maths, quaternion code, gravity removal, or filtering.
Do not call any browser motion API. The values below are the whole interface.

## Connecting

Add this one line to the page. It connects, reconnects on drop, and keeps
`Sensor.actions` up to date:

```html
<script src="https://discourageable-nestor-footsore.ngrok-free.dev/sensor-client.js" data-room="JAM9"></script>
```

Keep that `src` exactly as written. **Do not** copy the file into the project,
inline its contents, bundle it, or change it to a relative path. The script works
out which server to open its socket to from the address it was itself loaded from,
so a local copy points at the wrong host, connects to nothing, and shows no error —
the app just sits there reading zeroes.

This one file is the entire integration. Nothing else from the server gets copied
into the project, and there is nothing to install.

If the app must be served somewhere that cannot reach that URL, name the socket
explicitly instead — but prefer the script tag above:

```js
Sensor.connect({ room: 'JAM9', url: 'wss://discourageable-nestor-footsore.ngrok-free.dev/ws?room=JAM9&type=display' });
```

## What you can read

| Name | Type | Reads | What the student does |
| --- | --- | --- | --- |
| `steer` | Number | -100 to 100 | tilt left / right |
| `lean` | Number | -100 to 100 | tilt forward / back |
| `button` | On / off | true / false | finger down |

### Numbers — read every frame

```js
Sensor.actions.steer    // -100 … 100, 0 means centred
Sensor.actions.lean     // -100 … 100, 0 means centred
```

These update 30 times a second. Read them inside your animation
loop; never wait for them.

### On / off — read every frame

```js
if (Sensor.actions.button) { /* held right now */ }
```

## Things that will bite you

- The phone may not be connected yet. Check `Sensor.connected` and show something
  useful when it is false — the student needs to know it is the link, not your game.
- Values are already smoothed and dead-zoned. Adding your own easing on top makes
  the controls feel laggy.
- Arrow keys and the space bar drive the same values on a desktop, so the student
  can test without picking up the phone. Do not add your own keyboard handling.
- Never sample faster than your render loop or store a history of packets unless
  the app actually needs it.

## Full packet shape

```json
{
  "t": "data",
  "meta": { "room": "JAM9", "seq": 1024, "t": 1730000000000 },
  "actions": {
    "steer": 0,  // -100 … 100
    "lean": 0,  // -100 … 100
    "button": false
  }
}
```

## Asking for the app

Paste this whole file, then say what you want. For example:

> Build a single HTML file that reads steer and lean to move knife on the screen based of x,y and button to direct cut to make a fruit ninja like game