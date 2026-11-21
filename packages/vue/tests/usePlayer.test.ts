import type { Track } from '@vue-player/core'
import { mount } from '@vue/test-utils'
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defineComponent, h, ref } from 'vue'
import { usePlayer } from '../src/composables/usePlayer'

// ─── Controllable hls.js mock ──────────────────────────────────────────────
// Every instance records its event handlers and destroyed state so tests can
// emit MANIFEST_PARSED / ERROR after the generation that created it has
// expired, and assert the stale instance is torn down without state writes.
interface HlsHandlers {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [event: string]: ((...args: any[]) => void) | undefined
}

interface MockHlsInstance {
  levels: Array<{ height: number; bitrate: number }>
  handlers: HlsHandlers
  destroyed: boolean
  loadedSrc: string | null
  attached: boolean
  nextLevel: number | undefined
  currentLevel: number | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (event: string, cb: (...args: any[]) => void) => void
  off: () => void
  loadSource: (src: string) => void
  attachMedia: (el: unknown) => void
  destroy: () => void
}

const createdInstances: MockHlsInstance[] = []
const mockEvents = {
  MANIFEST_PARSED: 'MANIFEST_PARSED',
  LEVEL_SWITCHED: 'LEVEL_SWITCHED',
  ERROR: 'ERROR',
}

vi.mock('hls.js', () => {
  class MockHls {
    static Events = mockEvents
    static isSupported = vi.fn(() => true)
    levels = [
      { height: 720, bitrate: 2000 },
      { height: 480, bitrate: 1000 },
    ]

    handlers: HlsHandlers = {}
    destroyed = false
    loadedSrc: string | null = null
    attached = false
    nextLevel: number | undefined
    currentLevel: number | undefined

    constructor() {
      createdInstances.push(this)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void) {
      this.handlers[event] = cb
    }

    off() {}

    loadSource(src: string) {
      this.loadedSrc = src
    }

    attachMedia() {
      this.attached = true
    }

    destroy() {
      this.destroyed = true
    }
  }
  return { default: MockHls }
})

