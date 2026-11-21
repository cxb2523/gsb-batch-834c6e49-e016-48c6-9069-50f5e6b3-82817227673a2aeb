/**
 * The MIT License (MIT)
 *
 * Igor Zinken 2016-2023 - https://www.igorski.nl
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import Config from "@/config";
import { type ModuleParamDef, NON_PERSISTED_PARAMS } from "@/definitions/automatable-parameters";
import { createTimer, isOscillatorNode, isAudioBufferSourceNode } from "./webaudio-helper";
import type { EffluxAudioEvent } from "@/model/types/audio-event";
import type { EventVoice, EventVoiceList } from "@/model/types/event-voice";
import type { Instrument } from "@/model/types/instrument";
import type { InstrumentModules } from "@/model/types/instrument-modules";
import { rangeToIndex } from "@/utils/array-util";
import { toHex } from "@/utils/number-util";
import { processVoiceLists } from "./audio-util";
import { applyRouting } from "./module-router";

const filterTypes = [ "off", "sine", "square", "sawtooth", "triangle" ];

import {
    DELAY_ENABLED, DELAY_FEEDBACK, DELAY_DRY, DELAY_CUTOFF, DELAY_TIME, DELAY_OFFSET,
    EQ_ENABLED, EQ_LOW, EQ_MID, EQ_HIGH,
    FILTER_ENABLED, FILTER_FREQ, FILTER_Q, FILTER_LFO_ENABLED, FILTER_LFO_SPEED, FILTER_LFO_DEPTH,
    OD_ENABLED, OD_DRIVE, OD_PRE_BAND, OD_COLOR, OD_POST_CUT,
    EXTERNAL_EVENT,
    PAN_LEFT, PAN_RIGHT, PITCH_UP, PITCH_DOWN,
    VOLUME
} from "@/definitions/automatable-parameters";

type ExternalEventCallbackProps = { c: number, t: number };
export type ExternalEventCallback = ( props: ExternalEventCallbackProps ) => void;

/**
 * Describes the currently active glide on an AudioParam. As the Web Audio API has no
 * facility to query the value of an AudioParam at a future time, we track the range
 * in which a pending glide ramp is active so repeated automation triggers (e.g. an
 * event being retriggered while it is still gliding) can be chained correctly
 * instead of stacking duplicate cancel/anchor/ramp sequences.
 */
type ParameterGlideState = {
    startTime: number;
    startValue: number;
    endTime: number;
    target: number;
};

let parameterGlideStates = new WeakMap<AudioParam, ParameterGlideState>();

// automation of the filter LFO type alters the instruments model (the LFO type describes the
// oscillator type to use for modulation). Keep track of the original value so a reset can
// restore the instrument to its configured (and persisted) state.

let filterLfoTypeSnapshots = new Map<number, OscillatorType | "off">();

/**
 * discard the snapshots of the pre-automation filter LFO types. Should be invoked whenever
 * the instrument models are (re)applied onto the audio modules, as a subsequent reset() will
 * restore the value described by the (new) model instead.
 */
export const clearFilterLfoSnapshots = (): void => {
    filterLfoTypeSnapshots.clear();
};

/**
 * apply a module parameter change defined inside an audioEvent during playback
 */
