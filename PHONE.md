# Restyling the phone controller — room JAM9

## Read this first

You are changing how a phone controller **looks**. It already works. Every
behaviour — sensors, calibration, the socket, reconnecting, the one-at-a-time
rule — lives in `phone.js`, and none of it reads a class name, an id, or the
order elements appear in.

- **Edit `phone.html` and the CSS.** Colours, fonts, wording, layout, language,
  whole sections removed — all fair game.
- **Do not edit `phone.js`.** Nothing about the appearance lives there.
- **Do not add sensor code, socket code, or a permission prompt.** They exist.

## The only rule

`phone.js` finds the page through `data-vsn="..."` attributes. Keep each one on
*something* and the page keeps working. Move them, rename the visible text,
restyle the element, wrap them in whatever structure you like.

| Attribute | What it gets | If you remove it |
| --- | --- | --- |
| `code` | the room code, on every element that has it | code is not shown |
| `gate` | hidden once the sensors start | first screen never hides |
| `live` | revealed once the sensors start | play screen never appears |
| `start` | asks for motion permission on tap | **a plain button is added back** |
| `warn` | where permission problems are written | problems go unexplained |
| `zero` | recalibrate — "Set centre" | **a plain button is added back** |
| `strips` | the live meters | no meters, everything else fine |
| `controls` | on-screen touch controls | **a plain host is added back** |
| `status` | `connecting` / `linked` / `dropped` | no status text |
| `dot` | gets class `on` or `off` | no status light |
| `rate` | packets per second | no rate readout |

The three marked in bold are the ones the phone cannot be used without, so they
are recreated unstyled rather than silently missing. Better to keep them and
style them yourself.

## What this room will actually draw

One meter per action, inside `strips`:

- **steer** — number, from tilt left / right
- **lean** — number, from tilt forward / back
- **button** — on / off, from finger down

Inside `controls`, 1 touch control will be created:

- `<div class="ctl hold">` labelled **button** — a press-and-hold button

Style `.ctl`, `.ctl.pad` and `.ctl.hold` to taste. The class `lit` is added
while a finger is down. **Size them generously** — they are the actual
controls, not decoration.

## The screen you cannot edit

When the room is busy, or the controller is handed on after fifteen seconds of
stillness, `phone.js` injects a full-screen `.vsn-halt` overlay explaining why
and offering a **Rejoin** button. It is injected rather than written into the
page so that editing cannot remove the one screen that explains a dead phone.

Its default styling is inserted ahead of every stylesheet, so you can restyle it
freely — target `.vsn-halt` in your own CSS and you win:

```css
.vsn-halt { background: #1a0033; font-family: Georgia, serif; }
.vsn-halt h1 { color: gold; }
```

## Things that will bite you

- **Do not put `touch-action: none` on `body`.** It stops the page scrolling as
  well as dragging. It belongs on `.ctl`, which already has it.
- **Keep the recalibrate button reachable while playing.** It is sticky at the
  bottom for a reason: a phone that drifts is re-centred mid-game, not by
  scrolling to find a button.
- **Leave room for the home bar** on phones with a gesture area —
  `padding-bottom: env(safe-area-inset-bottom)`.
- **The play screen starts hidden** via the `hidden` attribute. If your CSS sets
  `display` on that element, add `[hidden] { display: none }` or it will show
  through from the start.
- Dark backgrounds suit a phone held up in a bright room; this is a controller
  glanced at, not a page read.

## Asking for it

Paste this whole file, then say what you want. For example:

> Restyle this phone controller to look like a 1970s hi-fi — brushed aluminium,
> orange indicator lamps, chunky serif labels. Keep every `data-vsn` attribute
> exactly where it is. Give me the new `phone.html` and CSS only.