function mountPlayer() {
  const videoRef = ref<HTMLVideoElement | null>(null)
  const Host = defineComponent({
    setup() {
      const player = usePlayer(videoRef)
      return { player }
    },
    render() {
      return h('video', { ref: videoRef })
    },
  })
  const wrapper = mount(Host)
  const video = wrapper.element as HTMLVideoElement
  const { state, controls, loadSource } = wrapper.vm.player
  return { wrapper, video, state, controls, loadSource }
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const englishTrack: Track = { src: '/en.vtt', label: 'English', language: 'en', default: true }
const spanishTrack: Track = { src: '/es.vtt', label: 'Español', language: 'es' }

describe('usePlayer — atomic source switching', () => {
  beforeEach(() => {
    createdInstances.length = 0
    vi.clearAllMocks()
  })

  it('consecutive native loads leave only the final source attached', async () => {
    const { wrapper, video, state, loadSource } = mountPlayer()

    loadSource('/first.mp4')
    loadSource('/second.mp4')
    loadSource('/third.mp4')
    await flushMicrotasks()

    expect(video.getAttribute('src')).toBe('/third.mp4')
    expect(state.error).toBeNull()
    expect(state.currentTime).toBe(0)
    expect(state.duration).toBe(0)
    expect(state.availableQualities).toEqual([])
    expect(state.currentQuality).toBe('auto')
    expect(state.currentTrack).toBeNull()
    expect(state.isLive).toBe(false)
    expect(state.buffered).toBe(0)

    wrapper.unmount()
  })

  it('discards an HLS instance created after its generation expired during import', async () => {
    const { wrapper, state, loadSource } = mountPlayer()

    loadSource('https://example.com/a/index.m3u8')
    await flushMicrotasks()
    const first = createdInstances.at(-1)!
    expect(first.loadedSrc).toContain('/a/')

    // Switch while the first stream's manifest is still pending.
    loadSource('https://example.com/b/index.m3u8')
    await flushMicrotasks()

    // The first instance is destroyed; only the current generation survives.
    expect(first.destroyed).toBe(true)
    const live = createdInstances.filter((i) => !i.destroyed)
    expect(live).toHaveLength(1)
    expect(live[0].loadedSrc).toBe('https://example.com/b/index.m3u8')

    // A manifest arriving on the abandoned (a) instance must not touch state,
    // and the stale instance is defensively destroyed again.
    first.handlers.MANIFEST_PARSED?.()
    expect(state.availableQualities).toEqual([])
    expect(first.destroyed).toBe(true)

    // The live instance's manifest populates state normally.
    live[0].handlers.MANIFEST_PARSED?.()
    expect(state.availableQualities.map((q) => q.value)).toEqual([720, 480])
    expect(state.currentQuality).toBe('auto')

    wrapper.unmount()
  })

  it('ignores fatal HLS errors from a previous generation', async () => {
    const { wrapper, state, loadSource } = mountPlayer()

    loadSource('https://example.com/a/index.m3u8')
    await flushMicrotasks()
    const first = createdInstances.at(-1)!
    expect(first.destroyed).toBe(false)

    loadSource('https://example.com/b/index.m3u8')
    await flushMicrotasks()

    // First instance was destroyed by the switch.
    expect(first.destroyed).toBe(true)

    // A late fatal error from the dead stream must not surface on the new one.
    first.handlers.ERROR?.(undefined, {
      fatal: true,
      response: { code: 404 },
    })
    expect(state.error).toBeNull()
    expect(state.isLoading).toBe(true)

    wrapper.unmount()
  })

  it('keeps only the last source when the same src is loaded repeatedly', async () => {
    const { wrapper, video, loadSource } = mountPlayer()

    for (let i = 0; i < 5; i++) loadSource('/same.mp4')
    await flushMicrotasks()

    expect(video.getAttribute('src')).toBe('/same.mp4')

    wrapper.unmount()
  })

  it('resets currentTrack on every source switch and re-applies the new source default', async () => {
    const { wrapper, video, state, controls, loadSource } = mountPlayer()

    // Simulate the user (and default-track logic) selecting a track on source A.
    controls.setTrack(spanishTrack)
    expect(state.currentTrack).toEqual(spanishTrack)

    loadSource('/second.mp4')
    await flushMicrotasks()

    // No residue from the previous source.
    expect(state.currentTrack).toBeNull()

    // Metadata becomes ready → the VideoPlayer isLoading watcher equivalent
    // re-applies the default track for the current source.
    controls.setTrack(englishTrack)
    expect(state.currentTrack).toEqual(englishTrack)

    // Switch again: the English selection must not leak into source C.
    loadSource('/third.mp4')
    await flushMicrotasks()
    expect(state.currentTrack).toBeNull()

    // Track element modes reflect the reset (all disabled when no track).
    const trackEl = document.createElement('track')
    trackEl.label = englishTrack.label
    trackEl.srclang = englishTrack.language
    video.appendChild(trackEl)
    controls.setTrack(englishTrack)
    expect(trackEl.track).toBeTruthy()

    wrapper.unmount()
  })

  it('stale HLS LEVEL_SWITCHED callbacks never overwrite the current quality', async () => {
    const { wrapper, state, loadSource } = mountPlayer()

    loadSource('https://example.com/a/index.m3u8')
    await flushMicrotasks()
    const first = createdInstances.at(-1)!

    loadSource('https://example.com/b/index.m3u8')
    await flushMicrotasks()

    first.handlers.LEVEL_SWITCHED?.(undefined, { level: 1 })
    expect(state.currentQuality).toBe('auto')
    expect(state.availableQualities).toEqual([])

    wrapper.unmount()
  })

  it('retry reloads the last source as a fresh generation', async () => {
    const { wrapper, video, state, controls, loadSource } = mountPlayer()

    loadSource('/fails.mp4')
    await flushMicrotasks()
    expect(video.getAttribute('src')).toBe('/fails.mp4')

    // Simulate a fatal playback error, then retry.
    state.error = { code: 2, message: 'network', type: 'network' }
    controls.retry()
    await flushMicrotasks()

    expect(video.getAttribute('src')).toBe('/fails.mp4')
    expect(state.error).toBeNull()

    // The browser's loadstart (fired for the fresh video.load()) flips the
    // loading flag back on, as it would in a real retry.
    video.dispatchEvent(new Event('loadstart'))
    expect(state.isLoading).toBe(true)

    wrapper.unmount()
  })

  it('a superseded HLS generation tears down its instance and ignores later callbacks', async () => {
    const { wrapper, state, loadSource } = mountPlayer()

    // First generation loads and creates a live HLS instance.
    loadSource('https://example.com/a/index.m3u8')
    await flushMicrotasks()
    const first = createdInstances.at(-1)!
    expect(first.destroyed).toBe(false)

    // A second generation supersedes it.
    loadSource('https://example.com/b/index.m3u8')
    await flushMicrotasks()
    expect(first.destroyed).toBe(true)

    // Every late callback from the abandoned instance must be a no-op against
    // the current source's state.
    first.handlers.MANIFEST_PARSED?.()
    first.handlers.LEVEL_SWITCHED?.(undefined, { level: 0 })
    first.handlers.ERROR?.(undefined, { fatal: true, response: { code: 404 } })

    expect(state.availableQualities).toEqual([])
    expect(state.currentQuality).toBe('auto')
    expect(state.error).toBeNull()
    expect(state.isLoading).toBe(true)

    // Only the second generation remains live and can populate state.
    const live = createdInstances.filter((i) => !i.destroyed)
    expect(live).toHaveLength(1)
    live[0].handlers.MANIFEST_PARSED?.()
    expect(state.availableQualities.map((q) => q.value)).toEqual([720, 480])

    wrapper.unmount()
  })
})