export const applyModuleParamChange = ( audioContext: BaseAudioContext, audioEvent: EffluxAudioEvent,
    modules: InstrumentModules, instrument: Instrument, voiceLists: EventVoiceList[],
    startTimeInSeconds: number, output: AudioNode, optEventCallback?: ExternalEventCallback ) => {
    const { value, module } = audioEvent.mp;

    // @todo should all enabled states here determine whether the node is actually connected ?
    switch ( module ) {
        // gain effects
        case VOLUME:
            applyVolumeEnvelope( audioEvent, voiceLists, startTimeInSeconds );
            break;

        // equalizer effects
        case EQ_ENABLED:
            modules.eq.eqEnabled = value >= 50;
            applyRouting( modules, output );
            break;

        case EQ_LOW:
        case EQ_MID:
        case EQ_HIGH:
            applyEQ( audioEvent, modules, startTimeInSeconds );
            break;

        // overdrive effects
        case OD_ENABLED:
            modules.overdrive.overdriveEnabled = value >= 50;
            applyRouting( modules, output );
            break;

        case OD_DRIVE:
        case OD_PRE_BAND:
        case OD_COLOR:
        case OD_POST_CUT:
            applyOverdrive( audioEvent, modules/*, startTimeInSeconds*/ );
            break;

        // panning effects
        case PAN_LEFT:
        case PAN_RIGHT:
            applyPanning( audioEvent, modules, startTimeInSeconds );
            break;

        // pitch effects
        case PITCH_UP:
        case PITCH_DOWN:
            applyPitchShift( audioEvent, voiceLists, startTimeInSeconds );
            break;

        // filter effects
        case FILTER_ENABLED:
            modules.filter.filterEnabled = value >= 50;
            applyRouting( modules, output );
            break;

        case FILTER_LFO_ENABLED:
            if ( !filterLfoTypeSnapshots.has( instrument.index )) {
                filterLfoTypeSnapshots.set( instrument.index, instrument.filter.lfoType );
            }
            instrument.filter.lfoType = rangeToIndex( filterTypes, value ) as OscillatorType;
            applyRouting( modules, output );
            break;

        case FILTER_FREQ:
        case FILTER_Q:
        case FILTER_LFO_SPEED:
        case FILTER_LFO_DEPTH:
            applyFilter( audioEvent, modules, startTimeInSeconds );
            break;

        // delay effects
        case DELAY_ENABLED:
            modules.delay.delayEnabled = value >= 50;
            applyRouting( modules, output );
            break;

        case DELAY_TIME:
        case DELAY_FEEDBACK:
        case DELAY_DRY:
        case DELAY_CUTOFF:
        case DELAY_OFFSET:
            applyDelay( audioEvent, modules/*, startTimeInSeconds*/ );
            break;

        // external events
        case EXTERNAL_EVENT:
            applyExternalEvent( audioContext, audioEvent, startTimeInSeconds, optEventCallback );
            break;
    }
};

/**
 * Retrieve the current value for givin param from the instruments current state
 */
export const getCurrentValueForParam = ( modules: InstrumentModules, instrument: Instrument, param: ModuleParamDef ): number => {
    if ( NON_PERSISTED_PARAMS.has( param )) {
        return NON_PERSISTED_PARAMS.get( param );
    }
    const { delay, eq, filter, overdrive, panner } = modules;
    let value: number;
    
    switch ( param ) {
        default:
            return 0;

        // equalizer effects
        case EQ_ENABLED:
            return eq.eqEnabled ? 100 : 0;
        case EQ_LOW:
            ({ value } = eq.lowGain.gain );
            break;
        case EQ_MID:
            ({ value } = eq.midGain.gain );
            break;
        case EQ_HIGH:
            ({ value } = eq.highGain.gain );
            break;

        // overdrive effects
        case OD_ENABLED:
            return overdrive.overdriveEnabled ? 100 : 0;
        case OD_DRIVE:
            value = overdrive.overdrive.drive;
            break;
        case OD_PRE_BAND:
            value = overdrive.overdrive.preBand;
            break;
        case OD_COLOR:
            value = overdrive.overdrive.color / Config.MAX_FILTER_FREQ;
            break;
        case OD_POST_CUT:
            value = overdrive.overdrive.postCut / Config.MAX_FILTER_FREQ;
            break;

        // panning effects
        case PAN_LEFT:
            value = -panner.pan.value;
            break;
        case PAN_RIGHT:
            ({ value } = panner.pan );
            break;

        // filter effects
        case FILTER_ENABLED:
            return filter.filterEnabled ? 100 : 0;
        case FILTER_LFO_ENABLED:
            return instrument.filter.lfoType === "off" ? 0 : 100;
        case FILTER_FREQ:
            value = filter.filter.frequency.value / Config.MAX_FILTER_FREQ;
            break;
        case FILTER_Q:
            value = filter.filter.Q.value / Config.MAX_FILTER_Q;
            break;
        case FILTER_LFO_SPEED:
            value = filter.lfo.frequency.value / Config.MAX_FILTER_LFO_SPEED;
            break;
        case FILTER_LFO_DEPTH:
            value = ( filter.lfoAmp.gain.value / Config.MAX_FILTER_LFO_DEPTH ) * 100 / filter.filter.frequency.value;
            break;

        // delay effects
        case DELAY_ENABLED:
            return delay.delayEnabled ? 100 : 0;
        case DELAY_TIME:
            value = delay.delay.delay;
            break;
        case DELAY_FEEDBACK:
            value = delay.delay.feedback;
            break;
        case DELAY_DRY:
            value = delay.delay.dry;
            break;
        case DELAY_CUTOFF:
            value = delay.delay.cutoff / Config.MAX_DELAY_CUTOFF;
        case DELAY_OFFSET:
            value = delay.delay.offset - Config.MIN_DELAY_OFFSET;
            break;
    }
    return value * 100;
};

