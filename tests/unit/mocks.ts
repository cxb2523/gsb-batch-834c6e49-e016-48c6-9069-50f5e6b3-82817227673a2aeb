import { vi } from "vitest";
import type { Store } from "vuex";
import { MP3 } from "@/definitions/file-types";
import { type Sample, PlaybackType } from "@/model/types/sample";
import type { EffluxState } from "@/store";
import { createEditorState } from "@/store/modules/editor-module";
import { createHistoryState } from "@/store/modules/history-module";
import { createInstrumentState } from "@/store/modules/instrument-module";
import { createMidiState } from "@/store/modules/midi-module";
import { createSampleState } from "@/store/modules/sample-module";
import { createSelectionState } from "@/store/modules/selection-module";
import { createSequencerState } from "@/store/modules/sequencer-module";
import { createSettingsState } from "@/store/modules/settings-module";
import { createSongState } from "@/store/modules/song-module";

export const mockAudioContext: BaseAudioContext = {
    sampleRate: 44100,
    currentTime: 0
} as BaseAudioContext;

export const setContextCurrentTime = ( context: BaseAudioContext, currentTime = 0 ): void => {
    // @ts-expect-error read only property in actual implementation
    context.currentTime = currentTime;
};

export const mockGainNode: GainNode = {
    gain: {
        cancelScheduledValues: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        setValueAtTime: vi.fn()
    }
} as unknown as GainNode;

export const createMockOscillatorNode = (): OscillatorNode => ({
    disconnect: vi.fn(),
} as unknown as OscillatorNode );

/**
 * An AudioParam stub whose scheduling methods update the "current" value, mimicking the
 * resolution of a parameter timeline (the value reflects the last scheduled target).
 */
export const createMockAudioParam = ( value = 0 ): AudioParam => {
    const param = {
        value,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(( target: number ) => { param.value = target; }),
        linearRampToValueAtTime: vi.fn(( target: number ) => { param.value = target; }),
        exponentialRampToValueAtTime: vi.fn(( target: number ) => { param.value = target; }),
        setTargetAtTime: vi.fn(),
    };
    return param as unknown as AudioParam;
};

export const createMockGainNode = ( value = 1 ): GainNode => ({
    gain: createMockAudioParam( value ),
    connect: vi.fn(),
    disconnect: vi.fn(),
} as unknown as GainNode );

export const createMockBiquadFilterNode = ( type: BiquadFilterType = "lowpass" ): BiquadFilterNode => ({
    type,
    frequency: createMockAudioParam( 350 ),
    Q: createMockAudioParam( 1 ),
    gain: createMockAudioParam( 0 ),
    detune: createMockAudioParam( 0 ),
    connect: vi.fn(),
    disconnect: vi.fn(),
} as unknown as BiquadFilterNode );

export const createMockStereoPannerNode = (): StereoPannerNode => ({
    pan: createMockAudioParam( 0 ),
    connect: vi.fn(),
    disconnect: vi.fn(),
} as unknown as StereoPannerNode );

export const createMockOscillatorSourceNode = (): OscillatorNode => ({
    type: "sine",
    frequency: createMockAudioParam( 440 ),
    detune: createMockAudioParam( 0 ),
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    setPeriodicWave: vi.fn(),
    onended: null,
} as unknown as OscillatorNode );

export const createMockBufferSourceNode = (): AudioBufferSourceNode => ({
    buffer: null,
    loop: false,
    playbackRate: createMockAudioParam( 1 ),
    detune: createMockAudioParam( 0 ),
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    onended: null,
} as unknown as AudioBufferSourceNode );

export const createMockWaveShaperNode = (): WaveShaperNode => ({
    curve: null,
    oversample: "none",
    connect: vi.fn(),
    disconnect: vi.fn(),
} as unknown as WaveShaperNode );

export const createMockDelayNode = (): DelayNode => ({
    delayTime: createMockAudioParam( 0 ),
    connect: vi.fn(),
    disconnect: vi.fn(),
} as unknown as DelayNode );

/**
 * create a minimal AudioContext stub capable of hosting the full AudioService module chain.
 * All audio nodes are vi.fn()-based stubs, so no real audio device is required.
 */
