/**
 * Effective Comparison State — single source of truth for the WebGL diff view
 *
 * The picture, metrics overlay, color picker and export annotations must all
 * derive from the SAME "effective comparison state": which media feeds texture
 * slot A/B (after A/B flip), which mode is active, and which threshold/ROI the
 * metrics were computed with. These pure helpers compute that state from the
 * stores so every consumer (render loop, metrics scheduler, export) agrees.
 */

import type {
  MediaFile,
  ROIRect,
  TimelineTrack,
  WebGLAnalysisMetrics,
  WebGLComparisonMode,
} from '../../types'

/** Media resolved for each comparison track, BEFORE A/B flip is applied */
export interface StableMediaPair {
  stableA: MediaFile | null
  stableB: MediaFile | null
}

/** Media feeding each WebGL texture slot, AFTER A/B flip is applied */
export interface TextureSlotMedia {
  slotA: MediaFile | null
  slotB: MediaFile | null
}

/**
 * Resolve the media file currently in effect for comparison tracks A and B.
 * Uses the clip under the playhead (falling back to the first clip) and only
 * returns image/video media that actually has a URL ready.
 */
export function selectStableMedia(
  tracks: TimelineTrack[],
  mediaFiles: MediaFile[],
  currentTime: number
): StableMediaPair {
  const pick = (trackType: 'a' | 'b'): MediaFile | null => {
    const track = tracks.find(t => t.type === trackType)
    if (!track) return null

    const activeClip = track.clips.find(
      c => currentTime >= c.startTime && currentTime < c.endTime
    )
    const clip = activeClip || track.clips[0] || null
    if (!clip) return null

    const raw = mediaFiles.find(f => f.id === clip.mediaId) || null
    if (!raw) return null
    if (raw.type !== 'video' && raw.type !== 'image') return null
    return raw.url ? raw : null
  }

  return { stableA: pick('a'), stableB: pick('b') }
}

/**
 * Map stable (track-order) media onto WebGL texture slots, applying the A/B
 * flip. When flipAB is true, texture slot A is fed by track B's media and
 * vice versa — this is the ONLY place that mapping is decided.
 */
export function applyFlipAB(stable: StableMediaPair, flipAB: boolean): TextureSlotMedia {
  return flipAB
    ? { slotA: stable.stableB, slotB: stable.stableA }
    : { slotA: stable.stableA, slotB: stable.stableB }
}

/** Everything a metrics computation depends on */
export interface MetricsContext {
  mode: WebGLComparisonMode
  flipAB: boolean
  /** Stable (pre-flip) track A media URL — flipAB is tracked separately */
  urlA: string | null
  /** Stable (pre-flip) track B media URL */
  urlB: string | null
  threshold: number
  roi: ROIRect | null
}

/**
 * Build an opaque key identifying a metrics computation context. Any change
 * to mode, flip state, media segment (URL), threshold or ROI produces a new
 * key, which invalidates previously computed metrics.
 */
export function buildMetricsContextKey(ctx: MetricsContext): string {
  return JSON.stringify([
    ctx.mode,
    ctx.flipAB,
    ctx.urlA,
    ctx.urlB,
    ctx.threshold,
    ctx.roi ? [ctx.roi.x, ctx.roi.y, ctx.roi.width, ctx.roi.height] : null,
  ])
}

/**
 * A metrics object is only usable (display / export) when it was computed for
 * the context that is currently in effect.
 */
export function isMetricsCurrent(
  metrics: Pick<WebGLAnalysisMetrics, 'contextKey'> | null | undefined,
  currentContextKey: string
): boolean {
  return !!metrics && metrics.contextKey === currentContextKey
}

/**
 * Check that a media element is actually loaded from the URL we expect.
 * After a source change there is a window where readyState still describes
 * the PREVIOUS resource — comparing the element's src against the expected
 * URL closes that window so stale frames are never sampled or uploaded.
 */
export function elementMatchesUrl(
  el: HTMLVideoElement | HTMLImageElement,
  url: string
): boolean {
  if ('currentSrc' in el && el.currentSrc && el.currentSrc === url) return true
  return el.src === url || el.getAttribute('src') === url
}