/* internal methods */

function applyVolumeEnvelope( audioEvent: EffluxAudioEvent, voiceLists: EventVoiceList[], startTimeInSeconds: number ): void {
    const mp = audioEvent.mp;
    const doGlide = mp.glide;
    const durationInSeconds = audioEvent.seq.mpLength;
    const target = ( mp.value / 100 );

    processVoiceLists( voiceLists, ( voice: EventVoice ): void => {
        scheduleParameterChange(
            voice.gain.gain, target, startTimeInSeconds, durationInSeconds, doGlide, voice
        );
    });
}

function applyPitchShift( audioEvent: EffluxAudioEvent, voiceLists: EventVoiceList[], startTimeInSeconds: number ): void {
    const mp = audioEvent.mp;
    const doGlide = mp.glide;
    const durationInSeconds = audioEvent.seq.mpLength;
    const goingUp = ( mp.module === PITCH_UP );

    let tmp: number;
    let target: number;

    processVoiceLists( voiceLists, ( voice: EventVoice ): void => {
        if ( isOscillatorNode( voice.generator )) {
            const generator = voice.generator as OscillatorNode;
            tmp    = voice.frequency + ( voice.frequency / 1200 ); // 1200 cents == octave
            target = ( tmp * ( mp.value / 100 ));

            if ( goingUp ) {
                target += voice.frequency;
            } else {
                target = voice.frequency - ( target / 2 );
            }
            scheduleParameterChange(
                generator.frequency, target, startTimeInSeconds, durationInSeconds, doGlide, voice
            );
        }
        else if ( isAudioBufferSourceNode( voice.generator )) {
            const generator = voice.generator as AudioBufferSourceNode;
            tmp = ( mp.value / 100 );
            target = ( goingUp ) ? generator.playbackRate.value + tmp : generator.playbackRate.value - tmp;
            scheduleParameterChange(
                generator.playbackRate, target, startTimeInSeconds, durationInSeconds, doGlide, voice
            );
        }
    });
}

function applyPanning( audioEvent: EffluxAudioEvent, modules: InstrumentModules, startTimeInSeconds: number ): void {
    const mp = audioEvent.mp;
    const doGlide = mp.glide;
    const durationInSeconds = audioEvent.seq.mpLength;
    const target = ( mp.value / 100 );

    scheduleParameterChange(
        modules.panner.pan,
        mp.module === PAN_LEFT ? -target : target,
        startTimeInSeconds, durationInSeconds, doGlide
    );
}

function applyEQ( audioEvent: EffluxAudioEvent, modules: InstrumentModules, startTimeInSeconds: number ): void {
    const mp = audioEvent.mp;
    const doGlide = mp.glide;
    const durationInSeconds = audioEvent.seq.mpLength;
    const module = modules.eq;
    const target = ( mp.value / 100 );

    switch ( mp.module ) {
        case EQ_LOW:
            scheduleParameterChange( module.lowGain.gain, target, startTimeInSeconds, durationInSeconds, doGlide );
            break;
        case EQ_MID:
            scheduleParameterChange( module.midGain.gain, target, startTimeInSeconds, durationInSeconds, doGlide );
            break;
        case EQ_HIGH:
            scheduleParameterChange( module.highGain.gain, target, startTimeInSeconds, durationInSeconds, doGlide );
            break;
    }
}

function applyOverdrive( audioEvent: EffluxAudioEvent, modules: InstrumentModules ): void {
    const { value, module } = audioEvent.mp;
    const target = value / 100;

    const { overdrive } = modules.overdrive;

    switch ( module ) {
        case OD_DRIVE:
            overdrive.drive = target;
            break;
        case OD_PRE_BAND:
            overdrive.preBand = target;
            break;
        case OD_COLOR:
            overdrive.color = target * Config.MAX_FILTER_FREQ;
            break;
        case OD_POST_CUT:
            overdrive.postCut = target * Config.MAX_FILTER_FREQ;
            break;
    }
}

