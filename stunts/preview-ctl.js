// The track menu's 3D overview, as an interaction with a defined lifecycle.
//
// One PreviewCtl lives on the HiresView. It owns every piece of the overview's interaction state
// (auto-turn, the drag's heading and tilt, the wheel's zoom) and nothing else: the camera itself is
// still built in HiresView.renderPreview, from the frame this returns.
//
// Lifecycle (the two transitions, driven by what is really on screen):
//   enter()  the overview's picture is on screen for the first time in this visit:
//            default heading, tilt and zoom, every input released
//   exit()   the overview has left the screen (another menu, a dialog covering it, a new game):
//            all interaction state is dropped at once, including a drag in flight
// Re-entering never inherits the last visit's rotation or zoom: each enter() starts from the defaults.
//
// This file has no dependencies on purpose: its logic can be exercised on its own (tools/test-preview-ctl.mjs).
'use strict';
(function (root) {
  const TURN_PER_SEC = 0.00008;     // the slow self-turn, radians per millisecond (a turn in about 80 s)
  const DRAG_TURN = Math.PI * 1.5; // half a turn of heading across the picture's width
  const DRAG_TILT = 0.6;           // the tilt's drag gain
  const TILT_MIN = 0.08, TILT_MAX = 0.53;   // the original bounds: never edge-on, never straight down
  const ZOOM_MIN = 0.32, ZOOM_MAX = 1.3;    // wheel limits over the framing zoom (geometry may raise the near end)
  const WHEEL_GAIN = 0.0012;
  const BAND = { y0: 0.1, y1: 0.82 };       // where the picture shows, between the title and the menu's buttons

  class PreviewCtl {
    constructor() { this.active = false; this.pt = null; this.reset(); }

    // the whole interaction state, back to its defaults (also the released-drag state)
    reset() {
      this.t0 = null; this.last = null;
      this.auto = 0;                    // self-turn accumulated this visit
      this.hov = this.hovTo = 0;       // heading dragged in (eased hov -> hovTo)
      this.el = this.elTo = null;      // tilt above the horizon, radians; null until the framing sets el0
      this.zoom = this.zoomTo = 1;     // zoom over the framing distance, eased zoom -> zoomTo
      this.dragAt = null;              // the pointer's place on the last frame while held; null: not dragging
      this.dragging = false;
      this.pt = null;
    }

    // lifecycle transitions; each returns true only on the actual edge, so callers need no bookkeeping
    enter(now) {
      if (this.active) return false;
      this.active = true;
      this.reset();
      this.t0 = this.last = now;
      return true;
    }
    exit() {
      if (!this.active) return false;
      this.active = false;
      this.reset();
      return true;
    }

    // the latest pointer frame from the page ({x, y} in 0..1 of the picture, b: held buttons) or null.
    // Only a button pressed while the overview itself is on screen can start a drag; once started it is
    // tracked until the button comes up or the visit ends, never across an exit().
    setPointer(pt) {
      this.pt = pt;
      if (!this.active || !pt) { this.dragAt = null; this.dragging = false; return; }
      const held = !!(pt.b & 1);
      const inside = held && pt.y > BAND.y0 && pt.y < BAND.y1;
      if (held && inside && !this.dragging) { this.dragging = true; this.dragAt = { x: pt.x, y: pt.y }; }
      if (!held) { this.dragging = false; this.dragAt = null; }
    }

    // release whatever is held, without ending the visit (pointer cancelled, the window losing focus)
    release() { this.dragAt = null; this.dragging = false; }

    // the wheel over the overview: zoom, clamped. Returns false when the overview is not on screen,
    // so the caller can leave the wheel to the page underneath (a list's scroll) instead.
    wheel(deltaY) {
      if (!this.active) return false;
      this.zoomTo = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomTo * Math.exp(deltaY * WHEEL_GAIN)));
      return true;
    }

    // one display frame. B is the track's world box, k the widescreen ratio, f the projection's focal
    // length, el0/shift/framingZoom the static framing (as renderPreview had them). Returns the camera
    // numbers the renderer builds its matrices from, or null when the overview is not on screen.
    frame(now, B, k, f, el0, shift, framingZoom) {
      if (!this.active || !B) return null;
      if (this.t0 == null) { this.t0 = this.last = now; this.el = this.elTo = el0; }
      const dt = Math.min(100, now - (this.last == null ? now : this.last));
      this.last = now;
      if (this.el == null) this.el = this.elTo = el0;
      const pt = this.pt;
      if (this.dragging && this.dragAt && pt) {
        this.hovTo -= (pt.x - this.dragAt.x) * DRAG_TURN;
        this.elTo = Math.max(TILT_MIN, Math.min(TILT_MAX, this.elTo + (pt.y - this.dragAt.y) * DRAG_TILT));
        this.dragAt = { x: pt.x, y: pt.y };
      }
      if (!this.dragging) this.auto += dt * TURN_PER_SEC;
      const ease = 1 - Math.exp(-dt / 180);
      this.hov += (this.hovTo - this.hov) * ease;
      this.el += (this.elTo - this.el) * ease;
      this.zoom += (this.zoomTo - this.zoom) * ease;
      const el = this.el;
      // the unzoomed distance at which the whole track fits the frame's width and the title/buttons band
      const r = Math.max(2500, Math.hypot(B.x1 - B.x0, B.z1 - B.z0) / 2 + 600);
      const fit = Math.max(2 * r * f / (4 / 3) / k / 1.5, 2 * r * Math.sin(el) * f / 0.8);
      // the nearest the camera may come: outside the map's ground extent, above its highest piece,
      // and never closer than the near plane can show. Zooming in stops there instead of entering the track.
      const cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2;
      const groundR = Math.hypot(B.x1 - cx, B.z1 - cz) * 1.08;
      const topY = Math.max(1, B.y1) + 250;
      const minDist = Math.max(600, groundR / Math.max(0.15, Math.cos(el)), topY / Math.max(0.1, Math.sin(el)));
      // the wheel's zoom, but never so near that the geometry limit would be crossed
      const z = Math.max(this.zoom, minDist / (fit * framingZoom));
      const dist = Math.max(minDist, fit * framingZoom * z);
      return { az: 0.7 + this.auto + this.hov, el, dist, cx, cy: B.y1 * 0.3, cz, f, k, shift };
    }
  }

  PreviewCtl.ZOOM_MIN = ZOOM_MIN; PreviewCtl.ZOOM_MAX = ZOOM_MAX;
  PreviewCtl.TILT_MIN = TILT_MIN; PreviewCtl.TILT_MAX = TILT_MAX;
  PreviewCtl.BAND = BAND;
  root.StuntsPreviewCtl = PreviewCtl;
})(typeof window !== 'undefined' ? window : globalThis);
