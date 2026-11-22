// AudioDenoiser — main-thread controller for the denoise subsystem. Owns the
// AudioContext graph (source → [worklet] → destination) and the worklet
// lifecycle. Independent of the video Worker; the only shared surface is the
// output MediaStream (its destination track).
//
// Lifecycle mirrors the video "passthrough until ready" pattern: the output
// track is live immediately as passthrough; the denoise worklet is spliced in
// once its wasm + weights have loaded.
//
// Fail open: whatever goes wrong (asset fetch, module load, wasm compile or
// instantiate inside the worklet, an exception in process()), the graph goes
// back to source → destination, so the output carries the ORIGINAL audio —
// never silence — and onError says why.
//
// A context that isn't running (autoplay policy, iOS interruption) passes no
// audio at all, so then the output track switches to a clone of the mic track
// (original audio), and back to the context's track once it runs. That is the
// one case where `outputTrack` changes; onOutputTrackChanged says so.
//
// Input replacement (setInputTrack): a call can move to a different mic
// mid-way (device switch, unplug/replug, or the system changing the device's
// sample rate). The source node is rebuilt and wired to whatever is currently
// in the signal path (the worklet, or the passthrough edge), the old source is
// disconnected and the old track's listeners unbound, and the worklet drops
// every sample it buffered from the old input (including its resampler state)
// so the output is the NEW mic only — never a double-mixed or stale stream.
// While it re-primes, the worklet passes the new input through dry, so the
// switch has no silent hole. The new track's `ended` ends the output.

import {
  KERNELS, SAMPLE_RATE, resolveModel,
  type DenoiseModel, type DenoiseModelOption,
} from './kernels'
import { fetchKernel, simdSupported, type KernelAssets } from './fetch_assets'
import { selectTier } from './probe'
import type { ProcessorInit, FromWorklet, AudioStats } from './messages'
import { WORKLET_SOURCE } from './worklet_inline'
import { DEFAULT_WEIGHTS_BASE_URL } from '~/weights_url.ts'
import { isDebug } from '~/pipeline/debug.ts'

export interface AudioDenoiserOptions {
  model?:          DenoiseModelOption   // 'auto' (default) | tier | explicit model
  weightsBaseUrl?: string               // default: the public CDN (DEFAULT_WEIGHTS_BASE_URL)
  postFilterBeta?: number               // default 0.03 (DFN)
  gruLeak?:        number               // default 0.9995 (DFN): decays GRU state per hop; 1 = off, lower = more suppression, less speech quality
  enabled?:        boolean              // default true
  debug?:          boolean              // default: the Pipeline's `debug` flag
  onReady?:        () => void
  onError?:        (message: string) => void
  // The AudioContext is suspended (autoplay policy) and couldn't be resumed
  // without a user gesture. The output is the original mic audio (see
  // onOutputTrackChanged) until resume() or the next gesture (the denoiser
  // listens for one and resumes by itself).
  onSuspended?:    () => void
  // `outputTrack` was replaced: `denoised` false = the output carries the
  // original mic audio, on a clone of the mic track (the context isn't running,
  // or the audio graph is being rebuilt for a new input). true = the output is
  // back on the denoiser's (context) track. Put the new track on your sender
  // (RTCRtpSender.replaceTrack).
  onOutputTrackChanged?: (track: MediaStreamTrack, previous: MediaStreamTrack, denoised: boolean) => void
}

const DEFAULT_BETA = 0.03
// 0.995 cost up to 0.7 PESQ on noisy speech. 0.9995 is within ~0.1 of no leak on a
// fresh 20 s clip and ~0.1 better than no leak over a 14-min stream; no drift either way.
const DEFAULT_GRU_LEAK = 0.9995
const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const
// How long to wait for a replacement source to start carrying a signal before
// crossfading it in anyway (a cold MediaStreamAudioSourceNode starts with a few
// ms of silence). A silent mic never trips this — the timeout is the cap.
const PRIME_TIMEOUT_MS = 250
const PRIME_POLL_MS = 10
// Equal-gain crossfade between the old and new source (long enough to bridge a
// cold new source's first quantum, short enough to be inaudible).
const CROSSFADE_MS = 20
const CROSSFADE_S = CROSSFADE_MS / 1000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
// How long the context may stay not-running before the output falls back to
// the original audio (a context created while allowed starts within a few ms).
const SUSPEND_GRACE_MS = 250
// An unlocked context nobody adopts is closed after this long.
const UNLOCK_TTL_MS = 60_000

