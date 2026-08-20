/* sensors.js — turns a phone into named actions.
   Two stages, kept separate on purpose:
     hardware  ->  sources   (fixed, normalised, posture-independent)
     sources   ->  actions   (whatever the student named and bound)  */
(function (root) {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const v3 = (x, y, z) => ({ x, y, z });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  const len = (a) => Math.hypot(a.x, a.y, a.z);
  const norm = (a) => { const l = len(a) || 1; return v3(a.x / l, a.y / l, a.z / l); };
  const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
  const scale = (a, k) => v3(a.x * k, a.y * k, a.z * k);
  const clamp = (n, lo, hi) => n < lo ? lo : n > hi ? hi : n;

  /* Tilt this far from your calibrated neutral and the source reads full scale.
     Per-action gain lets a student make it twitchier or calmer than this. */
  const FULL_TILT_DEG = 45;
  const SHAKE_FULL = 18;     // m/s² of shaking that counts as 100
  const SPIN_FULL = 360;     // deg/sec of twisting that counts as 100

  /* Mouse drags are released anywhere on the page, so one window listener serves
     every surface — surfaces get rebuilt whenever the config changes, and
     re-registering per surface would pile up listeners. */
  let dragging = null;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging.up();
      dragging = null;
    });
  }

  /* ---- experimental: full 3D rotation ----
     Deliberately kept out of the sources → actions pipeline. An action is one
     tuned scalar; an orientation is four coupled numbers that mean nothing
     individually, and running a dead zone or a gain over one component would
     produce a quaternion that is no longer a rotation. It travels as its own
     field instead, so nothing already built can be affected by it. */

  const qmul = (a, b) => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
  });
  const qconj = (q) => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });

  /* The browser reports intrinsic Z-X'-Y'' angles; this is the standard
     conversion, with the screen's own rotation folded in so landscape and
     portrait agree. */
  function quatFromAngles(alphaDeg, betaDeg, gammaDeg, screenDeg) {
    const x = (betaDeg || 0) * D2R / 2;
    const y = (gammaDeg || 0) * D2R / 2;
    const z = (alphaDeg || 0) * D2R / 2;
    const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z);
    const sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    let q = {
      w: cX * cY * cZ - sX * sY * sZ,
      x: sX * cY * cZ - cX * sY * sZ,
      y: cX * sY * cZ + sX * cY * sZ,
      z: cX * cY * sZ + sX * sY * cZ
    };
    if (screenDeg) {
      const h = -screenDeg * D2R / 2;
      q = qmul(q, { w: Math.cos(h), x: 0, y: 0, z: Math.sin(h) });
    }
    return q;
  }

  const Sensors = {
    ready: false,
    reason: '',
    calibrated: false,
    haveOrientation: false,
    haveMotion: false,
    sources: { tiltLR: 0, tiltFB: 0, spin: 0, shakeAmount: 0, touchX: 0, touchY: 0, touchHold: 0 },
    config: null,
    actions: {},
    rotation: null,          // experimental: {x,y,z,w} relative to the last calibration
    haveRotation: false,

    _g: v3(0, 0, -1),        // current gravity direction, device frame
    _frame: null,            // { g0, right, fwd } snapshot taken at calibration
    _q: null,                // latest raw attitude
    _q0: null,               // attitude at calibration, so rotation reads zero there
    _lp: null,               // low-passed accelerometer, used to isolate shaking
    _peak: 0,
    _state: new Map(),       // per-action smoothing / latch state

    /* ---- hardware ---- */

    async start() {
      // iOS will not deliver anything until the user asks for it by hand.
      const needsAsk = typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function';
      if (needsAsk) {
        try {
          const ok = await DeviceOrientationEvent.requestPermission();
          if (ok !== 'granted') {
            this.reason = 'Motion access was turned down. Reload the page to ask again.';
            return false;
          }
          if (typeof DeviceMotionEvent !== 'undefined' &&
              typeof DeviceMotionEvent.requestPermission === 'function') {
            await DeviceMotionEvent.requestPermission();
          }
        } catch (err) {
          this.reason = 'This page needs to be opened over HTTPS before it can read motion.';
          return false;
        }
      }
      if (!window.isSecureContext) {
        this.reason = 'Motion sensors only work over HTTPS. Open this page through a tunnel or a hosted URL.';
        return false;
      }

      window.addEventListener('deviceorientation', (e) => this._orientation(e), { passive: true });
      window.addEventListener('devicemotion', (e) => this._motion(e), { passive: true });

      // If nothing arrives, say so rather than sitting at zero forever.
      await new Promise((r) => setTimeout(r, 700));
      if (!this.haveOrientation && !this.haveMotion) {
        this.reason = 'No motion data arrived. This device may not have the sensors, or the browser is blocking them.';
        return false;
      }
      this.ready = true;
      return true;
    },

    _orientation(e) {
      if (e.beta == null && e.gamma == null) return;
      this.haveOrientation = true;
      const b = (e.beta || 0) * D2R, g = (e.gamma || 0) * D2R;
      // Gravity in the device's own frame, straight from the tilt angles.
      // No alpha, so there is nothing for a drifting compass to spoil.
      this._g = norm(v3(Math.cos(b) * Math.sin(g), -Math.sin(b), -Math.cos(b) * Math.cos(g)));
      this._project();

      // Experimental, and separate: this one does use alpha, which is why it
      // drifts and why it is not allowed anywhere near the tilt maths above.
      if (e.alpha != null) {
        const screenDeg = ((screen.orientation && screen.orientation.angle) ||
          window.orientation || 0);
        this._q = quatFromAngles(e.alpha, e.beta, e.gamma, screenDeg);
        this.haveRotation = true;
        this._rotate();
      }
    },

    _rotate() {
      if (!this._q) return;
      const q = this._q0 ? qmul(qconj(this._q0), this._q) : this._q;
      const r = (n) => Math.round(n * 10000) / 10000;
      this.rotation = { x: r(q.x), y: r(q.y), z: r(q.z), w: r(q.w) };
    },

    _motion(e) {
      const a = e.accelerationIncludingGravity;
      if (a && a.x != null) {
        this.haveMotion = true;
        const cur = v3(a.x || 0, a.y || 0, a.z || 0);
        // Slow-moving part is gravity; whatever is left is the student moving.
        this._lp = this._lp ? v3(
          this._lp.x + (cur.x - this._lp.x) * 0.12,
          this._lp.y + (cur.y - this._lp.y) * 0.12,
          this._lp.z + (cur.z - this._lp.z) * 0.12
        ) : cur;
        const jolt = len(sub(cur, this._lp));
        // Peak-hold so a single sharp spike survives to the next packet.
        this._peak = Math.max(jolt, this._peak * 0.82);
        this.sources.shakeAmount = clamp(this._peak / SHAKE_FULL * 100, 0, 100);
        // Fall back to the accelerometer if orientation events never show up.
        if (!this.haveOrientation) { this._g = norm(scale(this._lp, -1)); this._project(); }
      }
      const r = e.rotationRate;
      if (r && r.alpha != null) {
        this.haveMotion = true;
        this.sources.spin = clamp((r.alpha || 0) / SPIN_FULL * 100, -100, 100);
      }
    },

    /* ---- the calibrated frame ----
       Snapshot gravity, then build a right/forward pair around it. Every reading
       afterwards is measured against that snapshot, so it does not matter whether
       the phone is held flat, upright, or somewhere in between — and there is no
       Euler angle left to gimbal-lock. */

    calibrate() {
      const g0 = norm(this._g);
      const angle = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * D2R;
      const sRight = v3(Math.cos(angle), Math.sin(angle), 0);
      const sUp = v3(-Math.sin(angle), Math.cos(angle), 0);

      // "Right" is the screen's right, flattened so it is level with the ground.
      let right = sub(sRight, scale(g0, dot(sRight, g0)));
      if (len(right) < 0.15) right = cross(sUp, g0);   // phone held edge-on
      right = norm(right);

      // right × down gives the level "away from you" direction. Holds for any
      // grip, so tipping the top edge downward always reads positive.
      const fwd = norm(cross(right, g0));

      this._frame = { g0, right, fwd };
      this.calibrated = true;
      this._state.clear();
      this._peak = 0;
      this._project();

      // Re-zeroes the experimental rotation too, which is the only cure for
      // yaw drift — the compass has no fixed reference to fall back on.
      this._q0 = this._q;
      this._rotate();
    },

    _project() {
      if (!this._frame) return;
      const g = this._g, f = this._frame;
      const lr = Math.asin(clamp(dot(g, f.right), -1, 1)) * R2D;
      const fb = Math.asin(clamp(dot(g, f.fwd), -1, 1)) * R2D;
      this.sources.tiltLR = clamp(lr / FULL_TILT_DEG * 100, -100, 100);
      this.sources.tiltFB = clamp(fb / FULL_TILT_DEG * 100, -100, 100);
    },

    /* ---- touch ---- */

    /* `axes` says which sources this surface drives, so a jump button and a
       steering strip can be separate widgets instead of one shared pad.
       Omit it and the surface drives all three, as a single pad always did. */
    bindTouchSurface(el, axes) {
      const want = axes || { x: true, y: true, hold: true };
      const read = (touch) => {
        const r = el.getBoundingClientRect();
        if (want.x) this.sources.touchX = clamp(((touch.clientX - r.left) / r.width * 2 - 1) * 100, -100, 100);
        if (want.y) this.sources.touchY = clamp((1 - (touch.clientY - r.top) / r.height * 2) * 100, -100, 100);
      };
      const down = (e) => { if (want.hold) this.sources.touchHold = 100; if (e.touches && e.touches[0]) read(e.touches[0]); };
      const move = (e) => { if (e.touches && e.touches[0]) read(e.touches[0]); };
      const up = () => { if (want.hold) this.sources.touchHold = 0; };
      el.addEventListener('touchstart', down, { passive: true });
      el.addEventListener('touchmove', move, { passive: true });
      el.addEventListener('touchend', up, { passive: true });
      el.addEventListener('touchcancel', up, { passive: true });
      el.addEventListener('mousedown', (e) => { dragging = { read, up }; if (want.hold) this.sources.touchHold = 100; read(e); });
      el.addEventListener('mousemove', (e) => { if (dragging && dragging.read === read) read(e); });
    },

    /* ---- sources -> actions ---- */

    setConfig(cfg) {
      this.config = cfg;
      const live = new Set((cfg.actions || []).map((a) => a.id));
      for (const id of [...this._state.keys()]) if (!live.has(id)) this._state.delete(id);
    },

    compute() {
      const cfg = this.config;
      const out = {};
      if (!cfg) return out;
      const now = performance.now();

      for (const a of cfg.actions || []) {
        if (!a.name) continue;
        const meta = root.VSN.SOURCES[a.source];
        if (!meta) continue;

        /* Not a number: no dead zone, no gain, no smoothing — any of those
           would leave four values that no longer describe a rotation. */
        if (meta.vector) {
          if (this.rotation) out[a.name] = this.rotation;
          continue;
        }

        let v = this.sources[a.source] || 0;

        if (a.invert) v = meta.signed ? -v : 100 - v;

        const dz = a.deadzone || 0;
        if (dz > 0) {
          if (meta.signed) {
            const m = Math.abs(v);
            v = m <= dz ? 0 : Math.sign(v) * (m - dz) / (100 - dz) * 100;
          } else {
            v = v <= dz ? 0 : (v - dz) / (100 - dz) * 100;
          }
        }

        v = clamp(v * (a.gain == null ? 1 : a.gain), meta.range[0], meta.range[1]);

        let st = this._state.get(a.id);
        if (!st) { st = { s: 0, on: false, count: 0, last: -1e9 }; this._state.set(a.id, st); }
        const k = 1 - clamp(a.smooth == null ? 0.25 : a.smooth, 0, 0.95);
        st.s += (v - st.s) * k;
        const s = st.s;

        if (a.kind === 'range') {
          const r = root.VSN.outRange(a);
          const lo = meta.range[0], hi = meta.range[1];
          const t = (s - lo) / (hi - lo);
          const mapped = r.min + t * (r.max - r.min);
          out[a.name] = r.max <= 1 ? Math.round(mapped * 1000) / 1000 : Math.round(mapped);
        } else if (a.kind === 'switch') {
          // Hysteresis, or it chatters on and off at the threshold.
          const th = a.threshold == null ? 50 : a.threshold;
          if (!st.on && s >= th) st.on = true;
          else if (st.on && s < th - 8) st.on = false;
          out[a.name] = st.on;
        } else {
          const th = a.threshold == null ? 45 : a.threshold;
          const cd = a.cooldown == null ? 350 : a.cooldown;
          if (!st.on && s >= th && now - st.last > cd) {
            st.on = true; st.count++; st.last = now;
          } else if (st.on && s < th * 0.6) {
            st.on = false;
          }
          // A counter, not a boolean: a dropped packet cannot lose the event and a
          // slow frame cannot replay it.
          out[a.name] = st.count;
        }
      }
      this.actions = out;
      return out;
    }
  };

  root.Sensors = Sensors;
})(typeof self !== 'undefined' ? self : this);
