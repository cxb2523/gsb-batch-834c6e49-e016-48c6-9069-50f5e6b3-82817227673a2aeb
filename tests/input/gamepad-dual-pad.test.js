/**
 * Two pads of the same model, capture teardown and suppression recovery, all
 * on the one input chain the runtime owns:
 *
 * - in-memory mapping edits are isolated per pad slot + identity key, so two
 *   Xbox pads keep separate edits and a reconnect into the same slot gets its
 *   own edit back;
 * - a capture that is cancelled, replaced or cut by a disconnect calls its old
 *   callback with null exactly once, and an input still held when it ends fires
 *   nothing until it is released and pressed anew;
 * - suppressing gameplay releases every pressed action and zeroes every live
 *   analog value, including pads only known through that state, and inputs
 *   still held after resume stay silent until pressed anew.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GamepadRuntime } from '../../src/input/gamepad-runtime.js';
import { ActionRegistry } from '../../src/core/action-registry.js';
import { BindingStore } from '../../src/core/binding-store.js';

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)';

function pad({ index = 0, id = XBOX_ID, pressed = [], axes = [0, 0, 0, 0], buttons = 17 } = {}) {
  return {
    id,
    index,
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: buttons }, (_, i) => ({
      pressed: pressed.includes(i),
      value: pressed.includes(i) ? 1 : 0,
    })),
    axes,
  };
}

/** Two pads of the same model in slots 0 and 1; both are polled from navigator. */
function setup() {
  const registry = new ActionRegistry();
  const store = new BindingStore(registry);
  for (let i = 0; i < 17; i++) registry.register({ id: `GP_B${i}`, label: `B${i}`, slots: 1, gamepadSlots: 1 });
  registry.register({ id: 'left', label: 'Left', slots: 1, gamepadSlots: 1, analog: true });
  store.init({});
  for (const action of registry.getAll()) store.initAction(action);
  for (let i = 0; i < 17; i++) store.set(`GP_B${i}`, 0, `GP_B${i}`, 'gamepad');
  store.set('left', 0, 'GP_A0N', 'gamepad');

  /** Mutable slots: a test may remove/insert pads without a disconnect event. */
  const slots = [pad({ index: 0 }), pad({ index: 1 })];
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => slots });
  const runtime = new GamepadRuntime(store, registry, { deadband: 0.12, analogThreshold: 0.5 });

  const events = [];
  runtime.onAnyAction((e) => {
    const code = e.code ?? `A${e.axisIndex}`;
    events.push(e.type === 'analog'
      ? `${e.gamepadIndex}:${code}:analog:0`
      : `${e.gamepadIndex}:${code}:${e.type}`);
  });
  const take = () => events.splice(0);
  /** Digital `pressed` entries among events. */
  const pressedAmong = (taken) => taken.filter((entry) => entry.endsWith(':pressed'));
  /** Final analog 0 entries among events, formatted `index:code:0`. */
  const analogZeros = (taken) => taken
    .filter((entry) => entry.endsWith(':analog:0'))
    .map((entry) => entry.replace(':analog:0', ':0'));

  return { runtime, slots, store, events, take, pressedAmong, analogZeros };
}

