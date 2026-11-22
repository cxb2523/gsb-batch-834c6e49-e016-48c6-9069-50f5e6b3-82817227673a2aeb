// Helpers for the audio-switch tests: synthetic mic tracks with a known
// frequency (so "whose sound is this?" is a matter of measuring), and a
// recorder that reads audio samples flowing through a live MediaStreamTrack.

import { sleep } from './pipeline'

/** An oscillator-backed mic track. `freq` identifies it in the output. */
export function toneTrack(freq = 440, rate = 48000, gain = 0.5) {
  const ctx = new AudioContext({ sampleRate: rate })
  const osc = ctx.createOscillator()
  osc.frequency.value = freq
  const amp = ctx.createGain()
  amp.gain.value = gain
  const dest = ctx.createMediaStreamDestination()
  osc.connect(amp).connect(dest)
  osc.start()
  return {
    track: dest.stream.getAudioTracks()[0],
    ctx,
    freq,
    stop: () => {
      try { osc.stop() } catch { /* already stopped */ }
      dest.stream.getTracks().forEach((t) => t.stop())
      void ctx.close().catch(() => {})
    },
  }
}

/** A live mic track carrying silence (e.g. a muted mic / a stopped source). */
export function silentTrack(rate = 48000) {
  const ctx = new AudioContext({ sampleRate: rate })
  const constSrc = ctx.createConstantSource()
  const amp = ctx.createGain()
  amp.gain.value = 0
  const dest = ctx.createMediaStreamDestination()
  constSrc.connect(amp).connect(dest)
  constSrc.start()
  return {
    track: dest.stream.getAudioTracks()[0],
    ctx,
    stop: () => {
      try { constSrc.stop() } catch { /* already stopped */ }
      dest.stream.getTracks().forEach((t) => t.stop())
      void ctx.close().catch(() => {})
    },
  }
}

interface Recorder {
  /** Samples captured so far (mono, at the recorder context's rate). */
  samples: Float32Array[]
  /** Peak over the window that started at `fromSample` (samples are absolute). */
  peak(fromSample?: number): number
  /** Total captured samples. */
  count(): number
  /** Zero-crossing frequency estimate over a window (identifies a tone). */
  freq(fromSample?: number): number
  stop(): void
  /** Index of the first non-silent sample (past the recorder's own cold start). */
  mark?: () => number
}

// Records what a track actually carries, using a tiny AudioWorklet (a live
// graph's output can't be pulled back through OfflineAudioContext). A gain of 0
// drains the node to the destination so the worklet keeps running, silently.
//
// The RECORDER itself has a cold start too: its MediaStreamAudioSourceNode can
// emit a few silent quanta when first pulled. `flowing()` waits past that, so a
// test that measures the SYSTEM's continuity never mistakes the probe for a
// hole. The recorder also has a short teardown at the end; tests only look at
// samples before they stop it.
const RECORDER_SRC = `
class Recorder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      const copy = new Float32Array(ch.length)
      copy.set(ch)
      this.port.postMessage(copy, [copy.buffer])
    }
    return true
  }
}
registerProcessor('longpipe-test-recorder', Recorder)
`
// Each AudioContext has its own AudioWorkletGlobalScope, so addModule must run
// per context; the Blob URL itself is shared.
let recorderUrl: Promise<string> | null = null
function recorderModuleUrl(): Promise<string> {
  recorderUrl ??= Promise.resolve(
    URL.createObjectURL(new Blob([RECORDER_SRC], { type: 'application/javascript' })),
  )
  return recorderUrl
}

/** Record `track` in a fresh AudioContext at `rate` for the lifetime of the
 *  returned recorder. Resolves once the worklet is live (audio flowing). */
export async function recordTrack(track: MediaStreamTrack, rate = 48000): Promise<Recorder> {
  const ctx = new AudioContext({ sampleRate: rate })
  await ctx.resume()
  await ctx.audioWorklet.addModule(await recorderModuleUrl())
  const src = ctx.createMediaStreamSource(new MediaStream([track]))
  const node = new AudioWorkletNode(ctx, 'longpipe-test-recorder', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  })
  const chunks: Float32Array[] = []
  let total = 0
  node.port.onmessage = (e: MessageEvent<Float32Array>) => { chunks.push(e.data); total += e.data.length }
  const sink = ctx.createGain()
  sink.gain.value = 0
  src.connect(node)
  node.connect(sink).connect(ctx.destination)

  // First non-silent sample (see the cold-start note above).
  const firstSignal = (): number => {
    let seen = 0
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++, seen++) if (c[i] !== 0) return seen
    }
    return -1
  }
  const peakFrom = (from: number) => {
    let p = 0
    let seen = 0
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++, seen++) {
        if (seen < from) continue
        const v = Math.abs(c[i])
        if (v > p) p = v
      }
    }
    return p
  }
  const freqFrom = (from: number) => {
    const flat: number[] = []
    let seen = 0
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++, seen++) if (seen >= from) flat.push(c[i])
    }
    if (flat.length < 64) return 0
    let crossings = 0
    let first = -1, last = -1
    for (let i = 1; i < flat.length; i++) {
      if (flat[i - 1] <= 0 && flat[i] > 0) {
        if (first < 0) first = i
        last = i
        crossings++
      }
    }
    if (crossings < 2) return 0
    return ((crossings - 1) * ctx.sampleRate) / (last - first)
  }

  const rec: Recorder = {
    samples: chunks,
    count: () => total,
    peak: peakFrom,
    freq: freqFrom,
    stop() {
      try { node.port.onmessage = null; node.disconnect(); src.disconnect() } catch { /* gone */ }
      void ctx.close().catch(() => {})
    },
  }
  // Audio flowing: wait until the recorder has carried real samples for a few
  // quanta, past its own cold start.
  const deadline = performance.now() + 2000
  while (performance.now() < deadline) {
    const at = firstSignal()
    if (at >= 0 && total - at >= 3 * 128) break
    await sleep(20)
  }
  rec.mark = () => firstSignal()
  return rec
}

