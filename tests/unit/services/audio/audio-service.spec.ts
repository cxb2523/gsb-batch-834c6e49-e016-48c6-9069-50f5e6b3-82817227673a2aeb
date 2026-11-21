import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import OscillatorTypes from "@/definitions/oscillator-types";
import { FILTER_FREQ, PAN_LEFT, PAN_RIGHT, EQ_LOW, DELAY_FEEDBACK } from "@/definitions/automatable-parameters";
import EventFactory from "@/model/factories/event-factory";
import InstrumentFactory from "@/model/factories/instrument-factory";
import SongFactory from "@/model/factories/song-factory";
import { ACTION_NOTE_ON } from "@/model/types/audio-event";
import type { EffluxAudioEvent } from "@/model/types/audio-event";
import type { Instrument } from "@/model/types/instrument";
import {
    createMockAudioContextGraph, createMockWaveTables, ensureAudioNodeGlobals,
} from "../../mocks";

// The AudioService uses the WebAudio API helpers which query the window for feature support
// at import time. As this suite runs within jsdom (which lacks the Web Audio API), we provide
// mapped mock implementations of the helper methods. The "isStandards" feature check is thus
// bypassed, but startOscillation()/stopOscillation() are still routed to the mocked nodes.

vi.mock( "@/services/audio/webaudio-helper", () => ({
    init: vi.fn(),
    startOscillation: vi.fn(( node: any ) => node.start?.()),
    stopOscillation: vi.fn(( node: any, time: number ) => node.stop?.( time )),
    setValue: vi.fn(( param: any, value: number ) => { param.value = value; }),
    createGainNode: vi.fn(( context: any ) => context.createGain()),
    createStereoPanner: vi.fn(( context: any ) => context.createStereoPanner?.()),
    createPWM: vi.fn(),
    createWaveTableFromGraph: vi.fn(() => ({})),
    createTimer: vi.fn(),
    beep: vi.fn(),
    isOscillatorNode: vi.fn(( node: any ) => !!node.frequency ),
    isAudioBufferSourceNode: vi.fn(( node: any ) => !!node.buffer ),
    createOfflineAudioContext: vi.fn(),
    supports: vi.fn(),
}));

// the third party audio graph modules are replaced with minimal stubs
// ensuring they expose the routing API used by the module factory and router

vi.mock( "@/services/audio/modules/delay-module", () => ({
    default: class Delay {
        public input: any;
        public output: any;
        public type = 0;
        public delay = 0.5;
        public feedback = 0.42;
        public offset = 0;
        public cutoff = 1200;
        public dry = 1;
        constructor( context: any ) {
            this.input  = context.createGain();
            this.output = context.createGain();
        }
        connect(): void {}
        disconnect(): void {}
    }
}));

vi.mock( "wa-overdrive", () => ({
    default: class Overdrive {
        public input: any;
        public output: any;
        public drive = 0.8;
        public preBand = 1;
        public color = 4000;
        public postCut = 8000;
        constructor( context: any ) {
            this.input  = context.createGain();
            this.output = context.createGain();
        }
        connect(): void {}
        disconnect(): void {}
    }
}));

vi.mock( "@/services/audio/output-recorder", () => ({ default: class Recorder {} }));

import * as AudioService from "@/services/audio-service";

const POOL_SIZE_PER_OSCILLATOR = 16; // Config.INSTRUMENT_AMOUNT (8) * 2 (see createModules())
const OSCILLATOR_INDEX = 0;