function applyFilter( audioEvent: EffluxAudioEvent, modules: InstrumentModules, startTimeInSeconds: number ): void {
    const mp = audioEvent.mp;
    const doGlide = mp.glide;
    const durationInSeconds = audioEvent.seq.mpLength;
    const module = modules.filter;
    const target = ( mp.value / 100 );

    switch ( mp.module ) {
        case FILTER_FREQ:
            scheduleParameterChange( module.filter.frequency, target * Config.MAX_FILTER_FREQ, startTimeInSeconds, durationInSeconds, doGlide );
            break;
        case FILTER_Q:
            scheduleParameterChange( module.filter.Q, target * Config.MAX_FILTER_Q, startTimeInSeconds, durationInSeconds, doGlide );
            break;
        case FILTER_LFO_SPEED:
            scheduleParameterChange( module.lfo.frequency, target * Config.MAX_FILTER_LFO_SPEED, startTimeInSeconds, durationInSeconds, doGlide );
            break;
        case FILTER_LFO_DEPTH:
            scheduleParameterChange( module.lfoAmp.gain,
                ( target * Config.MAX_FILTER_LFO_DEPTH ) / 100 * module.filter.frequency.value,
                startTimeInSeconds, durationInSeconds, doGlide
            );
            break;
    }
}

function applyDelay( audioEvent: EffluxAudioEvent, modules: InstrumentModules ): void {
    const mp = audioEvent.mp
    const module = modules.delay.delay;
    const target = ( mp.value / 100 );

    switch ( mp.module ) {
        case DELAY_TIME:
            module.delay = target; // 0 - 1 range
            break;
        case DELAY_FEEDBACK:
            module.feedback = target; // 0 - 1 range
            break;
        case DELAY_DRY:
            module.dry = target; // 0 - 1 range
            break;
        case DELAY_CUTOFF:
            module.cutoff = target * Config.MAX_DELAY_CUTOFF;
            break;
        case DELAY_OFFSET:
            module.offset = Config.MIN_DELAY_OFFSET + target; // -0.5 - 0.5 range
            break;
    }
}

function applyExternalEvent( audioContext: BaseAudioContext, event: EffluxAudioEvent,
    startTimeInSeconds: number, eventCallback?: ExternalEventCallback ): void {
    if ( !eventCallback ) {
        return;
    }
    createTimer( audioContext, startTimeInSeconds, (): void => {
       
        // note that within Efflux values are scaled to percentile, so here
        // we convert the model value to the same on-screen hexadecimal value

        eventCallback({ c: parseInt(`0x${toHex(event.mp.value)}`, 16), t: startTimeInSeconds });
    });
}

/**
 * @param {AudioParam} param the AudioParam whose value to change
 * @param {number} value the target value for the AudioParam
 * @param {number} startTimeInSeconds relative to the currentTime of the AudioContext, when the change should take place
 * @param {number=} durationInSeconds the total duration of the change (only rqeuired when 'doGlide' is true)
 * @param {boolean=} doGlide whether to "glide" to the value (linear change), defaults to false for instant change
 * @param {Object=} data optional data Object to track the status of the scheduled parameter changes (can for instance
 *                  be EventVoiceList which shouldn't cancel previously scheduled changes upon repeated invocation)
 */
