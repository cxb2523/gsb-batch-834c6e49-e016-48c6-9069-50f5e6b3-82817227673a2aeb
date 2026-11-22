import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { AudioDenoiser } from '~/audio/denoiser'
import { identityKernel, resamplerKernel } from '../helpers/synth_kernel'
import { toneTrack, silentTrack, recordTrack, recentPeak, recentFreq, probeNode } from '../helpers/audio_tracks'
import { sleep, waitUntil, stubWeights, restoreFetch } from '../helpers/pipeline'

// Input replacement (mic switch) and sample-rate changes on the denoise chain,
// driven with synthetic kernels and synthetic mic tracks — no network.
//
// The identity kernel (DFN ABI, scale 1) passes its input through unchanged, so
// the output's level/frequency say WHICH mic it carries and whether two sources
// are mixed. The resampler kernel is that plus an echo-ring resampler: the new
// input passes at full level, but the ring keeps echoing the previous input for
// ~0.74 s. Rebuilding the resampler state (what `reset` does) zeroes the ring,
// so "the old input's tail is gone" is observable at the output.

const BASE = 'https://test.local/audio/'
const realFetch = globalThis.fetch.bind(globalThis)

// Serve our kernel for every audio asset the denoiser asks for; everything
// else goes to whatever fetch was installed before (so stubWeights still works).
function useKernel(wasm: ArrayBuffer): void {
  const fallback = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(BASE)) return new Response(wasm.slice(0))
    return fallback(input as RequestInfo, init)
  }) as typeof fetch
}

// Force every AudioContext to a rate (the AudioDenoiser requests 48k, so this is
// how a non-48k context — the case the worklet resamplers exist for — is
// exercised). Returns a restore function.
function forceContextRate(rate: number): () => void {
  const Real = globalThis.AudioContext
  class Forced extends Real {
    constructor(opts?: AudioContextOptions) { super({ ...opts, sampleRate: rate }) }
  }
  ;(globalThis as { AudioContext: unknown }).AudioContext = Forced
  return () => { ;(globalThis as { AudioContext: unknown }).AudioContext = Real }
}

// Headless Chromium enforces the autoplay policy; a click unlocks audio.
async function unlock(): Promise<void> { try { await userEvent.click(document.body) } catch { /* best effort */ } }

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const f of cleanup.reverse()) { try { f() } catch { /* best effort */ } }
  cleanup = []
  globalThis.fetch = realFetch
  restoreFetch()
})

describe('AudioDenoiser input replacement', () => {
  it('swaps to the new mic: new sound only, no double mix, no silent hole', async () => {
    await unlock()
    useKernel(identityKernel())
    const a = toneTrack(300)
    const b = toneTrack(900)
    const errors: string[] = []
    // debug: the processor reports output-ring underruns, which this test pins.
    const d = new AudioDenoiser(a.track, { model: 'dfn', weightsBaseUrl: BASE, debug: true, onError: (m) => errors.push(m) })
    cleanup.push(() => d.destroy(), a.stop, b.stop)
    expect(await d.ready).toBe(true)

    // Tap the denoise node INSIDE its own context: this is the chain's real
    // output, with no second-context media hop that could drop a quantum and be
    // mistaken for a hole.
    const ctx = (d as unknown as { ctx: AudioContext }).ctx
    const node = (d as unknown as { node: AudioWorkletNode }).node
    const probe = await probeNode(ctx, node)
    cleanup.push(probe.stop)
    expect(await recentFreq(probe, 300)).toBeGreaterThan(200)   // mic A
    expect(await recentFreq(probe, 300)).toBeLessThan(400)

    const before = probe.count()
    await d.setInputTrack(b.track)
    const after = probe.count()
    await sleep(150)

    // Across the switch — strictly the samples the node produced — the denoise
    // ring must never run dry. That is the deterministic gate: the old bug
    // (one-hop priming, silence on underrun) makes this non-zero every run.
    // The bounded silent run is a backstop: Chromium's capture pipeline can
    // itself stall for a few quanta when a new MediaStreamAudioSourceNode is
    // created (reproducible with no denoiser in the graph at all), so the
    // exact-continuity claim is pinned in the worklet-level test instead
    // (processor_rate.test.ts: no underrun, no silent block).
    expect(d.underrunCount).toBe(0)
    expect(probe.longestSilentRun(before, after + 128 * 8)).toBeLessThanOrEqual(4)

    const settled = probe.peak(after)
    const f = probe.freq(after)

    expect(f).toBeGreaterThan(700)          // ~900 Hz: mic B
    expect(f).toBeLessThan(1100)
    expect(settled).toBeLessThan(0.8)       // not the old + new summed
    expect(errors.filter((m) => m.includes('passing the original audio'))).toEqual([])
  }, 20_000)

  it('unbinds the old track’s listener; the new track ending ends the output', async () => {
    await unlock()
    useKernel(identityKernel())
    const a = toneTrack(300)
    const b = toneTrack(900)
    const d = new AudioDenoiser(a.track, { model: 'dfn', weightsBaseUrl: BASE })
    cleanup.push(() => d.destroy(), a.stop, b.stop)
    expect(await d.ready).toBe(true)
    const out = d.outputTrack

    await d.setInputTrack(b.track)
    // A late `ended` from the OLD track must not kill the output.
    a.track.dispatchEvent(new Event('ended'))
    await sleep(150)
    expect(out.readyState).not.toBe('ended')
    expect(d.outputTrack).toBe(out)

    // The NEW track ending ends the output.
    b.track.dispatchEvent(new Event('ended'))
    await waitUntil(() => out.readyState === 'ended', 3000, 'output ended with the new track')
  }, 20_000)

  it('repeated switches leave exactly the current mic on the output', async () => {
    await unlock()
    useKernel(identityKernel())
    // Mics an octave apart, so "which mic is this?" is robust to a few samples
    // of jitter and to load-related streaming hiccups in the recorder.
    const mics = [toneTrack(250), toneTrack(500), toneTrack(1000)]
    const d = new AudioDenoiser(mics[0].track, { model: 'dfn', weightsBaseUrl: BASE })
    cleanup.push(() => d.destroy(), ...mics.map((m) => m.stop))
    expect(await d.ready).toBe(true)
    const rec = await recordTrack(d.outputTrack)
    cleanup.push(rec.stop)

    await d.setInputTrack(mics[1].track)
    let f = await recentFreq(rec, 300)
    expect(f).toBeGreaterThan(350)    // ~500 Hz
    expect(f).toBeLessThan(700)

    await d.setInputTrack(mics[2].track)
    f = await recentFreq(rec, 300)
    expect(f).toBeGreaterThan(750)    // ~1000 Hz
    expect(f).toBeLessThan(1350)
    expect(d.isBypassed).toBe(false)
  }, 20_000)
})

