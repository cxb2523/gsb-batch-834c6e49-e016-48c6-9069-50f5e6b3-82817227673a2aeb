// js/quality.js: graphics quality, 'high' (sky, clouds, more particles) or 'low' (the plain look), and the frame-rate
// measurement that picks it.
//
// Setting (saved): 'auto' (default), 'high' or 'low'. Auto starts at high and, once a flight has run a few seconds,
// measures 5 s of frames: under 45 fps on average, or over 10 % of frames slower than 33 ms (visible stutter), and
// it drops to low and remembers that for this browser. It tries high first because the frame rate never goes above
// the screen's refresh rate: 60 fps on low says nothing about whether high would also make 60. Choosing Auto again
// clears the memory and tries high once more.
//
// The level is the single source of truth for the whole look: sky.js turns its dome/clouds/sun on or off and
// effects.js reads it when it spawns smoke, debris and trails. A drop in the middle of a flight therefore takes
// effect on the next explosion or trail puff; particles that already exist simply finish their (short) lives.
// Quality.emit() tells the subscribers (the sky) about a change.
//
// Sampling deliberately ignores every frame that is not a frame of the flight: the pause menu and countdown, the
// results screen and a backgrounded/hidden tab. The first frame after such a gap is also dropped, because its
// duration contains the time spent away (a 300 ms background gap is not a 300 ms frame). Quality.interrupt() marks
// such a gap even when the loop does not run at all (a hidden tab stops requestAnimationFrame).

import { Save } from './save.js';

const WARMUP_MS = 3000;          // the first seconds of a flight load things and are slow on every device
const WINDOW_MS = 5000;          // how much flying one judgment looks at
const MIN_FPS = 45, MAX_SLOW = 0.1, SLOW_MS = 1000 / 30;

export const Quality = {
  setting() { return ['high', 'low'].includes(Save.data.quality) ? Save.data.quality : 'auto'; },
  // what is actually running now: the setting itself, or what Auto settled on for this device. Sky and effects both
  // read this; the pause screen prints it, so a drop measured this flight shows there at once.
  get level() { const s = this.setting(); return s === 'auto' ? (Save.data.qualityAuto === 'low' ? 'low' : 'high') : s; },
  get effective() { return this.level; },
  get high() { return this.level === 'high'; },
  label() { const s = this.setting(); return s === 'auto' ? `Auto (${this.level === 'high' ? 'High' : 'Low'})` : s === 'high' ? 'High' : 'Low'; },

  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  emit() { for (const fn of this.listeners) fn(this.level); },
  // the button: Auto -> High -> Low -> Auto (back to Auto = test again from high)
  cycle() {
    const next = { auto: 'high', high: 'low', low: 'auto' }[this.setting()];
    const before = this.level;
    Save.data.quality = next;
    if (next === 'auto') Save.data.qualityAuto = null;
    Save.write();
    this.resetSampling();
    if (this.level !== before) this.emit();
    return next;
  },

  // frame timing, fed by main.js with each frame's real duration while flying (not paused, not the results screen,
  // tab visible). `eligible` is false for every other frame.
  frames: [], warm: 0, last: null, gap: true,
  // a new run (or a manual quality change): forget the old window, and don't measure the frame that carried us here
  resetSampling(keepLast = false) { this.frames = []; this.warm = 0; this.gap = true; if (!keepLast) this.last = null; },
  // called when the loop was not running (hidden tab) or when a gap started: the next sampled frame is not a frame
  interrupt() { this.gap = true; },
  sample(ms, eligible = true) {
    if (!eligible) { this.gap = true; return; }          // paused / results / hidden: nothing to judge
    if (this.gap) { this.gap = false; return; }          // first frame back: its duration includes the time away
    // a second or more: a pause in the page, not a frame to judge. (It was 250 ms, which also threw away every frame
    // of a really slow device, so Auto never lowered it.)
    if (!(ms > 0) || ms >= 1000) { this.gap = true; return; }
    if (this.warm < WARMUP_MS) { this.warm += ms; return; }
    this.frames.push(ms);
    let total = 0;
    for (const f of this.frames) total += f;
    while (total > WINDOW_MS && this.frames.length > 1) total -= this.frames.shift();
    if (total < WINDOW_MS * 0.95) return;
    const slow = this.frames.filter(f => f > SLOW_MS).length / this.frames.length;
    this.last = { fps: Math.round(1000 * this.frames.length / total), slow: Math.round(slow * 100) };
    if (this.setting() === 'auto' && this.level === 'high' && (this.last.fps < MIN_FPS || slow > MAX_SLOW)) {
      Save.data.qualityAuto = 'low';
      Save.write();
      this.resetSampling(true);            // keep `last`: it is the measurement that explains the drop
      this.emit();                          // sky follows at once; effects read the level on their next spawn
    }
  },
  // "58 fps · 2 % slow frames · Graphics: Auto (High)" — the label is the level in force now, not the saved setting
  readout() {
    const m = this.last ? `${this.last.fps} fps · ${this.last.slow} % slow frames` : 'measuring frame rate...';
    return `${m} · Graphics: ${this.label()}`;
  },
};