describe('GamepadRuntime — same-model pads keep their own mapping edits', () => {
  let h;
  beforeEach(() => {
    h = setup();
  });

  function pressOn(runtime, index, raw) {
    runtime._processGamepad(pad({ index, pressed: [raw] }));
  }
  function releaseAll(runtime, count = 2) {
    for (let index = 0; index < count; index++) runtime._processGamepad(pad({ index }));
  }

  it('an edit on slot 0 changes slot 0 only', () => {
    const { runtime, take, pressedAmong } = h;
    expect(runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 })).toBe(true);
    expect(runtime.getResolvedProfile(0).source).toBe('memory-edit');
    expect(runtime.getResolvedProfile(1).source).toBe('family');
    expect(runtime.getProfileDefinition(1)).toBeNull();

    releaseAll(runtime);
    take();
    pressOn(runtime, 0, 3);
    pressOn(runtime, 1, 3);
    expect(pressedAmong(take()).sort()).toEqual(['0:GP_B0:pressed', '0:GP_B3:pressed', '1:GP_B3:pressed']);
    releaseAll(runtime);
    take();

    // Raw 0: slot 0's GP_B0 has moved to raw 3; slot 1 still maps it to raw 0.
    pressOn(runtime, 0, 0);
    pressOn(runtime, 1, 0);
    expect(pressedAmong(take()).sort()).toEqual(['1:GP_B0:pressed']);
  });

  it('both pads can be edited independently in their own slots', () => {
    const { runtime, take, pressedAmong } = h;
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });
    runtime.setProfileMappingEntry(1, 'GP_B0', { kind: 'button', index: 4 });

    releaseAll(runtime);
    take();
    pressOn(runtime, 0, 3);
    pressOn(runtime, 1, 4);
    expect(pressedAmong(take()).sort()).toEqual(['0:GP_B0:pressed', '0:GP_B3:pressed', '1:GP_B0:pressed', '1:GP_B4:pressed']);

    expect(runtime.getProfileDefinition(0).mapping.GP_B0).toMatchObject({ kind: 'button', index: 3 });
    expect(runtime.getProfileDefinition(1).mapping.GP_B0).toMatchObject({ kind: 'button', index: 4 });
  });

  it('resetProfileMapping clears the slot it names only', () => {
    const { runtime } = h;
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });
    runtime.setProfileMappingEntry(1, 'GP_B0', { kind: 'button', index: 4 });

    expect(runtime.resetProfileMapping(0)).toBe(true);
    expect(runtime.getResolvedProfile(0).source).toBe('family');
    expect(runtime.getResolvedProfile(1).source).toBe('memory-edit');
    expect(runtime.resetProfileMapping(1)).toBe(true);
    expect(runtime.getResolvedProfile(1).source).toBe('family');
    expect(runtime.resetProfileMapping(0)).toBe(false);
  });

  it('removing back to the base drops that slot edit and leaves the other one', () => {
    const { runtime } = h;
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });
    runtime.setProfileMappingEntry(1, 'GP_B0', { kind: 'button', index: 4 });

    expect(runtime.removeProfileMappingEntry(0, 'GP_B0')).toBe(true);
    expect(runtime.getResolvedProfile(0).source).toBe('family');
    expect(runtime.getResolvedProfile(1).source).toBe('memory-edit');
  });

  it('a reconnect into the same slot brings that slot edit back', () => {
    const { runtime, take, pressedAmong } = h;
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });

    runtime._handleDisconnect({ gamepad: pad({ index: 0 }) });
    runtime._handleConnect({ gamepad: pad({ index: 0 }) });

    expect(runtime.getResolvedProfile(0).source).toBe('memory-edit');
    take();
    pressOn(runtime, 0, 3);
    expect(pressedAmong(take()).sort()).toEqual(['0:GP_B0:pressed', '0:GP_B3:pressed']);
  });

  it('an edit belongs to its slot: the same model reconnecting into another slot does not inherit it', () => {
    const { runtime, slots } = h;
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });

    runtime._handleDisconnect({ gamepad: pad({ index: 0 }) });
    slots[0] = null;
    slots[2] = pad({ index: 2 });
    runtime._handleConnect({ gamepad: slots[2] });

    expect(runtime.getResolvedProfile(2).source).toBe('family');
    // Slot 0 is empty now: the edit stays with the slot, not the model.
    expect(runtime.getResolvedProfile(0).source).toBe('generic');
    slots[0] = pad({ index: 0 });
    expect(runtime.getResolvedProfile(0).source).toBe('memory-edit');
  });

  it('a different model taking the same slot does not inherit the edit', () => {
    const { runtime, slots } = h;
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });

    slots[0] = pad({ index: 0, id: '054c-0ce6-DualSense Wireless Controller' });
    expect(runtime.getResolvedProfile(0).source).toBe('family');
    // The Xbox edit is still there for an Xbox reconnecting into slot 0.
    slots[0] = pad({ index: 0 });
    expect(runtime.getResolvedProfile(0).source).toBe('memory-edit');
  });

  it('does not serialise the mapping on polled frames, and recompiles after an edit', () => {
    const { runtime, take, pressedAmong } = h;
    runtime._processGamepad(pad({ index: 0 }));
    runtime._processGamepad(pad({ index: 1 }));

    const stringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = (...args) => { calls += 1; return stringify(...args); };
    try {
      for (let i = 0; i < 5; i++) {
        runtime._processGamepad(pad({ index: 0, pressed: [i] }));
        runtime._processGamepad(pad({ index: 1, pressed: [i] }));
      }
      expect(calls).toBe(0);

      // The edit produces a new definition and therefore a fresh compile; the
      // frames after it are cached again (no per-frame serialisation).
      releaseAll(runtime);
      runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });
      runtime._processGamepad(pad({ index: 0 }));
      calls = 0;
      for (let i = 0; i < 5; i++) {
        runtime._processGamepad(pad({ index: 0, pressed: [3] }));
        runtime._processGamepad(pad({ index: 0 }));
      }
      expect(calls).toBe(0);
    } finally {
      JSON.stringify = stringify;
    }

    take();
    runtime._processGamepad(pad({ index: 0, pressed: [3] }));
    expect(pressedAmong(take())).toContain('0:GP_B0:pressed');
  });

  it('every edit on a pad with an exact profile is isolated per slot too', () => {
    const { runtime, slots } = h;
    // A raw DualSense (no browser remap): the shipped profile applies.
    const ds = (index) => ({
      id: '054c-0ce6-DualSense Wireless Controller',
      index,
      connected: true,
      mapping: '',
      buttons: Array.from({ length: 14 }, () => ({ pressed: false, value: 0 })),
      axes: new Array(12).fill(0),
    });
    slots[0] = ds(0);
    slots[1] = ds(1);
    expect(runtime.getResolvedProfile(0).source).toBe('exact');
    expect(runtime.getResolvedProfile(1).source).toBe('exact');

    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 8 });
    expect(runtime.getResolvedProfile(0).source).toBe('memory-edit');
    expect(runtime.getResolvedProfile(1).source).toBe('exact');
  });
});