export const createMockAudioContextGraph = ( currentTime = 0 ): BaseAudioContext => {
    const context = {
        sampleRate: 44100,
        currentTime,
        destination: createMockGainNode(),
        createGain: vi.fn(() => createMockGainNode()),
        createGainNode: vi.fn(() => createMockGainNode()),
        createBiquadFilter: vi.fn(() => createMockBiquadFilterNode()),
        createOscillator: vi.fn(() => createMockOscillatorSourceNode()),
        createBufferSource: vi.fn(() => createMockBufferSourceNode()),
        createStereoPanner: vi.fn(() => createMockStereoPannerNode()),
        createDynamicsCompressor: vi.fn(() => createMockGainNode()),
        createAnalyser: vi.fn(() => createMockGainNode()),
        createWaveShaper: vi.fn(() => createMockWaveShaperNode()),
        createDelay: vi.fn(() => createMockDelayNode()),
        createChannelSplitter: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        createChannelMerger: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        createPeriodicWave: vi.fn(() => ({})),
        createBuffer: vi.fn(( _channels: number, length: number ) => ({
            getChannelData: () => new Float32Array( length )
        })),
    };
    return context as unknown as BaseAudioContext;
};

/**
 * jsdom does not provide the Web Audio API globals. The module router performs
 * "instanceof GainNode" checks to distinguish wrapped nodes, so ensure the global
 * exists when exercising the audio chain (all mocked nodes will simply not match).
 */
export const ensureAudioNodeGlobals = (): void => {
    const scope = globalThis as any;
    if ( typeof scope.GainNode === "undefined" ) {
        scope.GainNode = class GainNode {};
    }
};

/**
 * minimal WaveTable set (the AudioService expects all pooled oscillator waveforms to
 * be present when running outside of production builds)
 */
export const createMockWaveTables = (): any => ({
    SINE:     { real: [ 0, 0 ], imag: [ 0, 0 ] },
    SAW:      { real: [ 0, 0 ], imag: [ 0, 0 ] },
    TRIANGLE: { real: [ 0, 0 ], imag: [ 0, 0 ] },
    SQUARE:   { real: [ 0, 0 ], imag: [ 0, 0 ] },
});

export const mockAudioBuffer: AudioBuffer = {
    sampleRate: 44100,
    length: 132300,
    duration: 3,
    numberOfChannels: 1
} as AudioBuffer;

export const createSample = ( sampleName: string, optId?: string, type = PlaybackType.REPITCHED ): Sample => ({
    id         : optId ?? `s{Math.ceil( Math.random() * 100 )}`,
    name       : sampleName,
    source     : "base64;",
    buffer     : mockAudioBuffer,
    rangeStart : 0,
    rangeEnd   : mockAudioBuffer.duration,
    rate       : mockAudioBuffer.sampleRate,
    duration   : mockAudioBuffer.duration,
    loop       : true,
    pitch      : null,
    slices     : [],
    optimized  : false,
    type,
});

export const createSampleSourceBlob = ( type = MP3, size = 512000 ) => {
    return new Blob([ new Uint8Array( size ) ], { type });
};

export const createState = ( props?: Partial<EffluxState> ): EffluxState => ({
    menuOpened: false,
    blindActive: false,
    helpTopic: "general",
    loadingStates: [], // wether one or more long running operations are running
    windowSize: { width: 800, height: 600 },
    dialog: null,
    notifications: [],
    modal: null,
    mobileMode: null,
    supportsTouch: false,
    dropboxConnected: false,
    mediaConnected: false,
    applicationFocused: true,
    editor: createEditorState(),
    history: createHistoryState(),
    instrument: createInstrumentState(),
    midi: createMidiState(),
    sample: createSampleState(),
    selection: createSelectionState(),
    sequencer: createSequencerState(),
    settings: createSettingsState(),
    song: createSongState(),
    ...props
});

export const createMockStore = ( props?: Partial<EffluxState> ): Store<EffluxState> => ({
    state: createState( props ),
    getters: {
        t: vi.fn(), // vue-i18n
    },
    commit: vi.fn(),
    dispatch: vi.fn(),
}) as unknown as Store<EffluxState>;