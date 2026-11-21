'use strict';

const { loadSkin } = require('./skin');

/*
 * Skin lifecycle: one skin is live at a time, and switching frees the old one.
 *
 * The host (the console app) calls the same three things this models:
 *
 *   switchSkin(name, jsonText) -> { skin, released, generation }
 *   decodeImage(name)          -> decoded picture handle for the live skin
 *   onAnimationFrame(fn)       -> runs fn only if its generation still matches
 *
 * That is what stops a slow decode or a queued animation step from the old
 * skin writing over the new one: every callback carries the generation it was
 * made for, and `release` bumps the generation.
 *
 * Memory: the old skin's decoded picture and its background state are dropped
 * on switch, so switching quickly N times leaves one picture alive, not N.
 * This module exposes counters a test can assert on.
 */

function createSkinController(options = {}) {
  const loader = options.loadSkin || loadSkin;

  const state = {
    liveName: null,
    skin: null,
    generation: 0,
    decodedImage: null,
    background: null,
    // Texts the current skin has put on screen. Cleared on every switch so a
    // previous skin cannot leave a line behind; a render pass replaces it.
    drawnText: [],
    // Counters, so memory behaviour is observable rather than assumed.
    stats: {
      decodedImagesOpen: 0,
      decodedImagesTotal: 0,
      releasedImages: 0,
      switches: 0,
      staleCallbacksDropped: 0,
      textCleared: 0,
    },
  };

  const release = () => {
    if (state.decodedImage) {
      state.stats.decodedImagesOpen -= 1;
      state.stats.releasedImages += 1;
      state.decodedImage = null;
    }
    if (state.drawnText.length) {
      state.stats.textCleared += state.drawnText.length;
      state.drawnText = [];
    }
    state.background = null;
    state.skin = null;
    state.liveName = null;
  };

  /**
   * @param {string} name     folder name, for diagnostics
   * @param {string} jsonText raw skin.json; missing file passes null
   * @param {{screen?:string}} [opts]
   */
  function switchSkin(name, jsonText, opts = {}) {
    release();
    state.generation += 1;
    state.stats.switches += 1;
    const skin = loader(jsonText, { screen: opts.screen || 'psp' });
    state.skin = skin;
    state.liveName = name;
    state.background = skin.background;
    return { skin, generation: state.generation, name };
  }

  /**
   * The host decodes the picture after switching. It must pass the generation
   * it read at switch time; a decode that finishes late for an old generation
   * is discarded rather than installed.
   */
  function installDecodedImage(name, generation, handle) {
    if (generation !== state.generation || name !== state.liveName) {
      state.stats.staleCallbacksDropped += 1;
      return false;
    }
    if (state.decodedImage) {
      state.stats.decodedImagesOpen -= 1;
      state.stats.releasedImages += 1;
    }
    state.decodedImage = handle;
    state.stats.decodedImagesOpen += 1;
    state.stats.decodedImagesTotal += 1;
    return true;
  }

  function isCurrent(generation) {
    return generation === state.generation;
  }

  function frame(generation, fn) {
    if (!isCurrent(generation)) {
      state.stats.staleCallbacksDropped += 1;
      return false;
    }
    fn(state.skin);
    return true;
  }

  /**
   * Record what the current skin has drawn this frame. Text from another
   * generation is refused, which is the second half of "no old text lingers":
   * a late pass cannot re-add its lines after release() cleared them.
   */
  function setDrawnText(generation, lines) {
    if (!isCurrent(generation)) {
      state.stats.staleCallbacksDropped += 1;
      return false;
    }
    state.drawnText = Array.isArray(lines) ? lines.slice() : [];
    return true;
  }

  return {
    switchSkin,
    installDecodedImage,
    isCurrent,
    frame,
    setDrawnText,
    get generation() { return state.generation; },
    get skin() { return state.skin; },
    get liveName() { return state.liveName; },
    get background() { return state.background; },
    get drawnText() { return state.drawnText; },
    get stats() { return state.stats; },
  };
}

module.exports = { createSkinController };
