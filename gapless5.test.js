/** mock browser environment **/

// Fake timer queue: lets tests deterministically fire the crossfade/ended
// timers while leaving the 27 ms player tick alone.
let timerQueue = [];
let timerSeq = 0;
let audioInstances = [];
let xhrInstances = [];
let bufferSources = [];

const resetHarness = () => {
  timerQueue = [];
  timerSeq = 0;
  audioInstances = [];
  xhrInstances = [];
  bufferSources = [];
  window.gapless5Players = {};
  delete window.gapless5AudioContext;
};

const takeTimeouts = (predicate) => {
  const taken = timerQueue.filter(predicate);
  timerQueue = timerQueue.filter((item) => !predicate(item));
  return taken;
};

const fireTimeouts = (predicate) => takeTimeouts(predicate).forEach((item) => {
  item.fn();
});

const flushPromises = async() => {
  // drain resolved promise chains (play(), context.resume(), decodeAudioData())
  for (let i = 0; i < 12; i++) {
    await Promise.resolve(); // eslint-disable-line no-await-in-loop
  }
};

const makeAudioElement = () => {
  const listeners = {};
  const element = {
    src            : '',
    srcObject      : null,
    controls       : false,
    loop           : false,
    volume         : 1,
    currentTime    : 0,
    duration       : 10,
    playbackRate   : 1,
    preservesPitch : false,
    seekable       : { length: 0, end: () => 0 },
    addEventListener: jest.fn((event, callback) => {
      listeners[event] = callback;
    }),
    removeEventListener: jest.fn(),
    load  : jest.fn(),
    pause : jest.fn(),
    play  : jest.fn(() => Promise.resolve()),
    emit  : (event, payload) => {
      const listener = listeners[event];
      if (listener) {
        listener(payload || { target: element });
      }
    },
  };
  audioInstances.push(element);
  return element;
};

const makeAudioContext = () => ({
  currentTime : 0,
  baseLatency : 0,
  destination : {},
  createGain: () => {
    const gainNode = {
      gain: {
        value                   : 1,
        setValueAtTime          : jest.fn(),
        linearRampToValueAtTime : jest.fn(),
      },
      connect    : jest.fn(),
      disconnect : jest.fn(),
    };
    return gainNode;
  },
  createBufferSource: () => {
    const sourceNode = {
      buffer       : null,
      playbackRate : { value: 1 },
      loop         : false,
      start        : jest.fn(),
      stop         : jest.fn(),
      connect      : jest.fn(),
      disconnect   : jest.fn(),
    };
    bufferSources.push(sourceNode);
    return sourceNode;
  },
  createAnalyser    : () => ({ fftSize: 256, connect: jest.fn(), disconnect: jest.fn() }),
  decodeAudioData   : jest.fn(() => Promise.resolve({ duration: 10 })),
  resume            : jest.fn(() => Promise.resolve()),
});

Audio = jest.fn(() => makeAudioElement());

XMLHttpRequest = jest.fn(() => {
  const xhr = {
    url             : null,
    open            : jest.fn((_method, url) => {
      xhr.url = url;
    }),
    send            : jest.fn(),
    setRequestHeader: jest.fn(),
    abort           : jest.fn(),
    status          : 200,
    response        : null,
  };
  xhrInstances.push(xhr);
  return xhr;
});

window = {
  clearTimeout     : (id) => {
    timerQueue = timerQueue.filter((item) => item.id !== id);
  },
  setTimeout       : (fn, ms) => {
    timerSeq++;
    timerQueue.push({ id: timerSeq, fn: fn, ms: ms });
    return timerSeq;
  },
  AudioContext     : jest.fn().mockImplementation(() => makeAudioContext()),
};

const { Gapless5, LogLevel } = require('./gapless5.js');

/** test data **/

const TRACKS = [ '0.mp3', '1.mp3', '2.mp3', '3.mp3', '4.mp3' ];
const INIT_OPTIONS = {
  logLevel: LogLevel.None,
  useWebAudio: false,
  useHTML5Audio: false,
};