describe( "AudioService", () => {

    let context: BaseAudioContext;
    let instrument: Instrument;
    let sampleCache: Map<string, any>;
    let infoSpy: ReturnType<typeof vi.spyOn>;

    const createInstrument = (): Instrument => {
        const created = InstrumentFactory.create( 0 );
        created.oscillators[ 1 ].enabled = false; // a single enabled oscillator keeps the pools simple
        created.oscillators[ 2 ].enabled = false;
        created.oscillators[ 0 ].waveform = OscillatorTypes.SAW;
        return created;
    };

    const createNoteOnEvent = ( instrumentRef: Instrument, note = "C", octave = 3 ): EffluxAudioEvent => {
        const event = EventFactory.create( instrumentRef.index, note, octave, ACTION_NOTE_ON );
        event.seq.mpLength = 0.5;
        return event;
    };

    // capture the generator nodes created by the AudioService so we can simulate playback end

    let createdGenerators: any[] = [];
    const captureGenerators = (): void => {
        const ctx = context as any;
        const original = ctx.createOscillator;
        ctx.createOscillator = vi.fn(() => {
            const node = original();
            createdGenerators.push( node );
            return node;
        });
    };

    beforeEach(() => {
        ensureAudioNodeGlobals();
        vi.clearAllMocks();
        createdGenerators = [];

        const song = SongFactory.create();
        instrument = createInstrument();
        song.instruments[ 0 ] = instrument;

        context = createMockAudioContextGraph( 0 );
        captureGenerators();

        // prepare the AudioService environment
        ( AudioService as any ).prepareEnvironment( context, createMockWaveTables());
        AudioService.cacheCustomTables( song.instruments );
        AudioService.applyModules( song );

        // the module chain creates oscillator nodes (e.g. the filter LFO) during environment setup:
        // discard these so the captured generators represent the note voices only
        createdGenerators = [];

        sampleCache = new Map();
        infoSpy = vi.spyOn( console, "info" ).mockImplementation(() => {});
    });

    afterEach(() => {
        // dispose of any leftover playback
        AudioService.reset( true );
        infoSpy.mockRestore();
        vi.restoreAllMocks();
    });

    describe( "when playing back notes", () => {

        it( "should assign a unique id to the triggered event", () => {
            const event = createNoteOnEvent( instrument );
            AudioService.noteOn( event, instrument, sampleCache, 0 );

            expect( typeof event.id ).toBe( "number" );
            expect( AudioService.getPlayingEventIds( instrument.index )).toContain( event.id );
        });

        it( "should return the voice nodes to the pool once playback has ended", () => {
            const event = createNoteOnEvent( instrument );
            AudioService.noteOn( event, instrument, sampleCache, 0 );

            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( POOL_SIZE_PER_OSCILLATOR - 1 );

            createdGenerators[ 0 ].onended();

            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( POOL_SIZE_PER_OSCILLATOR );
            expect( AudioService.getPlayingEventIds( instrument.index )).not.toContain( event.id );
        });
    });

    describe( "when retriggering an event that is already playing back", () => {

        it( "should generate a new unique event id for the retriggered event", () => {
            const event = createNoteOnEvent( instrument );
            AudioService.noteOn( event, instrument, sampleCache, 0 );
            const firstId = event.id;

            AudioService.noteOn( event, instrument, sampleCache, 0.25 );

            expect( event.id ).not.toBe( firstId );
            expect( event.id! ).toBeGreaterThan( firstId! );
        });

        it( "should return the previously playing voice to the pool once its release has ended", () => {
            const event = createNoteOnEvent( instrument );
            AudioService.noteOn( event, instrument, sampleCache, 0 );

            AudioService.noteOn( event, instrument, sampleCache, 0.1 ); // retrigger -> previous voice starts release
            AudioService.noteOn( event, instrument, sampleCache, 0.2 ); // and again

            expect( createdGenerators ).toHaveLength( 3 );

            // simulate the release phases ending
            createdGenerators[ 0 ].onended();
            createdGenerators[ 1 ].onended();

            // two voices back in the pool, one still playing (the last retrigger)
            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( POOL_SIZE_PER_OSCILLATOR - 1 );
        });

        it( "should not delete the playback record of a retriggered event when the old voice ends", () => {
            const event = createNoteOnEvent( instrument );
            AudioService.noteOn( event, instrument, sampleCache, 0 );

            AudioService.noteOn( event, instrument, sampleCache, 0.1 );
            const retriggeredId = event.id;

            // the release phase of the FIRST (now superseded) voice ends
            createdGenerators[ 0 ].onended();

            // the retriggered event must still be registered (its voice is still playing)
            expect( AudioService.getPlayingEventIds( instrument.index )).toContain( retriggeredId );

            // and its generator should still be stoppable via noteOff
            AudioService.noteOff( event, 0.2 );
            expect( createdGenerators[ 1 ].stop ).toHaveBeenCalled();
        });

        it( "should not exhaust the voice pool over many retriggers with a long release tail", () => {
            const event = createNoteOnEvent( instrument );
            const RETRIGGERS = POOL_SIZE_PER_OSCILLATOR * 20;

            for ( let i = 0; i < RETRIGGERS; ++i ) {
                AudioService.noteOn( event, instrument, sampleCache, i * 0.1 );

                // simulate the previous voices' release phase ending (the release tail overlaps the retrigger)
                if ( i > 0 ) {
                    createdGenerators[ i - 1 ].onended();
                }
            }
            createdGenerators[ createdGenerators.length - 1 ].onended();

            expect( infoSpy ).not.toHaveBeenCalledWith( expect.stringContaining( "no more nodes in the pool" ));
            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( POOL_SIZE_PER_OSCILLATOR );
        });

        it( "should not stack release envelopes when noteOff is invoked repeatedly for the same event", () => {
            const event = createNoteOnEvent( instrument );
            AudioService.noteOn( event, instrument, sampleCache, 0 );

            AudioService.noteOff( event, 0.2 );
            AudioService.noteOff( event, 0.2 );
            AudioService.noteOff( event, 0.2 );

            // the stop time is scheduled exactly once (repeated noteOff invocations are ignored)
            expect( createdGenerators[ 0 ].stop ).toHaveBeenCalledTimes( 1 );
        });
    });

    describe( "when halting playback", () => {

        it( "should return all voices to the pool, including those still in their release phase", () => {
            const event = createNoteOnEvent( instrument );
            AudioService.noteOn( event, instrument, sampleCache, 0 );

            // put the voice in its release phase
            AudioService.noteOff( event, 0.2 );

            AudioService.reset();

            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( POOL_SIZE_PER_OSCILLATOR );
            expect( AudioService.getPlayingEventIds( instrument.index )).toHaveLength( 0 );
        });

        it( "should not leak voices when stopping playback mid-release of many released voices", () => {
            // trigger a batch of notes, then release them all so they are in their release tail
            const events = Array.from({ length: POOL_SIZE_PER_OSCILLATOR }, () => createNoteOnEvent( instrument ));
            events.forEach(( event, index ) => AudioService.noteOn( event, instrument, sampleCache, index * 0.01 ));
            events.forEach( event => AudioService.noteOff( event, 0.2 ));

            // the release tails have NOT yet ended when playback is stopped
            AudioService.reset();

            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( POOL_SIZE_PER_OSCILLATOR );

            // a new cycle of notes can be triggered without pool exhaustion
            events.forEach(( event, index ) => AudioService.noteOn( event, instrument, sampleCache, 1 + index * 0.01 ));

            expect( infoSpy ).not.toHaveBeenCalledWith( expect.stringContaining( "no more nodes in the pool" ));
        });

        it( "should not return the same voices to the pool twice when their generator ends after a reset", () => {
            const event = createNoteOnEvent( instrument );
            AudioService.noteOn( event, instrument, sampleCache, 0 );

            AudioService.reset();

            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( POOL_SIZE_PER_OSCILLATOR );

            // the (now stale) generator ends after the reset : it must not re-add the voice to the pool
            createdGenerators[ 0 ].onended();

            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( POOL_SIZE_PER_OSCILLATOR );
        });

        it( "should restore a gliding panning automation onto the instrument model value", () => {
            instrument.panning = 0.25;
            AudioService.applyModules( { instruments: [ instrument ] } as any );

            const event = createNoteOnEvent( instrument );
            event.mp = { module: PAN_LEFT, value: 80, glide: true };
            AudioService.noteOn( event, instrument, sampleCache, 0 );

            const panner = AudioService.getInstrumentModules( instrument.index ).panner;
            expect( panner.pan.value ).not.toEqual( instrument.panning );

            AudioService.reset();

            expect( panner.pan.value ).toEqual( instrument.panning );
        });

        it( "should restore a gliding filter frequency automation onto the instrument model value", () => {
            instrument.filter.enabled = true;
            instrument.filter.frequency = 880;
            AudioService.applyModules( { instruments: [ instrument ] } as any );

            const filter = AudioService.getInstrumentModules( instrument.index ).filter.filter;

            const event = createNoteOnEvent( instrument );
            event.mp = { module: FILTER_FREQ, value: 100, glide: true };
            AudioService.noteOn( event, instrument, sampleCache, 0 );

            AudioService.reset();

            expect( filter.frequency.value ).toEqual( instrument.filter.frequency );
            expect( filter.Q.value ).toEqual( instrument.filter.q );
        });

        it( "should restore the module enabled states and routing after automation", () => {
            instrument.panning = 0;
            instrument.eq.enabled = false;
            AudioService.applyModules( { instruments: [ instrument ] } as any );

            const modules = AudioService.getInstrumentModules( instrument.index );

            const event = createNoteOnEvent( instrument );
            event.mp = { module: EQ_LOW, value: 90, glide: false };
            AudioService.noteOn( event, instrument, sampleCache, 0 );
            expect( modules.eq.lowGain.gain.value ).toEqual( 0.9 );

            AudioService.reset();

            // the EQ band gains are restored to the model values, routing is left consistent
            expect( modules.eq.lowGain.gain.value ).toEqual( instrument.eq.lowGain );
            expect( modules.eq.eqEnabled ).toEqual( instrument.eq.enabled );
        });

        it( "should restore delay and overdrive module values altered by automation", () => {
            AudioService.applyModules( { instruments: [ instrument ] } as any );
            const modules = AudioService.getInstrumentModules( instrument.index );

            const delayEvent = createNoteOnEvent( instrument );
            delayEvent.mp = { module: DELAY_FEEDBACK, value: 90, glide: false };
            AudioService.noteOn( delayEvent, instrument, sampleCache, 0 );
            expect( modules.delay.delay.feedback ).toEqual( 0.9 );

            AudioService.reset();

            expect( modules.delay.delay.feedback ).toEqual( instrument.delay.feedback );
            expect( modules.overdrive.overdrive.drive ).toEqual( instrument.overdrive.drive );
        });

        it( "should restore a gliding panning automation to the right side of the model value", () => {
            instrument.panning = -0.5;
            AudioService.applyModules( { instruments: [ instrument ] } as any );

            const event = createNoteOnEvent( instrument );
            event.mp = { module: PAN_RIGHT, value: 100, glide: true };
            AudioService.noteOn( event, instrument, sampleCache, 0 );

            AudioService.reset();

            const panner = AudioService.getInstrumentModules( instrument.index ).panner;
            expect( panner.pan.value ).toEqual( instrument.panning );
        });
    });

    describe( "when triggering multiple events concurrently for the same instrument", () => {

        it( "should assign a unique id and keep a separate playback record per event", () => {
            const events = [
                createNoteOnEvent( instrument, "C", 3 ),
                createNoteOnEvent( instrument, "E", 3 ),
                createNoteOnEvent( instrument, "G", 3 ),
            ];
            events.forEach(( event, index ) => {
                AudioService.noteOn( event, instrument, sampleCache, index * 0.1 );
            });

            const ids = events.map( event => event.id );
            expect( new Set( ids ).size ).toEqual( 3 );
            expect( AudioService.getPlayingEventIds( instrument.index )).toHaveLength( 3 );
            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( POOL_SIZE_PER_OSCILLATOR - 3 );
        });

        it( "should recycle all voices once each concurrent event has finished", () => {
            const events = Array.from({ length: POOL_SIZE_PER_OSCILLATOR }, (_, index ) =>
                createNoteOnEvent( instrument, "C", 3 + ( index % 2 ))
            );
            events.forEach(( event, index ) => {
                AudioService.noteOn( event, instrument, sampleCache, index * 0.01 );
            });

            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( 0 );

            // finish playback of all events (their release tails end)
            createdGenerators.forEach( generator => generator.onended());

            expect( AudioService.getAvailableVoiceCount( instrument.index, OSCILLATOR_INDEX )).toBe( POOL_SIZE_PER_OSCILLATOR );
            expect( AudioService.getPlayingEventIds( instrument.index )).toHaveLength( 0 );

            // the pool is replenished : a new batch of events can be played back
            events.forEach(( event, index ) => {
                AudioService.noteOn( event, instrument, sampleCache, 1 + index * 0.01 );
            });
            expect( infoSpy ).not.toHaveBeenCalledWith( expect.stringContaining( "no more nodes in the pool" ));
        });

        it( "should not let a stale voice end callback clear another events playback record", () => {
            const eventA = createNoteOnEvent( instrument, "C", 3 );
            const eventB = createNoteOnEvent( instrument, "E", 3 );

            AudioService.noteOn( eventA, instrument, sampleCache, 0 );
            AudioService.noteOn( eventB, instrument, sampleCache, 0.1 );

            // event A retriggers (its old voice is released and a new record created for the event)
            AudioService.noteOn( eventA, instrument, sampleCache, 0.2 );

            // the old voice of event A ends AFTER the retrigger : event B's record must survive
            createdGenerators[ 0 ].onended();

            expect( AudioService.getPlayingEventIds( instrument.index )).toEqual(
                expect.arrayContaining([ eventA.id, eventB.id ])
            );
        });

        it( "should not let a voice ending after a reset delete the record of a new event with a recycled id", () => {
            // fill the pool, then stop playback (which flushes all records)
            const flushedEvent = createNoteOnEvent( instrument );
            AudioService.noteOn( flushedEvent, instrument, sampleCache, 0 );

            AudioService.reset( true ); // resets the unique event id counter

            // a new event now receives the same id as the flushed event
            const newEvent = createNoteOnEvent( instrument );
            AudioService.noteOn( newEvent, instrument, sampleCache, 0 );
            expect( newEvent.id ).toEqual( flushedEvent.id );

            // the flushed generator only signals its end AFTER the new event was triggered.
            // its stale callback must not clear the new events playback record.
            createdGenerators[ 0 ].onended();

            expect( AudioService.getPlayingEventIds( instrument.index )).toContain( newEvent.id );

            // the new event can still be stopped
            AudioService.noteOff( newEvent, 0.2 );
            expect( createdGenerators[ 1 ].stop ).toHaveBeenCalled();
        });
    });

    describe( "when scheduling a gliding module parameter automation", () => {

        it( "should chain a repeated glide from the value in flight, instead of re-anchoring it", () => {
            const modules = AudioService.getInstrumentModules( instrument.index );
            const frequencyParam = modules.filter.filter.frequency;
            const ramp      = frequencyParam.linearRampToValueAtTime as unknown as ReturnType<typeof vi.fn>;
            const setValue  = frequencyParam.setValueAtTime as unknown as ReturnType<typeof vi.fn>;

            const createGlideEvent = ( value: number ): EffluxAudioEvent => {
                const event = createNoteOnEvent( instrument );
                event.mp = { module: FILTER_FREQ, value, glide: true };
                return event;
            };

            AudioService.noteOn( createGlideEvent( 100 ), instrument, sampleCache, 0 );

            const firstRamp = ramp.mock.calls.length;
            const firstAnchor = setValue.mock.calls[ 0 ][ 0 ] as number;

            // while the first glide is still in flight (duration == seq.mpLength == 0.5s), the event retriggers
            AudioService.noteOn( createGlideEvent( 100 ), instrument, sampleCache, 0.25 );

            // a new ramp is scheduled (a single sequence per trigger, not a duplicate stack)
            expect( ramp.mock.calls.length ).toEqual( firstRamp + 1 );

            // the second glide anchors at the interpolated value of the first glide (midway between
            // anchor and target) instead of re-anchoring at the (still unchanged) param value
            const secondAnchor = setValue.mock.calls[ 1 ][ 0 ] as number;
            expect( secondAnchor ).toBeGreaterThan( firstAnchor );
        });

        it( "should start a new glide from the resolved target once a previous glide has completed", () => {
            const modules = AudioService.getInstrumentModules( instrument.index );
            const frequencyParam = modules.filter.filter.frequency;
            const setValue = frequencyParam.setValueAtTime as unknown as ReturnType<typeof vi.fn>;

            const createGlideEvent = ( value: number, time: number ): EffluxAudioEvent => {
                const event = createNoteOnEvent( instrument );
                event.mp = { module: FILTER_FREQ, value, glide: true };
                AudioService.noteOn( event, instrument, sampleCache, time );
                return event;
            };

            // first glide : start at t=0, duration 0.5s -> resolved at t=0.5s
            createGlideEvent( 100, 0 );

            // a new glide triggered AFTER the first has resolved : anchors at the previous target
            createGlideEvent( 20, 1.0 );

            const anchors = setValue.mock.calls.map( call => call[ 0 ] as number );
            // the second anchor equals the value of the first glides target (MAX_FILTER_FREQ * 1.0)
            expect( anchors[ anchors.length - 1 ]).toEqual( anchors[ 1 ] );
        });

        it( "should not append a duplicate ramp when a non-gliding change follows a glide", () => {
            const modules = AudioService.getInstrumentModules( instrument.index );
            const frequencyParam = modules.filter.filter.frequency;
            const ramp     = frequencyParam.linearRampToValueAtTime as unknown as ReturnType<typeof vi.fn>;
            const cancel   = frequencyParam.cancelScheduledValues as unknown as ReturnType<typeof vi.fn>;

            const glide = createNoteOnEvent( instrument );
            glide.mp = { module: FILTER_FREQ, value: 100, glide: true };
            AudioService.noteOn( glide, instrument, sampleCache, 0 );

            const rampsAfterGlide = ramp.mock.calls.length;

            const instant = createNoteOnEvent( instrument );
            instant.mp = { module: FILTER_FREQ, value: 20, glide: false };
            AudioService.noteOn( instant, instrument, sampleCache, 0.1 );

            // the non-gliding change cancels pending automation (no additional ramp is scheduled)
            expect( ramp.mock.calls.length ).toEqual( rampsAfterGlide );
            expect( cancel ).toHaveBeenCalled();
        });
    });
});
