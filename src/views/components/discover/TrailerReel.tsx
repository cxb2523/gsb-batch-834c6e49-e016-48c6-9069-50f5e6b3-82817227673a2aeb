import '@/views/css/discover.css';
import { useEffect, useReducer, useRef } from 'react';
import { type ReelPayload } from '../../../discover/model.js';
import { REEL_ADVANCE_DELAY_MS, REEL_MAX_CONSECUTIVE_FAILURES, initReel, reelReducer } from '../../../discover/reel.js';
import { useAutoHeight } from '../../hooks.js';
import { ICON, coverArt } from '../cover.js';
import { Icon } from '../Icon.js';
import { PreviewPlayerLazy } from './PreviewPlayerLazy.js';
import { Credits, FilmMeta, ModelContext, Topbar, WatchButton } from './shared.js';

/**
 * The Trailer Reel: previews played back to back, built for the side panel
 * next to a conversation (ChatGPT's thread entry point), where it keeps
 * running while the user chats. Each preview ends on a hand-off to the full
 * film; after a short beat the reel moves to the next one, and it stops after
 * the last.
 *
 * All reel progress lives in one reducer (`discover/reel.ts`): the current
 * index, phase, failure streak and the pending automatic advance. Player
 * callbacks carry the generation they were mounted with, so a player that has
 * already been torn down cannot move the reel or bump the failure count. The
 * 4-second wait is a token in that same state: cancelling it (next, replay,
 * turning auto off, a manual pick) drops the token, and a timer that still
 * fires is ignored.
 */
export function TrailerReel({ payload, licenseKey }: { payload?: ReelPayload; licenseKey: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useAutoHeight(rootRef);

  const films = payload?.films ?? [];
  const [reel, dispatch] = useReducer(reelReducer, 0, initReel);
  const payloadKey = films.map(f => f.id).join('|');

  // Follow the payload: the first result records the list without resetting;
  // a different result starts a new reel session (index 0, failures cleared).
  useEffect(() => {
    dispatch({ type: 'set-payload', key: payloadKey, total: films.length });
  }, [payloadKey, films.length]);

  // The pending advance is a token, not a callback: whenever the state issues
  // a new one the timer restarts from the full delay, and whenever it drops
  // the token this cleanup makes the old timer a no-op.
  const { pendingAdvance } = reel;
  useEffect(() => {
    if (pendingAdvance === null) {
      return;
    }
    const token = pendingAdvance;
    const timer = setTimeout(() => dispatch({ type: 'auto-advance', token }), REEL_ADVANCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pendingAdvance]);

  const film = films[reel.index];
  const generation = reel.generation;

  const select = (index: number) => {
    dispatch({ type: 'select', index });
  };
  const onEnded = () => dispatch({ type: 'ended', generation });
  const onError = () => dispatch({ type: 'failed', generation });
  const onReplay = () => dispatch({ type: 'replay', generation });
  const toggleAuto = (on: boolean) => dispatch({ type: 'set-auto', on });

  if (!payload || !film) {
    return (
      <div ref={rootRef} className="bitflix-root reel-root">
        <div className="empty">Loading the Trailer Reel…</div>
      </div>
    );
  }

  const provider = payload.brand.watchProvider;
  // A stale generation remounts the player even when the index did not change
  // (a manual pick of the current film, or a new payload), and the id makes a
  // different film a different mount regardless.
  const playerKey = `${reel.generation}:${film.id}`;

  return (
    <div ref={rootRef} className="bitflix-root reel-root">
      <Topbar
        brand={payload.brand}
        label="Trailer Reel"
        right={
          <span className="reel-count" aria-live="polite">
            {reel.index + 1} / {films.length}
          </span>
        }
      />

      <div className="player-shell">
        <PreviewPlayerLazy
          key={playerKey}
          film={film}
          licenseKey={licenseKey}
          onEnded={onEnded}
          onError={onError}
          onReplay={onReplay}
          handoff={<WatchButton film={film} provider={provider} />}
        />
      </div>

      <div className="film-bar reel-bar">
        <div className="titleblock">
          <h2>{film.title}</h2>
          <FilmMeta film={film} showPreviewBadge={false} />
          <p className="syn">{film.logline}</p>
        </div>
        <div className="controls">
          <WatchButton film={film} provider={provider} />
          {films.length > 1 ? (
            <button className="iconbtn" onClick={() => select(reel.index + 1)}>
              <Icon html={ICON.next} />
              Next preview
            </button>
          ) : null}
        </div>
      </div>

      <label className="reel-auto">
        <input type="checkbox" checked={reel.autoAdvance} onChange={e => toggleAuto(e.target.checked)} />
        Play the next preview automatically
      </label>

      {reel.stopped ? (
        <div className="notice" role="status">
          Stopped after {REEL_MAX_CONSECUTIVE_FAILURES} previews in a row could not play. Pick any preview to continue.
        </div>
      ) : null}

      <ol className="reel-queue" aria-label="Up next in the reel">
        {films.map((f, i) => (
          <li key={f.id}>
            <button
              className={`reel-item ${i === reel.index ? 'is-current' : ''}`}
              aria-current={i === reel.index ? 'true' : undefined}
              onClick={() => select(i)}
            >
              <span
                className="reel-thumb"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: coverArt(f.cover, f.title.charAt(0)) }}
              />
              <span className="reel-text">
                <span className="t">{f.title}</span>
                <span className="k">
                  {f.year} · {f.genre}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      <Credits text={payload.credits} />
      <ModelContext
        text={`The ${payload.brand.name} Trailer Reel is playing the "${film.title}" preview (${reel.index + 1} of ${films.length}). Full film: ${film.watchUrl}.`}
      />
    </div>
  );
}