function scheduleParameterChange( param: AudioParam, value: number, startTimeInSeconds: number,
    durationInSeconds: number, doGlide?: boolean, data?: any ): void {

    if ( !doGlide ) {
        // instant change : discard all pending automation and current glide state
        parameterGlideStates.delete( param );
        if ( data ) {
            data.gliding = false;
        }
        param.cancelScheduledValues( startTimeInSeconds );
        param.setValueAtTime( value, startTimeInSeconds );
        return;
    }

    // gliding change. When a glide is already pending on this parameter (e.g. the automated
    // event is retriggered before its previous glide has resolved, or an event with a repeated
    // automation was enqueued) we chain the new glide from the value the previous glide will
    // have at the requested start time. This prevents stacking of duplicate cancel/anchor/ramp
    // sequences, which would otherwise cut the previous ramp short and reset the progression.

    const pending = parameterGlideStates.get( param );

    if ( pending && startTimeInSeconds >= pending.startTime ) {

        if ( startTimeInSeconds < pending.endTime ) {

            // the previous glide is still in flight : interpolate the value it will have reached
            // at the requested start time, so the new glide continues seamlessly

            const progress = ( startTimeInSeconds - pending.startTime ) / ( pending.endTime - pending.startTime );
            const currentValue = pending.startValue + (( pending.target - pending.startValue ) * progress );

            param.cancelScheduledValues( startTimeInSeconds );
            param.setValueAtTime( currentValue, startTimeInSeconds );
            param.linearRampToValueAtTime( value, startTimeInSeconds + durationInSeconds );
            parameterGlideStates.set( param, {
                startTime  : startTimeInSeconds,
                startValue : currentValue,
                endTime    : startTimeInSeconds + durationInSeconds,
                target     : value
            });
            if ( data ) {
                data.gliding = true;
            }
            return;
        }

        // the previous glide has fully resolved (and the AudioParam's value now equals its target).

        param.cancelScheduledValues( startTimeInSeconds );
        param.setValueAtTime( pending.target, startTimeInSeconds );
        param.linearRampToValueAtTime( value, startTimeInSeconds + durationInSeconds );
        parameterGlideStates.set( param, {
            startTime  : startTimeInSeconds,
            startValue : pending.target,
            endTime    : startTimeInSeconds + durationInSeconds,
            target     : value
        });
        if ( data ) {
            data.gliding = true;
        }
        return;
    }

    // no glide pending : start a new glide from the current value

    param.cancelScheduledValues( startTimeInSeconds );
    param.setValueAtTime( param.value, startTimeInSeconds );
    param.linearRampToValueAtTime( value, startTimeInSeconds + durationInSeconds );

    parameterGlideStates.set( param, {
        startTime  : startTimeInSeconds,
        startValue : param.value,
        endTime    : startTimeInSeconds + durationInSeconds,
        target     : value
    });
    if ( data ) {
        data.gliding = true;
    }
}

/**
 * Restore all module parameters that can be altered through automation onto the values
 * described by the instruments model. The modules enabled states and their routing are
 * restored through ModuleFactory#applyConfiguration, ensuring the instruments processing
 * chain is left in a clean state for the next playback session.
 *
 * @param {BaseAudioContext} audioContext
 * @param {InstrumentModules} modules the audio modules for the instrument
 * @param {Instrument} instrument the model describing the desired state
 * @param {AudioNode} output the master bus to connect the module routing onto
 * @param {Function} applyConfiguration ModuleFactory#applyConfiguration used to restore
 *        enabled states, parameter values and routing for the module chain
 */
export const resetParameterAutomation = (
    audioContext: BaseAudioContext,
    instrumentIndex: number,
    modules: InstrumentModules,
    instrument: Instrument,
    output: AudioNode,
    applyConfiguration: ( type: string, modules: InstrumentModules, props: any, output: AudioNode ) => void
): void => {
    const { eq, filter, panner } = modules;
    const { currentTime } = audioContext;

    // discard all pending automation (and glide tracking) on every automatable AudioParam
    // before applying the model values. Note these values are set by applyConfiguration()
    // below, which routes through the exact same code path as the model-driven UI updates.

    const params = [
        eq.lowGain.gain, eq.midGain.gain, eq.highGain.gain,
        filter.filter.frequency, filter.filter.Q, filter.lfo.frequency, filter.lfoAmp.gain,
    ];
    if ( panner ) {
        params.push( panner.pan );
    }
    params.forEach(( param: AudioParam ): void => {
        param.cancelScheduledValues( currentTime );
        parameterGlideStates.delete( param );
    });

    // restore the filter LFO type altered by automation (the ModuleFactory only
    // configures the LFO type when the model describes an enabled LFO)

    const lfoSnapshot = filterLfoTypeSnapshots.get( instrumentIndex );
    if ( typeof lfoSnapshot !== "undefined" ) {
        instrument.filter.lfoType = lfoSnapshot;
        filterLfoTypeSnapshots.delete( instrumentIndex );
    }

    // panning is not part of the module chain configuration, restore it directly

    if ( panner ) {
        panner.pan.value = typeof instrument.panning === "number" ? instrument.panning : 0;
    }

    // restore module values, enabled states and routing via the ModuleFactory

    applyConfiguration( "eq",        modules, instrument.eq,        output );
    applyConfiguration( "filter",    modules, instrument.filter,    output );
    applyConfiguration( "delay",     modules, instrument.delay,     output );
    applyConfiguration( "overdrive", modules, instrument.overdrive, output );
};