// A context created (and resumed) inside a user gesture by unlock(), waiting
// for the next AudioDenoiser to adopt it.
let unlocked: { ctx: AudioContext; timer: ReturnType<typeof setTimeout> } | null = null

export class AudioDenoiser {
  // Create (or resume) the AudioContext the next AudioDenoiser will use, NOW.
  // Call it synchronously in the click handler that starts your call, before
  // any await (getUserMedia, fetches): browsers only let an AudioContext start
  // during a user gesture, and the gesture has expired by the time the stream
  // arrives. Safe to call repeatedly or without a gesture (it does nothing
  // useful then). Unused, the context is closed after a minute.
  static unlock(): void {
    if (typeof AudioContext === 'undefined') return
    if (unlocked && unlocked.ctx.state !== 'closed') { void unlocked.ctx.resume().catch(() => {}); return }
    let ctx: AudioContext
    try { ctx = new AudioContext({ sampleRate: SAMPLE_RATE }) } catch {
      try { ctx = new AudioContext() } catch { return }
    }
    void ctx.resume().catch(() => {})
    const entry = {
      ctx,
      timer: setTimeout(() => { if (unlocked === entry) { unlocked = null; void ctx.close().catch(() => {}) } }, UNLOCK_TTL_MS),
    }
    unlocked = entry
  }

  // Resolves true once the denoise worklet is spliced in; false if init failed
  // (or the denoiser was destroyed first) and the graph stayed in passthrough.
  // Never rejects — audio keeps flowing either way; onError carries the reason.
  readonly ready: Promise<boolean>

  private ctx: AudioContext
  private dest: MediaStreamAudioDestinationNode
  private destTrack: MediaStreamTrack
  private micTrack: MediaStreamTrack
  private inputRate: number | null
  // A clone of the input used as the output while the context isn't running
  // (or while a rebuilt graph primes).
  private rawTrack: MediaStreamTrack | null = null
  // The output: destTrack (denoised / passthrough) or rawTrack (original audio).
  private current: MediaStreamTrack
  private suspendTimer: ReturnType<typeof setTimeout> | null = null
  private removeStateListener: (() => void) | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  // The gain the source feeds (always 1 for the live source). It exists so a
  // replacement source can be primed at 0 gain and then crossfaded in without
  // gating the path itself (see setInputTrack).
  private sourceTap: GainNode | null = null
  private model: DenoiseModel | null = null
  private assets: KernelAssets | null = null
  // Whether the resolved kernel ships the DFN resamplers. A non-48k context
  // can't denoise with a kernel that lacks them (see startWorklet).
  private kernelResamples = true
  private latestStats: AudioStats | null = null
  private destroyed = false
  private bypassed = false
  private removeGestureListeners: (() => void) | null = null
  private removeEndedListener: (() => void) | null = null
  // Worklet module load is per-context: a graph rebuild starts over.
  private workletCtx: AudioContext | null = null
  private workletStarting: Promise<void> | null = null
  // The graph can't exist at all (no AudioContext could be built after an input
  // change). The output is the original audio clone from then on.
  private graphLost = false
  // Serializes setInputTrack (see there).
  private inputSwitch: Promise<void> = Promise.resolve()
  // Count of output-ring underruns the processor has reported (debug builds).
  // Each one was bridged with the input directly, so it's a glitch-free but
  // denoise-bypassed quantum — watch it if the priming headroom is tuned.
  private underruns = 0

