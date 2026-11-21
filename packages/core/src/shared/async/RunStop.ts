export const STOPPED = Symbol('stopped');

/**
 * Stops a run's waits at once, however many are in progress: `race` settles with `STOPPED` as
 * soon as `stop` is called. Only the waits in progress are remembered, so an hour-long run of
 * short waits keeps nothing of the ones that finished. Once stopped it starts no work at all:
 * work started and left unwatched could fail later with nobody to hear it.
 */
export class RunStop {
  private isStopped = false;
  private readonly wakeWaiters = new Set<() => void>();

  public get wasStopped(): boolean {
    return this.isStopped;
  }

  public stop(): void {
    this.isStopped = true;
    for (const wake of this.wakeWaiters) wake();
  }

  /**
   * The waiter is in place before `start` runs, so a stop that `start` itself causes (a decoder
   * failing at once) ends the wait too.
   */
  public async race<Value>(start: () => Promise<Value>): Promise<Value | typeof STOPPED> {
    if (this.isStopped) return STOPPED;
    let wake = doNothing;
    const stopped = new Promise<typeof STOPPED>((resolve) => {
      wake = (): void => {
        resolve(STOPPED);
      };
      this.wakeWaiters.add(wake);
    });
    try {
      return await Promise.race([start(), stopped]);
    } finally {
      this.wakeWaiters.delete(wake);
    }
  }
}

function doNothing(): void {
  // Replaced by the real waiter before anyone can call it.
}