const PLAY_STATE = 3; // Gapless5State.Play

/** engine-level helpers (both WebAudio and HTML5 mocks enabled) **/

const makeEnginePlayer = (options = {}) => new Gapless5({
  logLevel: LogLevel.None,
  tracks: TRACKS,
  ...options,
});

// Sources are loaded in track order, so the last N Audio elements created
// during construction correspond to tracks 0..N-1.
const trackAudioElements = (player) => audioInstances.slice(-player.totalTracks());

const loadAllHtml5 = (player) => {
  trackAudioElements(player).forEach((element) => element.emit('canplaythrough'));
};

// Index of a track's XHR among those created so far (-1 if it has no pending
// WebAudio request, e.g. because it was never loaded).
const xhrIndexFor = (player, trackIndex) => xhrInstances.findIndex(
  (xhr) => xhr.url === player.getTracks()[trackIndex]
);

// Deliver a WebAudio decode result to whichever source currently requests it.
const deliverWebAudioData = (player, trackIndex) => {
  const index = xhrIndexFor(player, trackIndex);
  if (index < 0) {
    return false;
  }
  const xhr = xhrInstances[index];
  xhr.response = { duration: 10 };
  xhr.onload();
  return true;
};

const loadedTrackPaths = (player) => player.playlist.sources
  .filter((source) => source.getState() !== 0)
  .map((source) => source.audioPath);

/** test suite **/

describe('Gapless-5 object', () => {
  let player = null;

  beforeEach(() => {
    resetHarness();
    player = new Gapless5(INIT_OPTIONS);
  });

  it('has correct initial state', () => {
    expect(player.getTracks()).toStrictEqual([]);
    expect(player.totalTracks()).toBe(0);
    expect(player.getIndex()).toBe(-1);
    expect(player.getPosition()).toBe(0);
    expect(player.canShuffle()).toBe(false);
    expect(player.initialized).toBe(true);
    expect(player.hasGUI).toBe(false);
  });

  it('can manipulate tracklist and position', () => {
    player.addTrack(TRACKS[1]);
    expect(player.getIndex()).toBe(0);
    player.insertTrack(0, TRACKS[0]);
    expect(player.getTracks()).toStrictEqual([ TRACKS[0], TRACKS[1] ]);
    expect(player.findTrack(TRACKS[1])).toBe(1);
    player.setPlaybackRate(0.1);
    player.setPosition(10);
    expect(player.getPosition()).toBe(10);

    player.removeTrack(0);
    expect(player.getTracks()).toStrictEqual([ TRACKS[1] ]);
    player.removeAllTracks();
    expect(player.getTracks()).toStrictEqual([]);
    player.setPosition(10);
    expect(player.getPosition()).toBe(0); // setPosition should do nothing without a track
  });
});

