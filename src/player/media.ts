export function formatVideoTime(time: number): string {
  if (!Number.isFinite(time) || time < 0) return '0:00';

  const totalSeconds = Math.floor(time);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  return minutes + ':' + String(seconds).padStart(2, '0');
}

export type AudioAvailability = 'available' | 'unavailable' | 'unknown';

export type AudioProbeOptions = {
  /** Milliseconds the current source has played while unmuted. */
  unmutedPlaybackMs?: number;
};

/** How long Safari needs after unmuting before a zero decode count is final. */
export const WEBKIT_AUDIO_DECODE_GRACE_MS = 300;

type AudioProbeVideo = HTMLVideoElement & {
  audioTracks?: { length: number };
  mozHasAudio?: boolean;
  webkitAudioDecodedByteCount?: number;
  webkitEnterFullscreen?: () => void;
  webkitEnterFullScreen?: () => void;
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

/**
 * Identify the WebKit/Safari media engine without user-agent parsing.
 *
 * Blink also exposes `webkitAudioDecodedByteCount`, so that counter cannot be
 * used on its own. Safari is the engine that exposes the prefixed fullscreen
 * media API (`webkitEnterFullscreen`/`webkitEnterFullScreen`); it is also the
 * only engine that skips decoding audio while playback is muted.
 */
function isWebKitVideo(video: HTMLVideoElement): boolean {
  const probe = video as AudioProbeVideo;
  if (
    typeof probe.webkitEnterFullscreen === 'function' ||
    typeof probe.webkitEnterFullScreen === 'function'
  ) {
    return true;
  }

  return (
    typeof probe.webkitAudioDecodedByteCount === 'number' &&
    !probe.captureStream &&
    !probe.mozCaptureStream
  );
}

/**
 * Returns a conclusive answer only when the current engine can back it up.
 *
 * `unavailable` is only reported when a negative observation is trustworthy:
 * never from an empty `audioTracks` list or a zero decode counter on Safari
 * while it is muted, because Safari does not decode audio for muted playback.
 * `unknown` means "keep probing".
 *
 * `unmutedPlaybackMs` is how long the current source has played while unmuted
 * since it was (re)loaded. Safari needs a short decoding window after unmuting
 * before an empty decode counter is meaningful.
 */
export function detectAudioAvailability(
  video: HTMLVideoElement,
  options: AudioProbeOptions = {},
): AudioAvailability {
  const probe = video as AudioProbeVideo;
  const isWebKit = isWebKitVideo(video);
  const hasMetadata = video.readyState >= HTMLMediaElement.HAVE_METADATA;

  // Firefox exposes an explicit boolean and keeps it authoritative, including
  // while muted.
  if (typeof probe.mozHasAudio === 'boolean') {
    return probe.mozHasAudio ? 'available' : 'unavailable';
  }

  // Positive track evidence is always conclusive, regardless of mute state.
  if (probe.audioTracks && typeof probe.audioTracks.length === 'number') {
    if (probe.audioTracks.length > 0) return 'available';
    // Safari may report an empty list at metadata even when audio is present.
    // Never treat the empty list as proof there.
    if (hasMetadata && !isWebKit) return 'unavailable';
  }

  // Chromium's captureStream lists the media's audio tracks once metadata is
  // available, even while playback is muted. Cross-origin media without CORS
  // can reject the call; in that case fall through to the other signals.
  const captureStream = probe.captureStream ?? probe.mozCaptureStream;
  let captureStreamWasReadable = false;
  if (captureStream && hasMetadata) {
    try {
      const stream = captureStream.call(video);
      captureStreamWasReadable = true;
      if (stream.getAudioTracks().length > 0) return 'available';
    } catch {
      // Keep probing with the other browser hints.
    }
  }

  if (isWebKit) {
    // Safari increments this counter once audio frames are decoded. Positive
    // evidence stays valid even if playback was muted in between.
    if (typeof probe.webkitAudioDecodedByteCount === 'number' && probe.webkitAudioDecodedByteCount > 0) {
      return 'available';
    }
    // Safari skips audio decoding for muted playback, so zero decoded bytes
    // proves nothing while muted or before the decoder has had time to run.
    // Only trust the negative after a real unmuted playback window.
    if (
      !video.muted &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      (options.unmutedPlaybackMs ?? 0) >= WEBKIT_AUDIO_DECODE_GRACE_MS
    ) {
      return 'unavailable';
    }
    return 'unknown';
  }

  // Chromium and other engines with a readable captureStream list the audio
  // tracks reliably at metadata time.
  if (captureStreamWasReadable && hasMetadata) return 'unavailable';

  return 'unknown';
}

/**
 * Whether an unresolved probe may fall back to the historical optimistic
 * answer. Safari is excluded: while muted it cannot observe audio at all, so
 * assuming "has audio" would leave a silent track looking playable forever.
 */
export function shouldOptimisticallyAssumeAudio(video: HTMLVideoElement): boolean {
  return video.readyState >= HTMLMediaElement.HAVE_METADATA && !isWebKitVideo(video);
}
