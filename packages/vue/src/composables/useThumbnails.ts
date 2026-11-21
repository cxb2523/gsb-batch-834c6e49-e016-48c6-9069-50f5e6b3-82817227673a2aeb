import type { ThumbnailCue } from '@vue-player/core'
import { parseThumbnailVtt } from '@vue-player/core'
import { onBeforeUnmount, ref, watch, type WatchSource } from 'vue'

/**
 * Owns the timeline thumbnail cues for a VideoPlayer.
 *
 * Every load (initial fetch, thumbnails-address change, source change) runs in
 * its own generation, backed by an AbortController. A newer generation aborts
 * the in-flight fetch and drops the stale continuation, so an old response can
 * never overwrite the cues of the current source/URL. Cues are cleared
 * synchronously on every reload, so no preview can reference a previous
 * source's thumbnails while the new resolution is pending.
 *
 * Inputs are WatchSources (getters or refs) so the composable can track
 * component props directly without an intermediate ref.
 */
export function useThumbnails(
  thumbnailsUrl: WatchSource<string | undefined>,
  sourceKey: WatchSource<string>,
) {
  const thumbnailCues = ref<ThumbnailCue[]>([])

  let controller: AbortController | null = null
  let loadGeneration = 0
  let latestUrl: string | undefined

  function reload(url: string | undefined) {
    latestUrl = url
    const generation = ++loadGeneration

    // Cancel any in-flight resolution so its fetch/continuation cannot win.
    controller?.abort()
    controller = url ? new AbortController() : null

    // Drop the previous generation's cues synchronously — a preview must never
    // reference thumbnails that do not belong to the current source/URL.
    thumbnailCues.value = []

    if (!url) return

    const signal = controller!.signal
    parseThumbnailVtt(url, signal)
      .then((cues) => {
        // Stale response — a newer load has already replaced this one.
        if (generation !== loadGeneration) return
        // Empty results stay cleared rather than resurrecting anything.
        thumbnailCues.value = Array.isArray(cues) ? cues : []
      })
      .catch(() => {
        if (generation !== loadGeneration) return
        thumbnailCues.value = []
      })
  }

  // Source switch: drop the previous source's preview immediately, before any
  // new resolution completes. When the URL is unchanged we re-fetch anyway so
  // cues always correspond to the current source. Registered before the URL
  // watcher so a combined src+thumbnails change processes the source reset
  // first.
  watch(sourceKey, () => reload(latestUrl), { flush: 'sync' })

  // New thumbnails address: cancel the previous fetch and resolve the new one.
  // Sync flush makes the cue reset atomic with the prop change — old cues can
  // never survive even a single render after the address changes.
  watch(thumbnailsUrl, (url) => reload(url), { immediate: true, flush: 'sync' })

  onBeforeUnmount(() => {
    loadGeneration++
    controller?.abort()
    controller = null
  })

  return { thumbnailCues, reloadThumbnails: reload }
}