describe('Gapless-5 object with tracklist', () => {
  let player = null;

  beforeEach(() => {
    resetHarness();
    player = new Gapless5({
      ...INIT_OPTIONS,
      tracks: TRACKS,
    });
  });

  it('has correct initial state', () => {
    expect(player.getTracks()).toStrictEqual(TRACKS);
    expect(player.getIndex()).toBe(0);
    expect(player.getPosition()).toBe(0);
    expect(player.initialized).toBe(true);
    expect(player.hasGUI).toBe(false);
  });

  it('can shuffle and un-shuffle tracklist', () => {
    expect(player.canShuffle()).toBe(true);
    expect(player.isShuffled()).toBe(false);
    player.shuffle();
    expect(player.isShuffled()).toBe(true);

    // shouldn't actually shuffle until we change tracks
    expect(player.getTracks()).toStrictEqual(TRACKS);
    player.next();
    expect(player.getTracks()).not.toStrictEqual(TRACKS);
    expect(player.totalTracks()).toBe(TRACKS.length);

    // shouldn't actually unshuffle until we change tracks
    player.toggleShuffle();
    expect(player.isShuffled()).toBe(false);
    expect(player.getTracks()).not.toStrictEqual(TRACKS);
    player.next();
    expect(player.getTracks()).toStrictEqual(TRACKS);
  });

  it('can navigate the tracklist', () => {
    expect(player.getIndex()).toBe(0);
    player.next();
    expect(player.getIndex()).toBe(1);
    player.prev();
    expect(player.getIndex()).toBe(0);
    player.gotoTrack(2);
    expect(player.getIndex()).toBe(2);

    // should loop around
    player.loop = true;
    TRACKS.forEach(() => player.next());
    expect(player.getIndex()).toBe(2);

    // should not loop around
    player.loop = false;
    TRACKS.forEach(() => player.next());
    expect(player.getIndex()).toBe(TRACKS.length - 1);
  });

  it('triggers navigation callbacks', () => {
    player.onprev = jest.fn();
    player.onnext = jest.fn();
    player.onplayrequest = jest.fn();
    player.onpause = jest.fn();
    player.onstop = jest.fn();

    player.next();
    expect(player.onnext).toHaveBeenCalledWith(TRACKS[0], TRACKS[1]);
    player.prev();
    expect(player.onprev).toHaveBeenCalledWith(TRACKS[1], TRACKS[0]);
    player.play();
    expect(player.onplayrequest).toHaveBeenCalledWith(TRACKS[0]);
    player.pause();
    expect(player.onpause).toHaveBeenCalledWith(TRACKS[0]);
    player.stop();
    expect(player.onstop).toHaveBeenCalledWith(TRACKS[0]);
  });

  it('regression: maintains correct index when removing tracks that come after the currently playing track', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    // Verify initial state
    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual(testTracks);

    // Move to track 1
    testPlayer.gotoTrack(1);
    expect(testPlayer.getIndex()).toBe(1);

    // Remove track at index 2
    testPlayer.removeTrack(2);

    // Check index is still 1 and track list is updated
    expect(testPlayer.getIndex()).toBe(1);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track2.mp3' ]);
  });

  it('regression: maintains correct index when removing the currently playing track', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    // Verify initial state
    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual(testTracks);

    // Move to track 1
    testPlayer.gotoTrack(1);
    expect(testPlayer.getIndex()).toBe(1);
    testPlayer.play();

    // Remove the currently playing track
    testPlayer.removeTrack(1);

    // Check index is still 1 and track list is updated, therefore we move to the next available track
    expect(testPlayer.getIndex()).toBe(1);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track3.mp3' ]);

    testPlayer.play();

    // Remove the currently playing track
    testPlayer.removeTrack(1);

    // Check index is still 0 and track list is updated, therefore we move to the next available track
    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3' ]);

    testPlayer.play();

    // Remove the only remaining track — list is empty, index resets to -1
    testPlayer.removeTrack(0);
    expect(testPlayer.getIndex()).toBe(-1);
    expect(testPlayer.getTracks()).toStrictEqual([]);
  });

  it('regression: removing a track does not wipe shuffledIndices', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3', 'track4.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    testPlayer.shuffle();
    testPlayer.next(); // commit the shuffle
    expect(testPlayer.isShuffled()).toBe(true);
    expect(testPlayer.playlist.shuffledIndices.length).toBe(testTracks.length);

    testPlayer.removeTrack(0);

    // Shuffle order should still be intact (one fewer entry, still shuffled)
    expect(testPlayer.isShuffled()).toBe(true);
    expect(testPlayer.playlist.shuffledIndices.length).toBe(testTracks.length - 1);
    expect(testPlayer.getTracks().length).toBe(testTracks.length - 1);
  });

  it('regression: removing currently-playing track repeatedly until empty does not crash', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    // Walk the list down to zero by always removing the current track
    // This reproduces a crash in the pre-PR code where updateLoading()
    // would dereference an undefined source after the list went empty.
    while (testPlayer.getTracks().length > 0) {
      testPlayer.removeTrack(testPlayer.getIndex());
    }
    expect(testPlayer.getTracks()).toStrictEqual([]);
    expect(testPlayer.getIndex()).toBe(-1);
  });

  it('regression: removing current-at-tail with loop=true wraps to start and resumes', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
      loop: true,
    });

    testPlayer.gotoTrack(2);
    expect(testPlayer.getIndex()).toBe(2);

    // Force the tail source to report as playing so removeTrack takes the
    // wasPlaying branch (the mock audio env never transitions real state).
    testPlayer.playlist.sources[2].inPlayState = () => true;

    testPlayer.onnext = jest.fn();
    testPlayer.onplayrequest = jest.fn();

    testPlayer.removeTrack(2);

    expect(testPlayer.getIndex()).toBe(0);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track2.mp3' ]);
    expect(testPlayer.onnext).toHaveBeenCalledWith('track3.mp3', 'track1.mp3');
    expect(testPlayer.onplayrequest).toHaveBeenCalledTimes(1);
    expect(testPlayer.onplayrequest).toHaveBeenCalledWith('track1.mp3');
  });

  it('regression: removing current-at-tail with loop=false clamps and always pauses', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
      loop: false,
    });

    testPlayer.gotoTrack(2);
    expect(testPlayer.getIndex()).toBe(2);

    // Force the tail source to report as playing so removeTrack takes the
    // wasPlaying branch — this is the scenario where the old code would
    // have auto-resumed on the clamped-to-last track.
    testPlayer.playlist.sources[2].inPlayState = () => true;

    testPlayer.onnext = jest.fn();
    testPlayer.onplayrequest = jest.fn();

    testPlayer.removeTrack(2);

    expect(testPlayer.getIndex()).toBe(1);
    expect(testPlayer.getTracks()).toStrictEqual([ 'track1.mp3', 'track2.mp3' ]);
    expect(testPlayer.onnext).toHaveBeenCalledWith('track3.mp3', 'track2.mp3');
    expect(testPlayer.onplayrequest).not.toHaveBeenCalled();
  });

  it('regression: removing a track does not spuriously disable shuffle when never shuffled', () => {
    const testTracks = [ 'track1.mp3', 'track2.mp3', 'track3.mp3' ];
    const testPlayer = new Gapless5({
      ...INIT_OPTIONS,
      tracks: testTracks,
    });

    expect(testPlayer.isShuffled()).toBe(false);
    const setShuffleSpy = jest.spyOn(testPlayer.playlist, 'setShuffle');

    // Drop to 2 tracks — previously tripped the shuffle-disable path
    // because `this.isShuffled` (a function reference) was always truthy.
    testPlayer.removeTrack(0);

    expect(testPlayer.isShuffled()).toBe(false);
    expect(setShuffleSpy).not.toHaveBeenCalled();
    setShuffleSpy.mockRestore();
  });
});

