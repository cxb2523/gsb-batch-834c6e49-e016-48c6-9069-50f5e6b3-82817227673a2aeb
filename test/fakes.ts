/**
 * Injectable fakes for local testing. No real network, MSE or audio hardware
 * is touched: HLS never loads a script/segment and the AudioContext is an
 * in-memory graph that records every connection instead of producing sound.
 */

/* ------------------------------------------------------------------ */
/* Fake HTMLAudioElement                                               */
/* ------------------------------------------------------------------ */

export class FakeAudioElement {
  src = '';
  srcObject: unknown = null;
  paused = true;
  muted = false;
  volume = 1;
  currentTime = 0;
  playbackRate = 1;
  preload = '';
  autoplay = false;
  crossOrigin: string | null = null;
  loop = false;
  HAVE_ENOUGH_DATA = 4;
  attributes: Record<string, string> = {};
  error: MediaError | null = null;
  buffered: TimeRanges = { length: 0, start: () => 0, end: () => 0 };
  played: TimeRanges = { length: 0, start: () => 0, end: () => 0 };
  duration = Number.NaN;

  private listeners: Record<string, Set<EventListener>> = {};

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
    if (name === 'src') {
      this.src = '';
    }
  }

  addEventListener(event: string, listener: EventListener) {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event].add(listener);
  }

  removeEventListener(event: string, listener: EventListener) {
    this.listeners[event]?.delete(listener);
  }

  dispatchEvent(event: Event) {
    for (const listener of this.listeners[event.type] ?? []) {
      listener(event);
    }
    return true;
  }

  // Safari returns '' for HLS playlists it can play natively; the tests
  // configure this per scenario.
  canPlayType(_type: string): string {
    return '';
  }

  load() {
    this.dispatchEvent(new Event('loadstart'));
  }

  async play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
}

/* ------------------------------------------------------------------ */
/* Fake Web Audio graph                                                */
/* ------------------------------------------------------------------ */

export class FakeAudioParam {
  value: number;
  readonly setTargetAtTimeCalls: Array<{ value: number; time: number; constant: number }> = [];

  constructor(value: number) {
    this.value = value;
  }

  setTargetAtTime(value: number, time: number, timeConstant: number) {
    this.value = value;
    this.setTargetAtTimeCalls.push({ value, time, constant: timeConstant });
  }
}

export class FakeAudioNode {
  readonly connects: FakeAudioNode[] = [];
  readonly disconnects: number[] = [];

  connect(node: FakeAudioNode): FakeAudioNode {
    this.connects.push(node);
    return node;
  }

  disconnect() {
    this.disconnects.push(this.connects.length);
  }
}

export class FakeMediaElementSourceNode extends FakeAudioNode {
  constructor(public readonly mediaElement: FakeAudioElement) {
    super();
  }
}

export class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'peaking';
  frequency = new FakeAudioParam(0);
  gain = new FakeAudioParam(0);
  Q = new FakeAudioParam(1);
}

export class FakeDynamicsCompressorNode extends FakeAudioNode {
  threshold = new FakeAudioParam(-24);
  knee = new FakeAudioParam(30);
  ratio = new FakeAudioParam(12);
  attack = new FakeAudioParam(0.003);
  release = new FakeAudioParam(0.25);
}

export class FakeAudioDestinationNode extends FakeAudioNode {}

export const createdAudioContexts: FakeAudioContext[] = [];
export const createdMediaElementSources: FakeMediaElementSourceNode[] = [];

export class FakeAudioContext {
  readonly destination = new FakeAudioDestinationNode();
  readonly currentTime = 0;
  state: 'suspended' | 'running' | 'closed' = 'running';
  readonly latencyHint?: string;
  closed = false;
  mediaElementSources: FakeMediaElementSourceNode[] = [];

  constructor(options?: AudioContextOptions) {
    this.latencyHint = options?.latencyHint as string | undefined;
    createdAudioContexts.push(this);
  }

  createMediaElementSource(element: FakeAudioElement): FakeMediaElementSourceNode {
    // Mirror the real browser constraint: one element => one source node.
    if (this.mediaElementSources.some((node) => node.mediaElement === element)) {
      throw new DOMException(
        'HTMLMediaElement already connected previously to a different MediaElementSourceNode',
        'InvalidStateError',
      );
    }
    const node = new FakeMediaElementSourceNode(element);
    this.mediaElementSources.push(node);
    createdMediaElementSources.push(node);
    return node;
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    return new FakeBiquadFilterNode();
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    return new FakeDynamicsCompressorNode();
  }

