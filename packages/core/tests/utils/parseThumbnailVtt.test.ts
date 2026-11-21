import { describe, expect, it, vi } from 'vitest'
import { parseThumbnailVtt } from '../../src/utils/parseThumbnailVtt'

const VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
thumbs.jpg
`

describe('parseThumbnailVtt', () => {
  it('returns parsed cues on a normal response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () => VTT,
      })),
    )

    const cues = await parseThumbnailVtt('/thumbs.vtt')
    expect(cues).toHaveLength(1)
    expect(cues[0].url).toContain('thumbs.jpg')

    vi.unstubAllGlobals()
  })

  it('passes the abort signal through to fetch', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      text: async () => VTT,
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const controller = new AbortController()

    await parseThumbnailVtt('/thumbs.vtt', controller.signal)
    expect(fetchSpy).toHaveBeenCalledWith('/thumbs.vtt', { signal: controller.signal })

    vi.unstubAllGlobals()
  })

  it('rejects with AbortError when the signal is already aborted', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const controller = new AbortController()
    controller.abort()

    await expect(parseThumbnailVtt('/thumbs.vtt', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    // Never touched the network for a generation that is already stale.
    expect(fetchSpy).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('re-throws an abort raised mid-flight instead of resolving empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        const error = new DOMException('Aborted', 'AbortError')
        init?.signal?.addEventListener('abort', () => {})
        throw error
      }),
    )
    const controller = new AbortController()

    const promise = parseThumbnailVtt('/thumbs.vtt', controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })

    vi.unstubAllGlobals()
  })

  it('still resolves to an empty array on a non-abort failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, text: async () => '' })),
    )
    expect(await parseThumbnailVtt('/missing.vtt', new AbortController().signal)).toEqual([])
    vi.unstubAllGlobals()
  })
})