describe('Gapless-5 object with load limit', () => {
  it('obeys load limit', () => {
    resetHarness();
    const player = new Gapless5({
      ...INIT_OPTIONS,
      loadLimit: 2,
    });
    const loadedTracks = new Set([]);
    player.onloadstart = (audioPath) => {
      loadedTracks.add(audioPath);
    };
    player.onunload = (audioPath) => {
      loadedTracks.delete(audioPath);
    };

    TRACKS.forEach((track) => player.addTrack(track));
    expect(player.totalTracks()).toBe(TRACKS.length);
    expect(loadedTracks.size).toBe(2);
    player.next();
    expect(loadedTracks.size).toBe(2);
    player.next();
    expect(loadedTracks.size).toBe(2);
    player.removeAllTracks();
    expect(loadedTracks.size).toBe(0);
  });
});

describe('Gapless-5 atomic track switching', () => {
  beforeEach(() => {
    resetHarness();
  });

  it('rapid next/next only plays the final track and disarms skipped sources', async() => {
    const player = makeEnginePlayer();
    const played = [];
    player.onplay = (path) => played.push(path);

    // Both engines finish loading for every track, so play() starts on HTML5.
    loadAllHtml5(player);
    player.play();
    await flushPromises();
    expect(player.getIndex()).toBe(0);
    expect(played).toStrictEqual([ TRACKS[0] ]);

    // Two rapid skips before any WebAudio data arrives.
    player.next();
    player.next();
    await flushPromises();
    expect(player.getIndex()).toBe(2);
    expect(played).toStrictEqual([ TRACKS[0], TRACKS[2] ]);

    // Every skipped source must have had its ended timer cancelled in stop();
    // only the current track may have a pending ended callback armed.
    const armed = takeTimeouts((item) => item.ms !== 27);
    expect(armed).toHaveLength(1);

    // Sources other than the current one must all be stopped, so a stray
    // timer cannot resurrect them.
    const stopped = player.playlist.sources.slice(0, 2)
      .map((source) => source.getState());
    expect(stopped).toStrictEqual([ 4, 4 ]); // Gapless5State.Stop

    // Late WebAudio decodes for skipped tracks must be inert; only the
    // current track may take over from HTML5.
    deliverWebAudioData(player, 1);
    deliverWebAudioData(player, 2);
    await flushPromises();
    expect(player.getIndex()).toBe(2);
    expect(player.currentSource().getState()).toBe(PLAY_STATE);
    expect(played).not.toContain(TRACKS[1]);
  });

  it('rapid re-entry into the same track does not start its audio twice', async() => {
    const player = makeEnginePlayer();
    deliverWebAudioData(player, 0); // WebAudio buffer ready for track 0
    await flushPromises();

    // Defer the AudioContext resume promises so both play() attempts are
    // still pending when the second one is issued.
    const resolvers = [];
    player.context.resume = jest.fn(() => new Promise((resolve) => resolvers.push(resolve)));

    player.play(); // attempt A
    player.stop(); // user immediately stops (or skips away and back)
    player.play(); // attempt B, same source
    expect(resolvers).toHaveLength(2);

    // Both promises resolve, but only attempt B (the latest generation) may
    // create and start an AudioBufferSourceNode.
    resolvers.forEach((resolve) => resolve());
    await flushPromises();

    expect(bufferSources).toHaveLength(1);
    expect(bufferSources[0].start).toHaveBeenCalledTimes(1);
    expect(player.currentSource().getState()).toBe(PLAY_STATE);
  });

  it('a late WebAudio takeover cannot resurrect the track that is fading out', async() => {
    const player = makeEnginePlayer();
    player.setCrossfade(1000);
    const switched = [];
    player.onswitchtowebaudio = (path) => switched.push(path);

    loadAllHtml5(player);
    player.play();
    await flushPromises();
    expect(player.getIndex()).toBe(0);

    // Crossfade to track 1 while track 0's WebAudio data is still in flight.
    // The fading source keeps playing, so it looks "audible" to its own
    // decode callback.
    player.next(null, true, true);
    await flushPromises();
    expect(player.getIndex()).toBe(1);
    expect(player.fadingTrack).toBe(0);

    // Track 0's decode lands now. It must not take over the audio engine or
    // restart playback on the track we already left.
    deliverWebAudioData(player, 0);
    await flushPromises();
    expect(player.getIndex()).toBe(1);
    expect(switched).not.toContain(TRACKS[0]);

    // The current track still takes over from HTML5 normally.
    deliverWebAudioData(player, 1);
    await flushPromises();
    expect(player.getIndex()).toBe(1);
    expect(switched).toContain(TRACKS[1]);
  });

  it('an ended timer left over from a skipped track cannot advance the playlist', async() => {
    const player = makeEnginePlayer();
    const finished = [];
    player.onfinishedtrack = (path) => finished.push(path);

    loadAllHtml5(player);
    player.play();
    await flushPromises();

    // Track 0 is playing HTML5, so it has an armed "ended" timer.
    const staleTimers = takeTimeouts((item) => item.ms !== 27);
    expect(staleTimers.length).toBeGreaterThan(0);

    player.next();
    await flushPromises();
    expect(player.getIndex()).toBe(1);

    // Simulate the browser delivering a timeout that was already queued
    // before stop() cleared it. The identity guard in the source must make
    // it inert rather than advancing off the track we just moved to.
    staleTimers.forEach((item) => item.fn());
    expect(player.getIndex()).toBe(1);
    expect(finished).not.toContain(TRACKS[0]);

    // Track 1's own timer still works and advances the playlist normally.
    fireTimeouts((item) => item.ms !== 27);
    expect(player.getIndex()).toBe(2);
    expect(finished).toContain(TRACKS[1]);
  });

  it('interrupting a crossfade stops the old fade timer and only fades the right source', async() => {
    const player = makeEnginePlayer();
    player.setCrossfade(1000);

    loadAllHtml5(player);
    player.play();
    await flushPromises();

    // Kick off a crossfade 0 -> 1, then immediately skip 1 -> 2.
    player.next(null, true, true);
    await flushPromises();
    expect(player.getIndex()).toBe(1);
    const firstFadeTrack = player.fadingTrack;
    expect(firstFadeTrack).not.toBeNull();

    player.next(null, true, true);
    await flushPromises();
    expect(player.getIndex()).toBe(2);
    // A fresh fade was scheduled for track 1; track 0's fade was superseded.
    expect(player.fadingTrack).toBe(1);

    fireTimeouts((item) => item.ms === 1000);
    // The pending fade resolved to silence: track 1 is no longer fading and
    // nothing re-started playback on track 0.
    expect(player.fadingTrack).toBeNull();
    expect(player.getIndex()).toBe(2);
    expect(player.isPlaying()).toBe(true);
  });

  it('skipping during a fade leaves the faded-out source stopped with no timer armed', async() => {
    const player = makeEnginePlayer();
    player.setCrossfade(1000);

    loadAllHtml5(player);
    player.play();
    await flushPromises();

    player.next(null, true, true); // 0 fading out, 1 playing
    await flushPromises();
    const fadedSource = player.getFadingSource();
    expect(fadedSource).not.toBeNull();

    player.gotoTrack(3); // hard cut, asking for a crossfade is not required
    await flushPromises();

    expect(player.getIndex()).toBe(3);
    expect(player.fadingTrack).toBeNull();
    // Any outstanding fade timer was cancelled, so firing it does nothing.
    fireTimeouts((item) => item.ms === 1000);
    expect(player.getIndex()).toBe(3);
    expect(player.isPlaying()).toBe(true);
  });
});