describe('GamepadRuntime — capture teardown is one callback and latches held inputs', () => {
  let h;
  beforeEach(() => {
    h = setup();
  });

  it('cancelCapture calls the old callback with null exactly once', () => {
    const { runtime, take } = h;
    const results = [];
    runtime.startCapture((code) => results.push(code));
    runtime.cancelCapture();
    runtime.cancelCapture();
    expect(results).toEqual([null]);

    // Gameplay works again and no stale capture eats the next press.
    take();
    runtime._processGamepad(pad({ index: 0, pressed: [1] }));
    expect(take()).toEqual(['0:GP_B1:pressed']);
  });

  it('a second startCapture cancels the first exactly once and keeps the new one pending', () => {
    const { runtime } = h;
    const first = [];
    const second = [];
    runtime.startCapture((code) => first.push(code));
    runtime.startCapture((code) => second.push(code));
    expect(first).toEqual([null]);
    expect(second).toEqual([]);

    runtime._processGamepad(pad({ index: 0 }));                 // baseline
    runtime._processGamepad(pad({ index: 0, pressed: [2] }));
    expect(first).toEqual([null]);
    expect(second).toEqual(['GP_B2']);
  });

  it('a callback that restarts capture from inside gets no second call', () => {
    const { runtime } = h;
    const results = [];
    runtime.startCapture((code) => {
      results.push(`first:${code}`);
      runtime.startCapture((next) => results.push(`second:${next}`));
    });
    runtime.cancelCapture();
    expect(results).toEqual(['first:null']);

    runtime._processGamepad(pad({ index: 0 }));                 // baseline for the second capture
    runtime._processGamepad(pad({ index: 0, pressed: [6] }));
    expect(results).toEqual(['first:null', 'second:GP_B6']);
  });

  it('an input held before capture starts keeps its gameplay press/release', () => {
    const { runtime, take } = h;
    runtime._processGamepad(pad({ index: 0 }));
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));   // pressed in gameplay
    take();

    runtime.startCapture(() => {});
    runtime.cancelCapture();
    take();
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));   // still held: held is fine, it was pressed
    expect(take().filter((e) => !e.includes(':analog'))).toEqual(['0:GP_B0:held']);
    runtime._processGamepad(pad({ index: 0 }));                 // release
    expect(take()).toEqual(['0:GP_B0:released']);
  });

  it('an input first seen during a capture baseline is silent after cancel until pressed anew', () => {
    const { runtime, take } = h;
    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));   // no prior frame: baseline only
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));
    expect(captured).toEqual([]);
    runtime.cancelCapture();
    expect(captured).toEqual([null]);

    take();
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));   // still held: silent
    expect(take().filter((e) => !e.includes(':analog'))).toEqual([]);
    runtime._processGamepad(pad({ index: 0 }));                 // release: silent
    expect(take()).toEqual([]);
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));   // new press
    expect(take()).toEqual(['0:GP_B0:pressed']);
  });

  it('an input captured and still held stays silent until released', () => {
    const { runtime, take } = h;
    runtime._processGamepad(pad({ index: 0 }));
    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));
    expect(captured).toEqual(['GP_B0']);
    take();
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));
    expect(take().filter((e) => !e.includes(':analog'))).toEqual([]);
    runtime._processGamepad(pad({ index: 0 }));
    expect(take().filter((e) => !e.includes(':analog'))).toEqual([]);
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));
    expect(take().filter((e) => !e.includes(':analog'))).toEqual(['0:GP_B0:pressed']);
  });

  it('a disconnect during capture ends it with one null', () => {
    const { runtime } = h;
    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    runtime._processGamepad(pad({ index: 0 }));                 // capture baselines slot 0
    runtime._handleDisconnect({ gamepad: pad({ index: 0 }) });  // slot 0 gone
    expect(captured).toEqual([null]);
    runtime._handleDisconnect({ gamepad: pad({ index: 0 }) });  // no second null
    runtime.cancelCapture();
    expect(captured).toEqual([null]);
  });

  it('an input held on another pad at capture baseline is silent after the capture ends', () => {
    const { runtime, take } = h;
    // Slot 1 is first seen (no prior frame) while the capture runs: never pressed.
    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    runtime._processGamepad(pad({ index: 1, pressed: [5] }));
    runtime.cancelCapture();
    expect(captured).toEqual([null]);

    take();
    runtime._processGamepad(pad({ index: 1, pressed: [5] }));    // still held: silent
    expect(take().filter((e) => !e.includes(':analog'))).toEqual([]);
    runtime._processGamepad(pad({ index: 1 }));
    expect(take()).toEqual([]);
    runtime._processGamepad(pad({ index: 1, pressed: [5] }));    // new press
    expect(take()).toEqual(['1:GP_B5:pressed']);
  });

  it('a captured-and-held input on the disconnecting pad fires no gameplay event before release', () => {
    const { runtime, take } = h;
    const captured = [];
    runtime._processGamepad(pad({ index: 0 }));
    runtime.startCapture((code) => captured.push(code));
    runtime._processGamepad(pad({ index: 0, pressed: [4] }));
    expect(captured).toEqual(['GP_B4']);
    runtime._handleDisconnect({ gamepad: pad({ index: 0 }) });
    // The pressed code was never dispatched, so the disconnect has nothing to release.
    expect(take()).toEqual([]);
  });

  it('a capture replaced after it already delivered: the stale capture cannot fire later', () => {
    const { runtime, take } = h;
    const results = [];
    runtime._processGamepad(pad({ index: 0 }));
    runtime.startCapture((code) => results.push(`first:${code}`));
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));   // first captures GP_B0 and ends
    expect(results).toEqual(['first:GP_B0']);
    runtime.startCapture((code) => results.push(`second:${code}`)); // nothing to cancel: first already ended
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));   // still held: no re-capture, no gameplay
    expect(results).toEqual(['first:GP_B0']);
    expect(take().filter((e) => !e.includes(':analog'))).toEqual([]);
    runtime._processGamepad(pad({ index: 0 }));
    runtime._processGamepad(pad({ index: 0, pressed: [1] }));   // the second capture gets a fresh press
    expect(results).toEqual(['first:GP_B0', 'second:GP_B1']);
  });

  it('stop() ends a pending capture with one null', () => {
    const { runtime } = h;
    const captured = [];
    runtime.startCapture((code) => captured.push(code));
    runtime.stop();
    runtime.cancelCapture();
    expect(captured).toEqual([null]);
  });
});