/** Peak amplitude in the last `ms` of a recorder (fresh samples only). */
export async function recentPeak(rec: Recorder, ms = 200): Promise<number> {
  const start = rec.count()
  await sleep(ms)
  return rec.peak(start)
}

/** Lowest per-block RMS (block = `block` samples) in the last `ms`. Unlike a
 *  peak over the window, this sees a short silent hole inside it. */
export async function recentMinBlockRms(rec: Recorder, ms = 200, block = 128): Promise<number> {
  const start = rec.count()
  await sleep(ms)
  let min = Infinity
  let n = 0
  let sum = 0
  let seen = 0
  for (const c of rec.samples) {
    for (let i = 0; i < c.length; i++, seen++) {
      if (seen < start) continue
      const v = c[i]
      sum += v * v
      if (++n === block) {
        min = Math.min(min, Math.sqrt(sum / n))
        n = 0
        sum = 0
      }
    }
  }
  return Number.isFinite(min) ? min : 0
}

/** Frequency of the tone in the last `ms` of a recorder. */
export async function recentFreq(rec: Recorder, ms = 200): Promise<number> {
  const start = rec.count()
  await sleep(ms)
  return rec.freq(start)
}

/**
 * Tap a node's output INSIDE its own AudioContext and record it block by block.
 * Recording a track from a second AudioContext (recordTrack) crosses the
 * media pipeline, which can itself drop a few quanta under load; this measures
 * the node's real output, so "the switch has no silent block" is exact.
 *
 * Returns a recorder whose `minimumBlockRms(fromSample, toSample)` is over
 * samples strictly produced by the node.
 */
export async function probeNode(ctx: AudioContext, node: AudioNode): Promise<Recorder & {
  minimumBlockRms(fromSample: number, toSample: number, block?: number): number
  /** Longest run of consecutive silent blocks in [from, to) (in blocks). */
  longestSilentRun(fromSample: number, toSample: number, block?: number, threshold?: number): number
}> {
  await ctx.audioWorklet.addModule(await recorderModuleUrl())
  const pn = new AudioWorkletNode(ctx, 'longpipe-test-recorder', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  })
  const chunks: Float32Array[] = []
  let total = 0
  pn.port.onmessage = (e: MessageEvent<Float32Array>) => { chunks.push(e.data); total += e.data.length }
  const sink = ctx.createGain()
  sink.gain.value = 0
  node.connect(pn)
  pn.connect(sink).connect(ctx.destination)

  const base = (from: number) => {
    const flat: number[] = []
    let seen = 0
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++, seen++) if (seen >= from) flat.push(c[i])
    }
    return flat
  }
  const rec: Recorder & {
    minimumBlockRms: (a: number, b: number, n?: number) => number
    longestSilentRun: (a: number, b: number, n?: number, threshold?: number) => number
  } = {
    samples: chunks,
    count: () => total,
    peak(from = 0) { let p = 0; for (const v of base(from)) p = Math.max(p, Math.abs(v)); return p },
    freq(from = 0) {
      const flat = base(from)
      if (flat.length < 64) return 0
      let crossings = 0, first = -1, last = -1
      for (let i = 1; i < flat.length; i++) {
        if (flat[i - 1] <= 0 && flat[i] > 0) { if (first < 0) first = i; last = i; crossings++ }
      }
      return crossings < 2 ? 0 : ((crossings - 1) * ctx.sampleRate) / (last - first)
    },
    minimumBlockRms(fromSample, toSample, block = 128) {
      const flat = base(fromSample)
      const span = Math.min(flat.length, toSample - fromSample)
      let min = Infinity
      for (let s = 0; s + block <= span; s += block) {
        let n = 0
        for (let i = 0; i < block; i++) n += flat[s + i] * flat[s + i]
        min = Math.min(min, Math.sqrt(n / block))
      }
      return Number.isFinite(min) ? min : 0
    },
    longestSilentRun(fromSample, toSample, block = 128, threshold = 0.05) {
      const flat = base(fromSample)
      const span = Math.min(flat.length, toSample - fromSample)
      let longest = 0, cur = 0
      for (let s = 0; s + block <= span; s += block) {
        let n = 0
        for (let i = 0; i < block; i++) n += flat[s + i] * flat[s + i]
        if (Math.sqrt(n / block) < threshold) { cur++; longest = Math.max(longest, cur) } else cur = 0
      }
      return longest
    },
    stop() {
      try { pn.port.onmessage = null; pn.disconnect(); node.disconnect(pn) } catch { /* gone */ }
    },
  }
  const deadline = performance.now() + 2000
  while (total === 0 && performance.now() < deadline) await sleep(20)
  return rec
}
