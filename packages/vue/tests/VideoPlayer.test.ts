import type { Track } from '@vue-player/core'
import { mount } from '@vue/test-utils'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VpTimeline from '../src/components/controls/VpTimeline.vue'
import VideoPlayer from '../src/components/VideoPlayer/VideoPlayer.vue'

const VTT_A = `WEBVTT

00:00:00.000 --> 00:00:05.000
thumbs-a.jpg
`

const VTT_B = `WEBVTT

00:00:00.000 --> 00:00:05.000
thumbs-b.jpg
`

const tracks: Track[] = [
  { src: '/en.vtt', label: 'English', language: 'en', default: true },
  { src: '/es.vtt', label: 'Español', language: 'es' },
]

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

// Simulate the browser's media event ordering so the isLoading watcher sees a
// real true → false transition before default-track re-application runs.
async function simulateReady(wrapper: ReturnType<typeof mount>) {
  const video = wrapper.element.querySelector('video') as HTMLVideoElement
  video.dispatchEvent(new Event('loadstart'))
  await tick()
  video.dispatchEvent(new Event('canplay'))
  await tick()
}

describe('videoPlayer — source switching resets subtitles and thumbnails', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn(async (url: string) => {
      // Key off the thumbnail prefix, not a bare letter that also appears in
      // the "a-thumbs" filename.
      const body = String(url).startsWith('/b') ? VTT_B : VTT_A
      return {
        ok: true,
        text: async () => body,
      }
    })
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function mountPlayer(props: Record<string, unknown> = {}) {
    const wrapper = mount(VideoPlayer, {
      props: {
        src: '/a.mp4',
        thumbnails: '/a-thumbs.vtt',
        tracks,
        ...props,
      },
      global: {
        // The real timeline is mounted so we can assert the thumbnail cues it
        // receives; every other control is stubbed to keep the test focused.
        stubs: {
          VpPlayButton: true,
          VpTimeDisplay: true,
          VpVolumeControl: true,
          VpSubtitlesButton: true,
          VpPiPButton: true,
          VpFullscreenButton: true,
          VpSettingsButton: true,
          VpLoadingOverlay: true,
          VpErrorOverlay: true,
          VpTimeline,
        },
      },
    })
    await tick()
    return wrapper
  }

  function lastTrackChange(wrapper: ReturnType<typeof mount>): Track | null | undefined {
    return (wrapper.emitted('trackChange') ?? []).at(-1)?.[0] as Track | null | undefined
  }

  it('applies the default track once metadata is ready', async () => {
    const wrapper = await mountPlayer()
    await simulateReady(wrapper)
    expect(lastTrackChange(wrapper)).toMatchObject({ language: 'en', label: 'English' })
  })

  it('resets the selected subtitle track when src changes, then re-applies the default', async () => {
    const wrapper = await mountPlayer()
    await simulateReady(wrapper)
    expect(lastTrackChange(wrapper)).toMatchObject({ language: 'en' })

    // User picks Spanish.
    wrapper.findComponent({ name: 'VpSubtitlesButton' }).vm.$emit('set-track', tracks[1])
    await tick()
    expect(lastTrackChange(wrapper)).toMatchObject({ language: 'es' })

    // Switch source: the Spanish selection must be discarded (null emitted)
    // before the new source becomes ready.
    await wrapper.setProps({ src: '/b.mp4' })
    await tick()
    expect(lastTrackChange(wrapper)).toBeNull()

    // New source metadata ready → English default is applied again, not Spanish.
    await simulateReady(wrapper)
    expect(lastTrackChange(wrapper)).toMatchObject({ language: 'en', label: 'English' })
  })

  it('replaces thumbnail cues on src change so the old preview cannot show', async () => {
    const wrapper = await mountPlayer()
    const timeline = () => wrapper.findComponent(VpTimeline)

    // Initial source A cues resolved.
    let cues = timeline().props('thumbnailCues') as Array<{ url: string }>
    expect(cues).toHaveLength(1)
    expect(cues[0].url).toContain('thumbs-a.jpg')

    // Hold every request for the new sheet unresolved so the intermediate
    // (no-cues) state can be observed deterministically.
    let resolvePending: ((v: { ok: boolean; text: () => Promise<string> }) => void) | null = null
    fetchSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve
        }),
    )

    // New source brings its own thumbnail sheet.
    await wrapper.setProps({ src: '/b.mp4', thumbnails: '/b-thumbs.vtt' })
    await tick()

    // Mid-switch: cues were cleared synchronously, so no old preview can show
    // while the new source's VTT is still resolving.
    expect(timeline().props('thumbnailCues')).toBeUndefined()

    // Once the latest sheet resolves, only its cues are available.
    resolvePending?.({ ok: true, text: async () => VTT_B })
    for (let i = 0; i < 5; i++) await tick()
    cues = timeline().props('thumbnailCues') as Array<{ url: string }>
    expect(cues).toHaveLength(1)
    expect(cues[0].url).toContain('thumbs-b.jpg')
  })

  it('clears thumbnail cues when the new address fails to resolve', async () => {
    const wrapper = await mountPlayer()
    const timeline = () => wrapper.findComponent(VpTimeline)
    expect((timeline().props('thumbnailCues') as unknown[]).length).toBe(1)

    // A failed resolution must leave the player without cues rather than
    // retaining the previous source's.
    fetchSpy.mockImplementationOnce(async () => ({
      ok: false,
      status: 404,
      text: async () => '',
    }))
    await wrapper.setProps({ thumbnails: '/missing.vtt' })
    await tick()
    await tick()
    expect(timeline().props('thumbnailCues')).toBeUndefined()

    // Removing the thumbnails prop also yields no cues (and no extra fetch).
    const callsBefore = fetchSpy.mock.calls.length
    await wrapper.setProps({ thumbnails: undefined })
    await tick()
    expect(fetchSpy).toHaveBeenCalledTimes(callsBefore)
    expect(timeline().props('thumbnailCues')).toBeUndefined()
  })

  it('does not keep the previous source cues while a replacement fetch is pending', async () => {
    const wrapper = await mountPlayer()
    const timeline = () => wrapper.findComponent(VpTimeline)

    // Hold the new request unresolved and switch the thumbnails address.
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise(() => {
          // intentionally never resolves
        }),
    )
    await wrapper.setProps({ thumbnails: '/slow.vtt' })
    await tick()

    expect(timeline().props('thumbnailCues')).toBeUndefined()
  })
})
