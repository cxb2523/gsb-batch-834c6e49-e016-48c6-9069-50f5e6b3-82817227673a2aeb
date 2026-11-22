import { describe, it, expect } from 'vitest'
import { fetchKernel } from '~/audio/fetch_assets'
import type { DenoiseModel } from '~/audio/kernels'
import type { ProcessorInit } from '~/audio/messages'

// Processor-level coverage for the sample-rate fallback, run against the REAL
// kernels in an OfflineAudioContext:
//   - a kernel without resamplers on a non-48 kHz context falls back to dry
//     passthrough (the original audio) and reports why, instead of running the
//     net on wrong-rate samples;
//   - a kernel WITH resamplers denoises at the device rate and stays finite.
//
// The input-swap / resampler-reset behaviour itself (which needs a live graph
// and two real mics) is covered by switch_input.test.ts.
//
// Needs the pinned kernels: `npm run e2e:assets` (tests/e2e/fetch_assets.mjs).

const ASSETS = '/examples/vanilla-webrtc/public/assets/models/'
const SR = 48000

function noisySpeech(rate: number, seconds: number): Float32Array {
  const x = new Float32Array(Math.round(rate * seconds))
  let seed = 1
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  let ph = 0
  for (let i = 0; i < x.length; i++) {
    const t = i / rate
    ph += 2 * Math.PI * (140 + 20 * Math.sin(2 * Math.PI * 3 * t)) / rate
    const env = Math.max(0, Math.sin(2 * Math.PI * 2.5 * t))
    let v = 0
    for (let h = 1; h <= 8; h++) v += Math.sin(h * ph) / h
    x[i] = 0.15 * env * v + 0.03 * rnd()
  }
  return x
}

async function render(model: DenoiseModel, rate: number, input: Float32Array, debug = false): Promise<{ out: Float32Array; errors: string[]; underruns: number }> {
  const assets = await fetchKernel(model, ASSETS).catch((e) => {
    throw new Error(`${(e as Error).message} — run \`npm run e2e:assets\` first`)
  })
  const ctx = new OfflineAudioContext(1, input.length, rate)
  await ctx.audioWorklet.addModule(new URL('../../src/audio/worklet/processor.ts', import.meta.url).href)
  const buf = ctx.createBuffer(1, input.length, rate)
  buf.copyToChannel(input, 0)
  const src = ctx.createBufferSource()
  src.buffer = buf
  const processorOptions: ProcessorInit = {
    model, wasmBytes: assets.wasmBytes, weights: assets.weights, enabled: true,
    postFilterBeta: 0.03, gruLeak: 1, debug,
  }
  const node = new AudioWorkletNode(ctx, 'denoise', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions,
  })
  const errors: string[] = []
  let underruns = 0
  node.port.onmessage = (e) => {
    if (e.data?.type === 'error') errors.push(e.data.message)
    if (e.data?.type === 'underrun') underruns++
  }
  src.connect(node).connect(ctx.destination)
  src.start()
  const rendered = await ctx.startRendering()
  return { out: rendered.getChannelData(0), errors, underruns }
}

function rms(y: Float32Array): number {
  let s = 0
  for (const v of y) s += v * v
  return Math.sqrt(s / Math.max(1, y.length))
}

describe('denoise processor: sample-rate fallback', () => {
  it('rnnoise on a non-48k context passes the original audio through and says why', async () => {
    const rate = 44100
    const input = noisySpeech(rate, 1)
    const { out, errors } = await render('rnnoise', rate, input)
    // The processor passed its input through unchanged (not silence, and never
    // a net run on wrong-rate samples).
    let maxDiff = 0
    for (let i = 0; i < input.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - input[i]))
    expect(maxDiff).toBeLessThan(1e-6)
    expect(errors.some((m) => /can't resample 44100→48000/.test(m))).toBe(true)
  })

  it('dfnint8 on a non-48k context resamples (no rate error) and stays finite', async () => {
    const rate = 44100
    const input = noisySpeech(rate, 1)
    const { out, errors } = await render('dfnint8', rate, input)
    expect(errors.filter((m) => /can't resample/.test(m))).toEqual([])
    for (const v of out) expect(Number.isFinite(v)).toBe(true)
    expect(rms(out.subarray(Math.round(rate * 0.5)))).toBeGreaterThan(1e-3)
  })
})

describe('denoise processor: 128⇄480 ring never underruns', () => {
  // A hop is produced every 480 input samples but the ring is drained 128 at a
  // time. Priming exactly one hop (480) leaves the ring dry once their phases
  // drift apart, which used to fill the output with silence for 32–96 samples
  // every few quanta — an audible dropout, and the "hole" a mic switch hit.
  // The processor now primes two hops and, as a last resort, bridges with the
  // input directly instead of silence; this pins both.
  it('a steady 2 s render produces no underrun and no silent block', async () => {
    const n = SR * 2
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR)
    const { out, underruns } = await render('rnnoise', SR, x, true)
    expect(underruns).toBe(0)

    // No 128-sample block may be silent (the tone itself is never silent).
    let silent = 0
    for (let s = Math.round(SR * 0.5); s + 128 <= out.length; s += 128) {
      let e = 0
      for (let i = 0; i < 128; i++) e += out[s + i] * out[s + i]
      if (Math.sqrt(e / 128) < 0.02) silent++
    }
    expect(silent).toBe(0)
  }, 30_000)
})
