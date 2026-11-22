// Denoise AudioWorkletProcessor — runs on the audio render thread.
//
// The bare wasm Module is compiled on the main thread and handed in via
// processorOptions; we instantiate it here (the worklet scope has no fetch /
// no ESM). process() delivers 128-sample render quanta but the kernels work on
// 480-sample (10 ms @ 48 kHz) hops, so an input accumulator + a primed output
// ring decouple the two.
//
// When the AudioContext can't run at 48 kHz, two stateful rubato resamplers
// (exposed by the DFN wasm) bridge device-rate ⇄ 48 kHz around the net. They
// engage only when sampleRate ≠ 48000 and the kernel exposes them (DFN does;
// rnnoise doesn't — at non-48k on rnnoise we fall back to dry passthrough and
// say why, rather than running the net on samples at the wrong rate).
//
// The input source can be replaced while the graph stays up (mic switch, a
// device that resamples itself): the main thread sends `reset`, which drops the
// buffered input/output samples and rebuilds the resampler state, so nothing
// from the old source or rate is mixed into the new one.
//
// Bundled to a self-contained ESM by the inline-worklet tsup plugin and loaded
// via Blob URL + audioWorklet.addModule (see ../worklet_inline.ts).

import { KERNELS, HOP, SAMPLE_RATE, type KernelSpec } from '~/audio/kernels.ts'
import type { ProcessorInit, ToWorklet, FromWorklet, AudioStats } from '~/audio/messages.ts'

declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(
  name: string,
  ctor: new (options: { processorOptions: ProcessorInit }) => AudioWorkletProcessor,
): void

type Fn = (...a: number[]) => number
type WasmExports = Record<string, Fn> & { memory: WebAssembly.Memory }
const RS_CAP = 4096   // resampler output-burst scratch capacity (frames)

class DenoiseProcessor extends AudioWorkletProcessor {
  private cfg: KernelSpec
  private mem!: WebAssembly.Memory
  private run!: (st: number, inPtr: number, outPtr: number) => number
  private state = 0
  private inPtr = 0
  private outPtr = 0
  private setBeta: Fn | null = null
  private setGruLeak: Fn | null = null

  // Resampling (engaged only when sampleRate ≠ 48000 and the wasm supports it).
  private resample = false
  // Non-48k context and this kernel has no resampler: run as dry passthrough
  // (original audio, never samples at the wrong rate) and tell the main thread.
  private unsupportedRate = false
  private rsPush: ((rs: number, inPtr: number, n: number, outPtr: number, cap: number) => number) | null = null
  private rsCreate: ((from: number, to: number) => number) | null = null
  private inRs = 0
  private outRs = 0
  private rsDevInPtr = 0   // device-rate input scratch (one quantum)
  private rsOutPtr = 0     // resampler output-burst scratch (RS_CAP)
  // JS copy of a resampled input burst: feed48k runs hops, which may grow wasm
  // memory and detach any view into it mid-loop.
  private rsIn = new Float32Array(RS_CAP)

  private enabled: boolean
  private model: ProcessorInit['model']
  private debug: boolean
  private warnedNonFinite = false

  // 128 ⇄ 480 buffering (at 48 kHz). outRing is at the OUTPUT (device) rate.
  private inAcc = new Float32Array(HOP)
  private inFill = 0
  private outRing = new Float32Array(4096)
  private outRead = 0
  private outWrite = 0
  private outCount = 0
  private primed = false
  // Set by reset: until the ring re-primes, process() passes the input through
  // dry so an input swap has no silent hole (and never plays old samples).
  private repriming = false

  private now: (() => number) | null
  private times = new Float32Array(256)
  private tIdx = 0
  private hops = 0
  private _f32: Float32Array | null = null