  // Throws only if no AudioContext graph can be built at all (the caller then
  // passes the original track through).
  constructor(inputTrack: MediaStreamTrack, private opts: AudioDenoiserOptions = {}) {
    // Request 48 kHz; the browser resamples the mic into the context rate for
    // free when it honors this. If it doesn't, the worklet engages its own
    // resamplers (see worklet/processor.ts). Some engines (historically
    // Firefox) refuse to connect a mic whose rate differs from the context's:
    // retry with the device's default rate before giving up.
    // A context unlock() created inside a gesture is adopted if it got to run;
    // otherwise build one here (the constructor may itself run in a gesture).
    let built = adoptUnlocked(inputTrack)
    if (!built.ok) built = buildGraph(inputTrack, SAMPLE_RATE)
    if (!built.ok) built = buildGraph(inputTrack, undefined)
    if (!built.ok) throw built.error
    this.ctx = built.ctx
    this.source = built.source
    this.micTrack = inputTrack
    this.inputRate = trackSampleRate(inputTrack)
    this.dest = this.ctx.createMediaStreamDestination()
    this.destTrack = this.dest.stream.getAudioTracks()[0]
    this.current = this.destTrack

    // Passthrough immediately; denoise splices in when ready.
    this.sourceTap = this.ctx.createGain()
    this.source.connect(this.sourceTap)
    this.sourceTap.connect(this.dest)

    // Autoplay policy can start the context suspended (Safari, Firefox or
    // Chrome without a recent user gesture) — and a suspended context passes NO
    // audio, not even passthrough. Try to resume now (synchronously: this keeps
    // a gesture the constructor runs in); if the browser refuses, the output
    // falls back to the original mic audio, resumes on the next user gesture,
    // and the caller is told.
    void this.resume().catch(() => { /* handled by the state watcher */ })
    this.bindContextState()
    this.onStateChange()

    // Mic ended (unplugged / stopped) → end our output too.
    this.bindInputEnded()

    this.ready = this.init().then(() => this.node !== null && !this.bypassed, (err) => {
      this.opts.onError?.(`audio denoise init failed: ${errorText(err)}; passing the original audio through`)
      // Leave passthrough running — audio still flows, just not denoised.
      return false
    })
  }

  // The current output track: the context's (denoised, or passthrough while
  // the worklet loads / after a failure), or the original mic audio while the
  // context isn't running.
  get outputTrack(): MediaStreamTrack { return this.current }

  // The current input (mic) track. Follows setInputTrack().
  get inputTrack(): MediaStreamTrack { return this.micTrack }

  // Resolved AudioContext sample rate. getStats().sampleRate matches it once
  // the (current graph's) worklet has reported.
  get sampleRate(): number { return this.ctx.sampleRate }

  // The input track's own rate (getSettings), before the browser resamples it
  // into the context. null when the track doesn't report one.
  get inputSampleRate(): number | null { return this.inputRate }

  // True when the original audio is being passed through because denoise
  // failed or can't run (not because setEnabled(false) asked for it).
  get isBypassed(): boolean { return this.bypassed }

  // ── Input replacement ─────────────────────────────────────────────────────

  // Replace the mic track feeding the denoiser. Rebuilds the source node, wires
  // it to whatever is currently in the signal path (the worklet or the
  // passthrough edge), unbinds the old track's listeners, and tells the
  // worklet to drop every buffered sample and its resampler state, so no audio
  // from the old input (or its old rate) is mixed into the new one.
  //
  // A sample-rate change is handled here too: when the kernel can resample, its
  // resampler state is rebuilt from scratch; when it can't (a non-48k context
  // with a kernel lacking the DFN resamplers) the chain stays in passthrough
  // and onError says why — never a throw, never the old track's audio.
  //
  // Resolves once the new input is live. Never rejects: failures fail open to
  // the original audio (onError carries the reason).
  setInputTrack(track: MediaStreamTrack): Promise<void> {
    // Serialize: a switch awaits a priming window, and two interleaved switches
    // would otherwise crossfade from a tap that is no longer the live one.
    const run = this.inputSwitch.then(() => this.doSetInputTrack(track))
    this.inputSwitch = run.catch(() => {})
    return run
  }