describe('GamepadRuntime — suppression releases and zeroes every known pad', () => {
  let h;
  beforeEach(() => {
    h = setup();
  });

  it('releases held buttons and zeroes live analog values on both pads', () => {
    const { runtime, take, analogZeros } = h;
    runtime._processGamepad(pad({ index: 0, pressed: [0], axes: [-0.8, 0, 0, 0] }));
    runtime._processGamepad(pad({ index: 1, pressed: [1], axes: [-0.6, 0, 0, 0] }));
    take();

    runtime.setGameplaySuppressed(true);
    const suppressed = take();
    expect(suppressed.filter((e) => e.endsWith(':released')).sort()).toEqual([
      '0:GP_A0N:released', '0:GP_B0:released',
      '1:GP_A0N:released', '1:GP_B1:released',
    ]);
    expect(analogZeros(suppressed).sort()).toEqual(['0:GP_A0N:0', '1:GP_A0N:0']);
    expect(runtime._pressedCodes.get(0)?.size ?? 0).toBe(0);
    expect(runtime._analogActive.get(0)?.size ?? 0).toBe(0);
    expect(runtime._analogActive.get(1)?.size ?? 0).toBe(0);
  });

  it('releases a pad whose pressed state is known even without a polled frame entry', () => {
    const { runtime, take, analogZeros } = h;
    runtime._processGamepad(pad({ index: 0, pressed: [0], axes: [-0.7, 0, 0, 0] }));
    take();
    // Defensive path: the frame cache was dropped, the pressed/analog state was not.
    runtime._curState.delete(0);

    runtime.setGameplaySuppressed(true);
    const suppressed = take();
    expect(suppressed.filter((e) => e.endsWith(':released')).sort()).toEqual(['0:GP_A0N:released', '0:GP_B0:released']);
    expect(analogZeros(suppressed).sort()).toEqual(['0:GP_A0N:0']);
  });

  it('inputs still held after resume stay silent until released and pressed anew', () => {
    const { runtime, take } = h;
    runtime._processGamepad(pad({ index: 0, pressed: [0], axes: [-0.8, 0, 0, 0] }));
    runtime.setGameplaySuppressed(true);
    take();

    runtime._processGamepad(pad({ index: 0, pressed: [0], axes: [-0.8, 0, 0, 0] })); // still held while suppressed
    runtime.setGameplaySuppressed(false);
    take();
    runtime._processGamepad(pad({ index: 0, pressed: [0], axes: [-0.8, 0, 0, 0] }));
    expect(take().filter((e) => e.endsWith(':pressed'))).toEqual([]);
    runtime._processGamepad(pad({ index: 0 }));                                     // release
    runtime._processGamepad(pad({ index: 0, pressed: [0], axes: [-0.8, 0, 0, 0] }));
    expect(take().filter((e) => e.endsWith(':pressed')).sort()).toEqual(['0:GP_A0N:pressed', '0:GP_B0:pressed']);
  });

  it('suppression also latches a pad released while suppressed so the next press is fresh', () => {
    const { runtime, take } = h;
    runtime._processGamepad(pad({ index: 1, pressed: [3] }));
    runtime.setGameplaySuppressed(true);
    runtime._processGamepad(pad({ index: 1 }));                                      // released while suppressed
    runtime.setGameplaySuppressed(false);
    take();
    runtime._processGamepad(pad({ index: 1, pressed: [3] }));
    expect(take()).toEqual(['1:GP_B3:pressed']);
  });

  it('an input first pressed while suppressed stays silent after resume until pressed anew', () => {
    const { runtime, take } = h;
    runtime._processGamepad(pad({ index: 0 }));                 // known in gameplay, nothing held
    runtime.setGameplaySuppressed(true);
    runtime._processGamepad(pad({ index: 0, pressed: [7] }));   // pressed for the first time while suppressed
    runtime.setGameplaySuppressed(false);
    take();
    runtime._processGamepad(pad({ index: 0, pressed: [7] }));   // still held: silent
    expect(take()).toEqual([]);
    runtime._processGamepad(pad({ index: 0 }));
    runtime._processGamepad(pad({ index: 0, pressed: [7] }));   // new press
    expect(take()).toEqual(['0:GP_B7:pressed']);
  });

  it('an input pressed in gameplay keeps its release across suppress and resume', () => {
    const { runtime, take } = h;
    runtime._processGamepad(pad({ index: 0, pressed: [2] }));
    expect(take()).toEqual(['0:GP_B2:pressed']);
    runtime.setGameplaySuppressed(true);
    expect(take()).toEqual(['0:GP_B2:released']);
    runtime.setGameplaySuppressed(false);
    runtime._processGamepad(pad({ index: 0, pressed: [2] }));   // still held: silent
    expect(take()).toEqual([]);
    runtime._processGamepad(pad({ index: 0 }));                 // release: already released once
    expect(take()).toEqual([]);
    runtime._processGamepad(pad({ index: 0 }));
    runtime._processGamepad(pad({ index: 0, pressed: [2] }));
    expect(take()).toEqual(['0:GP_B2:pressed']);
  });

  it('toggling suppression during a capture keeps the capture pending and leaves no stale latch', () => {
    const { runtime, take } = h;
    runtime._processGamepad(pad({ index: 0 }));
    const captured = [];
    runtime.startCapture((code) => captured.push(code));

    runtime.setGameplaySuppressed(true);                       // capture is not affected
    runtime.setGameplaySuppressed(false);
    expect(captured).toEqual([]);

    runtime._processGamepad(pad({ index: 0, pressed: [0] }));  // still captured normally
    expect(captured).toEqual(['GP_B0']);
    take();

    // The captured input is held: silent until released, then a fresh press fires.
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));
    expect(take()).toEqual([]);
    runtime._processGamepad(pad({ index: 0 }));
    expect(take()).toEqual([]);
    runtime._processGamepad(pad({ index: 0, pressed: [0] }));
    expect(take()).toEqual(['0:GP_B0:pressed']);
  });
});
