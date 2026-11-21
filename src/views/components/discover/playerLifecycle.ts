// ─────────────────────────────────────────────────────────────────────────
// Bitflix Discover — serialized player retirement
// ─────────────────────────────────────────────────────────────────────────
// React runs an unmount cleanup and then the replacement's mount effect, but
// the Bitmovin SDK's `unload()`/`destroy()` are asynchronous. Without a barrier
// the reel's next instance would create and start loading while the previous
// instance was still unloading, so the two lifecycles overlapped and a late
// event from the old player could land on the new stage.
//
// Every preview player queues its teardown here and every new instance waits
// for that queue to drain before creating the SDK. A teardown that never
// settles would otherwise wedge the reel forever, so each step is capped.
// ─────────────────────────────────────────────────────────────────────────

/** A ceiling on one teardown step, so a stuck unload cannot block the next player. */
export const RETIRE_TIMEOUT_MS = 5_000;

const settleWithin = (step: () => Promise<void>, timeoutMs: number): Promise<void> =>
  new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    void Promise.resolve()
      .then(step)
      .catch(() => {})
      .then(finish);
  });

let retirement: Promise<void> = Promise.resolve();

/**
 * Adds one player's teardown to the retirement queue. The returned promise
 * resolves once that teardown (and everything queued before it) is done; it
 * never rejects, and a teardown that hangs is abandoned after `timeoutMs`.
 */
export function retirePreviewPlayer(teardown: () => Promise<void>, timeoutMs = RETIRE_TIMEOUT_MS): Promise<void> {
  const done = retirement.then(() => settleWithin(teardown, timeoutMs));
  retirement = done;
  return done;
}

/** Resolves once every queued player teardown has finished. */
export function previewPlayersRetired(): Promise<void> {
  return retirement;
}

/** Test hook: forgets the queue, so a test starts from a clean slate. */
export function resetPreviewPlayerRetirement(): void {
  retirement = Promise.resolve();
}
