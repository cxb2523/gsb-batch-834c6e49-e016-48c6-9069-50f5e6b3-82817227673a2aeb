import type { MediaTrack } from 'types';

export const track = (id: string, source: string): MediaTrack => ({
  id,
  title: `track-${id}`,
  source,
  artwork: null,
});

export const MP3_A = track('mp3-a', 'https://example.test/audio/a.mp3');
export const MP3_B = track('mp3-b', 'https://example.test/audio/b.mp3');
export const HLS_A = track('hls-a', 'https://example.test/live/a.m3u8');
export const HLS_B = track('hls-b', 'https://example.test/live/b.m3u8');
export const HLS_C = track('hls-c', 'https://example.test/live/c.m3u8');

/** Flushes pending microtasks so awaited adapter initializations settle. */
export const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));
