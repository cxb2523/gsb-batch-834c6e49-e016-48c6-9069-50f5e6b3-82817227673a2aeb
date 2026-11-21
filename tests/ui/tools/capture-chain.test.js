/**
 * The whole chain the player sees: the bindings modal (gameplay suppressed)
 * and the gamepad capture dialog on one GamepadRuntime.
 *
 * - A capture cancelled or cut by a disconnect ends with one null, closes the
 *   dialog and leaves the next capture able to take a fresh press only.
 * - An input held when a capture ends does not reach the game until it is
 *   released and pressed anew; closing the modal makes the next press fresh.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBindManager } from '../../../src/core/bind-manager.js';

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)';

function pad(pressed = []) {
  return {
    id: XBOX_ID,
    index: 0,
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: 18 }, (_, i) => ({
      pressed: pressed.includes(i),
      value: pressed.includes(i) ? 1 : 0,
    })),
    axes: [0, 0, 0, 0],
  };
}

let counter = 0;
let frameCallbacks = [];

function mountManager(slots) {
  counter += 1;
  document.body.innerHTML = '';
  frameCallbacks = [];
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => slots });
  vi.stubGlobal('requestAnimationFrame', (cb) => { frameCallbacks.push(cb); return frameCallbacks.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const manager = createBindManager({ namespace: `chain-${counter}`, storage: { load: () => null, save() {} } });
  manager.registerAction({
    id: 'jump',
    label: 'Jump',
    slots: 1,
    gamepadSlots: 1,
    defaultBindings: ['KeyJ'],
    defaultGamepadBindings: ['GP_B12'],
  });
  /** Run one animation frame (the runtime's poll). */
  const frame = () => {
    const current = frameCallbacks;
    frameCallbacks = [];
    for (const cb of current) cb(performance.now());
  };
  return { manager, frame };
}

describe('bindings modal + gamepad capture on one runtime', () => {
  let manager;
  let slots;
  let frame;
  let events;

  beforeEach(() => {
    slots = [pad(), null, null, null];
    ({ manager, frame } = mountManager(slots));
    events = [];
    manager.onAnyAction((e) => { if (e.type !== 'analog') events.push(`${e.code}:${e.type}`); });
  });

  afterEach(() => {
    manager.destroy();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  const gamepadBinding = () => manager.getBinding('jump', 'gamepad')[0];
  const gamepadSlotButton = () => document.querySelector('.bm-bind-btn[data-device="gamepad"]');
  const captureOpen = () => document.querySelector('.bm-capture-overlay')?.getAttribute('aria-hidden') === 'false';
  /** Click the gamepad slot, then feed one baseline frame and one frame per argument. */
  function startCapture(...frames) {
    gamepadSlotButton().click();
    for (const pressed of frames) {
      slots[0] = pad(pressed);
      frame();
    }
  }

  it('a held press is not re-captured when the dialog is reopened, and it reaches no game action', () => {
    manager.open();
    startCapture([], [0]);                       // baseline, then A pressed
    expect(gamepadBinding()).toBe('GP_B0');
    expect(captureOpen()).toBe(false);

    // Reopen the capture while A is still held (the player clicks the slot again).
    gamepadSlotButton().click();
    expect(captureOpen()).toBe(true);
    events.length = 0;
    frame();                                     // first frame of the new capture: baseline
    frame();
    expect(events).toEqual([]);                  // the held A fires no game event
    expect(captureOpen()).toBe(true);            // no stale re-capture of the held A

    // Release, then press again: that fresh press feeds the new capture.
    slots[0] = pad([]);
    frame();
    slots[0] = pad([1]);
    frame();
    frame();
    expect(gamepadBinding()).toBe('GP_B1');
    expect(captureOpen()).toBe(false);
  });

  it('a disconnect during capture closes the dialog and the next capture needs a fresh press', () => {
    manager.open();
    startCapture([], [3]);
    expect(gamepadBinding()).toBe('GP_B3');
    expect(captureOpen()).toBe(false);

    // Start a new capture and disconnect before any input.
    gamepadSlotButton().click();
    expect(captureOpen()).toBe(true);
    slots[0] = null;
    window.dispatchEvent(Object.assign(new Event('gamepaddisconnected'), { gamepad: pad() }));
    expect(captureOpen()).toBe(false);
    expect(gamepadBinding()).toBe('GP_B3');      // unchanged by the disconnect

    // Reconnect with the same input still held: the new capture ignores it.
    slots[0] = pad([3]);
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad([3]) }));
    gamepadSlotButton().click();
    frame();
    frame();
    expect(captureOpen()).toBe(true);
    expect(gamepadBinding()).toBe('GP_B3');
  });

  it('an input held while the modal closes does not fire the game until pressed anew', () => {
    manager.open();
    startCapture([], [0]);                       // captured: A held
    expect(gamepadBinding()).toBe('GP_B0');

    manager.close();                             // gameplay resumes with A still held
    events.length = 0;
    frame();
    frame();
    expect(events).toEqual([]);                  // silent while held

    slots[0] = pad([]);
    frame();
    expect(events).toEqual([]);
    slots[0] = pad([0]);
    frame();
    expect(events).toEqual(['GP_B0:pressed']);
  });
});