  private async doSetInputTrack(track: MediaStreamTrack): Promise<void> {
    if (this.destroyed) return
    if (track === this.micTrack) {
      if (track.readyState === 'ended') this.endOutput()
      return
    }
    const oldSource = this.source
    const oldRaw = this.rawTrack
    this.micTrack = track
    this.inputRate = trackSampleRate(track)
    // Old track's listeners go first: a late `ended` must not kill the output.
    this.removeEndedListener?.()
    this.removeEndedListener = null
    this.bindInputEnded()

    // Build the new source before touching the graph. It throws for a mic whose
    // rate the current context refuses (Firefox devices); then the whole graph
    // moves to a context at the new rate.
    let source: MediaStreamAudioSourceNode
    try {
      source = this.ctx.createMediaStreamSource(new MediaStream([track]))
    } catch (err) {
      if (oldSource) { try { oldSource.disconnect() } catch { /* not connected */ } this.source = null }
      await this.rebuildGraph(track, err)
      return
    }

    // A freshly created MediaStreamAudioSourceNode is cold: its first render
    // quanta are silent for a few ms (Chromium starts the capture pipeline
    // lazily). Connecting it straight into the path — even in the same task as
    // disconnecting the old one — leaves a short silent hole. So the new source
    // is wired through a 0-gain priming tap while the old one keeps playing,
    // and the hand-over is a short equal-gain crossfade: at no point is the sum
    // silent, and at no point do both sources play at full level (no double
    // mix). The worklet's buffers are reset right after the swap, so no old
    // samples (or the old rate's resampler tail) survive into the new mic's
    // audio.
    const oldPath = this.sourceTap
    const tap = this.ctx.createGain()
    tap.gain.value = 0
    source.connect(tap)
    if (this.node && !this.bypassed) tap.connect(this.node)
    else tap.connect(this.dest)
    this.source = source
    this.sourceTap = tap

    // Warm the new source (it's wired to the priming tap; an analyser branch
    // through a 0-gain sink confirms it carries a signal). Cap the wait so a
    // silent mic (muted, or an idle device) never blocks the switch.
    await this.waitForLiveSignal(source)
    if (this.destroyed || this.graphLost) { try { source.disconnect(); tap.disconnect() } catch { /* gone */ } return }

    // Crossfade over a few ms: a short linear ramp from old to new keeps the
    // sum ≈ constant (equal-gain crossfade), so no quantum in between is silent
    // and at no point do both play at full level. The old path is disconnected
    // once the ramp is over.
    if (oldPath) {
      const now = this.ctx.currentTime
      try {
        tap.gain.setValueAtTime(0, now)
        tap.gain.linearRampToValueAtTime(1, now + CROSSFADE_S)
        oldPath.gain.setValueAtTime(1, now)
        oldPath.gain.linearRampToValueAtTime(0, now + CROSSFADE_S)
      } catch {
        // No automation on this node (or a stopped context): hard switch.
        tap.gain.value = 1
        oldPath.gain.value = 0
      }
      await sleep(CROSSFADE_MS)
      if (this.destroyed || this.graphLost) return
      try { oldPath.disconnect() } catch { /* not connected */ }
    } else {
      tap.gain.value = 1
    }
    if (oldSource) { try { oldSource.disconnect() } catch { /* not connected */ } }

    // Drop everything the previous input left inside the worklet (input
    // accumulator, output ring, resampler state). The processor keeps the new
    // input flowing straight through while it re-primes (no silent hole), so
    // nothing from the old mic or its rate continues into the new one.
    this.resetProcessor()

    // While the context isn't running the output is a clone of the mic: follow
    // the new mic so the call never carries the old one, and retire the old
    // clone.
    if (this.current !== this.destTrack) {
      const prevRaw = this.rawTrack
      this.rawTrack = track.clone()
      this.setOutput(this.rawTrack)
      if (prevRaw && prevRaw !== this.rawTrack && prevRaw.readyState === 'live') { try { prevRaw.stop() } catch { /* gone */ } }
    }
    if (oldRaw && oldRaw !== this.rawTrack && oldRaw !== this.current && oldRaw.readyState === 'live') {
      try { oldRaw.stop() } catch { /* gone */ }
    }

    // The context rate still needs bridging and the kernel can't: stay on the
    // original audio (a new mic can't make an impossible rate possible) and say
    // why.
    this.checkRateSupport()

    if (track.readyState === 'ended') this.endOutput()
  }

  // Wait until a priming source is delivering non-silent audio, or until
  // PRIME_TIMEOUT_MS (a silent mic, or a context that isn't rendering). A small
  // analyser branch (through a 0-gain sink, so it stays inaudible) reads the
  // source's own output — the priming tap is at gain 0 by design.
  private async waitForLiveSignal(source: AudioNode): Promise<void> {
    if (this.ctx.state !== 'running') { await sleep(PRIME_POLL_MS); return }
    let an: AnalyserNode, sink: GainNode
    try {
      an = this.ctx.createAnalyser()
      sink = this.ctx.createGain()
    } catch { await sleep(PRIME_POLL_MS); return }
    an.fftSize = 128
    sink.gain.value = 0
    try { source.connect(an); an.connect(sink); sink.connect(this.dest) } catch { /* unavailable */ return }
    const buf = new Float32Array(an.fftSize)
    const deadline = performance.now() + PRIME_TIMEOUT_MS
    try {
      while (performance.now() < deadline) {
        an.getFloatTimeDomainData(buf)
        if (buf.some((v) => v !== 0)) return
        await sleep(PRIME_POLL_MS)
      }
    } finally {
      try { source.disconnect(an); an.disconnect(); sink.disconnect() } catch { /* already gone */ }
    }
  }

