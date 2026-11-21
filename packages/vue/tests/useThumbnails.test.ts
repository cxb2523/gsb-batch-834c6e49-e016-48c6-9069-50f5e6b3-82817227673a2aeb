import type { ThumbnailCue } from '@vue-player/core'
import { mount } from '@vue/test-utils'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { useThumbnails } from '../src/composables/useThumbnails'

const VTT_A = `WEBVTT

00:00:00.000 --> 00:00:05.000
thumbs-a.jpg#xywh=0,0,160,90
`

const VTT_B = `WEBVTT

00:00:00.000 --> 00:00:05.000
thumbs-b.jpg
`

interface PendingFetch {
  url: string
  resolve: (res: { ok: boolean; text: () => Promise<string> }) => void
  reject: (error: Error) => void
  signal: AbortSignal
}

// The resolution chain spans several microtask ticks (fetch promise →
// response.text() → parse → state write), so flush on a timer instead of a
// fixed number of Promise.resolve() calls.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

describe('useThumbnails — cancellation races', () => {
  let pending: PendingFetch[]
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    pending = []
    fetchSpy = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        pending.push({
          url,
          resolve,
          reject,
          signal: init?.signal ?? new AbortController().signal,
        })
      })
    })
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mountComposable(initialUrl?: string) {
    const urlRef = ref<string | undefined>(initialUrl)
    const srcRef = ref('source-a')
    let api: ReturnType<typeof useThumbnails> | null = null
    const Host = defineComponent({
      setup() {
        api = useThumbnails(urlRef, srcRef)
        return () => null
      },
    })
    const wrapper = mount(Host)
    return {
      wrapper,
      urlRef,
      srcRef,
      cues: () => api!.thumbnailCues.value,
    }
  }

  it('resolves the initial VTT into cues', async () => {
    const { cues } = mountComposable('/thumbs-a.vtt')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    pending[0].resolve({ ok: true, text: async () => VTT_A })
    await settle()

    expect(cues()).toHaveLength(1)
    expect((cues()[0] as ThumbnailCue).url).toContain('thumbs-a.jpg')
    expect((cues()[0] as ThumbnailCue).w).toBe(160)
  })

  it('a newer thumbnails URL aborts the old fetch and its result never lands', async () => {
    const { cues, urlRef } = mountComposable('/thumbs-a.vtt')
    const firstSignal = pending[0].signal

    urlRef.value = '/thumbs-b.vtt'
    await Promise.resolve()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(firstSignal.aborted).toBe(true)
    expect(pending).toHaveLength(2)

    // Old request settles (aborted) after the new one was issued.
    pending[0].reject(new DOMException('Aborted', 'AbortError'))
    pending[1].resolve({ ok: true, text: async () => VTT_B })
    await settle()

    expect(cues()).toHaveLength(1)
    expect((cues()[0] as ThumbnailCue).url).toContain('thumbs-b.jpg')
  })

  it('clears cues immediately on a source switch and re-resolves for the new source', async () => {
    const { cues, srcRef } = mountComposable('/thumbs.vtt')
    pending[0].resolve({ ok: true, text: async () => VTT_A })
    await settle()
    expect(cues()).toHaveLength(1)

    srcRef.value = 'source-b'
    await settle()

    // Old preview is gone before the new fetch resolves.
    expect(cues()).toEqual([])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(pending[1].url).toBe('/thumbs.vtt')

    pending[1].resolve({ ok: true, text: async () => VTT_B })
    await settle()
    expect((cues()[0] as ThumbnailCue).url).toContain('thumbs-b.jpg')
  })

  it('clears rather than retains cues when resolution fails or returns empty', async () => {
    const { cues, urlRef } = mountComposable('/thumbs-a.vtt')
    pending[0].resolve({ ok: true, text: async () => VTT_A })
    await settle()
    expect(cues()).toHaveLength(1)

    // Failed fetch → empty.
    urlRef.value = '/missing.vtt'
    await Promise.resolve()
    pending[1].reject(new Error('network down'))
    await settle()
    expect(cues()).toEqual([])

    // OK response with no cues → empty (not the previous cues).
    urlRef.value = '/empty.vtt'
    await Promise.resolve()
    pending[2].resolve({ ok: true, text: async () => 'WEBVTT\n' })
    await settle()
    expect(cues()).toEqual([])

    // Undefined URL → empty without a fetch.
    const callsBefore = fetchSpy.mock.calls.length
    urlRef.value = undefined
    await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledTimes(callsBefore)
    expect(cues()).toEqual([])
  })

  it('a stale resolution resolving late cannot overwrite the current cues', async () => {
    const { cues, urlRef } = mountComposable('/thumbs-a.vtt')
    urlRef.value = '/thumbs-b.vtt'
    await Promise.resolve()

    // The old request resolves successfully (e.g. an environment that ignores
    // the abort signal) — the generation guard must still reject its result.
    pending[0].resolve({ ok: true, text: async () => VTT_A })
    pending[1].resolve({ ok: true, text: async () => VTT_B })
    await settle()

    expect(cues()).toHaveLength(1)
    expect((cues()[0] as ThumbnailCue).url).toContain('thumbs-b.jpg')
  })
})