  constructor(options: { processorOptions: ProcessorInit }) {
    super()
    const init = options.processorOptions
    this.model = init.model
    this.enabled = init.enabled
    this.debug = !!init.debug
    this.cfg = KERNELS[init.model]

    try {
      const ex = this.instantiate(init.wasmBytes)
      const pick = (name?: string) => (name ? ex[name] : undefined)
      this.mem = ex.memory
      // WASI reactors (rnnoise, emscripten) must run their ctors once before any
      // other export; wasm-bindgen builds (DFN) have no _initialize.
      ex['_initialize']?.()
      const malloc = ex[this.cfg.exports.malloc]
      this.run = ex[this.cfg.exports.process] as typeof this.run
      this.inPtr = malloc(HOP * 4)
      this.outPtr = malloc(HOP * 4)

      if (init.weights) this.state = ex[this.cfg.exports.create](this.upload(malloc, init.weights), init.weights.byteLength)
      else this.state = ex[this.cfg.exports.create]()

      this.setBeta = (pick(this.cfg.exports.setBeta) ?? null) as Fn | null
      this.setGruLeak = (pick(this.cfg.exports.setGruLeak) ?? null) as Fn | null
      if (this.setBeta && (init.postFilterBeta ?? 0) > 0) this.setBeta(this.state, init.postFilterBeta!)
      if (this.setGruLeak && (init.gruLeak ?? 1) < 1) this.setGruLeak(this.state, init.gruLeak!)

      // Non-48k → wire the resamplers if this wasm provides them.
      if (sampleRate !== SAMPLE_RATE) {
        this.rsCreate = (ex['df_resampler_create'] as typeof this.rsCreate) ?? null
        this.rsPush = (ex['df_resampler_push'] as typeof this.rsPush) ?? null
        if (this.rsCreate && this.rsPush) {
          this.rsDevInPtr = malloc(256 * 4)
          this.rsOutPtr = malloc(RS_CAP * 4)
          this.setUpResamplers()
        } else {
          // No resampler in this kernel: dry passthrough (original audio at the
          // device rate) beats running the net on wrong-rate samples. The main
          // thread turns this into onError + a passthrough graph.
          this.unsupportedRate = true
          this.post({ type: 'error', message: `${init.model} can't resample ${sampleRate}→48000 Hz; passing the original audio through (needs a 48 kHz AudioContext)` })
        }
      }
    } catch (err) {
      const e = err as Error
      this.state = 0
      this.post({ type: 'error', fatal: true, message: `denoise init failed: ${e.message ?? String(err)}${e.stack ? '\n' + e.stack : ''}` })
    }

    this.now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : null

    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      const d = e.data
      if (d.type === 'enabled') this.enabled = d.value
      else if (d.type === 'reset') this.reset()
      else if (d.type === 'config') {
        if (this.setBeta && d.postFilterBeta != null) this.setBeta(this.state, d.postFilterBeta)
        if (this.setGruLeak && d.gruLeak != null) this.setGruLeak(this.state, d.gruLeak)
      }
    }
    this.post({ type: 'ready', resample: this.resample })
    // Report early, so callers see the resolved model/rate without waiting ~0.5 s
    // for the first periodic report (the hop timings are null until then).
    if (this.state !== 0) this.reportStats()
  }

  private instantiate(bytes: ArrayBuffer): WasmExports {
    const module = new WebAssembly.Module(bytes)   // sync compile — fine off the main thread
    const imports: Record<string, Record<string, unknown>> = {}
    for (const im of WebAssembly.Module.imports(module)) {
      ;(imports[im.module] ??= {})
      if (im.kind === 'function') imports[im.module][im.name] = () => 0
      else if (im.kind === 'memory') imports[im.module][im.name] = new WebAssembly.Memory({ initial: 256 })
      else if (im.kind === 'table') imports[im.module][im.name] = new WebAssembly.Table({ initial: 0, element: 'anyfunc' })
      else if (im.kind === 'global') imports[im.module][im.name] = new WebAssembly.Global({ value: 'i32', mutable: false }, 0)
    }
    return new WebAssembly.Instance(module, imports as WebAssembly.Imports).exports as WasmExports
  }

  private upload(malloc: (n: number) => number, buf: ArrayBuffer): number {
    const u8 = new Uint8Array(buf)
    const ptr = malloc(u8.length)
    new Uint8Array(this.mem.buffer).set(u8, ptr)
    return ptr
  }

  private heap(): Float32Array {
    if (!this._f32 || this._f32.buffer !== this.mem.buffer) this._f32 = new Float32Array(this.mem.buffer)
    return this._f32
  }

  private post(msg: FromWorklet): void { this.port.postMessage(msg) }

  // Bind fresh resampler state for the current device rate. Called at init and
  // again on `reset` (a new input may arrive at a different rate); the old
  // resampler state is what keeps a partial input burst and its filter history,
  // so it must not survive an input swap.
  private setUpResamplers(): void {
    if (!this.rsCreate) return
    this.inRs = this.rsCreate(sampleRate, SAMPLE_RATE)      // device → 48k
    this.outRs = this.rsCreate(SAMPLE_RATE, sampleRate)     // 48k → device
    this.resample = true
  }

  // The input source was replaced: drop everything buffered from the old
  // source and rebuild the resampler state, so no sample from the old input
  // (or its old rate) is mixed into the new one. The output ring restarts
  // 'unprimed', so the next hop is primed from the new input only.
  private reset(): void {
    this.inFill = 0
    this.outRead = 0
    this.outWrite = 0
    this.outCount = 0
    this.primed = false
    this.repriming = true
    if (this.resample) this.setUpResamplers()
  }

  // Last line of defence: a non-finite sample must never reach the output (one
  // NaN poisons every downstream node and the encoder). Replaced by silence.
  private pushOut(v: number): void {
    if (v - v !== 0) {   // NaN or ±Inf (cheaper than Number.isFinite)
      if (this.debug && !this.warnedNonFinite) {
        this.warnedNonFinite = true
        console.warn(`[longpipe/denoise] ${this.model} produced a non-finite sample; replacing with 0 (logged once)`)
      }
      v = 0
    }
    this.outRing[this.outWrite] = v
    this.outWrite = (this.outWrite + 1) % this.outRing.length
    this.outCount++
  }

  // Accumulate 48 kHz samples; run a hop each time 480 fill.
  private feed48k(s: ArrayLike<number>, n: number): void {
    for (let i = 0; i < n; i++) {
      // A non-finite input sample would poison the recurrent state for good.
      const v = s[i]
      this.inAcc[this.inFill++] = v - v === 0 ? v : 0
      if (this.inFill === HOP) { this.runHop(); this.inFill = 0 }
    }
  }

  private runHop(): void {
    let f32 = this.heap()
    const inBase = this.inPtr >> 2
    for (let i = 0; i < HOP; i++) f32[inBase + i] = this.inAcc[i] * this.cfg.scaleIn

    const t0 = this.now ? this.now() : 0
    this.run(this.state, this.inPtr, this.outPtr)
    if (this.now) this.times[this.tIdx = (this.tIdx + 1) & 255] = this.now() - t0
    // The kernel may grow wasm memory (DFN does on its first hop: lazy scratch
    // buffers), which detaches the old ArrayBuffer. Reading through a stale view
    // yields undefined → NaN, so re-take the view after every call into wasm.
    f32 = this.heap()

    if (this.resample && this.rsPush) {
      // outPtr holds the 48 kHz net output (DFN scaleOut === 1) — resample it to
      // device rate and ring the result. df_resampler_push may grow memory.
      const got = this.rsPush(this.outRs, this.outPtr, HOP, this.rsOutPtr, RS_CAP)
      f32 = this.heap()   // may have grown again
      const ob = this.rsOutPtr >> 2
      for (let i = 0; i < got; i++) this.pushOut(f32[ob + i])
    } else {
      const ob = this.outPtr >> 2
      for (let i = 0; i < HOP; i++) this.pushOut(f32[ob + i] * this.cfg.scaleOut)
    }
    if (++this.hops >= 50) { this.reportStats(); this.hops = 0 }
  }

  private reportStats(): void {
    const v = Array.from(this.times).filter((x) => x > 0).sort((a, b) => a - b)
    const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null)
    const stats: AudioStats = {
      model: this.model,
      p50Ms: this.now ? q(0.5) : null,
      p95Ms: this.now ? q(0.95) : null,
      latencyMs: (this.outCount / sampleRate) * 1000,
      active: this.enabled && this.state !== 0,
      sampleRate,
    }
    this.post({ type: 'stats', stats })
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const inCh = inputs[0]?.[0]
    const outCh = outputs[0]?.[0]
    if (!outCh) return true
    const n = outCh.length

    if (!inCh || !this.enabled || this.state === 0 || this.unsupportedRate) {
      // Dry passthrough when bypassed, when the kernel failed to start
      // (state 0), or when the context rate can't be bridged: fail open with
      // the original audio, never silence and never wrong-rate samples.
      if (inCh) outCh.set(inCh)
      else outCh.fill(0)
      return true
    }

    // Feed the 480-hop accumulator with 48 kHz samples — resampled from the
    // device rate when needed, else the input directly.
    if (this.resample && this.rsPush) {
      let f32 = this.heap()
      const ib = this.rsDevInPtr >> 2
      for (let i = 0; i < n; i++) f32[ib + i] = inCh[i]
      const got = this.rsPush(this.inRs, this.rsDevInPtr, n, this.rsOutPtr, RS_CAP)
      f32 = this.heap()
      this.rsIn.set(f32.subarray(this.rsOutPtr >> 2, (this.rsOutPtr >> 2) + got))
      this.feed48k(this.rsIn, got)
    } else {
      this.feed48k(inCh, n)
    }

    // Prime enough hops to absorb the mismatch between hop rate and quantum
    // rate. A hop is produced every 480 input samples but the ring is drained
    // 128 at a time, so their phases drift: at a quantum boundary the ring can
    // hold as little as (hops × HOP) mod 128 of the headroom it had. Two hops
    // leave ≥ 2·HOP − 128 = 832 samples of slack — several quanta — so draining
    // never underruns (the old "one hop" primed at exactly 480 and underran 32–96
    // samples every few quanta, which is what produced the audible dropouts).
    const PRIME_TARGET = 2 * HOP
    if (!this.primed) {
      if (this.outCount >= PRIME_TARGET) {
        this.primed = true
        this.repriming = false
      } else if (!this.repriming) {
        // First start: stay silent until the ring has enough hops (nothing has
        // been played yet, so there is nothing to pass through).
        outCh.fill(0)
        return true
      }
      // A re-prime after a reset falls through to the dry passthrough below, so
      // the input swap has no silent hole.
    }
    if (!this.primed) {
      outCh.set(inCh)
      return true
    }
    if (this.outCount >= n) {
      for (let i = 0; i < n; i++) {
        outCh[i] = this.outRing[this.outRead]
        this.outRead = (this.outRead + 1) % this.outRing.length
        this.outCount--
      }
    } else {
      // Underrun: the resampler can deliver fewer output samples than a quantum
      // (a device↔48 kHz ratio leaves a partial quantum), and a paused/loaded
      // render thread can starve the ring. Filling silence here was the audible
      // dropout — pass the current input through for the remaining samples
      // instead (never silence, never stale samples). Debug builds report it, so
      // a too-small priming headroom shows up as telemetry, not as a mystery.
      const have = this.outCount
      for (let i = 0; i < have; i++) {
        outCh[i] = this.outRing[this.outRead]
        this.outRead = (this.outRead + 1) % this.outRing.length
      }
      this.outCount = 0
      outCh.set(inCh.subarray(0, n - have), have)
      if (this.debug) this.post({ type: 'underrun', missing: n - have })
    }
    return true
  }
}

registerProcessor('denoise', DenoiseProcessor)
