/**
 * The public manager surface for two same-model pads and reconnects: the
 * Controller Test's Profile editor calls these, so the isolation must hold at
 * this layer too, not only inside GamepadRuntime.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBindManager } from '../../src/core/bind-manager.js';

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)';

function pad(index, pressed = []) {
  return {
    id: XBOX_ID,
    index,
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
    axes: [0, 0, 0, 0],
  };
}

let counter = 0;

/** Mount a manager over a mutable four-slot gamepad list. */
function mountManager() {
  counter += 1;
  document.body.innerHTML = '';
  const slots = [pad(0), pad(1), null, null];
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => slots });
  const manager = createBindManager({ namespace: `dual-pad-${counter}`, storage: { load: () => null, save() {} } });
  return { manager, slots };
}

describe('manager in-memory mapping edits — per slot + identity', () => {
  let mounted = null;

  beforeEach(() => {
    mounted = mountManager();
  });
  afterEach(() => {
    mounted?.manager.destroy();
    mounted = null;
  });

  it('two pads of the same model in slots 0 and 1 keep separate edits', () => {
    const { manager } = mounted;
    expect(manager.setGamepadProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 })).toBe(true);
    expect(manager.getResolvedGamepadProfile(0).source).toBe('memory-edit');
    expect(manager.getResolvedGamepadProfile(1).source).toBe('family');
    expect(manager.getGamepadProfileDefinition(1)).toBeNull();

    expect(manager.setGamepadProfileMappingEntry(1, 'GP_B0', { kind: 'button', index: 4 })).toBe(true);
    expect(manager.getGamepadProfileDefinition(0).mapping.GP_B0).toMatchObject({ kind: 'button', index: 3 });
    expect(manager.getGamepadProfileDefinition(1).mapping.GP_B0).toMatchObject({ kind: 'button', index: 4 });

    expect(manager.resetGamepadProfileMapping(0)).toBe(true);
    expect(manager.getResolvedGamepadProfile(0).source).toBe('family');
    expect(manager.getResolvedGamepadProfile(1).source).toBe('memory-edit');
  });

  it('a reconnect into the same slot restores that slot edit; another slot gets its own', () => {
    const { manager, slots } = mounted;
    manager.setGamepadProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });

    slots[0] = null;
    window.dispatchEvent(Object.assign(new Event('gamepaddisconnected'), { gamepad: pad(0) }));
    expect(manager.getResolvedGamepadProfile(0).source).toBe('generic');

    slots[0] = pad(0);
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad(0) }));
    expect(manager.getResolvedGamepadProfile(0).source).toBe('memory-edit');

    // The same model connecting into slot 2 does not inherit slot 0's edit.
    slots[2] = pad(2);
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad(2) }));
    expect(manager.getResolvedGamepadProfile(2).source).toBe('family');
  });

  it('a same-model pad editing while the other holds its own edit re-emits the profile event for its slot', () => {
    const { manager } = mounted;
    const changes = [];
    window.addEventListener('bm-gamepad-profile-changed', (e) => changes.push(e.detail));

    manager.setGamepadProfileMappingEntry(1, 'GP_B0', { kind: 'button', index: 4 });
    expect(changes.at(-1)?.gamepadIndex).toBe(1);
    expect(changes.at(-1)?.resolvedProfile.source).toBe('memory-edit');
    // Slot 0 was never edited.
    expect(manager.getResolvedGamepadProfile(0).source).toBe('family');
  });
});