  // A non-48k context needs the kernel's resamplers. Without them, passthrough
  // (the original audio) is the only correct option — say why once.
  private checkRateSupport(): void {
    if (this.destroyed || this.graphLost) return
    if (this.ctx.sampleRate === SAMPLE_RATE || this.kernelResamples) return
    if (this.bypassed) return
    this.bypass()
    this.opts.onError?.(
      `the audio context runs at ${this.ctx.sampleRate} Hz and the ${this.model ?? 'selected'} kernel ` +
      `can't resample ${this.ctx.sampleRate}→${SAMPLE_RATE} Hz; passing the original audio through`,
    )
  }

  // Context running → output on the context's track. Not running for
  // SUSPEND_GRACE_MS → original audio on a clone of the mic track, a
  // non-fatal onSuspended, and a resume on the next user gesture.
  private onStateChange(): void {
    if (this.destroyed || this.graphLost) return
    const state = this.ctx.state as string
    if (state === 'closed') return
    if (state === 'running') {
      if (this.suspendTimer) { clearTimeout(this.suspendTimer); this.suspendTimer = null }
      this.removeGestureListeners?.()
      this.maybeRestoreDest()
      return
    }
    if (this.suspendTimer) return
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null
      if (this.destroyed || this.graphLost) return
      if ((this.ctx.state as string) === 'running' || this.ctx.state === 'closed') return
      this.setOutput(this.originalTrack())
      this.opts.onSuspended?.()
      this.listenForGesture()
    }, SUSPEND_GRACE_MS)
  }

  // Back to the context's output track (it has audio once the context runs).
  private maybeRestoreDest(): void {
    if (this.destroyed || this.graphLost || this.ctx.state !== 'running') return
    this.setOutput(this.destTrack)
    if (this.rawTrack && this.rawTrack !== this.current && this.rawTrack.readyState === 'live') {
      try { this.rawTrack.stop() } catch { /* gone */ }
    }
    this.rawTrack = null
  }

  private originalTrack(): MediaStreamTrack {
    if (!this.rawTrack || this.rawTrack.readyState === 'ended') this.rawTrack = this.micTrack.clone()
    return this.rawTrack
  }

  private setOutput(track: MediaStreamTrack): void {
    if (track === this.current) return
    const previous = this.current
    this.current = track
    try { this.opts.onOutputTrackChanged?.(track, previous, track === this.destTrack) } catch (err) {
      console.error('[longpipe/audio] onOutputTrackChanged threw:', err)
    }
  }

  private listenForGesture(): void {
    if (typeof window === 'undefined' || this.removeGestureListeners) return
    const onGesture = () => { void this.ctx.resume().catch(() => {}) }
    for (const g of GESTURES) window.addEventListener(g, onGesture, { capture: true })
    this.removeGestureListeners = () => {
      for (const g of GESTURES) window.removeEventListener(g, onGesture, { capture: true })
      this.removeGestureListeners = null
    }
  }

  // ── Graph wiring ──────────────────────────────────────────────────────────

  private bindContextState(): void {
    this.removeStateListener?.()
    const onState = () => this.onStateChange()
    this.ctx.addEventListener('statechange', onState)
    this.removeStateListener = () => this.ctx.removeEventListener('statechange', onState)
  }

  private bindInputEnded(): void {
    this.removeEndedListener?.()
    const track = this.micTrack
    const onEnded = () => this.endOutput()
    track.addEventListener('ended', onEnded)
    this.removeEndedListener = () => track.removeEventListener('ended', onEnded)
  }

  // source → tap → (worklet if it's in the path, else destination).
  private routeSource(): void {
    const tap = this.sourceTap
    if (!tap) return
    try { tap.disconnect() } catch { /* not connected */ }
    if (this.node && !this.bypassed) tap.connect(this.node)
    else tap.connect(this.dest)
  }

  // Drop everything buffered from the previous input inside the processor
  // (input accumulator, output ring, resampler state); it re-primes with the
  // new input passed through dry, so the swap has no silent hole. Safe before
  // the node exists — a fresh node has no state to reset.
  private resetProcessor(): void {
    if (this.destroyed) return
    this.node?.port.postMessage({ type: 'reset' })
  }

  // ── Worklet ───────────────────────────────────────────────────────────────

  // Explicit model/tier choice (NOT 'auto') → resolve, with a SIMD fallback.
  private resolveExplicit(): DenoiseModel {
    const model = resolveModel(this.opts.model as Exclude<DenoiseModelOption, 'auto'>)
    if (KERNELS[model].needsSimd && !simdSupported()) {
      this.opts.onError?.(`${model} needs wasm SIMD; falling back to rnnoise`)
      return 'rnnoise'
    }
    return model
  }

  private async init(): Promise<void> {
    // 'auto' runs the weight-free tier probe; an explicit model/tier skips it.
    const baseUrl = this.opts.weightsBaseUrl ?? DEFAULT_WEIGHTS_BASE_URL
    const model = (this.opts.model ?? 'auto') === 'auto'
      ? await selectTier(baseUrl, this.opts.onError)
      : this.resolveExplicit()
    this.model = model

    const assets = await fetchKernel(model, baseUrl)
    this.assets = assets
    // Capability is a property of the kernel bytes: check it once, up front, so
    // an input/rate change can decide passthrough vs. re-splice synchronously.
    this.kernelResamples = kernelResamples(assets.wasmBytes)
    if (this.destroyed || this.graphLost) return
    await this.startWorklet()
  }

  // Load the worklet module (once per context), create the processor and splice
  // it into the graph. Concurrent calls for the same context share one start; a
  // graph rebuild supersedes them (the context check below).
  private startWorklet(): Promise<void> {
    if (this.destroyed || this.graphLost || !this.model || !this.assets || this.node || this.bypassed) {
      return Promise.resolve()
    }
    const ctx = this.ctx
    if (this.workletCtx === ctx && this.workletStarting) return this.workletStarting
    this.workletCtx = ctx
    const run = this.doStartWorklet(ctx).finally(() => {
      if (this.workletCtx === ctx && this.workletStarting === run) this.workletStarting = null
    })
    this.workletStarting = run
    return run
  }

  private async doStartWorklet(ctx: AudioContext): Promise<void> {
    if (!this.model || !this.assets) return
    if (!ctx.audioWorklet) throw new Error('AudioWorklet is not available in this context')
    await ctx.audioWorklet.addModule(workletUrl())
    if (this.destroyed || ctx !== this.ctx) return   // superseded by a rebuild

    // A kernel without the resamplers can't run on a non-48k context. Stay in
    // passthrough (the graph already is) and say why — never process samples at
    // the wrong rate.
    if (ctx.sampleRate !== SAMPLE_RATE && !this.kernelResamples) {
      this.bypass()
      this.opts.onError?.(
        `${this.model} can't resample ${ctx.sampleRate}→${SAMPLE_RATE} Hz; ` +
        'passing the original audio through (needs a 48 kHz AudioContext)',
      )
      return
    }

    const processorOptions: ProcessorInit = {
      model:          this.model,
      wasmBytes:      this.assets.wasmBytes,
      weights:        this.assets.weights,
      enabled:        this.opts.enabled ?? true,
      postFilterBeta: this.opts.postFilterBeta ?? DEFAULT_BETA,
      gruLeak:        this.opts.gruLeak ?? DEFAULT_GRU_LEAK,
      debug:          this.opts.debug ?? isDebug(),
    }
    const node = new AudioWorkletNode(ctx, 'denoise', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions,
    })
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
      if (node !== this.node) return   // stale node from a graph that was torn down
      const d = e.data
      if (d.type === 'stats') this.latestStats = d.stats
      else if (d.type === 'underrun') this.underruns++
      else if (d.type === 'error') {
        // fatal = the kernel can't run (wasm compile/instantiate failed, or the
        // context rate can't be bridged): drop the worklet from the graph so
        // nothing depends on it. The processor passes input through either way;
        // this removes it.
        if (d.fatal) this.bypass()
        this.opts.onError?.(d.fatal ? `${d.message}; passing the original audio through` : d.message)
      }
      else if (d.type === 'ready') {
        if (typeof d.resample === 'boolean') this.kernelResamples = d.resample
        this.opts.onReady?.()
      }
    }
    // An exception inside process() kills the processor: it outputs silence
    // from then on. Route around it.
    node.onprocessorerror = () => {
      if (node !== this.node) return
      this.bypass()
      this.opts.onError?.('audio denoise processor crashed; passing the original audio through')
    }
    node.connect(this.dest)
    if (this.destroyed || ctx !== this.ctx) { try { node.disconnect() } catch { /* gone */ } return }

    this.node = node
    this.routeSource()
  }

  // Back to plain source → destination (original audio).
  private bypass(): void {
    if (this.bypassed || this.destroyed) return
    this.bypassed = true
    const node = this.node
    this.node = null
    if (node) {
      node.port.onmessage = null
      node.onprocessorerror = null
      try { node.disconnect() } catch { /* not connected */ }
    }
    this.routeSource()
    this.maybeRestoreDest()
  }

  // ── Graph rebuild (input the current context refuses) ─────────────────────

  // The current context can't take the new source (a device whose rate it
  // refuses). Move the whole graph to a context that can, keeping audio flowing
  // on a clone of the new mic meanwhile.
  private async rebuildGraph(track: MediaStreamTrack, cause: unknown): Promise<void> {
    // Keep audio flowing: the new mic, unprocessed, until the new graph primes.
    const oldRaw = this.rawTrack
    const raw = track.clone()
    this.rawTrack = raw
    this.setOutput(raw)
    if (oldRaw && oldRaw !== raw && oldRaw.readyState === 'live') { try { oldRaw.stop() } catch { /* gone */ } }

    // Tear the old context down. Its destination track is no longer the output
    // (the clone is), so ending it doesn't gap the call.
    this.removeStateListener?.(); this.removeStateListener = null
    this.removeGestureListeners?.(); this.removeGestureListeners = null
    if (this.suspendTimer) { clearTimeout(this.suspendTimer); this.suspendTimer = null }
    const oldNode = this.node
    this.node = null
    if (oldNode) {
      oldNode.port.onmessage = null
      oldNode.onprocessorerror = null
      try { oldNode.disconnect() } catch { /* not connected */ }
    }
    if (this.source) { try { this.source.disconnect() } catch { /* gone */ } }
    if (this.sourceTap) { try { this.sourceTap.disconnect() } catch { /* gone */ } }
    this.source = null
    this.sourceTap = null
    try { this.destTrack.stop() } catch { /* gone */ }
    const oldCtx = this.ctx
    this.workletCtx = null
    this.workletStarting = null
    this.latestStats = null
    this.bypassed = false

    // Find a context the new track connects to: 48k first, then the track's own
    // rate, then the device default.
    const tried: (number | undefined)[] = [SAMPLE_RATE]
    if (this.inputRate && this.inputRate !== SAMPLE_RATE) tried.push(this.inputRate)
    tried.push(undefined)
    let built: Graph | null = null
    for (const rate of tried) {
      built = buildGraph(track, rate)
      if (built.ok) break
    }
    void oldCtx.close().catch(() => {})

    if (!built || !built.ok) {
      // Nowhere to build: keep the original audio clone as the output and stop
      // pretending this denoiser exists.
      this.graphLost = true
      this.opts.onError?.(
        'audio denoise: could not rebuild the audio graph after the input changed ' +
        `(${errorText(cause)}); passing the original audio through`,
      )
      return
    }

    this.ctx = built.ctx
    this.source = built.source
    this.dest = this.ctx.createMediaStreamDestination()
    this.destTrack = this.dest.stream.getAudioTracks()[0]
    // Passthrough on the new context until the worklet is spliced in.
    this.sourceTap = this.ctx.createGain()
    this.source.connect(this.sourceTap)
    this.sourceTap.connect(this.dest)

    this.bindContextState()
    this.bindInputEnded()
    void this.resume().catch(() => { /* handled by state watcher */ })
    this.onStateChange()

    try {
      await this.startWorklet()
    } catch (err) {
      // Fail open: the passthrough wiring is already in place.
      this.opts.onError?.(`audio denoise restart failed: ${errorText(err)}; passing the original audio through`)
    }
    if (this.destroyed || this.graphLost) return

    this.maybeRestoreDest()
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  setEnabled(on: boolean): void {
    this.node?.port.postMessage({ type: 'enabled', value: on })
  }

  setConfig(cfg: { postFilterBeta?: number; gruLeak?: number }): void {
    this.node?.port.postMessage({ type: 'config', ...cfg })
  }

  getStats(): AudioStats | null { return this.latestStats }

  // Output-ring underruns so far (each was bridged with the input directly —
  // audible only as a single quantum of un-denoised audio). Diagnostic.
  get underrunCount(): number { return this.underruns }

  // Context state ('running' | 'suspended' | 'closed').
  get state(): AudioContextState { return this.ctx.state }

  // Resume the internal AudioContext. The constructor already tries this, but
  // autoplay policy may block it until a user gesture — call it from a click
  // handler (e.g. your join / unmute button) to be safe. No-op when already
  // running or after destroy().
  async resume(): Promise<void> {
    if (this.destroyed || this.graphLost) return
    if (this.ctx.state === 'running' || this.ctx.state === 'closed') return
    await this.ctx.resume()
    // statechange moves the output back to the context's track.
  }

  private endOutput(): void {
    if (this.destroyed) return
    this.destroy()
  }

  // Ends the output track too: it's ours (a MediaStreamAudioDestinationNode
  // track), and a closed context leaves it 'live' but silent, so a sender
  // would keep transmitting silence after pipeline.destroy().
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.destTrack.stop()
    this.rawTrack?.stop()
    if (this.suspendTimer) clearTimeout(this.suspendTimer)
    this.removeStateListener?.()
    this.removeGestureListeners?.()
    this.removeEndedListener?.()
    if (this.node) {
      this.node.port.onmessage = null
      this.node.onprocessorerror = null
      try { this.node.disconnect() } catch { /* already gone */ }
    }
    if (this.source) { try { this.source.disconnect() } catch { /* already gone */ } }
    if (this.sourceTap) { try { this.sourceTap.disconnect() } catch { /* already gone */ } }
    void this.ctx.close().catch(() => {})
  }
}