  async resume() {
    if (this.state === 'closed') {
      throw new DOMException('context is closed', 'InvalidStateError');
    }
    this.state = 'running';
  }

  async close() {
    if (this.closed) {
      throw new DOMException('context already closed', 'InvalidStateError');
    }
    this.closed = true;
    this.state = 'closed';
  }
}

/* ------------------------------------------------------------------ */
/* Fake HLS engine                                                     */
/* ------------------------------------------------------------------ */

export interface FakeHlsOptions {
  /** When false the engine reports the environment as unsupported. */
  supported?: boolean;
}

export class FakeHls {
  static Events = {
    MEDIA_ATTACHED: 'hlsMediaAttached',
    MEDIA_DETACHED: 'hlsMediaDetached',
    ERROR: 'hlsError',
  };

  static isSupportedImpl: () => boolean = () => true;
  static instances: FakeHls[] = [];
  static reset() {
    FakeHls.instances = [];
    FakeHls.isSupportedImpl = () => true;
  }

  static isSupported() {
    return FakeHls.isSupportedImpl();
  }

  readonly config: Record<string, unknown>;
  destroyed = false;
  attachMediaCalls: FakeAudioElement[] = [];
  detachMediaCalls = 0;
  loadSourceCalls: string[] = [];
  removeAllListenersCalls = 0;
  private listeners: Record<string, Set<(...args: unknown[]) => void>> = {};

  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
    FakeHls.instances.push(this);
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    if (this.destroyed) {
      throw new Error('listener attached to a destroyed HLS instance');
    }
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event].add(listener);
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners[event]?.delete(listener);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners[event] ?? []) {
      listener(...args);
    }
  }

  attachMedia(media: FakeAudioElement) {
    if (this.destroyed) {
      throw new Error('attachMedia called on a destroyed HLS instance');
    }
    this.attachMediaCalls.push(media);
  }

  detachMedia() {
    if (this.destroyed) {
      throw new Error('detachMedia called on a destroyed HLS instance');
    }
    this.detachMediaCalls += 1;
  }

  loadSource(url: string) {
    if (this.destroyed) {
      throw new Error('loadSource called on a destroyed HLS instance');
    }
    this.loadSourceCalls.push(url);
  }

  removeAllListeners() {
    this.removeAllListenersCalls += 1;
    this.listeners = {};
  }

  destroy() {
    this.destroyed = true;
  }
}

/* ------------------------------------------------------------------ */
/* Minimal document/navigator stubs for node                           */
/* ------------------------------------------------------------------ */

export class FakeBody {
  private listeners: Record<string, Set<EventListener>> = {};

  addEventListener(event: string, listener: EventListener) {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event].add(listener);
  }

  removeEventListener(event: string, listener: EventListener) {
    this.listeners[event]?.delete(listener);
  }
}

export function installDomStubs(): { body: FakeBody } {
  const body = new FakeBody();
  const doc = {
    body,
    createElement: () => ({}),
    head: { appendChild: () => {} },
  };
  Object.defineProperty(globalThis, 'document', {
    value: doc,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
    writable: true,
  });
  (globalThis as any).MediaError = {
    MEDIA_ERR_ABORTED: 1,
    MEDIA_ERR_NETWORK: 2,
    MEDIA_ERR_DECODE: 3,
    MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
  };
  return { body };
}

export function installAudioStubs(): { body: FakeBody } {
  const stubs = installDomStubs();
  Object.defineProperty(globalThis, 'Audio', {
    value: FakeAudioElement,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'AudioContext', {
    value: FakeAudioContext,
    configurable: true,
    writable: true,
  });
  return stubs;
}

export function uninstallAudioStubs() {
  for (const name of ['Audio', 'AudioContext', 'document', 'navigator', 'MediaError']) {
    Object.defineProperty(globalThis, name, {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }
}

export function resetWebAudioFakes() {
  createdAudioContexts.length = 0;
  createdMediaElementSources.length = 0;
}
