import {
  Player,
  type PlayerAPI,
  type ErrorEvent as PlayerErrorEvent,
  PlayerEvent,
  type SourceConfig,
  type TimeChangedEvent,
} from 'bitmovin-player';
import { UIFactory } from 'bitmovin-player-ui';
import 'bitmovin-player-ui/dist/css/bitmovinplayer-ui.css';
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
import { type Film, type Preview, isBeforePreview, isPastPreview, previewRemaining } from '../../../discover/model.js';
import '../../utils/routeWindowOpenToHost.js';
import { ICON } from '../cover.js';
import { Icon } from '../Icon.js';
import { previewPlayersRetired, retirePreviewPlayer } from './playerLifecycle.js';
import { PlayerLoading, PreviewErrorCard } from './shared.js';

const LOAD_TIMEOUT_MS = 30_000; // how long a source may take to load before the stage reports a failure

export interface PreviewPlayerProps {
  film: Film & { preview: Preview };
  licenseKey: string;
  /** Fires each time the preview window plays through (again after a replay). */
  onEnded?: () => void;
  /** Fires once if the preview cannot load or play here. */
  onError?: () => void;
  /** Fires when the user replays the preview from the end card. */
  onReplay?: () => void;
  /** The hand-off to the full film, shown on the end card and on the error card. */
  handoff?: ReactNode;
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Plays a preview window of a film: from `preview.startSec` for
 * `preview.durationSec`, then pauses and shows an end card. The window is
 * enforced client-side on the full film's stream, so a "trailer" needs no
 * separate encode. Any catalogue can offer previews this way. The player's
 * seek bar still spans the whole film: seeking past the window ends the
 * preview, and seeking back before it returns to the window's start.
 *
 * Mounts the Bitmovin Player into a ref'd node that React leaves alone, since
 * the player appends its own DOM. Overlays are siblings React controls. Mount
 * one instance per film (`key={film.id}`); the player is not reused across films.
 */
export function PreviewPlayer({ film, licenseKey, onEnded, onError, onReplay, handoff }: PreviewPlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlayerAPI | null>(null);
  const endedRef = useRef(false); // the window has been reached; re-armed by replay
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [remaining, setRemaining] = useState(film.preview.durationSec);

  const { stream, startSec, durationSec } = film.preview;

  // Called from player events, which are wired once per film: these always see
  // the parent's latest callbacks without rebuilding the player.
  const fireEnded = useEffectEvent(() => onEnded?.());
  const fireError = useEffectEvent(() => onError?.());

  useEffect(() => {
    const node = mountRef.current;
    if (!node) {
      return;
    }
    let cancelled = false;
    let failed = false;
    let reachedWindow = false; // positions reported before the start offset applies are not seeks
    let seekingBack = false; // one seek back at a time, while old positions still arrive
    const previewWindow = { startSec, durationSec };

    // One container per player, so teardown can detach this player's DOM alone.
    const container = document.createElement('div');
    node.appendChild(container);

    let player: PlayerAPI | undefined;
    let uiManager: ReturnType<typeof UIFactory.buildUI> | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;

    const fail = (detail: string) => {
      if (cancelled || failed) {
        return;
      }
      failed = true;
      void player?.unload().catch(() => {}); // stop a load that is still in flight
      setError(detail);
      fireError();
    };

    const finish = () => {
      if (cancelled || failed || endedRef.current || !player) {
        return;
      }
      endedRef.current = true;
      player.pause();
      setEnded(true);
      setRemaining(0);
      fireEnded();
    };

    // Every handler checks `cancelled` and is also detached on teardown, so a
    // callback that a destroyed player still delivers (an in-flight Ready, a
    // late TimeChanged, a load that times out after unmount) can neither touch
    // this component's UI nor reach the reel's failure count.
    const onReady = () => {
      if (!cancelled) {
        setLoading(false);
      }
    };
    const onTimeChanged = (e: TimeChangedEvent) => {
      if (cancelled || failed || !player) {
        return;
      }
      if (isBeforePreview(previewWindow, e.time)) {
        if (reachedWindow && !seekingBack) {
          seekingBack = true;
          player.seek(startSec); // the user sought back before the window
        }
        return;
      }
      reachedWindow = true;
      seekingBack = false;
      setRemaining(previewRemaining(previewWindow, e.time));
      if (isPastPreview(previewWindow, e.time)) {
        finish();
      }
    };
    const onError = (e: PlayerErrorEvent) => {
      fail(`Error ${e.code}: ${e.message ?? 'playback failed'}`);
    };

    // The previous player must be fully retired (source unloaded, UI released,
    // instance destroyed) before this one exists and starts loading. The queue
    // in `playerLifecycle` serializes the two asynchronous lifecycles, so they
    // never overlap; a re-render that cancelled this effect removes it from
    // the queue by simply not creating anything.
    void previewPlayersRetired().then(() => {
      if (cancelled) {
        return;
      }
      player = new Player(container, {
        key: licenseKey,
        // Playback starts manually after load() so the play() promise is ours
        // to catch; config autoplay leaves an uncaught rejection when blocked.
        playback: { autoplay: false, muted: true },
        // A preview plays in a small widget: never fetch renditions larger than
        // the player, which would otherwise climb to 4K on a fast connection.
        adaptation: { limitToPlayerSize: true },
        ui: false,
      });
      const sdk = player;
      playerRef.current = sdk;
      uiManager = UIFactory.buildUI(sdk);

      sdk.on(PlayerEvent.Ready, onReady);
      sdk.on(PlayerEvent.TimeChanged, onTimeChanged);
      sdk.on(PlayerEvent.PlaybackFinished, finish);
      sdk.on(PlayerEvent.Error, onError);

      const source: SourceConfig = { title: film.title, options: { startOffset: startSec } };
      if (stream.type === 'hls') {
        source.hls = stream.url;
      } else {
        source.dash = stream.url;
      }

      const timeout = new Promise<never>((_, rej) => {
        loadTimer = setTimeout(
          () => rej(new Error(`The preview did not load within ${LOAD_TIMEOUT_MS / 1000}s.`)),
          LOAD_TIMEOUT_MS,
        );
      });
      Promise.race([sdk.load(source), timeout])
        .then(() => {
          if (cancelled || failed) {
            return;
          }
          // In a sandbox that blocks even muted autoplay the rejection is
          // benign; the user can press play.
          sdk.play().catch(() => {});
        })
        .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
        .finally(() => clearTimeout(loadTimer));
    });

    return () => {
      cancelled = true;
      clearTimeout(loadTimer);
      playerRef.current = null;
      const retiring = player;
      const ui = uiManager;
      if (!retiring) {
        container.remove();
        return;
      }
      // Detach first so nothing the teardown itself emits (a source-unload
      // error, a Ready already queued) reaches our handlers, then stop the
      // source, release the UI and destroy the instance. The next player's
      // mount waits on this queue, so the two never run at the same time.
      retiring.off(PlayerEvent.Ready, onReady);
      retiring.off(PlayerEvent.TimeChanged, onTimeChanged);
      retiring.off(PlayerEvent.PlaybackFinished, finish);
      retiring.off(PlayerEvent.Error, onError);
      container.remove();
      void retirePreviewPlayer(async () => {
        await retiring.unload().catch(() => {});
        ui?.release();
        await retiring.destroy().catch(() => {});
      });
    };
  }, [film.title, stream.url, stream.type, startSec, durationSec, licenseKey]);

  const replay = () => {
    const player = playerRef.current;
    if (!player) {
      return;
    }
    endedRef.current = false; // re-arm the cut-off for the next pass
    setEnded(false);
    setRemaining(durationSec);
    onReplay?.();
    player.seek(startSec);
    player.play().catch(() => {});
  };

  return (
    <div className="player-stage preview-stage">
      <div className="player-mount" ref={mountRef} />
      {!loading && !error && !ended ? (
        <div className="preview-chip" aria-live="off">
          Preview · {clock(remaining)} left
        </div>
      ) : null}
      {loading && !error ? <PlayerLoading title={film.title} /> : null}
      {error ? (
        <PreviewErrorCard title={film.title} handoff={handoff} detail={error} />
      ) : ended ? (
        <div className="preview-end">
          <div className="preview-end-kicker">That was the preview</div>
          <div className="preview-end-title">{film.title}</div>
          <div className="preview-end-actions">
            {handoff}
            <button className="btn btn-ghost" onClick={replay}>
              <Icon html={ICON.replay} />
              Replay preview
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