describe('Gapless-5 preload window in a live engine', () => {
  beforeEach(() => {
    resetHarness();
  });

  const createLivePlayer = (loadLimit) => {
    // Construct empty, attach callbacks, then add tracks: this way the
    // initial preload of every track is recorded by the callbacks.
    const player = new Gapless5({
      logLevel     : LogLevel.None,
      loadLimit    : loadLimit,
      useWebAudio  : true,
      useHTML5Audio: true,
    });
    const loads = [];
    const unloads = [];
    const finishedLoads = [];
    player.onloadstart = (path) => loads.push(path);
    player.onload = (path) => finishedLoads.push(path);
    player.onunload = (path) => unloads.push(path);
    TRACKS.forEach((track) => player.addTrack(track));
    return { player: player, loads: loads, unloads: unloads, finishedLoads: finishedLoads };
  };

  it('releases sources that leave the window and emits onunload exactly once', async() => {
    const { player, unloads } = createLivePlayer(2);
    loadAllHtml5(player);
    player.play();
    await flushPromises();

    // Loaded window initially covers tracks 0 and 1.
    expect(loadedTrackPaths(player)).toStrictEqual([ TRACKS[0], TRACKS[1] ]);
    expect(unloads).toStrictEqual([]);

    player.next();
    await flushPromises();
    // Window slides to 1 and 2; track 0 must be genuinely unloaded once.
    expect(loadedTrackPaths(player)).toStrictEqual([ TRACKS[1], TRACKS[2] ]);
    expect(unloads).toStrictEqual([ TRACKS[0] ]);

    // Re-entering the window loads the source again (only once).
    player.prev();
    await flushPromises();
    expect(loadedTrackPaths(player)).toStrictEqual([ TRACKS[0], TRACKS[1] ]);
    expect(unloads).toStrictEqual([ TRACKS[0], TRACKS[2] ]);
  });

  it('does not reload or re-callback when a track re-enters the window repeatedly', async() => {
    const { player, loads, unloads, finishedLoads } = createLivePlayer(2);
    loadAllHtml5(player);
    player.play();
    await flushPromises();

    // Bounce between tracks 0 and 1. Track 1 stays inside the window the
    // whole time, so it must be loaded exactly once with no unload churn.
    player.next(); // window {1,2} — track 0 unloads, track 1 stays
    player.prev(); // window {0,1} — track 2 unloads, track 0 reloads
    player.next(); // window {1,2} again — track 1 stays
    await flushPromises();

    expect(loads.filter((path) => path === TRACKS[1])).toHaveLength(1);
    expect(unloads.filter((path) => path === TRACKS[1])).toHaveLength(0);
    expect(finishedLoads.filter((path) => path === TRACKS[1])).toHaveLength(1);

    // Re-entering a window after a real unload also yields exactly one
    // load and one onload per re-entry, never duplicates.
    player.gotoTrack(4); // window {4}
    await flushPromises();
    const loadsBeforeReentry = loads.filter((path) => path === TRACKS[0]).length;
    const finishedBeforeReentry = finishedLoads.filter((path) => path === TRACKS[0]).length;
    const audioInstancesBeforeReentry = audioInstances.length;

    player.gotoTrack(0); // window {0,1}
    await flushPromises();
    expect(loads.filter((path) => path === TRACKS[0]).length).toBe(loadsBeforeReentry + 1);

    // The reloaded source gets a fresh Audio element; completing its metadata
    // must produce exactly one onload, not a duplicate for the stale one.
    const reloadedElements = audioInstances
      .slice(audioInstancesBeforeReentry)
      .filter((element) => element.src === TRACKS[0]);
    expect(reloadedElements).toHaveLength(1);
    reloadedElements.forEach((element) => element.emit('canplaythrough'));
    await flushPromises();
    expect(finishedLoads.filter((path) => path === TRACKS[0])).toHaveLength(
      finishedBeforeReentry + 1
    );
  });

  it('queuedTrack and fadingTrack are kept loaded even outside the window', async() => {
    const { player, unloads } = createLivePlayer(2);
    player.setCrossfade(1000);
    loadAllHtml5(player);
    player.play();
    await flushPromises();

    // Queue a track far outside the window; it must be loaded immediately.
    player.queueTrack(4);
    await flushPromises();
    expect(loadedTrackPaths(player)).toContain(TRACKS[4]);
    expect(unloads).not.toContain(TRACKS[4]);

    // Crossfade 0 -> 1: track 0 becomes the fading track but is already
    // outside the new window; it must survive its own fade.
    player.next(null, true, true);
    await flushPromises();
    expect(player.fadingTrack).toBe(0);
    expect(loadedTrackPaths(player)).toContain(TRACKS[0]);

    // Once the fade completes, track 0 is released and the queued track is
    // untouched until it becomes the current track.
    fireTimeouts((item) => item.ms === 1000);
    await flushPromises();
    expect(player.fadingTrack).toBeNull();
    expect(loadedTrackPaths(player)).not.toContain(TRACKS[0]);
    expect(loadedTrackPaths(player)).toContain(TRACKS[4]);
  });
});
