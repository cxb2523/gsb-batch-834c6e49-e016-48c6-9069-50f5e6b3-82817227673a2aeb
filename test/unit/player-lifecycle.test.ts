// The serialization barrier between a retired player and its replacement:
// teardowns run one at a time, in order, and a hang is capped so the reel can
// never wedge waiting for an unload that will not settle.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  previewPlayersRetired,
  resetPreviewPlayerRetirement,
  retirePreviewPlayer,
} from '../../src/views/components/discover/playerLifecycle.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('player retirement queue', () => {
  it('runs one teardown at a time, in queued order', async () => {
    resetPreviewPlayerRetirement();
    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const first = retirePreviewPlayer(async () => {
      events.push('first:start');
      await new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });
    const second = retirePreviewPlayer(() => {
      events.push('second:start');
      return Promise.resolve();
    });

    await tick();
    assert.deepEqual(events, ['first:start'], 'the second must wait for the first');

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  });

  it('lets the next player wait for every queued teardown', async () => {
    resetPreviewPlayerRetirement();
    const events: string[] = [];
    void retirePreviewPlayer(() => {
      events.push('retire');
      return Promise.resolve();
    });
    await previewPlayersRetired();
    events.push('mount');
    assert.deepEqual(events, ['retire', 'mount']);
  });

  it('never rejects, and moves past a teardown that throws', async () => {
    resetPreviewPlayerRetirement();
    await assert.doesNotReject(retirePreviewPlayer(() => Promise.reject(new Error('unload blew up'))));
    const events: string[] = [];
    await retirePreviewPlayer(() => {
      events.push('still runs');
      return Promise.resolve();
    });
    assert.deepEqual(events, ['still runs']);
  });

  it('abandons a teardown that hangs, so the next player is not blocked forever', async () => {
    resetPreviewPlayerRetirement();
    const events: string[] = [];
    const hung = retirePreviewPlayer(() => new Promise<void>(() => {}), 10);
    const next = retirePreviewPlayer(() => {
      events.push('next runs');
      return Promise.resolve();
    });
    await Promise.all([hung, next]);
    assert.deepEqual(events, ['next runs']);
  });
});