describe('AudioDenoiser sample-rate changes', () => {
  it('non-48k context, kernel can resample: rebuilds resampler state on input change', async () => {
    await unlock()
    const restore = forceContextRate(44100)
    cleanup.push(restore)
    useKernel(resamplerKernel())
    const loud = toneTrack(440, 44100, 0.5)
    const quiet = silentTrack(44100)
    const errors: string[] = []
    const d = new AudioDenoiser(loud.track, { model: 'dfn', weightsBaseUrl: BASE, onError: (m) => errors.push(m) })
    cleanup.push(() => d.destroy(), loud.stop, quiet.stop)
    expect(await d.ready).toBe(true)
    expect(d.sampleRate).toBe(44100)
    expect(d.isBypassed).toBe(false)

    // Stats report the context's rate, not a stale 48k.
    await waitUntil(() => d.getStats() !== null, 4000, 'stats')
    expect(d.getStats()!.sampleRate).toBe(44100)

    const rec = await recordTrack(d.outputTrack, 44100)
    cleanup.push(rec.stop)

    // Let the echo ring fill on the loud mic.
    await sleep(1500)
    expect(await recentPeak(rec, 100)).toBeGreaterThan(0.4)   // 1.0 + echo

    await d.setInputTrack(quiet.track)

    // A reset zeroed the ring: the old mic's echo does not carry over (without
    // it, the ring would keep ringing for ~0.74 s at ~0.5 peak).
    await sleep(250)
    expect(await recentPeak(rec, 150)).toBeLessThan(0.1)

    // The worklet is still in the path, at the context's rate, no fallback.
    expect(d.isBypassed).toBe(false)
    expect(d.getStats()!.sampleRate).toBe(44100)
    expect(errors.filter((m) => m.includes('passing the original audio'))).toEqual([])
  }, 25_000)

  it('non-48k context, kernel cannot resample: passthrough fallback, onError, switch does not throw', async () => {
    await unlock()
    const restore = forceContextRate(44100)
    cleanup.push(restore)
    useKernel(identityKernel())   // no df_resampler_* exports
    const a = toneTrack(300, 44100)
    const b = toneTrack(900, 44100)
    const errors: string[] = []
    const d = new AudioDenoiser(a.track, { model: 'dfn', weightsBaseUrl: BASE, onError: (m) => errors.push(m) })
    cleanup.push(() => d.destroy(), a.stop, b.stop)

    // Not denoised, but audio flows (the original mic), and onError explains.
    expect(await d.ready).toBe(false)
    expect(d.isBypassed).toBe(true)
    await waitUntil(() => errors.some((m) => /can't resample 44100→48000/.test(m) && m.includes('passing the original audio through')), 4000, 'rate fallback error')

    const rec = await recordTrack(d.outputTrack, 44100)
    cleanup.push(rec.stop)
    expect(await recentPeak(rec, 300)).toBeGreaterThan(0.1)

    // A mic switch still works in passthrough: new source, new sound, no throw,
    // no stale old source, no doubled mix.
    await expect(d.setInputTrack(b.track)).resolves.toBeUndefined()
    const f = await recentFreq(rec, 300)
    expect(f).toBeGreaterThan(700)
    expect(f).toBeLessThan(1100)
    expect(await recentPeak(rec, 200)).toBeLessThan(0.8)
    expect(d.isBypassed).toBe(true)                        // still the passthrough chain
    expect(d.outputTrack.readyState).toBe('live')
  }, 20_000)

  it('rebuilds the graph when the current context refuses the new track', async () => {
    await unlock()
    // A context pinned at 48k refuses a 44.1k stream (the Firefox failure the
    // rebuild path handles); a context at 44.1k accepts it.
    const realSource = AudioContext.prototype.createMediaStreamSource
    AudioContext.prototype.createMediaStreamSource = function (this: AudioContext, stream: MediaStream) {
      const rate = stream.getAudioTracks()[0]?.getSettings?.().sampleRate
      if (this.sampleRate === 48000 && rate && rate !== 48000) {
        throw new DOMException('sample-rate mismatch', 'NotSupportedError')
      }
      return realSource.call(this, stream)
    }
    cleanup.push(() => { AudioContext.prototype.createMediaStreamSource = realSource })

    useKernel(resamplerKernel())
    const a = toneTrack(440, 48000)
    const b = toneTrack(700, 44100)
    const errors: string[] = []
    const d = new AudioDenoiser(a.track, { model: 'dfn', weightsBaseUrl: BASE, onError: (m) => errors.push(m) })
    cleanup.push(() => d.destroy(), a.stop, b.stop)
    expect(await d.ready).toBe(true)
    expect(d.sampleRate).toBe(48000)

    // The 48k context can't take the 44.1k track → the whole graph moves to a
    // context at 44.1k. The output never goes silent: a clone of the new mic
    // carries the call until the rebuilt graph's worklet primes.
    await d.setInputTrack(b.track)
    expect(d.sampleRate).toBe(44100)
    expect(d.outputTrack.readyState).toBe('live')

    const rec = await recordTrack(d.outputTrack, 44100)
    cleanup.push(rec.stop)
    await waitUntil(() => d.getStats() !== null, 5000, 'stats from the rebuilt graph')
    expect(d.getStats()!.sampleRate).toBe(44100)
    expect(await recentPeak(rec, 300)).toBeGreaterThan(0.1)
    expect(errors.filter((m) => m.includes('could not rebuild'))).toEqual([])
  }, 25_000)
})

describe('EffectsPipeline.setInputStream follows the mic', () => {
  it('hands a new audio track to the denoiser: output switches to the new mic', async () => {
    await unlock()
    // Video weights come from the fixture (stubWeights); the audio kernel comes
    // from useKernel() on top of it.
    await stubWeights({ 'rnnoise.wasm': () => new Response(null, { status: 404 }) })
    useKernel(identityKernel())
    const { Pipeline } = await import('~/pipeline/index')
    const { PRESETS } = await import('~/pipeline/presets')
    const { syntheticCamera } = await import('../helpers/pipeline')
    const cam = syntheticCamera(30)
    const a = toneTrack(300)
    const b = toneTrack(900)
    const p = new Pipeline(new MediaStream([cam.track, a.track]), {
      preset: PRESETS[1], audio: { denoise: { model: 'dfn', weightsBaseUrl: BASE } },
    })
    cleanup.push(() => p.destroy(), cam.stop, a.stop, b.stop)
    await p.ready

    const outputTrack = p.stream.getAudioTracks()[0]
    const rec = await recordTrack(outputTrack)
    cleanup.push(rec.stop)
    await waitUntil(() => recentFreqCache(rec) > 0, 3000, 'audio through the pipeline')
    let f = await recentFreq(rec, 300)
    expect(f).toBeGreaterThan(200)
    expect(f).toBeLessThan(400)

    // A new capture stream (same camera, different mic — the device-switch
    // shape) replaces the input.
    await p.setInputStream(new MediaStream([cam.track, b.track]))
    f = await recentFreq(rec, 400)
    expect(f).toBeGreaterThan(700)
    expect(f).toBeLessThan(1100)
    // The output track itself is unchanged (only its content switched).
    expect(p.stream.getAudioTracks()[0]).toBe(outputTrack)
  }, 25_000)
})

function recentFreqCache(rec: { count(): number }): number { return rec.count() }
