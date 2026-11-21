import { describe, expect, it } from 'vitest';

import { RunStop, STOPPED } from './RunStop';
import { isCollected } from '../../../test/support/garbage';

function never(): Promise<string> {
  return new Promise<string>(() => {
    // Never settles: only the stop can end this wait.
  });
}

describe('RunStop', () => {
  it('lets a wait finish with its own value while the run goes on', async () => {
    await expect(new RunStop().race(() => Promise.resolve('segment'))).resolves.toBe('segment');
  });

  it('ends the wait in progress as soon as the run stops', async () => {
    const stop = new RunStop();
    const waiting = stop.race(
      () =>
        new Promise<string>(() => {
          // Never settles: only the stop can end this wait.
        }),
    );
    stop.stop();
    await expect(waiting).resolves.toBe(STOPPED);
    expect(stop.wasStopped).toBe(true);
  });

  it('keeps nothing of the waits that finished', async () => {
    const stop = new RunStop();
    const references: WeakRef<object>[] = [];
    for (let wait = 0; wait < 3; wait += 1) {
      const value = { wait };
      references.push(new WeakRef(value));
      await stop.race(() => Promise.resolve(value));
    }
    for (const reference of references) expect(await isCollected(reference)).toBe(true);
    stop.stop();
  });

  it('ends a wait whose own start stopped the run', async () => {
    const stop = new RunStop();
    const waiting = stop.race(() => {
      stop.stop();
      return new Promise<string>(() => {
        // Never settles: only the stop can end this wait.
      });
    });
    await expect(waiting).resolves.toBe(STOPPED);
  });

  it('ends every wait in progress as soon as the run stops', async () => {
    const stop = new RunStop();
    const first = stop.race(never);
    const second = stop.race(never);
    stop.stop();
    await expect(first).resolves.toBe(STOPPED);
    await expect(second).resolves.toBe(STOPPED);
  });

  it('starts no work once the run has stopped', async () => {
    const stop = new RunStop();
    stop.stop();
    let wasStarted = false;
    const waiting = stop.race(() => {
      wasStarted = true;
      return Promise.resolve('segment');
    });
    await expect(waiting).resolves.toBe(STOPPED);
    expect(wasStarted).toBe(false);
  });
});