type Graph =
  | { ok: true; ctx: AudioContext; source: MediaStreamAudioSourceNode }
  | { ok: false; error: unknown }

// The context unlock() made, if it is running (one that didn't start is no
// better than a fresh one, and on iOS getUserMedia can interrupt it) and the
// mic connects to it. Otherwise it is closed.
function adoptUnlocked(inputTrack: MediaStreamTrack): Graph {
  const entry = unlocked
  unlocked = null
  if (!entry) return { ok: false, error: new Error('no unlocked AudioContext') }
  clearTimeout(entry.timer)
  const ctx = entry.ctx
  if (ctx.state !== 'running') {
    void ctx.close().catch(() => {})
    return { ok: false, error: new Error(`unlocked AudioContext is ${ctx.state}`) }
  }
  try {
    return { ok: true, ctx, source: ctx.createMediaStreamSource(new MediaStream([inputTrack])) }
  } catch (error) {
    void ctx.close().catch(() => {})
    return { ok: false, error }
  }
}

function buildGraph(inputTrack: MediaStreamTrack, sampleRate: number | undefined): Graph {
  let ctx: AudioContext | null = null
  try {
    ctx = sampleRate ? new AudioContext({ sampleRate }) : new AudioContext()
    const source = ctx.createMediaStreamSource(new MediaStream([inputTrack]))
    return { ok: true, ctx, source }
  } catch (error) {
    void ctx?.close().catch(() => {})
    return { ok: false, error }
  }
}

// The track's own sample rate (before the browser resamples it into the
// context), or null when it doesn't report one.
function trackSampleRate(track: MediaStreamTrack): number | null {
  try {
    const rate = track.getSettings?.().sampleRate
    return typeof rate === 'number' && rate > 0 ? rate : null
  } catch { return null }
}

// Whether the kernel ships the DFN resampler exports (device-rate ⇄ 48 kHz).
// A wasm that fails to compile returns true here so the worklet reports the
// real compile error (fatal) instead of a misleading "can't resample".
function kernelResamples(wasmBytes: ArrayBuffer): boolean {
  try {
    const names = new Set(WebAssembly.Module.exports(new WebAssembly.Module(wasmBytes)).map((e) => e.name))
    return names.has('df_resampler_create') && names.has('df_resampler_push')
  } catch { return true }
}

function errorText(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

// Blob-URL the bundled processor (published) so addModule is same-origin from
// any CDN consumer; URL fallback in dev (note: AudioWorklet has no ESM import,
// so the dev URL path only works after a build populates WORKLET_SOURCE).
function workletUrl(): string {
  if (WORKLET_SOURCE) {
    return URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  }
  return new URL('./worklet/processor.ts', import.meta.url).href
}
