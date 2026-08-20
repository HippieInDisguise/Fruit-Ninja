# Room JAM9 — standalone controller bundle

Everything needed to run this experience on its own.

**Double-click `start.command` (Mac) or `start.bat` (Windows).** That is the
whole thing. It opens a window, starts the server, and tells you what to do if
Node is missing. Close the window to stop it.

From a terminal instead, if you prefer:

```bash
node server.js
```

Then open <http://localhost:8080>. The page shows a QR code until a phone joins,
and shows it again if the phone drops — the game does not have to handle that.

## Phones need HTTPS

Browsers refuse to report motion over plain `http://`, and they do it silently —
the page loads, and every reading stays at zero. `localhost` is exempt, so the
laptop works straight away. For a real phone, put a tunnel in front:

```bash
ngrok http 8080
```

…then open the `https://` address it prints, and scan the QR from there.

## What is in here

| | |
| --- | --- |
| `start.command` / `start.bat` | double-click to run it |
| `SPEC.md` | hand this to an AI to build the game |
| `PHONE.md` | hand this to an AI to restyle the phone |
| `public/index.html` | the game — **replace this**, it is a placeholder |
| `public/phone.html` | the controller's looks. Restyle it however you like |
| `public/phone.js` | the controller's behaviour. Leave this alone |
| `config.json` | the frozen bindings: `steer`, `lean`, `button` |
| `server.js` | the broker. No need to touch it |

## Changing the controls

`config.json` is frozen on purpose: the game was written against these exact
names, so nothing can drift. Editing it means editing the game to match.

## Restyling the phone

`public/phone.html` is yours. It is markup only — all the behaviour is in
`public/phone.js`, which finds the page through the `data-vsn="..."`
attributes rather than by class or id. Change colours, fonts, wording, layout,
or delete whole sections; keep the `data-vsn` attributes on something and it
keeps working.

**`PHONE.md` is the handout for this.** Paste it into an AI along with how you
want the controller to look, the same way `SPEC.md` is used for the game.
